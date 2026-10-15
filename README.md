# Gajae

Electron desktop client for [GJC](https://github.com/Yeachan-Heo/gajae-code) sessions. Chat, live transcript sync, steer, cancel, and model switching all run on the same GJC session files as the terminal CLI.

The app is a separate SDK connection from a TUI `gjc` process. They share session artifacts; they do not share a connection.

## User setup

- Apple-silicon macOS (arm64 only)
- Bun 1.4 or newer for the GJC runtime
- GJC CLI from the public [`Yeachan-Heo/gajae-code`](https://github.com/Yeachan-Heo/gajae-code) repository, version `0.15.5` or newer (the current compatibility target is `gajae-code@0.15.5`)

For a clean install, install GJC first, then copy the notarized Gajae release to
`/Applications`:

```bash
bun add -g gajae-code@0.15.5
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
a second runtime: both clients drive the one `GjcAcpController` in the host
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
- Static app assets are public; session data never is. The device token travels
  in an `Authorization` header, never in a URL.
- A device token is 32 random bytes. The host stores only `HMAC(secret, token)`
  in `remote-devices.json` (mode `0600`); the phone keeps the token in
  `localStorage`.
- A pairing code is carried in the URL fragment (`#pair=…`), which browsers never
  send to a server, and is removed from the address bar before it is used.
- `접근 해제` deletes the device record immediately: later requests answer `401`
  and the device's open event stream is closed.

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

## GJC runtime compatibility

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

Gajae requires the following SDK behavior, shipped by the supported
`gajae-code@0.15.5` runtime:

1. Forward `idempotencyKey` on CLI `control_request` envelopes
2. `turn.abort` `operator: true` — another connection can stop owned work. Requires `confirm: true`
3. Plain `turn.abort {}` is session-scoped — stops the current turn even when the requester is not the owner (empty-Enter flush)

Older GJC versions are unsupported. After updating GJC, restart running `gjc` /
`gjc --resume` session hosts because they do not hot-reload runtime code.

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
- Remote access host: `electron/remote/`
- Renderer: `src/`
- Remote client: `src/remote/`
- IPC and protocol contracts: `shared/`
- PWA assets and the web build: `web/`, `vite.web.config.ts`

## License

Gajae source code is available under the [MIT License](LICENSE). A public binary
release is produced only after the maintainer separately confirms redistribution
rights for the bundled artwork.
