# opencode-interactive-terminal

An OpenCode v2 plugin that lets the agent run a command in a real terminal window on the user's machine. The user can answer sudo prompts, type passwords or MFA codes, and interact with full-screen programs. When the command exits, its output and exit code return to the agent as the tool result.

## How it works

- The server plugin adds the `interactive_terminal` tool.
- The TUI plugin receives a request over typed RPC and claims it atomically, preventing two OpenCode windows from running the same command.
- A floating terminal runs `src/runner.sh`, which uses util-linux `script` to allocate a PTY and capture combined stdout/stderr.
- Input is **not** written to the capture log (`script --echo never`). The agent receives output only after the terminal closes.
- Stopping the session or reaching the timeout closes the terminal and its process group.

This is not a sandbox. The command has the same privileges and environment as a command started from your terminal.

## Requirements

- OpenCode v2.2.2 or newer, using the interactive TUI.
- Linux with util-linux `script` supporting `--echo never` and `--return`.
- Kitty, Ghostty, WezTerm, Alacritty, foot, or xterm. Another launcher can be configured explicitly.

`opencode run` has no TUI to open a window, so the tool is not available for noninteractive automation. A request with no active TUI fails after `startTimeout` instead of hanging indefinitely.

## Install

Load both the server and TUI parts by adding the package to `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:kgadberry/opencode-interactive-terminal#COMMIT_SHA",
      "options": {
        "terminal": {
          "command": "kitty",
          "args": [
            "--class", "opencode-interactive-terminal",
            "--title", "{title}"
          ]
        },
        "timeout": 1800,
        "startTimeout": 15,
        "maxOutputChars": 60000
      }
    }
  ]
}
```

Replace `COMMIT_SHA` with a full commit hash for a pinned installation. For a checkout, use an absolute local package path instead.

If `terminal` is omitted, the plugin recognizes `$TERMINAL` or `$TERM_PROGRAM` and selects a preset. `{title}` in terminal arguments expands to the current command title. The plugin appends this invocation to the configured terminal command:

```text
sh RUNNER OUTPUT_FILE STATUS_FILE CWD COMMAND_FILE
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `terminal.command` | auto-detected | Terminal executable. |
| `terminal.args` | terminal preset | Arguments before the runner invocation. |
| `timeout` | `1800` | Default command timeout in seconds, measured after a TUI claims the request. |
| `startTimeout` | `15` | Seconds to wait for a TUI to claim the request. |
| `maxOutputChars` | `60000` | Maximum cleaned output returned to the agent, from 1,000 to 1,000,000 characters. The beginning and end are retained. |

### Make Kitty float under Hyprland

The terminal class alone does not make a window float. Add a rule such as:

```nix
desktop.hyprland.extraConfig = ''
  windowrule = float on, center on, size 1100 700, match:class ^(opencode-interactive-terminal)$
'';
```

For a raw Hyprland configuration, put the same `windowrule` line in `hyprland.conf`.

## Agent usage

The tool accepts an executable and literal argument array; it does not invoke a shell implicitly.

```json
{
  "command": "sudo",
  "args": ["-v"],
  "cwd": "/home/me/project",
  "timeout": 300
}
```

For shell syntax, request it explicitly:

```json
{
  "command": "sh",
  "args": ["-lc", "sudo -v && sudo systemctl restart example.service"]
}
```

The result includes the command, working directory, exit code, duration, and cleaned terminal output. ANSI terminal control sequences are removed. Large output is capped with the beginning and end preserved.

## Security and privacy

- Never ask the agent to put a password in `command` or `args`; those values are part of the session transcript. Type secrets into the terminal instead.
- Typed input is excluded from the capture log, but a command can still print a secret. Anything printed to stdout or stderr is returned to the agent and stored in the OpenCode session.
- The tool uses OpenCode's `shell` permission action before opening a terminal.
- Temporary capture files are created in a private temporary directory and removed after completion.
- Output is not streamed to the model while the command runs; it returns when the process exits.

## Development

```sh
npm install
npm run check
```

Tests use Node.js 22.18 or newer. Terminal integration tests execute the same PTY runner without opening a GUI window.

## License

CC0 1.0 Universal. See [LICENSE](LICENSE).
