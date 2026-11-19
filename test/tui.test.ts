import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"

import plugin from "../src/tui.ts"

test("TUI retries the original completed result in its project after a tab change", async () => {
  const request = {
    id: "retry-request",
    command: "printf",
    args: ["retry-ok"],
    cwd: process.cwd(),
    title: "Retry test",
    timeoutMs: 60_000,
    claimed: false,
  }
  const location = { directory: process.cwd() }
  const otherLocation = { directory: `${process.cwd()}/another-project` }
  type RpcOptions = { location: typeof location }
  let selected: typeof location | undefined
  const polled = new Set<string>()
  let attempts = 0
  let received: { output: string; exitCode: number | null; error?: string } | undefined
  const rpc = {
    pending: async (_: unknown, options: RpcOptions) => {
      polled.add(options.location.directory)
      return { requests: options.location.directory === location.directory ? [request] : [] }
    },
    claim: async (_: unknown, options: RpcOptions) => {
      assert.deepEqual(options.location, location)
      request.claimed = true
      return { claimed: true }
    },
    complete: async (result: typeof received, options: RpcOptions) => {
      assert.deepEqual(options.location, location)
      attempts++
      selected = otherLocation
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
    get location() { return selected },
    data: { location: { default: () => location } },
    ui: { toast: { show: () => {} } },
  }

  const cleanup = plugin.setup(context as never)
  try {
    for (let attempt = 0; attempt < 100 && !received; attempt++) await delay(50)
    assert.ok(received, "completed result was not delivered")
    assert.ok(attempts >= 3)
    assert.deepEqual(polled, new Set([location.directory, otherLocation.directory]))
    assert.equal(received.output, "retry-ok")
    assert.equal(received.exitCode, 0)
    assert.equal(received.error, undefined)
  } finally {
    if (typeof cleanup === "function") await cleanup()
  }
})
