import { Rpc } from "@opencode/plugin/rpc"

const requestProperties = {
  id: { type: "string" },
  command: { type: "string" },
  args: { type: "array", items: { type: "string" } },
  cwd: { type: "string" },
  title: { type: "string" },
  timeoutMs: { type: "integer", minimum: 1 },
} as const

const requestRequired = ["id", "command", "args", "cwd", "title", "timeoutMs"] as const

export const InteractiveTerminal = Rpc.define({
  id: "interactive-terminal",
  methods: {
    pending: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          requests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ...requestProperties,
                claimed: { type: "boolean" },
              },
              required: [...requestRequired, "claimed"],
              additionalProperties: false,
            },
          },
        },
        required: ["requests"],
        additionalProperties: false,
      },
    },
    claim: {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          client: { type: "string" },
        },
        required: ["id", "client"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { claimed: { type: "boolean" } },
        required: ["claimed"],
        additionalProperties: false,
      },
    },
    complete: {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          client: { type: "string" },
          output: { type: "string" },
          exitCode: { type: ["integer", "null"] },
          durationMs: { type: "integer", minimum: 0 },
          truncated: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["id", "client", "output", "exitCode", "durationMs", "truncated"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { accepted: { type: "boolean" } },
        required: ["accepted"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

export interface TerminalRequest {
  id: string
  command: string
  args: string[]
  cwd: string
  title: string
  timeoutMs: number
}

export interface PendingTerminalRequest extends TerminalRequest {
  claimed: boolean
}

export interface TerminalResult {
  output: string
  exitCode: number | null
  durationMs: number
  truncated: boolean
  error?: string
}
