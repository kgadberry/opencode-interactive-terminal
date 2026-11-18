import { randomUUID } from "node:crypto"
import { isAbsolute, resolve } from "node:path"

import { Plugin } from "@opencode/plugin"

import { InteractiveTerminal } from "./rpc.js"
import type { TerminalRequest, TerminalResult } from "./rpc.js"

interface ToolInput {
  command: string
  args?: string[]
  cwd?: string
  timeout?: number
}

interface Pending {
  id: string
  client?: string
  timeoutMs: number
  startTimer: NodeJS.Timeout
  timeoutTimer?: NodeJS.Timeout
  signal: AbortSignal
  onAbort?: () => void
  resolve: (result: TerminalResult) => void
  reject: (error: Error) => void
}

function numberOption(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`
}

export function displayCommand(command: string, args: string[] = []): string {
  return [command, ...args].map(quote).join(" ")
}

export default Plugin.define({
  id: "interactive-terminal",
  async setup(ctx) {
    const requests = new Map<string, Pending>()
    const defaultTimeout = numberOption(ctx.options.timeout, 1_800, 1, 86_400)
    const startTimeout = numberOption(ctx.options.startTimeout, 15, 1, 300)

    const registration = await ctx.rpc.register(InteractiveTerminal, {
      claim: async (input) => {
        const { id, client } = input as { id: string; client: string }
        const pending = requests.get(id)
        if (!pending || pending.client) return { claimed: false }

        pending.client = client
        clearTimeout(pending.startTimer)
        pending.timeoutTimer = setTimeout(() => {
          fail(pending, `Interactive terminal command timed out after ${pending.timeoutMs / 1000} seconds.`)
        }, pending.timeoutMs)
        return { claimed: true }
      },
      complete: async (input) => {
        const value = input as TerminalResult & { id: string; client: string }
        const pending = requests.get(value.id)
        if (!pending || pending.client !== value.client) return { accepted: false }

        cleanup(pending)
        requests.delete(pending.id)
        pending.resolve({
          output: value.output,
          exitCode: value.exitCode,
          durationMs: value.durationMs,
          truncated: value.truncated,
          error: value.error,
        })
        return { accepted: true }
      },
    })

    function cleanup(pending: Pending): void {
      clearTimeout(pending.startTimer)
      if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer)
      if (pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort)
    }

    function fail(pending: Pending, message: string): void {
      if (requests.get(pending.id) !== pending) return
      cleanup(pending)
      requests.delete(pending.id)
      void registration.events.emit("cancelled", { id: pending.id }).catch(() => {})
      pending.reject(new Error(message))
    }

    async function waitForTerminal(
      request: TerminalRequest,
      timeoutMs: number,
      signal: AbortSignal,
    ): Promise<TerminalResult> {
      let pending!: Pending
      const result = new Promise<TerminalResult>((resolveResult, rejectResult) => {
        pending = {
          id: request.id,
          timeoutMs,
          startTimer: setTimeout(() => {
            fail(
              pending,
              "No OpenCode TUI opened the interactive terminal. Start OpenCode's terminal interface and try again.",
            )
          }, startTimeout * 1000),
          signal,
          resolve: resolveResult,
          reject: rejectResult,
        }
        pending.onAbort = () => fail(pending, "Interactive terminal command cancelled.")
        requests.set(request.id, pending)
        if (signal.aborted) pending.onAbort()
        else signal.addEventListener("abort", pending.onAbort, { once: true })
      })

      if (requests.has(request.id)) {
        try {
          await registration.events.emit("requested", { ...request })
        } catch (error) {
          fail(pending, `Could not request an interactive terminal: ${String(error)}`)
        }
      }
      return result
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "interactive_terminal",
        description:
          "Run an executable with an argument array in a floating terminal on the user's machine. Use this for sudo, password prompts, MFA, interactive installers, and full-screen terminal programs. The user types input directly; never put passwords or other secrets in command or args. The tool waits for the command to exit, then returns its captured stdout/stderr and exit code. No shell is implied: use sh -lc explicitly only when shell syntax is needed.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", minLength: 1, description: "Executable to run." },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Literal arguments; no shell expansion is performed.",
            },
            cwd: {
              type: "string",
              description: "Working directory on the user's machine. Defaults to the project directory.",
            },
            timeout: {
              type: "number",
              exclusiveMinimum: 0,
              maximum: 86_400,
              description: `Command timeout in seconds after the terminal opens (default ${defaultTimeout}).`,
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as ToolInput
          const args = input.args ?? []
          const rendered = displayCommand(input.command, args)
          const cwd = isAbsolute(input.cwd ?? "")
            ? input.cwd!
            : resolve(ctx.location.directory, input.cwd ?? ".")

          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: {
              type: "tool",
              messageID: context.messageID,
              id: context.id,
            },
            action: "shell",
            resources: [rendered],
            save: [rendered],
            metadata: { interactive: true, cwd },
          })

          await context.progress({ status: "waiting for the interactive terminal" })
          const timeout = numberOption(input.timeout, defaultTimeout, 1, 86_400)
          const result = await waitForTerminal(
            {
              id: randomUUID(),
              command: input.command,
              args,
              cwd,
              title: `OpenCode: ${input.command}`,
            },
            timeout * 1000,
            context.signal,
          )
          await context.progress({ status: "interactive terminal closed" })

          const lines = [
            `Command: ${rendered}`,
            `Working directory: ${cwd}`,
            result.exitCode === null ? "Exit code: unknown" : `Exit code: ${result.exitCode}`,
            `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
          ]
          if (result.error) lines.push(`Terminal error: ${result.error}`)
          if (result.truncated) lines.push("Output was truncated to the configured limit.")
          lines.push("", "Output:", result.output || "(no captured output)")
          return { content: lines.join("\n") }
        },
      })
    })

    return () => {
      for (const pending of requests.values()) {
        cleanup(pending)
        pending.reject(new Error("Interactive terminal plugin unloaded."))
      }
      requests.clear()
    }
  },
})
