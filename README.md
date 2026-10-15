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
npm run dev:web      # remote client renderer in a browser
npm run dev:desktop  # Electron + Vite
npm run build:web    # dist/web: served by the host, bundled into the app
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

The model picker has a separately scrollable profile list and Fast on/off
controls when the session advertises `service_tier.set`. `/fast` or `/fast toggle`
toggles configured intent; `/fast on`, `/fast off`, and `/fast status` are also
available. Configured Fast intent does not prove a provider applied priority service.

### Reasoning cards

Reasoning cards follow one window-wide preference instead of per-card state:
펼치기 on any card expands every reasoning card, including later turns and other
sessions, and 접기 collapses them all. The value persists in
`agent-control-settings.json` and can also be set in 설정 → GJC → 추론 카드 펼치기.
Streaming cards keep their header, `생각 중…` label and spinner, and follow the
same setting for their content.

### Slash commands and skills

The command palette combines desktop actions with controls advertised by the live
GJC SDK. `/skills` lists session skills, `/skill:<name> <request>` submits skill
work, `/progress` reads project progress, `/reload` reloads runtime components, and
`/plan on|off` changes plan mode when those SDK operations are available. Skill
work follows the same held-work rules as prompts; session controls execute immediately.

On attachment, skills are discovered from `skill.list/state` until the runtime
publishes its authoritative command list. GJC 0.18.11 does not expose a complete
CLI slash-command registry query, and its skill rows can omit visibility metadata.
An authoritative command update replaces that provisional skill list. TUI-only
commands and commands without a public SDK equivalent are not claimed as supported;
desktop slash commands are not a complete copy of the CLI command surface.

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

Eligible interactive GJC root sessions publish an SDK endpoint automatically
(unless `GJC_SDK_DISABLE=1`). The app and CLI can use that same live host through
public broker query/control routes. Attaching does not resume, replace, or change
the permission policy of an externally owned live session.

If a shared route is unavailable, the transcript remains readable. The internal
`terminal-only` state means an unavailable control route, not proof of exclusive
terminal ownership. Fresh positive endpoint evidence is checked with a public
metadata query so a recovered route is not permanently stuck read-only.
`세션 이어서 진행` also retries attachment on user action; only a non-live session
is re-hosted. Creating a different session or exiting a reachable terminal is not
required for ordinary shared interaction.

Operator-owned Stop has a separate GJC authority requirement: a directly launched
TUI can answer queries and steering while lacking the indexed lifecycle identity
required for terminal/owned-work abort. When the operator route is refused but the
host still answers, Stop falls back to the ordinary `turn.abort` and the cancellation
notice states that this host's background work is not confirmed stopped; the window
never claims it, and no signal or process kill is substituted. A refused release
(Empty Enter) hands the held work over as a steer instead of failing.

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

## Remote access

A phone or a second personal machine runs the same app as a *remote client* of
the host, over an HTTPS address the host publishes with Tailscale Serve. It is not
a second runtime: both clients drive the one `GjcSdkController` in the host
process, so a session started here shows up there and the result of an action is
the same on both screens.

Setup, on the desktop, in Settings → 원격 접속:

1. Turn it on. The host binds `127.0.0.1:8791` (configurable) and maps it with
   `tailscale serve --bg --https=443`. Loopback only; Tailscale Funnel / public
   exposure is not supported.
2. Press `보기 전용 코드` or `조작 가능 코드`. A code is valid for five minutes and
   works exactly once.
3. Scan the QR code, or open `https://<machine>.<tailnet>.ts.net/` and type the
   code.

A device signed in to the same tailnet account as this machine skips the code.
`tailscale serve` stamps each request with the login that owns the node it came
from, so a request that arrived through the local tailscaled, from a tailnet
address, not through Funnel, and naming this machine's own login is the owner and
is admitted directly. Everything else — another person's device, a tagged node, a
forged header — still needs a code.

What a paired device may do:

| Permission        | Allowed                                                                                            | Refused (stays desktop-only)                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 보기 전용 (view)   | session list, status, transcripts, diffs, artifacts, queued messages                                | everything below                                                                  |
| 조작 가능 (control) | those, plus send, steer, queue, cancel, tool approval, mark read                                   | create/delete/rename/compact sessions, git commit/push, file preview, host settings |

Host-destructive work keeps its native confirmation dialog, which a remote
device cannot answer, so it is not exposed at all. The permission is enforced in
the host: a view-only device that calls the control endpoints directly gets
`403`.

Security shape:

- `Host` and `Origin` are checked against this machine's loopback and tailnet
  names, and a cross-origin write is refused before authentication.
- Tailnet identity is only believed when `tailscale serve` produced it: the request
  must arrive from the local tailscaled, carry a single `X-Forwarded-For` address
  on the tailnet, name this machine's own login, and show no `Tailscale-Funnel-Request`.
  If `tailscale status` stops answering, identity access closes with it.
