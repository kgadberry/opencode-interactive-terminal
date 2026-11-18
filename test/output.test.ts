import assert from "node:assert/strict"
import test from "node:test"

import { capOutput, cleanOutput, resolveTerminal } from "../src/terminal.ts"

test("cleanOutput removes terminal control sequences and normalizes carriage returns", () => {
  const raw = "\u001b]0;secret title\u0007\u001b[31mred\u001b[0m\r\nnext\rprogress\u0000"
  assert.equal(cleanOutput(raw), "red\nnext\nprogress")
})

test("cleanOutput removes util-linux script metadata", () => {
  const raw =
    'Script started on 2026-11-18 [COMMAND="sh "$COMMAND_SCRIPT""]\nhello\r\n\nScript done on 2026-11-18 [COMMAND_EXIT_CODE="0"]\n'
  assert.equal(cleanOutput(raw), "hello\n")
})

test("capOutput preserves the beginning and end of large output", () => {
  const input = "a".repeat(2_000) + "b".repeat(2_000)
  const result = capOutput(input, 1_000)
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 1_000)
  assert.ok(result.text.startsWith("a".repeat(100)))
  assert.ok(result.text.endsWith("b".repeat(100)))
  assert.match(result.text, /characters omitted/)
})

test("capOutput leaves small output unchanged", () => {
  assert.deepEqual(capOutput("hello\n", 1_000), { text: "hello\n", truncated: false })
})

test("resolveTerminal uses the Kitty preset from TERMINAL", () => {
  assert.deepEqual(resolveTerminal({}, { TERMINAL: "kitty" }), {
    command: "kitty",
    args: ["--class", "opencode-interactive-terminal", "--title", "{title}"],
  })
})

test("resolveTerminal accepts an explicit terminal command", () => {
  const terminal = { command: "wezterm", args: ["start", "--"] }
  assert.deepEqual(resolveTerminal({ terminal }), terminal)
})
