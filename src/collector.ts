import { once } from "node:events"
import { writeFile } from "node:fs/promises"

const [output, limitValue] = process.argv.slice(2)
const limit = Math.max(4_096, Number(limitValue) || 240_000)
const headLimit = Math.floor(limit / 2)
const tailLimit = limit - headLimit
const head = Buffer.alloc(headLimit)
let headLength = 0
let tail: Buffer[] = []
let tailLength = 0
let total = 0
let interrupted = false

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true
    process.stdin.destroy()
  })
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

    tail.push(chunk)
    tailLength += chunk.length
    while (tail.length > 1 && tailLength - tail[0].length >= tailLimit) {
      tailLength -= tail[0].length
      tail.shift()
    }
    if (tailLength > tailLimit) {
      const excess = tailLength - tailLimit
      tail[0] = tail[0].subarray(excess)
      tailLength = tailLimit
    }
  }
} catch (error) {
  if (!interrupted) throw error
}

const truncated = total > limit
let captured: Buffer
if (truncated) {
  const omitted = total - headLength - tailLength
  captured = Buffer.concat([
    head.subarray(0, headLength),
    Buffer.from(`\n\n[... ${omitted} captured bytes omitted ...]\n\n`),
    ...tail,
  ])
} else if (total <= tailLimit) {
  captured = Buffer.concat(tail)
} else {
  captured = Buffer.concat([head.subarray(0, headLength), ...tail])
}

await writeFile(output, captured, { mode: 0o600 })
if (truncated) await writeFile(`${output}.truncated`, "1\n", { mode: 0o600 })
