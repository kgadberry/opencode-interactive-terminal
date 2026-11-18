import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Effect } from "effect"

import { displayCommand, scanPermissions, selectPermissionScanner } from "../src/permissions.ts"

test("the scanner adapter selects the portable entry point on each supported Core API", async () => {
  const result = { commands: [{ resource: "printf ok", save: "printf *" }], directories: [] }
  const scan = (command: string, shell: string, cwd: string) => {
    assert.deepEqual([command, shell, cwd], ["printf ok", "zsh", "/project"])
    return Effect.succeed(result)
  }
  const notPortable = () => assert.fail("Core 2.2 should use scanPortable")
  for (const api of [{ scanPortable: scan, scan: notPortable }, { scan }]) {
    const selected = selectPermissionScanner(api)
    assert.deepEqual(await Effect.runPromise(selected("printf ok", "zsh", "/project")), result)
  }
})

test("a missing scanner or a rejected scan stops without using another parser", async () => {
  assert.throws(() => selectPermissionScanner({}), /no supported shell permission scanner/)
  const parser = selectPermissionScanner({
    scanPortable: () => Effect.fail(new Error("opaque command")),
    scan: () => assert.fail("a rejected scan must not fall back"),
  })
  await assert.rejects(Effect.runPromise(parser("printf ok", "sh", "/project")), /opaque command/)
})

test("literal command preflight produces a shell permission resource", async () => {
  const command = displayCommand("printf", ["%s", "floating-terminal-smoke"])
  const result = await scanPermissions(command, process.cwd(), [process.cwd()])
  assert.deepEqual(result.commands, [command])
  assert.deepEqual(result.externalDirectories, [])
})

test("permission scanning includes commands nested in sh -lc", async () => {
  const command = displayCommand("sh", ["-lc", "printf ok; rm -- '*'"])
  const result = await scanPermissions(command, process.cwd(), [process.cwd()])
  assert.ok(result.commands.some((resource) => /^printf\b/.test(resource)))
  assert.ok(result.commands.some((resource) => /^rm\b/.test(resource)))
})

test("permission scanning handles shell options with separate arguments", async () => {
  for (const options of [
    ["-O", "extglob", "-c"],
    ["--init-file", "/dev/null", "-c"],
    ["--rcfile", "/dev/null", "-c"],
  ]) {
    const command = displayCommand("bash", [...options, "rm -- '*'"])
    const result = await scanPermissions(command, process.cwd(), [process.cwd()])
    assert.ok(
      result.commands.some((resource) => /^rm\b/.test(resource)),
      `missing nested rm in ${command}`,
    )
  }
})

test("recursive permission scanning preserves the shell dialect", async () => {
  const command = displayCommand("zsh", ["-c", "print hi"])
  const result = await scanPermissions(command, process.cwd(), [process.cwd()])
  assert.ok(result.commands.some((resource) => /^print\b/.test(resource)))
})

test("external working directories and shell cd targets are checked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-permissions-"))
  const project = join(directory, "project")
  const outside = join(directory, "outside")
  await Promise.all([mkdir(project), mkdir(outside)])

  try {
    const working = await scanPermissions("pwd", outside, [project])
    assert.deepEqual(working.externalDirectories, [join(outside, "*")])

    const changed = await scanPermissions(
      displayCommand("sh", ["-lc", `cd ${outside}`]),
      project,
      [project],
    )
    assert.deepEqual(changed.externalDirectories, [join(outside, "*")])

    const internal = await scanPermissions("pwd", project, [project])
    assert.deepEqual(internal.externalDirectories, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
