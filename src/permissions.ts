import { realpath } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

import { ShellParse } from "@opencode/core/shell/parse"
import { ShellScan } from "@opencode/core/shell/scan"
import { Effect } from "effect"

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`
}

export function displayCommand(command: string, args: string[] = []): string {
  return [command, ...args].map(quote).join(" ")
}

export interface PermissionScan {
  cwd: string
  commands: string[]
  externalDirectories: string[]
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return resolve(path)
    }
    throw error
  }
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

interface ParsedCommands {
  commands: string[]
  directories: string[]
}

type Dialect = "bash" | "zsh" | "posix"

interface EmbeddedScript {
  text: string
  shell: string
}

function dialect(shell: string): Dialect {
  const name = basename(shell)
  return name === "bash" || name === "zsh" ? name : "posix"
}

function embeddedScripts(command: string, shell: string): EmbeddedScript[] {
  const scanned = ShellScan.scan(command, dialect(shell))
  if (scanned.kind === "opaque") {
    throw new Error(`OpenCode's shell scanner cannot analyze command: ${scanned.reason}`)
  }

  return scanned.commands.flatMap((item) => {
    const words = item.words
    const executable = words[0] ?? ""
    if (!["sh", "bash", "zsh"].includes(basename(executable))) return []
    for (let index = 1; index < words.length - 1; index++) {
      const word = words[index]
      if (word === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
        return [{ text: words[index + 1], shell: executable }]
      }
      if (["-O", "+O", "-o", "--init-file", "--rcfile"].includes(word)) {
        index++
        continue
      }
      if (word === "--") break
      if (!word.startsWith("-") && !word.startsWith("+")) break
    }
    return []
  })
}

async function scanCommands(
  command: string,
  cwd: string,
  shell = "sh",
  depth = 0,
): Promise<ParsedCommands> {
  if (depth > 10) throw new Error("Embedded shell command nesting exceeds the scanner limit.")
  const parsed = await Effect.runPromise(ShellParse.scanPortable(command, shell, cwd))
  const nested = await Promise.all(
    embeddedScripts(command, shell).map((script) =>
      scanCommands(script.text, cwd, script.shell, depth + 1),
    ),
  )
  return {
    commands: [...parsed.commands.map((item) => item.resource), ...nested.flatMap((item) => item.commands)],
    directories: [...parsed.directories, ...nested.flatMap((item) => item.directories)],
  }
}

export async function scanPermissions(
  command: string,
  cwd: string,
  internalRoots: string[],
): Promise<PermissionScan> {
  const [canonicalCwd, roots] = await Promise.all([
    canonical(cwd),
    Promise.all(internalRoots.map(canonical)),
  ])
  const parsed = await scanCommands(command, canonicalCwd)
  const directories = await Promise.all(
    [canonicalCwd, ...parsed.directories.map((directory) => resolve(canonicalCwd, directory))].map(
      canonical,
    ),
  )
  const external = directories
    .filter((directory) => roots.every((root) => !within(root, directory)))
    .map((directory) => join(directory, "*"))

  return {
    cwd: canonicalCwd,
    commands: [...new Set(parsed.commands)],
    externalDirectories: [...new Set(external)],
  }
}
