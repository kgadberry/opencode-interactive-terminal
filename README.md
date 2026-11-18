# opencode-interactive-terminal

An OpenCode v2 plugin that lets the agent run a command in a real terminal window on the user's machine. The user can answer sudo prompts, type passwords or MFA codes, and interact with full-screen programs. When the command exits, its output and exit code return to the agent as the tool result.

## How it works

- The server plugin adds the `interactive_terminal` tool.
- The TUI plugin polls pending requests over typed RPC and claims them atomically, preventing two OpenCode windows from running the same command. Polling also reconciles requests after a reconnect or server restart.
- A floating terminal runs `src/runner.sh`, which uses util-linux `script` to allocate a PTY. A bounded streaming collector displays and captures combined stdout/stderr without terminating a verbose command.
- `script --echo never` disables input echo initially. Normal password prompts keep input out of the capture, but a program can re-enable echo; any echoed input is then captured. The agent receives output only after the terminal closes.
- Stopping the session or reaching the timeout signals both the terminal launcher and the inner command's process group, escalating to SIGKILL when needed.

This is not a sandbox. The command has the same privileges and environment as a command started from your terminal.

## Requirements

- OpenCode v2.2.2 or newer, using the interactive TUI.
- Linux with util-linux `script` supporting `--echo never` and `--return`.
- Node.js 22.18 or newer on the user's machine for the bounded capture collector.
- Kitty, Ghostty, WezTerm, Alacritty, foot, or xterm. Another launcher can be configured explicitly, but its process must remain running until the command exits.

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
The plugin pins its own Core and Effect versions in `package.json`; a Git installation can resolve those dependencies separately from both the running OpenCode binary and the checkout's npm lockfile.

If `terminal` is omitted, the plugin recognizes `$TERMINAL` or `$TERM_PROGRAM` and selects a preset. `{title}` in terminal arguments expands to the current command title. The plugin appends this invocation to the configured terminal command:

```text
sh RUNNER OUTPUT_FILE STATUS_FILE CWD COMMAND_FILE PID_FILE COLLECTOR CAPTURE_LIMIT
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `terminal.command` | auto-detected | Terminal executable. |
| `terminal.args` | terminal preset | Arguments before the runner invocation. |
| `timeout` | `1800` | Default command timeout in seconds, measured after a TUI claims the request. |
| `startTimeout` | `15` | Seconds to wait for a TUI to claim the request. |
| `maxOutputChars` | `60000` | Maximum cleaned output returned to the agent, from 1,000 to 1,000,000 characters. Capture uses a bounded head/tail buffer of four times this many bytes; the command continues when output exceeds the limit. |

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
- Normal password prompts disable echo and keep typed secrets out of the capture. If a program enables echo, typed input can be captured. Anything echoed or printed to stdout/stderr is returned to the agent and stored in the OpenCode session.
- The tool uses OpenCode's portable shell scanner and `shell` permission action, including commands nested in explicit `sh`/`bash`/`zsh -c` scripts. External working directories and `cd` targets use `external_directory` checks. Arbitrary commands do not propose durable “allow always” patterns.
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
