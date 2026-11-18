import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import type { TerminalRequest, TerminalResult } from "./rpc.ts"

export interface TerminalSpec {
  command: string
  args: string[]
}

const runner = fileURLToPath(new URL("./runner.sh", import.meta.url))
const collector = fileURLToPath(new URL("./collector.ts", import.meta.url))

const presets: Record<string, string[]> = {
  kitty: ["--class", "opencode-interactive-terminal", "--title", "{title}"],
  ghostty: ["--class=opencode-interactive-terminal", "--title={title}", "-e"],
  wezterm: ["start", "--always-new-process", "--"],
  alacritty: ["--class", "opencode-interactive-terminal", "--title", "{title}", "-e"],
  foot: ["--app-id", "opencode-interactive-terminal", "--title", "{title}", "--"],
  xterm: ["-class", "opencode-interactive-terminal", "-title", "{title}", "-e"],
}

function configuredTerminal(value: unknown): TerminalSpec | undefined {
  if (value === undefined) return
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The terminal option must be an object with command and args fields.")
  }
  const candidate = value as { command?: unknown; args?: unknown }
  if (typeof candidate.command !== "string" || candidate.command.length === 0) {
    throw new Error("The terminal.command option must be a non-empty string.")
  }
  if (
    candidate.args !== undefined &&
    (!Array.isArray(candidate.args) || candidate.args.some((arg) => typeof arg !== "string"))
  ) {
    throw new Error("The terminal.args option must be an array of strings.")
  }
  return { command: candidate.command, args: candidate.args ?? [] }
}

export function resolveTerminal(options: unknown, env: NodeJS.ProcessEnv = process.env): TerminalSpec {
  const configured = configuredTerminal(
    typeof options === "object" && options !== null
      ? (options as { terminal?: unknown }).terminal
      : undefined,
  )
  if (configured) return configured

  const selected = env.TERMINAL || env.TERM_PROGRAM || "kitty"
  const name = basename(selected).toLowerCase().replace(/\.exe$/, "")
  const known = Object.keys(presets).find((candidate) => name.includes(candidate))
  return {
    command: known ?? selected,
    args: known ? [...presets[known]] : ["-e"],
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function removeScriptMetadata(raw: string): string {
  let text = raw
  if (text.startsWith("Script started on ")) {
    const end = text.indexOf("\n")
    text = end === -1 ? "" : text.slice(end + 1)
  }

  const footer = text.lastIndexOf("\nScript done on ")
  if (footer !== -1 && /^\nScript done on [^\n]*\n?$/.test(text.slice(footer))) {
    text = text.slice(0, footer)
  }
  return text
}

export function cleanOutput(raw: string): string {
  let text = removeScriptMetadata(raw)
    // OSC sequences set titles and clipboard contents; they are not command output text.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // CSI sequences control cursor movement, colour, erasing, and other terminal state.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")

  let plain = ""
  for (const character of text) {
    if (character === "\b") plain = plain.slice(0, -1)
    else plain += character
  }

  return plain.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
}

export function capOutput(
  text: string,
  maximum: number,
): { text: string; truncated: boolean } {
  if (text.length <= maximum) return { text, truncated: false }

  const marker = "\n\n[... characters omitted ...]\n\n"
  const available = maximum - marker.length
  if (available < 2) return { text: text.slice(-maximum), truncated: true }

  const headLength = Math.floor(available / 4)
  const tailLength = available - headLength
  return {
    text: `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`,
    truncated: true,
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // The process has already exited.
    }
  }
}

function signalLauncher(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) signalGroup(child.pid, signal)
}

function commandPid(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, "utf8").trim())
    return Number.isInteger(value) && value > 1 ? value : undefined
  } catch {
    return
  }
}

function groupRunning(pgid: number): boolean {
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const info = readFileSync(`/proc/${entry}/stat`, "utf8")
        const fields = info.slice(info.lastIndexOf(")") + 2).split(" ")
        if (Number(fields[2]) === pgid && fields[0] !== "Z") return true
      } catch {
        // Processes can exit while /proc is being inspected.
      }
    }
    return false
  } catch {
    try {
      process.kill(-pgid, 0)
      return true
    } catch {
      return false
    }
  }
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (groupRunning(pgid)) {
    if (Date.now() >= deadline) return false
    await delay(50)
  }
  return true
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      await stat(path)
      return
    } catch {
      if (Date.now() >= deadline) return
      await delay(50)
    }
  }
}

