import { Rpc } from "@opencode/plugin/rpc"

export const InteractiveTerminal = Rpc.define({
  id: "interactive-terminal",
  methods: {
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
  events: {
    requested: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          title: { type: "string" },
        },
        required: ["id", "command", "args", "cwd", "title"],
        additionalProperties: false,
      },
    },
    cancelled: {
      schema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
})

export interface TerminalRequest {
  id: string
  command: string
  args: string[]
  cwd: string
  title: string
}

export interface TerminalResult {
  output: string
  exitCode: number | null
  durationMs: number
  truncated: boolean
  error?: string
}
