import { once } from "node:events"
import { writeFile } from "node:fs/promises"

const [output, limitValue] = process.argv.slice(2)
const limit = Math.max(4_096, Number(limitValue) || 240_000)
const headLimit = Math.floor(limit / 2)
const tailLimit = limit - headLimit
const head = Buffer.alloc(headLimit)
const tail = Buffer.alloc(tailLimit)
let headLength = 0
let tailLength = 0
let tailStart = 0
let total = 0
let interrupted = false

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true
    process.stdin.destroy()
  })
}

function orderedTail(): Buffer {
  if (tailLength < tailLimit || tailStart === 0) return tail.subarray(0, tailLength)
  return Buffer.concat([tail.subarray(tailStart), tail.subarray(0, tailStart)])
}

try {
  for await (const value of process.stdin) {
    const chunk: Buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.length

    if (!process.stdout.write(chunk)) await once(process.stdout, "drain")

    const copied = Math.min(chunk.length, headLimit - headLength)
    if (copied > 0) {
      chunk.copy(head, headLength, 0, copied)
      headLength += copied
    }

    if (chunk.length >= tailLimit) {
      chunk.copy(tail, 0, chunk.length - tailLimit)
      tailLength = tailLimit
      tailStart = 0
      continue
    }

    const writeStart = (tailStart + tailLength) % tailLimit
    const first = Math.min(chunk.length, tailLimit - writeStart)
    chunk.copy(tail, writeStart, 0, first)
    if (first < chunk.length) chunk.copy(tail, 0, first)

    const combined = tailLength + chunk.length
    if (combined > tailLimit) tailStart = (tailStart + combined - tailLimit) % tailLimit
    tailLength = Math.min(combined, tailLimit)
  }
} catch (error) {
  if (!interrupted) throw error
}

const bufferedTail = orderedTail()
const truncated = total > limit
let captured: Buffer
if (truncated) {
  const omitted = total - headLength - tailLength
  captured = Buffer.concat([
    head.subarray(0, headLength),
    Buffer.from(`\n\n[... ${omitted} captured bytes omitted ...]\n\n`),
    bufferedTail,
  ])
} else {
  const remaining = total - headLength
  captured = Buffer.concat([
    head.subarray(0, headLength),
    bufferedTail.subarray(bufferedTail.length - remaining),
  ])
}

await writeFile(output, captured, { mode: 0o600 })
if (truncated) await writeFile(`${output}.truncated`, "1\n", { mode: 0o600 })
