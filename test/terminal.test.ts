import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

import { capOutput, runInTerminal } from "../src/terminal.ts"

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

async function startedPid(marker: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pid = Number((await readFile(marker, "utf8")).trim())
      if (pid > 1) return pid
    } catch {
      // Wait for the command to start.
    }
    await delay(50)
  }
  throw new Error("Inner command did not start")
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    const info = readFileSync(`/proc/${pid}/stat`, "utf8")
    return !info.slice(info.lastIndexOf(")") + 2).startsWith("Z")
  } catch {
    return false
  }
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

test("collector preserves byte order around the head/tail threshold", async () => {
  const expected = Array.from({ length: 6_000 }, (_, index) => index % 10).join("")
  const result = await runInTerminal(
    {
      id: "ordered-output",
      command: "node",
      args: [
        "-e",
        "process.stdout.write(Array.from({ length: 6000 }, (_, i) => i % 10).join(''))",
      ],
      cwd: process.cwd(),
      title: "Ordered output",
      timeoutMs: 60_000,
    },
    direct,
    2_000,
  )
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, capOutput(expected, 2_000).text)
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
    const pid = await startedPid(marker)
    controller.abort()
    const result = await runningCommand
    assert.equal(result.error, "Cancelled by OpenCode.")
    assert.equal(processRunning(pid), false, `inner command ${pid} survived cancellation`)
  } finally {
    controller.abort()
    await runningCommand
    await rm(directory, { recursive: true, force: true })
  }
})

test("cancellation kills a resistant child after its group leader exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "interactive-terminal-group-"))
  const marker = join(directory, "pid")
  const controller = new AbortController()
  const runningCommand = runInTerminal(
    {
      id: "cancel-group",
      command: "sh",
      args: [
        "-c",
        'sh -c "$1" & child=$!; printf "%s\\n" "$child" >"$2"; wait "$child"',
        "sh",
        'trap "" HUP TERM; while :; do sleep 1; done',
        marker,
      ],
      cwd: process.cwd(),
      title: "Group cancellation test",
      timeoutMs: 60_000,
    },
    direct,
    60_000,
    controller.signal,
  )

  try {
    const pid = await startedPid(marker)
    controller.abort()
    const result = await runningCommand
    assert.equal(result.error, "Cancelled by OpenCode.")
    assert.equal(processRunning(pid), false, `child process ${pid} survived cancellation`)
  } finally {
    controller.abort()
    await runningCommand
    await rm(directory, { recursive: true, force: true })
  }
})
