import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
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
    { id: "test", command, args, cwd, title: "Test", timeoutMs: 60_000 },
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

test("bounded capture does not kill a verbose successful command", async () => {
  const result = await runInTerminal(
    {
      id: "large-output",
      command: "node",
      args: ["-e", "process.stdout.write('x'.repeat(1_000_000))"],
      cwd: process.cwd(),
      title: "Large output",
      timeoutMs: 60_000,
    },
    direct,
    1_000,
  )
  assert.equal(result.exitCode, 0)
  assert.equal(result.truncated, true)
  assert.ok(result.output.length <= 1_000)
})

test("cancellation kills an inner command that ignores HUP and SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "interactive-terminal-cancel-"))
  const marker = join(directory, "pid")
  const controller = new AbortController()
  const runningCommand = runInTerminal(
    {
      id: "cancel",
      command: "sh",
      args: [
        "-c",
        'trap "" HUP TERM; printf "%s\\n" "$$" >"$1"; while :; do sleep 1; done',
        "sh",
        marker,
      ],
      cwd: process.cwd(),
      title: "Cancellation test",
      timeoutMs: 60_000,
    },
    direct,
    60_000,
    controller.signal,
  )

  try {
    let pid = 0
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        pid = Number((await readFile(marker, "utf8")).trim())
        if (pid > 1) break
      } catch {
        // Wait for the command to start.
      }
      await delay(50)
    }
    assert.ok(pid > 1, "inner command did not start")

    controller.abort()
    const result = await runningCommand
    assert.equal(result.error, "Cancelled by OpenCode.")

    let alive = true
    try {
      process.kill(pid, 0)
      const info = readFileSync(`/proc/${pid}/stat`, "utf8")
      alive = !info.slice(info.lastIndexOf(")") + 2).startsWith("Z")
    } catch {
      alive = false
    }
    assert.equal(alive, false, `inner command ${pid} survived cancellation`)
  } finally {
    controller.abort()
    await runningCommand
    await rm(directory, { recursive: true, force: true })
  }
})
