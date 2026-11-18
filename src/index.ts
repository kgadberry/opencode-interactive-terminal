import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

import { Plugin } from "@opencode/plugin"

import { displayCommand, scanPermissions } from "./permissions.ts"
import { InteractiveTerminal } from "./rpc.ts"
import type { TerminalRequest, TerminalResult } from "./rpc.ts"

interface ToolInput {
  command: string
  args?: string[]
  cwd?: string
  timeout?: number
}

interface Pending {
  request: TerminalRequest
  client?: string
  startTimer: NodeJS.Timeout
  timeoutTimer?: NodeJS.Timeout
  signal: AbortSignal
  onAbort?: () => void
  resolve: (result: TerminalResult) => void
  reject: (error: Error) => void
}

function numberOption(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.ceil(value)))
}

export default Plugin.define({
  id: "interactive-terminal",
  async setup(ctx) {
    const requests = new Map<string, Pending>()
    const defaultTimeout = numberOption(ctx.options.timeout, 1_800, 1, 86_400)
    const startTimeout = numberOption(ctx.options.startTimeout, 15, 1, 300)

    await ctx.rpc.register(InteractiveTerminal, {
      pending: async () => ({
        requests: [...requests.values()].map((pending) => ({
          ...pending.request,
          claimed: pending.client !== undefined,
        })),
      }),
      claim: async (input) => {
        const { id, client } = input as { id: string; client: string }
        const pending = requests.get(id)
        if (!pending || pending.client) return { claimed: false }

        pending.client = client
        clearTimeout(pending.startTimer)
        pending.timeoutTimer = setTimeout(() => {
          fail(
            pending,
            `Interactive terminal command timed out after ${pending.request.timeoutMs / 1000} seconds.`,
          )
        }, pending.request.timeoutMs)
        return { claimed: true }
      },
      complete: async (input) => {
        const value = input as TerminalResult & { id: string; client: string }
        const pending = requests.get(value.id)
        if (!pending || pending.client !== value.client) return { accepted: false }

        cleanup(pending)
        requests.delete(pending.request.id)
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
      if (requests.get(pending.request.id) !== pending) return
      cleanup(pending)
      requests.delete(pending.request.id)
      pending.reject(new Error(message))
    }

    function waitForTerminal(
      request: TerminalRequest,
      signal: AbortSignal,
    ): Promise<TerminalResult> {
      let pending!: Pending
      return new Promise<TerminalResult>((resolveResult, rejectResult) => {
        pending = {
          request,
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
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "interactive_terminal",
        description:
          "Run an executable with an argument array in a floating terminal on the user's machine. Use this for sudo, password prompts, MFA, interactive installers, and full-screen terminal programs. The user types input directly; never put passwords or other secrets in command or args. The tool waits for the command to exit, then returns captured terminal output and its exit code. Password prompts normally disable echo, but echoed input and any secrets printed by the command are included in the output. No shell is implied: use sh -lc explicitly only when shell syntax is needed.",
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
          const requestedCwd = resolve(ctx.location.directory, input.cwd ?? ".")
          const scanned = await scanPermissions(rendered, requestedCwd, [
            ctx.location.directory,
            ctx.location.project.canonical,
          ])
          if (scanned.commands.length === 0) {
            throw new Error("OpenCode's shell scanner did not produce a command to authorize.")
          }
          const source = {
            type: "tool" as const,
            messageID: context.messageID,
            id: context.id,
          }

          if (scanned.externalDirectories.length > 0) {
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              source,
              action: "external_directory",
              resources: scanned.externalDirectories,
              metadata: { interactive: true, cwd: scanned.cwd },
            })
          }
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source,
            action: "shell",
            resources: scanned.commands,
            metadata: { interactive: true, cwd: scanned.cwd },
          })

          await context.progress({ status: "waiting for the interactive terminal" })
          const timeout = numberOption(input.timeout, defaultTimeout, 1, 86_400)
          const result = await waitForTerminal(
            {
              id: randomUUID(),
              command: input.command,
              args,
              cwd: scanned.cwd,
              title: `OpenCode: ${input.command}`,
              timeoutMs: timeout * 1000,
            },
            context.signal,
          )
          await context.progress({ status: "interactive terminal closed" })

          const lines = [
            `Command: ${rendered}`,
            `Working directory: ${scanned.cwd}`,
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
      for (const pending of [...requests.values()]) {
        fail(pending, "Interactive terminal plugin unloaded.")
      }
    }
  },
})
