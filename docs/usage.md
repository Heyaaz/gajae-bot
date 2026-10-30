# Using Gajae

The full guide to the desktop app. For a short tour, see the [README](../README.md).

## GJC setup details

The first launch installs GJC when it is missing (see the [README](../README.md#install)).
GJC `0.18.12` or newer is required (the newest verified compatibility target is
`0.19.0`); to install it yourself, run GJC's installer:

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

## Conversations

Type a request and press Enter. Files and images are sent as local paths. Images are opened with GJC `read` before the model answers.

## While a turn is running

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

## Model / effort

- `/model` — open the preset picker
- `/model codex-medium` — switch immediately. A unique preset prefix also matches. Unknown names are not sent as chat; they show an error
- `Shift+Tab` — cycle thinking effort

The model picker has a separately scrollable profile list and Fast on/off
controls when the session advertises `service_tier.set`. `/fast` or `/fast toggle`
toggles configured intent; `/fast on`, `/fast off`, and `/fast status` are also
available. Configured Fast intent does not prove a provider applied priority service.

## Reasoning cards

Reasoning cards follow one window-wide preference instead of per-card state:
펼치기 on any card expands every reasoning card, including later turns and other
sessions, and 접기 collapses them all. The value persists in
`agent-control-settings.json` and can also be set in 설정 → GJC → 추론 카드 펼치기.
Streaming cards keep their header, `생각 중…` label and spinner, and follow the
same setting for their content.

## Slash commands and skills

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

## File mentions

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

## Shortcuts

| Key         | Action                |
| ----------- | --------------------- |
| `⌘T`        | New session           |
| `⌘1`–`⌘9`   | Select session        |
| Esc         | Abort the current run |
| `Shift+Tab` | Cycle effort          |

## Links from other apps

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

## Session delete

Delete targets saved history, not its host process and not just the sidebar row.
Gajae requests `session.delete` with the exact session ID, configured location and
transcript path; it never calls `session.close` to make deletion possible. This
preserves a CLI that may have switched to another conversation with `/new`.
The CLI picker can delete old history through its owning `SessionManager`, but
GJC 0.19.0's public SDK still does not expose that owner-local flow; saved history
deletion and its unknown-outcome fence are described under
[GJC SDK session CLI compatibility](development.md#gjc-sdk-session-cli-compatibility). A refusal
or unknown outcome leaves the row and local evidence intact and shows an error;
use that CLI's session picker for owner-local history deletion.

When the broker cannot settle the delete (an unknown outcome, or the
`lifecycle_legacy_history_ambiguous` fence that gjc/0.19.2 raises for every
delete once the agent dir's lifecycle ledger holds legacy rows), Gajae deletes
through GJC's own interactive `/session delete` instead
(`electron/gjc-cli-session-delete.ts`). `gjc -p` does not run slash commands
(it sends them to the model), so Gajae opens the transcript with
`gjc --resume <path> --no-mcp --no-lsp` in a hidden terminal, with
`GJC_AUTOMATION=1` so first-run onboarding does not open over the editor. It
types the command, chooses Yes only on GJC's own deletion prompt with Yes
already selected, presses Esc on any other dialog, and stops GJC once the
transcript is gone. That also discards the empty session GJC opens after
deleting. It never edits the ledger. It does this only for a saved transcript
that no host is running.

A session another GJC holds open (usually an interactive `gjc` in a terminal) is
deleted from the app too. The delete confirmation names that GJC (its terminal
and pid, read from the broker row's `pid` and checked with `ps`) and offers
`GJC 종료 후 삭제`; the answer is bound to that pid, so if a different process
holds the session when the delete runs, nothing is stopped and the user is asked
again. Gajae sends that GJC SIGTERM, waits up to 10 s for it to exit (it is
never SIGKILLed), waits for the broker to drop `live`, then deletes as above. A
row still marked `live` whose process is gone holds nothing and is deleted
without asking to stop anything. A GJC stopped this way can exit before
releasing its session-store lock, and gjc/0.19.2 reclaims a dead owner's lock
only after its 60 s lease, answering `/session delete` with "Another session
migration is still active" until then; the hidden terminal starts over in a new
GJC every 10 s, up to six runs. If GJC exits, times out (45 s per run) or shows a
prompt it does not expect, the session stays recovering and nothing local is
removed.

`node scripts/gjc-cli-delete-e2e.mjs` (also the `cli-delete-e2e` step of
`npm run gjc:matrix`) reproduces the fence with a legacy ledger row in a
throwaway HOME and agent dir and deletes through the real GJC: a saved session
in about 14 s, and a session held by an interactive `gjc --resume` in a pty in
about 15 s, or about 70 s when that GJC left its lock behind (6 of 6 runs passed on 0.19.2, two of them slow).

## CLI sessions

`새 세션 종류` in Settings > GJC decides whether 새 세션 opens a GJC chat in the
**app** (the default) or a terminal on the **CLI**. A request handed over with
the dialog, from quick input or a link, always opens the app. A CLI session opens a login shell in the
chosen folder, so `claude`, `codex`, or any other CLI runs there directly. The
app keeps the list in `terminal-sessions.json` under its user data, since GJC
does not know about these sessions.

- Switching to another session keeps the shell running. Coming back replays
  what it printed meanwhile, up to the last 512 KB.
- After a restart the session is still listed and opens a fresh shell in the
  same folder. Shells do not outlive the window that opened them.
- Rename and delete work from the sidebar. Delete asks in the host dialog, then
  closes the shell the way closing a terminal window does.
- Search, Inbox, notifications, remote access, model settings, and parallel
  runs only cover GJC sessions.

## Resume a session

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

## Permission handling

The Settings permission field is applied after create or resume with the public
`permission_mode.set` session control operation. `always-allow` maps to the
broker-hosted session's `allow` mode. There is no environment variable on a
desktop-owned agent child because Gajae has no agent child.

The session CLI has no reverse permission-request channel to the desktop. When
interactive prompting is selected, Gajae therefore fails closed instead of
silently granting tools: the broker-hosted session is placed in deny mode. This
can move back to an interactive prompt only when GJC exposes a public external
permission-answer operation.

## Open a past session

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

## Projects and the repository screen

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

## Parallel runs (Best-of-N)

The new-session dialog no longer starts parallel runs. Existing groups still
open in the comparison described here. A run of 2-4 attempts gives each
attempt its own managed worktree, a new branch (`<branch>-1`, `-2`, … or
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
- Removing the other attempts always goes through the host confirmation. It
  names each worktree and branch, the uncommitted files `--force` would discard,
  and the commits on a branch that are on no remote and no other local branch.
  Cancelling removes nothing and `나머지 정리` asks again. What is removed is read
  from Git again after the confirmation, and nothing is removed if it changed.
  A running attempt is refused until it is stopped. The removed attempts' sessions
  are hidden from the rail; their GJC history is not deleted.
- The group is one record in `agent-control-sessions.json`. If the app quits while
  attempts are being created, the unfinished ones are marked failed on the next
  start.