export async function runInTerminal(
  request: TerminalRequest,
  terminal: TerminalSpec,
  maxOutputChars: number,
  signal?: AbortSignal,
): Promise<TerminalResult> {
  const started = Date.now()
  if (signal?.aborted) {
    return {
      output: "",
      exitCode: null,
      durationMs: 0,
      truncated: false,
      error: "Cancelled before the terminal was opened.",
    }
  }

  const directory = await mkdtemp(join(tmpdir(), "opencode-interactive-terminal-"))
  const outputPath = join(directory, "output.log")
  const statusPath = join(directory, "status")
  const commandPath = join(directory, "command.sh")
  const commandPidPath = join(directory, "command.pid")
  let child: ChildProcess | undefined
  let forceKill: NodeJS.Timeout | undefined
  let cancel: (() => void) | undefined
  let cancelled = false

  const signalCommand = (signal: NodeJS.Signals) => {
    const pid = commandPid(commandPidPath)
    if (pid) signalGroup(pid, signal)
  }

  try {
    const command = [request.command, ...request.args].map(shellQuote).join(" ")
    await writeFile(
      commandPath,
      `#!/bin/sh\nset -e\nprintf '%s\\n' "$$" >"$COMMAND_PID_FILE"\nexec ${command}\n`,
      { mode: 0o600 },
    )

    const terminalArgs = terminal.args.map((arg) => arg.replaceAll("{title}", request.title))
    const captureLimit = Math.max(4_096, maxOutputChars * 4)
    const args = [
      ...terminalArgs,
      "sh",
      runner,
      outputPath,
      statusPath,
      request.cwd,
      commandPath,
      commandPidPath,
      collector,
      String(captureLimit),
    ]

    child = spawn(terminal.command, args, {
      detached: process.platform !== "win32",
      stdio: "ignore",
    })

    cancel = () => {
      if (cancelled) return
      cancelled = true
      signalCommand("SIGTERM")
      signalLauncher(child!, "SIGTERM")
      forceKill = setTimeout(() => {
        signalCommand("SIGKILL")
        signalLauncher(child!, "SIGKILL")
      }, 5_000)
      forceKill.unref()
    }
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()

    const outcome = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
      error?: Error
    }>((resolve) => {
      let settled = false
      child!.once("error", (error) => {
        if (settled) return
        settled = true
        resolve({ code: null, signal: null, error })
      })
      child!.once("close", (code, childSignal) => {
        if (settled) return
        settled = true
        resolve({ code, signal: childSignal })
      })
    })
    signal?.removeEventListener("abort", cancel)

    const initialStatus = await readIfPresent(statusPath)
    const pid = commandPid(commandPidPath)
    if (pid && (cancelled || !initialStatus)) {
      // A closed launcher or dead group leader does not prove the group is empty.
      signalGroup(pid, "SIGTERM")
      if (!(await waitForGroupExit(pid, 5_000))) {
        signalGroup(pid, "SIGKILL")
        await waitForGroupExit(pid, 5_000)
      }
    }
    if (!initialStatus) await waitForFile(outputPath, 1_000)

    const [rawOutput, rawStatus, captureTruncated] = await Promise.all([
      readIfPresent(outputPath),
      readIfPresent(statusPath),
      readIfPresent(`${outputPath}.truncated`),
    ])
    const captured = capOutput(cleanOutput(rawOutput), maxOutputChars)
    const status = rawStatus.trim()
    const exitCode = /^\d{1,3}$/.test(status) ? Number(status) : null

    let error: string | undefined
    if (outcome.error) error = `Could not open the terminal: ${outcome.error.message}`
    else if (cancelled) error = "Cancelled by OpenCode."
    else if (exitCode === null) {
      const reason = outcome.signal
        ? `signal ${outcome.signal}`
        : `exit code ${outcome.code ?? "unknown"}`
      error = `The terminal closed without a command status (${reason}).`
    }

    return {
      output: captured.text,
      exitCode,
      durationMs: Date.now() - started,
      truncated: captured.truncated || captureTruncated.length > 0,
      error,
    }
  } catch (error) {
    signalCommand("SIGKILL")
    if (child) signalLauncher(child, "SIGTERM")
    return {
      output: "",
      exitCode: null,
      durationMs: Date.now() - started,
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (forceKill) clearTimeout(forceKill)
    if (signal && cancel) signal.removeEventListener("abort", cancel)
    await rm(directory, { recursive: true, force: true })
  }
}
