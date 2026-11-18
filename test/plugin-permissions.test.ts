import assert from "node:assert/strict"
import { realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import test from "node:test"

import plugin from "../src/index.ts"

type Permission = { action: string; resources: string[] }
type TerminalTool = {
  execute: (
    input: { command: string; args: string[]; cwd?: string },
    context: {
      id: string
      messageID: string
      sessionID: string
      signal: AbortSignal
      progress: () => void
    },
  ) => Promise<unknown>
}
type FixtureRpc = { pending: () => Promise<{ requests: unknown[] }> }

test("permission denial never queues a floating terminal request", async (t) => {
  const directory = await realpath(process.cwd())
  const outside = dirname(directory)
  for (const deny of ["external_directory", "shell"]) {
    await t.test(deny, async () => {
      const assertions: Permission[] = []
      let rpc: FixtureRpc | undefined
      let tool: TerminalTool | undefined
      const denied = new Error("fixture permission denied")
      const ctx = {
        options: {},
        location: { directory, project: { canonical: directory } },
        rpc: { register: (_definition: unknown, impl: FixtureRpc) => { rpc = impl } },
        tool: {
          transform: (register: (editor: { add: (value: TerminalTool) => void }) => void) => {
            register({ add: (value) => { tool = value } })
          },
        },
        permission: {
          assert: async (permission: Permission) => {
            assertions.push(permission)
            if (permission.action === deny) throw denied
          },
        },
      }
      // Only the public context methods used by setup and execute are mocked.
      const cleanup = await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0])
      try {
        assert.ok(tool && rpc)
        await assert.rejects(tool.execute({
          command: "sh",
          args: ["-lc", "printf smoke"],
          ...(deny === "external_directory" ? { cwd: outside } : {}),
        }, {
          id: "tool",
          messageID: "message",
          sessionID: "session",
          signal: new AbortController().signal,
          progress: () => assert.fail("a denied command must not reach terminal dispatch"),
        }), denied)
        assert.deepEqual(assertions.map(({ action }) => action), [deny])
        if (deny === "external_directory") {
          assert.deepEqual(assertions[0].resources, [join(outside, "*")])
        } else {
          assert.ok(assertions[0].resources.includes("printf smoke"))
        }
        assert.deepEqual((await rpc.pending()).requests, [])
      } finally {
        cleanup?.()
      }
    })
  }
})