- Static app assets are public; session data never is. The device token travels
  in an `Authorization` header, never in a URL.
- A device token is 32 random bytes. The host stores only `HMAC(secret, token)`
  in `remote-devices.json` (mode `0600`); the phone keeps the token in
  `localStorage`.
- A pairing code is carried in the URL fragment (`#pair=…`), which browsers never
  send to a server, and is removed from the address bar before it is used.
- `접근 해제` deletes the device record immediately: later requests answer `401`
  and the device's open event stream is closed. A device admitted by identity never
  paired and is not in that list: to cut one off, turn remote access off or remove
  the device from the tailnet.

Reconnection and duplicate safety:

- The event stream is `text/event-stream` with sequence numbers. A reconnect
  resumes from the last sequence the client actually received; a gap the host can
  no longer replay becomes a snapshot refresh instead of a guess.
- Every control request carries an operation ID. A repeat replays the recorded
  outcome instead of running the instruction twice, and
  `GET /api/operations/<id>` answers what happened to a request whose reply was
  lost.
- A control request that dies without an answer is never resent: the client looks
  the outcome up and reports `전송 결과를 확인할 수 없습니다` when there is none.

The remote client installs as a PWA. Its service worker caches static app assets
only — `/api/` responses and the device token are always fetched live.

## Developer notes

Bundled original project artwork is not claimed as third-party material. Asset
redistribution must be confirmed before distributing a binary release.

Settings writes go through one of two paths, and the choice is part of the
contract:

- `settings.savePreferences` replaces the whole preferences object and runs
  `authorizeDestructive`, which raises the OS “Apply runtime settings?” prompt.
  Use it for settings that change what the runtime does: workspace, model preset,
  approval mode, GJC executable.
- Field-only channels validate one value, rewrite that one field and reuse the
  store's `persist()` — no prompt. Use them for display and reading preferences.
  `setWorkspaceLabel` and `setThoughtsExpanded` are the existing ones; a card
  toggle that raised a native modal on every click is why the second exists.
  A new field-only channel needs all three pieces: an entry in
  `shared/settings-ipc.ts`, the bridge method in `electron/preload.ts`, and a
  handler in `electron/settings-ipc-handlers.ts` that validates the value and
  does not call `authorizeDestructive`. `SettingsStore.validate()` stays the
  whole-object gate; the field setter checks only its own field, so an unrelated
  stale value cannot block a display toggle.

Card typography: every text element inside a card sets its own size. An unstyled
`<p>` or `<small>` inherits the browser's 16px default, which renders larger than
the card's own title in a UI whose body text is 9–12px.

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
Fixed upstream as https://github.com/Yeachan-Heo/gajae-code/pull/6776 (reported as
https://github.com/Yeachan-Heo/gajae-code/issues/6772): the active-submission lookup
was scoped to the aborting connection and ignored the broker-authorized `operator`
flag, so a running turn is now fenced and stopped (`turn:"stopped"`) instead of
reporting `no_active_turn`. Gajae already sends `operator: true` with `--confirm`, so
Stop needs no app change once the runtime carrying the fix is installed.

**Known limitation on 0.18.11:** `session.delete` requires the durable transcript
path, and a call that omits it is refused with `invalid_input`
("session.delete requires sessionPath and its configured cwd."). 0.18.11 renders
that refusal as `operation_failed` ("The operation failed. Its outcome could not be
established.", `outcomeCertainty: unknown`, retryability `unknown`, guidance "do not
blindly retry"), so a refused delete is indistinguishable from a delete that may
have half-applied. Gajae passes the path it located and, when the call still fails,
treats it as an unknown lifecycle outcome: it preserves the transcript, metadata,
and worktree and marks the session as recovering rather than reporting a deletion
it cannot prove. Fixed upstream as https://github.com/Yeachan-Heo/gajae-code/pull/6777
(the disabled-outcome code stays conservative; the refusal class becomes a
`lifecycle_input_refused` diagnostic).

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
- Route a display-only preference through `settings.savePreferences` (whole-object save, native confirm modal); add a field-only channel instead
- Keep a card's own copy of a window-wide preference, or let it fall behind the stored value
- Render card text without a rule of its own and let the 16px browser default decide its size

## Develop

```bash
npm run lint
npm test
npm run verify
```

- Electron main: `electron/`
- Remote access host: `electron/remote/`
- Renderer: `src/`
- Remote client: `src/remote/`
- IPC and protocol contracts: `shared/`
- PWA assets and the web build: `web/`, `vite.web.config.ts`

## License

Gajae source code is available under the [MIT License](LICENSE). A public binary
release is produced only after the maintainer separately confirms redistribution
rights for the bundled artwork.
