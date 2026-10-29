# Gajae

Electron desktop client for [GJC](https://github.com/Yeachan-Heo/gajae-code) sessions. Chat, live transcript sync, steer, cancel, and model switching all run on the same GJC session files as the terminal CLI.

Gajae is an external, process-isolated controller. It does not keep a resident
agent process and does not embed the GJC runtime in Electron. Every live action
uses the public broker-bound `gjc sdk session` CLI, while transcript history comes
from the same session files the terminal uses. Gajae and a TUI share session
files; they never share a TUI connection.

## User setup

- Apple-silicon macOS (arm64 only)
- Optional: the [`gh` CLI](https://cli.github.com), signed in with `gh auth login`, for the repository screen's issues, pull requests and CI

Copy the notarized Gajae release to `/Applications` and open it:

```bash
cd Gajae-0.1.0-darwin-arm64
shasum -a 256 -c Gajae-0.1.0-darwin-arm64.zip.sha256
ditto -x -k Gajae-0.1.0-darwin-arm64.zip .
cp -R Gajae.app /Applications/Gajae.app
```

On a Mac without GJC, the first launch walks through setup without a terminal:

1. It installs the GJC CLI from the public [`Yeachan-Heo/gajae-code`](https://github.com/Yeachan-Heo/gajae-code)
   releases, checked against the release's SHA-256, into `~/.local/bin/gjc`, the
   same place GJC's own installer uses, so `gjc update` keeps working.
2. It signs in to one provider through GJC's own login (a browser login, or an
   API key pasted into the app). GJC stores the credential; Gajae does not.
3. It switches to GJC's recommended model profile for that provider and opens
   the first conversation.

A Mac that already runs GJC skips this. GJC `0.18.12` or newer is required (the
newest verified compatibility target is `0.19.0`); to install it yourself, run
GJC's installer:

```bash
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh
```

The app is version `0.1.0`; that is the desktop app release version and is
separate from the GJC CLI version. Update each independently.

Lookup order for the executable:

1. Path set in app settings
2. `GJC_BIN`
3. `$GJC_INSTALL_DIR/gjc`
4. `PATH`
5. `~/.local/bin`, `~/.bun/bin`, `~/.nvm/current/bin`, `~/.volta/bin`,
   `/opt/homebrew/bin`, `/usr/local/bin` (a Finder launch has none of these on `PATH`)

Bun is needed only when `gjc` is a Bun launcher script (a Bun global or source
install), not for the release binary.

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

Packaging rebuilds `node-pty` against Electron and unpacks that module from the
asar archive, including its `spawn-helper`. The chat header can switch the
open session between the conversation and a login-shell terminal.

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
| Send now on a held row | Send that instruction as a steer without stopping the current turn; other held rows keep waiting |
| Edit / × on a held row | Restore that request to the draft / discard only that request |
| `/steer …`            | Hold a visible Steer row above the input; Send now delivers it to the open turn |
| `/queue …`            | Mark the held work to wait until the current turn ends                                                    |
| Esc or Stop           | Stop the current turn and owned background/subagent work. The session stays open                          |

The submit slot holds one button, not two: the send arrow whenever there is
something to send, otherwise Stop. The Composer owns one local held-work queue;
Both `/queue` and `/steer` hold work locally while a turn runs. The saved
steer-on-Enter preference also creates a visible Steer row rather than bypassing it.

GJC `turn.steer` is consumed at the next tool/turn boundary, so it is not a wait
queue. Held requests appear as full-width rows above the input, with Send now,
edit, and discard controls. Send now does not abort; empty Enter retains its
separate interrupt-and-release behavior. Failed deliveries remain visible for
review rather than being automatically resent.

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
publishes its authoritative command list. The palette also requests that context
when it opens, but reuses a read from the last 15 seconds so reopening it does not
spawn another pair of CLI processes. Until the live list arrives the palette keeps
the bundled commands and says that skills are loading. GJC 0.18.12 does not expose a complete
CLI slash-command registry query, and its skill rows can omit visibility metadata.
An authoritative command update replaces that provisional skill list. TUI-only
commands and commands without a public SDK equivalent are not claimed as supported;
desktop slash commands are not a complete copy of the CLI command surface.

### File mentions

Type `@` at the start of the draft or after a space to search the session
workspace's files. ↑/↓ moves the highlight, Enter or Tab attaches the file, and Esc
closes the list without stopping the run. The `@text` leaves the draft and the file
becomes a path chip, sent the same way as a file chosen with the attach button.

The list comes from `git ls-files --cached --others --exclude-standard`, so
`.gitignore` decides what is offered. Outside Git it is a bounded directory walk
that skips `.git` and `node_modules`. Either way it stops at 100,000 files and says
so. The main process reuses a listing for 10 seconds, so files written since then
appear on the next `@`. Mentions are desktop only: a remote device has no workspace
listing, and `@` stays plain text there.

### Shortcuts

| Key         | Action                |
| ----------- | --------------------- |
| `⌘T`        | New session           |
| `⌘1`–`⌘9`   | Select session        |
| Esc         | Abort the current run |
| `Shift+Tab` | Cycle effort          |

### Links from other apps

Raycast, Alfred, a shell `open`, or any other app can hand Gajae a link:

| Link | Action |
| ---- | ------ |
| `gajae://new?prompt=…&path=…` | Opens the new-session dialog with the folder and first request filled in |
| `gajae://session/<id>` | Opens that session |

Both parameters of `new` are optional. The dialog creates nothing until it is
confirmed, and the first request is placed in the new session's message box, never
sent. `path` must be an absolute path to an existing folder; a relative or missing
path, a request over 20,000 characters, or a session id the window does not know is
refused with a notice instead of opening anything. Other `gajae://` links are
ignored. A link works whether Gajae is running or not: one that starts the app is
held until the window has loaded, and a second launch hands its link to the running
instance. The packaged app registers the scheme in its `Info.plist`; a development
`electron .` run does not register it, and `npm run desktop:deep-link-smoke` drives
the handlers instead.

### Session delete

Delete targets saved history, not its host process and not just the sidebar row.
Gajae requests `session.delete` with the exact session ID, configured location and
transcript path; it never calls `session.close` to make deletion possible. This
preserves a CLI that may have switched to another conversation with `/new`.
The CLI picker can delete old history through its owning `SessionManager`, but
GJC 0.19.0's public SDK still does not expose that owner-local flow; saved history
deletion and its unknown-outcome fence are described under
[GJC SDK session CLI compatibility](#gjc-sdk-session-cli-compatibility). A refusal
or unknown outcome leaves the row and local evidence intact and shows an error;
use that CLI's session picker for owner-local history deletion.

### Resume a session

Eligible interactive GJC root sessions publish an SDK endpoint automatically
(unless `GJC_SDK_DISABLE=1`). The app and CLI can use that same live host through
public broker query/control routes. Attaching does not resume, replace, or change
the permission policy of an externally owned live session.

If a shared route is unavailable, the transcript remains readable. The internal
`terminal-only` state means an unavailable control route, not proof of exclusive
terminal ownership. Fresh positive endpoint evidence is checked with a public
metadata query so a recovered route is not permanently stuck read-only.
Opening history with a stale/unavailable endpoint succeeds only when the saved
transcript can actually be read, and explicitly displays
`기록 보기 전용 · 실행 연결 없음`. This does not claim that execution resumed;
permission failures and missing/unreadable history are not replaced with an empty
successful conversation. Repeated transcript refreshes retain the warning until
control is restored.
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
- Every saved session is offered: summaries are read from a bounded head with an
  eight-way worker pool, and the picker renders 100 rows per page on demand
- A long first request is summarised to one line and deep paths are shortened, so
  a row cannot push the id and time out of the dialog

Choosing a session closes the picker right away. The row is created even when
attaching is refused, so the failure is reported on the session rather than
holding the dialog open.

The full session id sits under the title in the inspector and copies on click.

### Projects and the repository screen

The rail opens on `전체 프로젝트` and can be filtered to one project. A project is a
Git repository's main working tree, so every linked worktree of the same repository
— including a Gajae managed worktree — belongs to the same project instead of
appearing as a second one. A workspace outside Git is still a project: it keeps its
sessions and its own root, and the repository screen says it is not a repository
rather than showing an empty one.

`레포 보기` sits next to the selector whenever one project is selected; from
`전체 프로젝트` the same place offers `프로젝트 목록`, because the whole rail has no
single repository to open. The repository screen fills the center area:

| Tab | What it reads |
| --- | --- |
| 개요 | current branch, worktree and branch counts, changed-file counts per worktree, connected sessions, GitHub issue/PR counts and default-branch CI, sessions started from an issue or CI |
| 이슈 | open issues, then one issue's body and labels |
| PR | open pull requests with review state and CI, then one pull's branches, diff size and reviews |
| 브랜치·워크트리 | local branches, which worktree has each checked out, and each worktree's changed-file count |

- Selecting a session returns to its conversation with the project still selected.
- Filtering the rail never closes the open conversation. A session from another
  project stays on screen with no row highlighted until a session of the selected
  project is picked.
- `레포 보기` is offered for any selected project, including one outside Git, and the
  screen then says the project is not a repository. The project list leaves the entry
  point out for such a project, because its row already says the same thing.
- A worktree row lists the sessions whose workspace is that checkout root. A session
  started in a subdirectory of a worktree is grouped into its project but gets no chip
  there: a managed worktree lives inside its source repository, so a prefix join would
  also list its sessions under the main worktree.
- A local Git read that fails is reported as its own sentence, and only a path Git
  itself refuses reads as `Git 저장소가 아닙니다` — a repository that could not be read
  is never drawn as one without branches.
- Right-click on `레포 보기` carries the auxiliary actions only: `GitHub에서 열기`
  and `로컬 폴더 열기`.
- `변경 파일` reuses the session's existing panel, so Stage / Unstage / Commit /
  Push are the same code, prompts and managed-worktree checks as the conversation's
  `변경 파일` button. Nothing on the repository screen writes on its own.
- `DONE` is the session's own state. It does not mean the pull request merged or the
  issue closed; those live on the PR and 이슈 tabs.
- `이 이슈로 세션 시작` on an issue and `CI 실패 고치기` on a pull request (or on the
  overview, for the default branch) open the new-session dialog filled in; the
  session is created only when the dialog is confirmed, and the first request is
  placed in its message box, not sent. The issue's request carries its title, body,
  labels and URL on branch `issue-<number>-<slug>`. The CI request carries the
  failed steps' log from `gh run view --log-failed` for up to three Actions runs,
  cut to the last 32 KB. A worktree that already has the branch checked out is
  used as it is; otherwise a managed worktree checks out the existing local branch
  rather than creating a second one. A CI fix never starts its branch from `HEAD`:
  the branch must exist locally or on one remote, or creation stops and asks for a
  `git fetch`.
- The session remembers the issue, pull request or CI run it was started from, and
  the overview lists those sessions. A `gh` failure while reading the CI log leaves
  the button disabled beside the same sentence used everywhere else on the screen.

GitHub reads go through the [`gh` CLI](https://cli.github.com), which supplies its
own credential from the keychain. The app never reads, stores or prints a token, and
every read is a `gh` subprocess whose failure is reported as a state:

- `원격 저장소가 없습니다` — the project has no remote configured
- `GitHub 저장소가 아닙니다` — the remote is not github.com
- `GitHub CLI(gh)를 찾을 수 없습니다` — `gh` is not on `PATH` (`GAJAE_GH_BIN`
  overrides the path for a packaged install)
- `GitHub에 로그인되어 있지 않습니다` — run `gh auth login`
- `GitHub에 연결하지 못했습니다` — DNS, TLS, timeout or proxy failure
- `GitHub에서 응답을 받지 못했습니다` — anything else the API answered

An empty issue or pull list is none of those: it is reported as an empty list.

### Parallel runs (Best-of-N)

`병렬 실행` in the new-session dialog runs one request as 2-4 attempts. Each
attempt gets its own managed worktree, a new branch (`<branch>-1`, `-2`, … or
`gajae/best-of-<id>-N` without a name) and its own model preset, and the first
request is sent to each attempt once. More than one attempt always uses worktrees.
A CI fix does not offer the option, because its attempts would start from `HEAD`
instead of the failing branch, and a branch name that already exists is refused
before anything is created.

- Attempts are created one after another, because each creation writes the
  source repository's `.git` and the broker's lifecycle ledger. Each request is
  sent as soon as its session exists, so the attempts run at the same time. An
  attempt that fails to create, or whose request did not run, is shown as failed
  while the others keep running.
- `session.create` takes the attempt's preset as `modelPreset`, which GJC 0.19.0
  resolves as an exact profile ID. The comparison shows the preset the runtime
  reports and marks one that differs from the request.
- The rail nests the attempts under one group row, with the same code that nests
  forks. The row opens the comparison: each attempt's state, changed-file count,
  context usage and its own `변경 파일` panel, side by side.
- `이 시도 채택` keeps that attempt's branch and worktree and merges nothing. Commit,
  push or open a PR from its panel later.
- Removing the other attempts always goes through the native confirmation. It
  names each worktree and branch, the uncommitted files `--force` would discard,
  and the commits on a branch that are on no remote and no other local branch.
  Cancelling removes nothing and `나머지 정리` asks again. What is removed is read
  from Git again after the confirmation, and nothing is removed if it changed.
  A running attempt is refused until it is stopped. The removed attempts' sessions
  are hidden from the rail; their GJC history is not deleted.
- The group is one record in `agent-control-sessions.json`. If the app quits while
  attempts are being created, the unfinished ones are marked failed on the next
  start.

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

<!-- gjc-matrix:start -->
<!-- gjc-matrix:end -->

Gajae targets installed `gajae-code` version `0.18.12` or newer. The live
checks below distinguish confirmed behavior from remaining runtime limitations;
the versions marked **verified on 0.19.0** were re-run against the installed
`gjc/0.19.0` release. It uses only the credential-free public surface:

```text
gjc sdk session list|inspect|send|status|tail
gjc sdk session raw control|query|global
```

Two flag rules from the 0.18.12 grammar are load-bearing:

- Every invocation passes `--json`. Failures answer a `gjc.command-error` envelope
  there, and plain human text without it, which the app cannot classify.
- Only `session list` passes `--repo`. Exact-session verbs resolve from the session
  ID and warn that the flag is ignored; `raw control` and `raw global` reject it as
  a usage error before dispatch. `session list` also states `--scope` explicitly
  because the 0.18.12 default scope is `repo`, which fails outside a git checkout.

Create, fork, resume, and delete use `raw global` with a fresh lifecycle
idempotency key. Prompt submission uses semantic `send` with a fresh operation
reference and reconciles completion with `status` plus the durable transcript.
Model, effort, commands, context, and capabilities use `raw query`. Live lifecycle
catch-up uses bounded `tail --all-events` reads with checkpoint cursors; the
session-file watcher remains the transcript source of truth.

The desktop additionally starts a read-only `sdk serve --stdio --session <id>`
relay for each attached session. After `hello`, it negotiates `turn_stream` and
`session_host_observer_v1` using `event_replay`. Tool updates replace the previous
output snapshot; `tool_execution_end` finalizes it. The relay reconnects after
failure and is terminated on detach or shutdown, without signalling the agent.
Durable tail/file reads remain authoritative. The app never opens a session
WebSocket itself, reads endpoint credentials, or uses discovery records to attach.

**Verified on 0.19.0.** The observer negotiation now delivers live
`tool_execution_start/update/end` frames during a multi-second bash loop:
`AGENT_CONTROL_GJC_PRESET=<working-profile> node scripts/gjc-tool-stream-e2e.mjs`
reported four intermediate running snapshots (`GJCLINE1` through `GJCLINE4`) that
were replaced, never appended, plus the authoritative completed result. Upstream
[PR #6832](https://github.com/Yeachan-Heo/gajae-code/pull/6832) fixed broker
observer delivery after v0.18.12 and is included in v0.19.0. Until that release
the same probe received no tool frames at all, so a build older than 0.19.0 still
has no live tool output. Partial bash output is labelled as a snapshot whose
beginning may be omitted: upstream tail-only updates do not always carry explicit
truncation metadata.

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

**Resolved in 0.18.12.** 0.18.11 answered the terminal abort with
`{turn:"no_active_turn", terminal:"terminal_no_effect"}` through this route even
while a turn was verifiably running (`status` in_flight and `turn.steer` accepted
on the same session), and the turn kept running. The same payload over a live
`sdk serve --stdio` connection was rejected with `operation_prohibited` ("Operator
terminal aborts are available only through the Broker control route"). Stop
therefore reported that it could not confirm the abort instead of claiming the run
stopped; the transcript stayed the source of truth for whether work continued.
Upstream https://github.com/Yeachan-Heo/gajae-code/pull/6776 (reported as
https://github.com/Yeachan-Heo/gajae-code/issues/6772) scoped the active-submission
lookup to the broker-authorized `operator` flag. On 0.18.12 the route does confirm
`turn:"stopped"` once the host has registered the active submission, and Gajae
re-asks briefly because a local `running` event precedes that registration. The
0.18.12 e2e still reproduced `no_active_turn` while a 30-second bash turn was
verifiably running; that path remains unconfirmed and is never reported as
stopped. Re-run on 0.19.0, `scripts/gjc-cancel-e2e.mjs` reports
`terminalAbortVerified: true`, `finalStatus: idle`, and `transcriptStable: true`
with the host actually executing a bash turn. Only `turn:"stopped"` is treated as
a confirmation. Confirmed cancellation remains idle during discovery even when
the durable file ends at an aborted tool result rather than a terminal assistant
message. The local cancellation notice survives durable refreshes. Upstream
#6860 (in 0.19.0) also stopped a direct CLI `/new` from leaving the previous
session id live; measured on 0.19.0, the old row became `live:false` and the new
id was registered under the same pid.

**Resolved in 0.18.12.** `session.delete` requires the durable transcript path,
and a call that omits it is refused with `invalid_input` ("session.delete requires
sessionPath and its configured cwd."). 0.18.11 rendered that refusal as
`operation_failed` ("The operation failed. Its outcome could not be established.",
`outcomeCertainty: unknown`, retryability `unknown`, guidance "do not blindly
retry"), so a refused delete was indistinguishable from a delete that may have
half-applied. Upstream https://github.com/Yeachan-Heo/gajae-code/pull/6777 adds the
`lifecycle_input_refused` diagnostic for that admission refusal. Gajae still passes
the path it located; an unknown outcome preserves the transcript, metadata, and
worktree and marks the session as recovering rather than reporting a deletion it
cannot prove. Close-then-delete succeeds for a session that only replied, but a
session containing tool execution still answered an unknown outcome on 0.18.12
(upstream #6828).

**Verified on 0.19.0.** The limitation remains: a disposable session that ran one
bash tool, and a separate empty session that never received a message, both got
`operation_failed` with `outcomeCertainty: unknown` and stayed `deleted:false`.
Neither response carried the `lifecycle_legacy_history_ambiguous` diagnostic, so
per the 0.19.0 guidance the legacy ledger fence was not the reported cause.

**Root cause identified on 0.19.0.** The broker settled each delete and persisted
the correct terminal row, then rejected its own read-back: `readTerminal` scans
every ledger row and returns `shape` on three rows from a 2026-10-15
`cleanup_pending` receipt whose `artifactTree.snapshot.entries` array has 1066
entries, over `isBoundedLedgerJson`'s 1024-element cap.
`verifyTerminalPersistence` converts that rejection into `terminal_uncertain`, and
the public CLI reports it as `operation_failed` without diagnostics. A copy of
the ledger with only those three rows removed returns the real
`invalid_input` / `lifecycle_input_refused` response, so this is GJC ledger
self-poisoning, not an app path. Upstream report:
[#7134](https://github.com/Yeachan-Heo/gajae-code/issues/7134). The owner-local
CLI session picker does not go through this broker read-back and remains the
supported way to delete saved history until GJC repairs or compacts the ledger.
The app never edits, truncates, or deletes the ledger, and a live host this
window created, forked, or resumed is closed first; a terminal's host is never
signalled.

Gajae now preserves the public envelope's diagnostics and outcome certainty.
`lifecycle_input_refused` produces an actionable input-refusal error, but it is not
proof that deletion was unapplied: unless broker reconciliation proves deletion,
the session remains recovering and all local evidence is retained. There is no
automatic retry. The existing empty `27f32a06…` probe failed deletion on 0.18.12
and still did on 0.19.0 with an unknown outcome and `deleted:false` (see
[upstream #6828](https://github.com/Yeachan-Heo/gajae-code/issues/6828)).
PR #6832 adds the `lifecycle_legacy_history_ambiguous` diagnostic, not permission
to clear the admission fence, and v0.19.0 includes it. That diagnostic was absent
from the 0.19.0 delete attempts above because admission passed: the failure came
from the post-persistence read-back described above, not from the legacy
`accepted` row. The isolation experiment removed rows only from a copy of the
ledger; the live ledger was never edited. Gajae surfaces the diagnostic
distinctly when a broker does return it and retains the session and evidence: the
current request was not dispatched, but earlier effects remain unresolved.
Preserve the original operation, request key, target, and ledger; do not edit the
ledger, force deletion, or retry under a new key. v0.19.0's new
`gjc sdk session retire` (`session.reconcile_uncertain`) only retires an indexed
`terminalUncertain` create effect with dead-host proof; it is not an override for
opaque legacy history.

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

Creating and forking both hit this for work that had already succeeded. The broker
index is consulted for the retained session instead of raising an error; the error
is raised only when nothing appears. GJC's public list/inspect projection strips
the ledger's internal `lifecycleRequestId`, so the caller's idempotency key never
matches a row: the app adopts the one new live generation>=1 session in that
workspace whose endpoint appeared after the request began. Two such sessions mean
a concurrent creator and stay a reconciliation error rather than a guess. A
resumed session stays readable and marked `recovering`, since its transcript comes
from the session file either way and only live control is unproven.

The receipt failures themselves come from the GJC ledger and are not fixable here.
On 0.18.12 the broker logs `mismatches:["readBack:shape"]` when one unrelated
ledger row exceeds its JSON field bound (for example a large `cleanup_pending`
response), which makes every terminal read-back look rejected. Do not edit the
ledger to clear it; the broker index is the recovery authority.

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
