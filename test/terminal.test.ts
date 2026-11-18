import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { runInTerminal } from "../src/terminal.ts"

// Execute the same runner without opening a GUI window during automated tests.
const direct = { command: "sh", args: ["-c", 'exec "$@"', "terminal-test"] }

async function fixture(
  command: string,
  args: string[] = [],
  cwd = process.cwd(),
  terminal = direct,
) {
  return runInTerminal(
    { id: "test", command, args, cwd, title: "Test" },
    terminal,
    60_000,
  )
}

test("captures stdout and stderr through a PTY and returns the exact exit code", async () => {
  const result = await fixture("sh", [
    "-c",
    "printf '\\033[31mhello\\033[0m\\n'; printf 'problem\\n' >&2; exit 42",
  ])
  assert.equal(result.exitCode, 42)
  assert.equal(result.error, undefined)
  assert.equal(result.output, "hello\nproblem\n")
})

test("passes arguments literally without shell interpretation", async () => {
  const result = await fixture("printf", ["%s", "hello; printf not-a-command"])
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, "hello; printf not-a-command")
})

test("preserves quotes, whitespace, and newlines in literal arguments", async () => {
  const value = "single ' quote; $HOME `false`\nsecond line"
  const result = await fixture("printf", ["%s", value])
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, value)
})

test("runs in the requested working directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "interactive-terminal-test-"))
  try {
    const result = await fixture("pwd", [], directory)
    assert.equal(result.exitCode, 0)
    assert.equal(result.output.trim(), directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reports a missing working directory", async () => {
  const result = await fixture("pwd", [], "/definitely/not/a/real/directory")
  assert.equal(result.exitCode, 125)
  assert.match(result.output, /No such file or directory/i)
})

test("reports terminal launch failures", async () => {
  const result = await fixture("true", [], process.cwd(), {
    command: "/definitely/not/a/terminal",
    args: [],
  })
  assert.equal(result.exitCode, null)
  assert.match(result.error ?? "", /Could not open the terminal/)
})
