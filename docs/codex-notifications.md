# Codex Desktop Notification Bridge (Windows)

This setup adds desktop notifications when Codex requests user action.

## What it does

1. Shows a Windows toast notification for:
   - command approval
   - file-change approval
   - `request_user_input` option questions
   - task completion (success/failure)
2. Adds clickable buttons in the toast for available options.
3. Opens VS Code to your workspace when the notification body (or button) is clicked.
4. Sends the clicked option back to the active Codex session.

## Files

- `scripts/codex-notify-bridge.ts`: runs Codex app-server and relays requests/responses
- `scripts/codex-notify-toast.ps1`: shows clickable toast notifications
- `scripts/codex-notify-handle.ps1`: receives click events via URI protocol and writes responses
- `scripts/install-codex-notify.ps1`: installs `codexnotify://` URI protocol handler for current user

## One-time install

```bash
npm run codex:notify:install
```

This registers `codexnotify://` under `HKCU\Software\Classes`.

## Run Codex with notifications

```bash
npm run codex:notify -- "your prompt"
```

Example:

```bash
npm run codex:notify -- "Review this repository and suggest reliability fixes."
```

## Always-on daemon mode

Run one process continuously and submit multiple prompts interactively:

```bash
npm run codex:notify:daemon
```

- Type prompts at `codex>` as needed
- Type `/exit` to stop the daemon

## Behavior details

- When notification delivery fails, bridge falls back to terminal prompts.
- For `request_user_input`, button mode is used when there are up to 5 options.
- Free-form answers (no fixed options) use terminal fallback input.
- Queue file for click responses:
  - `%LOCALAPPDATA%\CodexNotify\responses.jsonl`

## Notes

- This bridge runs its own Codex session via `codex app-server`.
- It does not inject into a separate already-running VS Code Codex extension session.
- It is intended for local Windows use.
