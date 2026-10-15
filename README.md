# Gajae

Electron desktop client for [GJC](https://github.com/Yeachan-Heo/gajae-code) sessions. Chat, live transcript sync, steer, cancel, and model switching all run on the same GJC session files as the terminal CLI.

Gajae is an external, process-isolated controller. It does not keep a resident
agent process and does not embed the GJC runtime in Electron. Every live action
uses the public broker-bound `gjc sdk session` CLI, while transcript history comes
from the same session files the terminal uses. Gajae and a TUI share session
files; they never share a TUI connection.

## User setup

- Apple-silicon macOS (arm64 only)
- Bun 1.4 or newer for the GJC runtime
- GJC CLI from the public [`Yeachan-Heo/gajae-code`](https://github.com/Yeachan-Heo/gajae-code) repository, version `0.18.11` or newer (the current compatibility target is `gajae-code@0.18.11`)

For a clean install, install GJC first, then copy the notarized Gajae release to
`/Applications`:

```bash
bun add -g gajae-code@0.18.11
cd Gajae-0.1.0-darwin-arm64
shasum -a 256 -c Gajae-0.1.0-darwin-arm64.zip.sha256
ditto -x -k Gajae-0.1.0-darwin-arm64.zip .
cp -R Gajae.app /Applications/Gajae.app
```

The app is version `0.1.0`; that is the desktop app release version and is
separate from the GJC CLI version. Update each independently. Keep `gjc` on
`PATH` or set its path in app settings.

Lookup order for the executable:

1. Path set in app settings
2. `GJC_BIN`
3. `~/.bun/bin/gjc`
4. `~/.local/bin/gjc`
5. `/opt/homebrew/bin/gjc`
6. `/usr/local/bin/gjc`

Default model preset is `codex-medium`. If `~/.gjc/agent/models.yml` defines it, that mapping wins.

## Run (developers)

Developers need Node.js 24 or newer. The local development package uses an
ad-hoc signature:

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

For a public release, first store notarization credentials in the login
Keychain, then provide the Developer ID identity, Keychain profile, and an
explicit confirmation that the bundled artwork is cleared for redistribution.
The release script refuses to create an ad-hoc or unnotarized artifact when any
gate is missing:

```bash
xcrun notarytool store-credentials gajae-notary \
  --apple-id release@example.com --team-id TEAMID

GJC_DEVELOPER_IDENTITY='Developer ID Application: Example (TEAMID)' \
GAJA_NOTARY_KEYCHAIN_PROFILE='gajae-notary' \
GAJAE_ASSET_RIGHTS_CONFIRMED=1 \
npm run package:mac -- --public-release
```

Never put these credentials in the repository or the packaged application. A
successful public release produces the portable pair:

```text
release/Gajae-0.1.0-darwin-arm64/Gajae-0.1.0-darwin-arm64.zip
release/Gajae-0.1.0-darwin-arm64/Gajae-0.1.0-darwin-arm64.zip.sha256
```

Published version artifacts are immutable. Bump `package.json` before creating a
different build; the release script refuses to overwrite a same-version ZIP.

The local ad-hoc development package remains at
`release/Gajae-darwin-arm64/Gajae.app` and is not a public distribution artifact.

## Use

Type a request and press Enter. Files and images are sent as local paths. Images are opened with GJC `read` before the model answers.

### While a turn is running

| Action                | Result                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Text + Enter          | Hold follow-up work visibly in the Composer. It waits until the current turn ends, unless you press empty Enter again |
| Empty Enter (with work held) | Interrupt the current turn and immediately release the held work through steering                         |
| `/steer …`            | Mark the held work as steering intent; it still takes the visible held-work step and does not interrupt on this Enter |
| `/queue …`            | Mark the held work to wait until the current turn ends                                                    |
| Esc or Stop           | Stop the current turn and owned background/subagent work. The session stays open                          |

The submit slot holds one button, not two: the send arrow whenever there is
something to send, otherwise Stop. The Composer owns one local held-work queue;
`/steer` and `/queue` do not create separate remote queues.

GJC `turn.steer` is consumed at the next tool/turn boundary, so it is not a wait
queue. Submissions are held locally as follow-up/Steer work; empty Enter aborts
the current turn and releases the held work through steering in order.

### Model / effort

- `/model` — open the preset picker
- `/model codex-medium` — switch immediately. A unique preset prefix also matches. Unknown names are not sent as chat; they show an error
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
`terminal-only` when a terminal holds the lease and `recovering` when runtime
re-hosting could not be verified. `세션 이어서 진행` resumes it again, from the inspector or the sidebar
right-click menu, on any session that is not already attached.

Resuming is a user action, not a retry timer. The lease may still be held, so a
scheduled retry would only fail repeatedly. When another terminal holds it, the
app says so instead of leaking the broker error; quit that `gjc` and try again.

### Permission handling

The Settings permission field is applied after create or resume with the public
`permission_mode.set` session control operation. `always-allow` maps to the
broker-hosted session's `allow` mode. There is no environment variable on a
desktop-owned agent child because Gajae has no agent child.

The session CLI has no reverse permission-request channel to the desktop. When
interactive prompting is selected, Gajae therefore fails closed instead of
silently granting tools: the broker-hosted session is placed in deny mode. This
can move back to an interactive prompt only when GJC exposes a public external
permission-answer operation.

### Open a past session

`지난 세션 이어서 진행` (sidebar, next to `+`) re-hosts the selected session with
the `session.resume` lifecycle global. The picker lists past sessions read straight
from the session files under
`~/.gjc/agent/sessions/` (`GJC_CODING_AGENT_DIR` overrides the root), because
discovery drops non-live sessions on purpose.

- Search by session id prefix, title, or workspace
- Ids show 12 characters; 8 collide across real sessions
- The newest `HISTORY_SESSION_LIMIT` (250) sessions are offered, since summarising
  each row costs a file read
- A long first request is summarised to one line and deep paths are shortened, so
  a row cannot push the id and time out of the dialog

Choosing a session closes the picker right away. The row is created even when
attaching is refused, so the failure is reported on the session rather than
holding the dialog open.

The full session id sits under the title in the inspector and copies on click.

## Developer notes

Bundled original project artwork is not claimed as third-party material. Asset
redistribution must be confirmed before distributing a binary release.

## GJC SDK session CLI compatibility

Gajae supports installed `gajae-code` version `0.18.11` or newer, and is verified
against that release. It uses only the credential-free public surface:

```text
gjc sdk session list|inspect|send|status|tail
gjc sdk session raw control|query|global
```

Two flag rules come from the 0.18.11 grammar and are load-bearing:

- Every invocation passes `--json`. Failures answer a `gjc.command-error` envelope
  there, and plain human text without it, which the app cannot classify.
- Only `session list` passes `--repo`. Exact-session verbs resolve from the session
  ID and warn that the flag is ignored; `raw control` and `raw global` reject it as
  a usage error before dispatch. `session list` also states `--scope` explicitly
  because the 0.18.11 default scope is `repo`, which fails outside a git checkout.

Create, fork, resume, close, and delete use `raw global` with a fresh lifecycle
idempotency key. Prompt submission uses semantic `send` with a fresh operation
reference and reconciles completion with `status` plus the durable transcript.
Model, effort, commands, context, and capabilities use `raw query`. Live lifecycle
catch-up uses bounded `tail --all-events` reads with checkpoint cursors; the
session-file watcher remains the transcript source of truth.

The desktop never starts `sdk serve`, opens a session WebSocket, reads endpoint
credentials, or uses discovery records as an attachment mechanism.

Desktop Esc/Stop sends:

```ts
turn.abort {
  mode: "terminal",
  scope: "owned",
  operator: true,
}
--confirm
--idempotency-key "gajae-abort-<uuid>"
```

Gajae requires the following behavior, shipped by the supported runtime:

1. Forward the CLI idempotency key on control-request envelopes
2. `turn.abort` `operator: true` — an external controller can stop owned work. Requires `--confirm`

**Known limitation on 0.18.11:** the terminal abort answers
`{turn:"no_active_turn", terminal:"terminal_no_effect"}` through this route even
while a turn is verifiably running (`status` in_flight and `turn.steer` accepted on
the same session), and the turn keeps running. The same payload over a live
`sdk serve --stdio` connection is rejected with `operation_prohibited` ("Operator
terminal aborts are available only through the Broker control route"). Stop
therefore reports that it could not confirm the abort instead of claiming the run
stopped; the transcript stays the source of truth for whether work continued.

**Known limitation on 0.18.11:** `session.delete` answers `operation_failed`
("The operation failed. Its outcome could not be established.", `outcomeCertainty:
unknown`, retryability `unknown`, and the guidance "do not blindly retry") for any
session whose durable state includes tool execution. A session that only replied
deletes cleanly; one that ran a single `printf` bash turn does not, in the default
agent directory and in a fresh one, and the broker row stays
`live:false, deleted:false`. Gajae treats that as an unknown lifecycle outcome:
it preserves the transcript, metadata, and worktree and marks the session as
recovering rather than reporting a deletion it cannot prove.

Older GJC versions are unsupported. After updating GJC, restart running `gjc` /
`gjc --resume` session hosts because they do not hot-reload runtime code.

If the CLI rejects the `operator` field, the app reports failure instead of pretending the run stopped.

Steer itself is unchanged in GJC. The desktop uses `raw control` with the existing
`turn.steer` operation. Empty Enter only aborts so the Composer's held work is
consumed once through steering (steer-on-interrupt). Do not dequeue and
`abort_and_prompt` the same text.

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

## License

Gajae source code is available under the [MIT License](LICENSE). A public binary
release is produced only after the maintainer separately confirms redistribution
rights for the bundled artwork.
