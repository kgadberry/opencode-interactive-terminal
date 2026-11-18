import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"

import plugin from "../src/tui.ts"

test("TUI retries the original completed result after transient RPC failures", async () => {
  const request = {
    id: "retry-request",
    command: "printf",
    args: ["retry-ok"],
    cwd: process.cwd(),
    title: "Retry test",
    timeoutMs: 60_000,
    claimed: false,
  }
  let attempts = 0
  let received: { output: string; exitCode: number | null; error?: string } | undefined
  const rpc = {
    pending: async () => ({ requests: [request] }),
    claim: async () => {
      request.claimed = true
      return { claimed: true }
    },
    complete: async (result: typeof received) => {
      attempts++
      if (attempts < 3) throw new Error("temporary disconnect")
      received = result
      return { accepted: true }
    },
  }
  const context = {
    options: {
      terminal: { command: "sh", args: ["-c", 'exec "$@"', "test"] },
      maxOutputChars: 60_000,
    },
    client: { rpc: () => rpc },
    ui: { toast: { show: () => {} } },
  }

  const cleanup = plugin.setup(context as never)
  try {
    for (let attempt = 0; attempt < 100 && !received; attempt++) await delay(50)
    assert.ok(received, "completed result was not delivered")
    assert.ok(attempts >= 3)
    assert.equal(received.output, "retry-ok")
    assert.equal(received.exitCode, 0)
    assert.equal(received.error, undefined)
  } finally {
    if (typeof cleanup === "function") await cleanup()
  }
})
