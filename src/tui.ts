import { randomUUID } from "node:crypto"

import { Plugin } from "@opencode/plugin/tui"

import { InteractiveTerminal } from "./rpc.js"
import type { TerminalRequest } from "./rpc.js"
import { resolveTerminal, runInTerminal } from "./terminal.js"

function outputLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 60_000
  return Math.min(1_000_000, Math.max(1_000, Math.floor(value)))
}

export default Plugin.define({
  id: "interactive-terminal.tui",
  setup(context) {
    const terminal = resolveTerminal(context.options)
    const maxOutputChars = outputLimit(context.options.maxOutputChars)
    const client = randomUUID()
    const rpc = context.client.rpc(InteractiveTerminal)
    const active = new Map<string, AbortController>()

    const sameLocation = (eventLocation: { directory: string }): boolean => {
      const location = context.location ?? context.data.location.default()
      return !location || location.directory === eventLocation.directory
    }

    async function run(request: TerminalRequest): Promise<void> {
      if (active.has(request.id)) return
      const claim = (await rpc.claim({ id: request.id, client })) as { claimed: boolean }
      if (!claim.claimed) return

      const controller = new AbortController()
      active.set(request.id, controller)
      context.ui.toast.show({
        title: "Interactive terminal",
        message: "Complete the command in the floating terminal. Output returns to the agent when it exits.",
        variant: "info",
        duration: 4000,
      })

      try {
        const result = await runInTerminal(request, terminal, maxOutputChars, controller.signal)
        const completion = (await rpc.complete({ id: request.id, client, ...result })) as {
          accepted: boolean
        }
        if (completion.accepted) {
          context.ui.toast.show({
            title: "Interactive terminal",
            message: result.error
              ? result.error
              : `Command finished with exit code ${result.exitCode ?? "unknown"}.`,
            variant: result.error || result.exitCode !== 0 ? "warning" : "success",
            duration: 3000,
          })
        }
      } catch (error) {
        context.ui.toast.show({
          title: "Interactive terminal failed",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
          duration: 5000,
        })
        try {
          await rpc.complete({
            id: request.id,
            client,
            output: "",
            exitCode: null,
            durationMs: 0,
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          })
        } catch {
          // The server may have unloaded the request while the terminal was closing.
        }
      } finally {
        active.delete(request.id)
      }
    }

    const stopRequested = rpc.events.on("requested", (event) => {
      if (!sameLocation(event.location)) return
      void run(event.data as unknown as TerminalRequest).catch((error) => {
        context.ui.toast.show({
          title: "Interactive terminal failed",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
          duration: 5000,
        })
      })
    })
    const stopCancelled = rpc.events.on("cancelled", (event) => {
      active.get((event.data as { id: string }).id)?.abort()
    })

    return () => {
      stopRequested()
      stopCancelled()
      for (const controller of active.values()) controller.abort()
      active.clear()
    }
  },
})
