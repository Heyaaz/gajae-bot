# Gajae

Electron desktop client for [GJC](https://github.com/gajae-code) sessions. Chat, live transcript sync, steer, cancel, and model switching all run on the same GJC session files as the terminal CLI.

The app is a separate SDK connection from a TUI `gjc` process. They share session artifacts; they do not share a connection.

## Requirements

- macOS arm64
- Node.js 24+
- GJC CLI (`gjc`) on `PATH` or at a known install location

Lookup order for the executable:

1. Path set in app settings
2. `GJC_BIN`
3. `~/.bun/bin/gjc`
4. `~/.local/bin/gjc`
5. `/opt/homebrew/bin/gjc`
6. `/usr/local/bin/gjc`

Default model preset is `GOAT` (`codex-lb/gpt-5.6-sol:medium`). If `~/.gjc/agent/models.yml` defines it, that mapping wins.

## Run

```bash
npm install
npm test
npm run dev          # Vite renderer
npm run dev:desktop  # Electron + Vite
```

Package:

```bash
npm run package:mac
```

Output is `release/Gajae-darwin-arm64/Gajae.app`. Copy it to `/Applications/Gajae.app` to install.

## Use

Type a request and press Enter. Files and images are sent as local paths. Images are opened with GJC `read` before the model answers.

### While a turn is running

| Action       | Result                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------ |
| Text + Enter | Queue follow-up work. It waits until the current turn ends, or until you press empty Enter |
| Empty Enter  | Abort the current turn and run the waiting work immediately                                |
| `/steer …`   | Same as empty Enter: interrupt now                                                         |
| `/queue …`   | Same as Text + Enter: wait                                                                 |
| Esc or Stop  | Stop the current turn and owned background/subagent work. The session stays open           |

The submit slot holds one button, not two: the send arrow whenever there is
something to send, otherwise Stop.

GJC `turn.steer` is consumed at the next tool/turn boundary, so it is not a wait queue. Waiting work uses `turn.follow_up`. Empty Enter aborts so the queued follow-up is promoted now.

### Model / effort

- `/model` — open the preset picker
- `/model GOAT` — switch immediately. `gajae-code/GOAT` and a unique prefix also match. Unknown names are not sent as chat; they show an error
- `Shift+Tab` — cycle thinking effort

### Shortcuts

| Key         | Action                |
| ----------- | --------------------- |
| `⌘T`        | New session           |
| `⌘1`–`⌘9`   | Select session        |
| Esc         | Abort the current run |
| `Shift+Tab` | Cycle effort          |

### Session delete

Delete is close-then-delete, not hide-from-list. A live session is closed with `session.close`, then artifacts are removed with `session.delete`. Only the clicked session is targeted.

### Resume a session

A session the window lost control of is readable but cannot be sent to. It shows
`terminal-only` when a terminal holds the lease and `recovering` when a reconnect
failed. `세션 이어서 진행` attaches again, from the inspector or the sidebar
right-click menu, on any session that is not already attached.

Resuming is a user action, not a retry timer. The lease may still be held, so a
schedule would only fail repeatedly. When another terminal holds it, the app says
so instead of leaking the broker error; quit that `gjc` and try again.

### Open a past session

`지난 세션 이어서 진행` (sidebar, next to `+`) is the app's `gjc --resume <id>`. It
lists past sessions read straight from the session files under
`~/.gjc/agent/sessions/` (`GJC_CODING_AGENT_DIR` overrides the root), because
discovery drops non-live sessions on purpose.

- Search by session id prefix, title, or workspace
- Ids show 12 characters; 8 collide across real sessions
- The newest `HISTORY_SESSION_LIMIT` (60) sessions are offered, since summarising
  each row costs a file read
- A long first request is summarised to one line and deep paths are shortened, so
  a row cannot push the id and time out of the dialog

Choosing a session closes the picker right away. The row is created even when
attaching is refused, so the failure is reported on the session rather than
holding the dialog open.

The full session id sits under the title in the inspector and copies on click.

## GJC runtime patches

Desktop Esc/Stop sends:

```ts
turn.abort {
  mode: "terminal",
  scope: "owned",
  operator: true,
}
confirm: true
idempotencyKey: "gajae-abort-<uuid>"
```

Stock GJC terminal owned abort only works when the requesting connection owns the turn. The desktop app does not, so that path returns `no_active_turn` / `terminal_no_effect`.

GJC changes required for this app (in `gajae-code`):

1. Forward `idempotencyKey` on CLI `control_request` envelopes
2. `turn.abort` `operator: true` — another connection can stop owned work. Requires `confirm: true`
3. Plain `turn.abort {}` is session-scoped — stops the current turn even when the requester is not the owner (empty-Enter flush)

Patched files:

- `packages/coding-agent/src/sdk/cli/session-cli.ts`
- `packages/coding-agent/src/sdk/host/control/dispatch.ts`
- `packages/coding-agent/src/sdk/host/control/operations.ts`
- `packages/coding-agent/src/sdk/host/session-runtime.ts`
- `packages/coding-agent/src/sdk/bus/index.ts`

A running `gjc` / `gjc --resume` process does not hot-reload these patches. Restart the session host. Editing a global install is overwritten on the next package install.

If the CLI rejects the `operator` field, the app reports failure instead of pretending the run stopped.

Steer itself is unchanged in GJC. The desktop uses the existing `turn.steer` surface. Empty Enter only aborts so queued steer is consumed once (steer-on-interrupt). Do not dequeue and `abort_and_prompt` the same text.

## Lifecycle receipts

`Lifecycle terminal evidence could not be verified after persistence; retained
artifacts require reconciliation` means GJC could not confirm it recorded the
operation. It does not mean the operation failed.

Forking and resuming both hit this for work that had already succeeded. The fork
is what creates the session, so the broker index is consulted for the new session
instead of raising an error; the error is raised only when nothing ever appears. A
resumed session stays readable and marked `recovering`, since its transcript comes
from the session file either way and only live control is unproven.

The receipt failures themselves come from the GJC ledger and are not fixable here.

## Do not

- `SIGINT` / kill the GJC process to cancel
- Use `turn.abort_and_prompt` as a cancel fallback (the control sentence becomes a real user message)
- Force `idle` / “cancelled” UI from the abort ACK alone
- Treat session delete as hiding a row in the list
- Treat an unverifiable lifecycle receipt as a failed operation

## Develop

```bash
npm run lint
npm test
npm run verify
```

- Electron main: `electron/`
- Renderer: `src/`
- IPC contract: `shared/`
