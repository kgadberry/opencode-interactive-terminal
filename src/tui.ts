import { randomUUID } from "node:crypto"

import { Plugin } from "@opencode/plugin/tui"

import { InteractiveTerminal } from "./rpc.js"
import type { PendingTerminalRequest, TerminalRequest, TerminalResult } from "./rpc.js"
import { resolveTerminal, runInTerminal } from "./terminal.js"

interface ActiveRequest {
  controller: AbortController
  claimed: boolean
  timeout?: NodeJS.Timeout
}

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
    const active = new Map<string, ActiveRequest>()
    let stopping = false
    let reconciling = false

    // The generated client changes after a server restart; resolve it at call time.
    const rpc = () => context.client.rpc(InteractiveTerminal)

    function showError(error: unknown): void {
      if (stopping) return
      context.ui.toast.show({
        title: "Interactive terminal failed",
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
        duration: 5000,
      })
    }

    async function complete(id: string, result: TerminalResult): Promise<boolean> {
      const response = (await rpc().complete({ id, client, ...result })) as { accepted: boolean }
      return response.accepted
    }

    async function run(request: TerminalRequest): Promise<void> {
      if (active.has(request.id)) return
      const state: ActiveRequest = { controller: new AbortController(), claimed: false }
      active.set(request.id, state)

      try {
        const claim = (await rpc().claim({ id: request.id, client })) as { claimed: boolean }
        if (!claim.claimed) return
        state.claimed = true
        if (stopping || state.controller.signal.aborted) {
          await complete(request.id, {
            output: "",
            exitCode: null,
            durationMs: 0,
            truncated: false,
            error: "Cancelled before the terminal was opened.",
          }).catch(() => false)
          return
        }

        // Do not depend on a server cancellation event arriving after a disconnect.
        state.timeout = setTimeout(() => state.controller.abort(), request.timeoutMs)
        context.ui.toast.show({
          title: "Interactive terminal",
          message:
            "Complete the command in the floating terminal. Output returns to the agent when it exits.",
          variant: "info",
          duration: 4000,
        })

        const result = await runInTerminal(
          request,
          terminal,
          maxOutputChars,
          state.controller.signal,
        )
        const accepted = await complete(request.id, result)
        if (accepted) {
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
        if (state.claimed) {
          await complete(request.id, {
            output: "",
            exitCode: null,
            durationMs: 0,
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => false)
        }
        if (!state.controller.signal.aborted) showError(error)
      } finally {
        if (state.timeout) clearTimeout(state.timeout)
        active.delete(request.id)
      }
    }

    async function reconcile(): Promise<void> {
      if (stopping || reconciling) return
      reconciling = true
      try {
        const response = (await rpc().pending({})) as { requests: PendingTerminalRequest[] }
        const present = new Set(response.requests.map((request) => request.id))
        for (const request of response.requests) {
          if (!request.claimed && !active.has(request.id)) void run(request)
        }
        for (const [id, state] of active) {
          if (!present.has(id)) state.controller.abort()
        }
      } catch {
        // Keep running commands during a disconnect; local deadlines still apply.
      } finally {
        reconciling = false
      }
    }

    void reconcile()
    const polling = setInterval(() => void reconcile(), 1_000)

    return () => {
      stopping = true
      clearInterval(polling)
      for (const state of active.values()) state.controller.abort()
      active.clear()
    }
  },
})
