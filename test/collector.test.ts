import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const collector = fileURLToPath(new URL("../src/collector.mjs", import.meta.url))

test("installed Node collector handles many one-byte writes with ordered bounded output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-collector-"))
  const installed = join(directory, "node_modules", "opencode-interactive-terminal", "src")
  await mkdir(installed, { recursive: true })
  const entry = join(installed, "collector.mjs")
  await copyFile(collector, entry)
  const output = join(directory, "output")
  const child = spawn(process.execPath, [entry, output, "4096"], {
    stdio: ["pipe", "ignore", "pipe"],
  })
  let errors = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => (errors += chunk))
  const expected = Array.from({ length: 10_000 }, (_, index) => index % 10).join("")

  try {
    for (const character of expected) {
      if (!child.stdin.write(character)) await once(child.stdin, "drain")
    }
    child.stdin.end()
    const [code] = (await once(child, "close")) as [number | null]
    assert.equal(code, 0, errors)

    const captured = await readFile(output, "utf8")
    assert.match(captured, /captured bytes omitted/)
    assert.ok(captured.endsWith(expected.slice(-2_048)))
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await rm(directory, { recursive: true, force: true })
  }
})
