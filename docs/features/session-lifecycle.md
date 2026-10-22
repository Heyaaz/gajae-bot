# Session lifecycle

A user can create a GJC session in a workspace, switch between live sessions in the rail,
find text across saved conversations, open a past session from disk, re-host it for
execution, fork it, rename it, remove it from the rail, or delete its saved history. The
rail lists live sessions; the history picker reads saved sessions from the same directory
the GJC CLI uses, so a session that has no live broker row is still reachable.

## Sub-features

- `SESSION-CREATE` — create a live session in a workspace, optionally in a managed worktree.
- `SESSION-SELECT` — switch the conversation by rail click or `⌘1`–`⌘9`; selection marks the row read.
- `SESSION-SEARCH` — search messages, plans, tool output, and attachment content across all saved conversations.
- `SESSION-HISTORY` — list saved sessions from disk and open one into the window.
- `SESSION-RESUME` — retry attachment or re-host a non-live session so it accepts new work.
- `SESSION-FORK` — create a new session from the selected session's recorded state.
- `SESSION-RENAME` — rename a rail row without changing its GJC transcript.
- `SESSION-DELETE` — confirmed removal of the session process and saved transcript.
- `SESSION-HIDE` — remove a row from the rail without deleting anything GJC owns.

## How to get to it (user POV)

- Create: the rail `+` (`title="새 Gajae 세션"`) and the empty workspace button
  `새 세션` open the `새 GJC 세션` dialog. `⌘T` creates immediately in the selected
  session's workspace (or the connection workspace; it opens the dialog only when no
  workspace is known). The composer command `/new` and the composer's workspace switcher
  (`세션을 시작할 workspace` → a recent folder or `다른 폴더 선택…`) also create
  immediately in the chosen workspace.
- Create dialog: `세션 이름`, `작업 격리` (`현재 workspace에서 작업` or
  `별도 worktree 생성` with optional `안전한 브랜치 (선택)`), and `프로젝트 위치`
  (`선택…` opens the native folder picker). `세션 만들기` submits; `취소` closes.
- Select: click any rail row. The native `Session` menu maps `⌘1`–`⌘9` to the filtered
  rail order (pinned first, then state groups, newest first). Selecting a row clears its
  `새 활동` dot through the backend.
- Search: click the rail field labelled `세션 검색`, or press `⌘K`. Both open the
  `전체 대화 검색` dialog with placeholder `메시지, 파일, 도구 실행 검색`. Clicking a
  result closes the dialog and reveals the matching message in its session.
- History: the rail footer button `title="지난 세션 이어서 진행"`, or the empty-rail
  `지난 세션 보기` button. The dialog `aria-label="지난 세션 이어서 진행"` searches by
  session ID prefix, title, or workspace; rows show a 12-character ID, time, and
  `N개 대화`, plus `진행 중` and `포크` badges. `더 보기 (N)` pages another 100 rows.
- Resume: right-click a row that is not attached and choose `세션 이어서 진행`, or open
  `세션 정보` and click `세션 이어서 진행`. The button shows `이어서 진행 중…` while
  working.
- Fork, rename, delete, hide: right-click a rail row to open its context menu, then
  choose `현재 상태에서 포크`, `이름 변경`, `삭제`, or `목록에서 숨기기`.
- Delete confirmation: the in-app `세션 삭제` dialog titled `세션을 삭제할까요?` with
  `취소` and `삭제`.

## Driving it with Codex Computer Use

Preconditions: the baseline instance from `README.md` is running and connected;
`$MAP_ROOT/workspace` is a git repository with one commit; `MAP-SESSION` exists and has
at least one completed turn for the history/search journeys; no modal is open;
`MAP_ROOT` is exported.

- **SESSION-CREATE — create from the rail.**
  Action: click `+`, fill the dialog, submit.
  ```bash
  cu "In Gajae, click the sidebar button titled '새 Gajae 세션'. In the dialog labeled '새 GJC 세션', set 세션 이름 to MAP-SESSION-CREATE, keep '현재 workspace에서 작업', leave 프로젝트 위치 at $MAP_ROOT/workspace, and click '세션 만들기'. Save $MAP_ROOT/evidence/SESSION-CREATE-01.png and report the new row title, selected row, header title, and whether the transcript is empty."
  ```
  Observable: a temporary `starting` row appears immediately, then is replaced by the
  real session row; it stays selected, the header shows `MAP-SESSION-CREATE`, and the
  transcript is empty. After a relaunch the session is offered by the history picker
  rather than assumed live in the rail.
  Cross-check:
  ```bash
  python3 - "$MAP_ROOT" <<'PY'
  import json, os, sys
  p = os.path.join(sys.argv[1], "user-data", "agent-control-sessions.json")
  print(json.load(open(p))["ownership"])
  PY
  ```

- **SESSION-CREATE — immediate entry points.**
  Action: use `⌘T` and `/new` separately; neither opens the dialog.
  ```bash
  cu "In Gajae with MAP-SESSION selected, press Command+T. Save $MAP_ROOT/evidence/SESSION-CREATE-03.png and report whether a new empty session was created immediately, its workspace, and whether the dialog appeared."
  cu "In the Gajae composer of MAP-SESSION, type exactly '/new' and press Enter. Save $MAP_ROOT/evidence/SESSION-CREATE-04.png and report the new row, its workspace, and whether the dialog appeared."
  ```
  Observable: `⌘T` creates and selects a new session in the selected session's workspace
  (or the connection workspace); `/new` creates and selects one in the current session's
  workspace. Both bypass the dialog. If no workspace is known, `⌘T` opens the dialog
  instead. These are separate entry points from the rail `+` journey.

- **SESSION-CREATE — worktree isolation.**
  Action: repeat the dialog with `별도 worktree 생성` and a synthetic branch.
  ```bash
  cu "In Gajae, click '새 Gajae 세션'. Set 세션 이름 to MAP-WORKTREE. Choose '별도 worktree 생성' and type map-worktree into '안전한 브랜치 (선택)'. Click '세션 만들기'. Save $MAP_ROOT/evidence/SESSION-CREATE-02.png and report the selected session and any visible worktree path."
  ```
  Observable: a new selected session appears; its workspace is a managed worktree, not
  `$MAP_ROOT/workspace` itself. Cross-check:
  ```bash
  git -C "$MAP_ROOT/workspace" worktree list
  ```
  lists a worktree for the new branch. If GJC refuses because the branch is checked out
  elsewhere or the repository has no commit, record the exact error and mark the journey
  unreachable with that precondition.

- **SESSION-SELECT — rail click.**
  Action: with `MAP-SESSION` and `MAP-SESSION-CREATE` both listed, click the older row.
  ```bash
  cu "In Gajae, click the sidebar row titled MAP-SESSION. Save $MAP_ROOT/evidence/SESSION-SELECT-01.png and report the header title, the highlighted row, and any unread dot that disappeared."
  ```
  Observable: the conversation switches to `MAP-SESSION`; that row is highlighted and its
  `새 활동` dot is gone. Cross-check: `agent-control-sessions.json` no longer marks that
  ID unread.

- **SESSION-SELECT — `⌘2`.**
  Action: press `⌘2` from the conversation.
  ```bash
  cu "In Gajae, press Command+2. Save $MAP_ROOT/evidence/SESSION-SELECT-02.png and report which row title is now selected and which shortcut badge it shows."
  ```
  Observable: the second row in the filtered rail order opens and shows its `⌘2` badge.
  This is a separate entry point; the click run does not prove it. Reordering the rail
  with a pin or project filter changes which row `⌘2` targets.

- **SESSION-SEARCH — global transcript search.**
  Action: press `⌘K`, search for the token from the first turn, open a result.
  ```bash
  cu "In Gajae, press Command+K. In the dialog labeled '전체 대화 검색', type MAP-TURN-1 and wait for results. Save $MAP_ROOT/evidence/SESSION-SEARCH-01.png, then click the first result and save $MAP_ROOT/evidence/SESSION-SEARCH-02.png. Report the result count, selected session, and whether the matching message was revealed."
  ```
  Observable: results show a session title, workspace, snippet, and kind; clicking one
  closes the dialog, selects that session, and reveals the matching message. Cross-check:
  no session file changes. Repeating with the rail search field exercises the other entry
  point; record it separately.

- **SESSION-HISTORY — list and open a saved session.**
  Action: complete a turn, quit, relaunch with the same isolated roots, then open the
  picker. Quit and relaunch are separate commands from the dialog action.
  ```bash
  cu "Quit Gajae with Command+Q. Report that the window closed."
  # Use the same launch path as baseline. With Vite still running in terminal A:
  GAJAE_USER_DATA_DIR="$MAP_ROOT/user-data" \
  GJC_CODING_AGENT_DIR="$MAP_ROOT/agent" \
  AGENT_CONTROL_WORKSPACE="$MAP_ROOT/workspace" \
  GJC_BIN="$(command -v gjc)" \
  npm run dev:desktop
  # Or, if the baseline used the built app:
  # GAJAE_USER_DATA_DIR="$MAP_ROOT/user-data" GJC_CODING_AGENT_DIR="$MAP_ROOT/agent" \
  # AGENT_CONTROL_WORKSPACE="$MAP_ROOT/workspace" GJC_BIN="$(command -v gjc)" npm run desktop
  cu "In the relaunched Gajae window, click the sidebar footer button titled '지난 세션 이어서 진행'. In the dialog, type MAP-SESSION into the search field, save $MAP_ROOT/evidence/SESSION-HISTORY-01.png, and report the matching rows, 12-character IDs, and badges. Click the MAP-SESSION row and save $MAP_ROOT/evidence/SESSION-HISTORY-02.png. Report the sidebar row, header title, transcript, and any read-only notice."
  ```
  Observable: the dialog lists the saved session from disk even when discovery no longer
  shows it in the rail; the row shows its 12-character ID, time, and conversation count,
  plus `진행 중` or `포크` when applicable. Clicking it closes the dialog, adds/selects a
  rail row, and displays the saved transcript. If no live endpoint can be recovered, the
  window shows `기록 보기 전용 · 실행 연결 없음`; record that state instead of claiming
  execution resumed.

- **SESSION-RESUME — retry attachment.**
  Action: open the read-only session's inspector or context menu and press resume.
  ```bash
  cu "In the open MAP-SESSION history view, click the header button titled '세션 정보'. In the inspector, click '세션 이어서 진행'. Save $MAP_ROOT/evidence/SESSION-RESUME-01.png and report the button label while busy, the resulting attachment state, and any error text. Then close the inspector."
  ```
  Observable: the button shows `이어서 진행 중…`; a non-live session is re-hosted and the
  composer becomes usable, while a live external session is attached without being
  replaced. If the route is refused, the exact app error remains visible and the window
  stays read-only. Repeating from the row's context menu is a separate entry point.

- **SESSION-FORK — fork the current state.**
  Action: right-click `MAP-SESSION`, choose `현재 상태에서 포크`.
  ```bash
  cu "In Gajae, right-click the sidebar row MAP-SESSION and choose '현재 상태에서 포크'. Save $MAP_ROOT/evidence/SESSION-FORK-01.png and report the new row title, whether it is selected, and the transcript state."
  ```
  Observable: a new selected row titled `MAP-SESSION (포크)` appears. Cross-check: a new
  session file exists under `$MAP_ROOT/agent/sessions`; the source row remains.

- **SESSION-RENAME — inline rename.**
  Action: right-click the fork row, choose `이름 변경`, type, press Enter.
  ```bash
  cu "In Gajae, right-click the row titled MAP-SESSION (포크) and choose '이름 변경'. Type MAP-RENAMED and press Enter. Save $MAP_ROOT/evidence/SESSION-RENAME-01.png and report the row title."
  ```
  Observable: the row title becomes `MAP-RENAMED`; pressing Escape instead leaves the old
  title. Cross-check:
  ```bash
  python3 -c 'import json,os;print(json.load(open(os.path.join(os.environ["MAP_ROOT"],"user-data","agent-control-sessions.json")))["aliases"])'
  ```
  contains the session ID mapped to `MAP-RENAMED`.

- **SESSION-HIDE — hide without deleting.**
  Action: right-click `MAP-RENAMED`, choose `목록에서 숨기기`.
  ```bash
  cu "In Gajae, right-click the sidebar row MAP-RENAMED and choose '목록에서 숨기기'. Save $MAP_ROOT/evidence/SESSION-HIDE-01.png and report whether the row disappeared, whether a dialog appeared, and whether the transcript opened elsewhere."
  ```
  Observable: the row disappears immediately with no confirmation dialog; the session's
  saved transcript remains on disk and the app shows no deletion claim. Relaunching the
  app keeps the row hidden.
  Cross-check: `agent-control-sessions.json` `hidden` contains the ID, and the matching
  JSONL file still exists:
  ```bash
  grep -RlF 'MAP-TURN-1' "$MAP_ROOT/agent/sessions"
  ```

- **SESSION-DELETE — delete a fresh session.**
  Action: create `MAP-DELETE` with no turns, right-click it, choose `삭제`, confirm.
  ```bash
  cu "In Gajae, create a new empty session named MAP-DELETE in $MAP_ROOT/workspace. Right-click its row, choose '삭제', and confirm in the dialog labeled '세션 삭제' by clicking '삭제'. Save $MAP_ROOT/evidence/SESSION-DELETE-01.png immediately and $MAP_ROOT/evidence/SESSION-DELETE-02.png after five seconds. Report the row state and any error text."
  ```
  Observable on success: the row disappears and stays gone; no confirmation dialog
  reopens. On GJC refusal: the row is restored, an error explains that deletion was not
  confirmed, and the session may become `복구 필요 · 읽기 전용`. Record the exact error
  and do not present a restored row as a successful delete. Cross-check whether the
  session JSONL still exists.

- **SESSION-DELETE — refused case with tool history.**
  Action: run a tool-using turn in a disposable session, then delete it.
  ```bash
  cu "In Gajae, use a session that has executed a tool, right-click it, choose '삭제', confirm '삭제', and save $MAP_ROOT/evidence/SESSION-DELETE-03.png. Report the exact error and whether the row was restored."
  ```
  Observable: on GJC 0.18.12 and 0.19.0 a session with tool execution commonly
  answers the delete with an unknown outcome. The app preserves the transcript and
  marks the row
  `복구 필요 · 읽기 전용` instead of pretending deletion succeeded. This is a valid
  observed outcome, not a test failure; report it as the known limitation.

## Gotchas

- The history picker reads `$GJC_CODING_AGENT_DIR/sessions`. If that environment variable
  is missing from the Electron process, it lists the real profile instead of the
  disposable one. Verify the path before trusting any history row.
- `SESSION-DELETE` is not guaranteed on GJC 0.18.12 or 0.19.0. A session that has
  executed a tool can return an uncertain delete outcome; the app keeps the row and
  transcript and marks the session recovering/read-only. Do not retry with a new key
  or force-delete files.
- `SESSION-HIDE` is local bookkeeping only. It is not a soft delete and does not remove
  the transcript; the two context-menu items are separate for that reason.
- Opening an old session can succeed as a read-only transcript with
  `기록 보기 전용 · 실행 연결 없음`. That is not a resumed execution. `세션 이어서 진행`
  is the retry path; only a non-live session is re-hosted.
- The resume entry point is offered only while the row is not attached. If the history
  open attached directly, the button and context-menu item are absent; record the journey
  as unreachable with that observed attachment state instead of forcing it.
- Creating a worktree needs a git repository with a commit and a branch that is not
  checked out in another worktree. A bare `git init` with no commit fails.
- `⌘1`–`⌘9` index the filtered rail, not creation order. Pin state, status groups, and
  the project selector all change the mapping.
- `⌘K` searches transcripts; it does not filter the rail. The rail search field opens the
  same dialog. Typing in it will not reduce the row list.
- Selecting a row marks it read asynchronously. The unread dot may remain for one backend
  round trip; do not call it a failure at the first frame.
- A long session title is summarized to 72 characters in the history dialog; search a
  stable token or the 12-character ID instead of the full display title.
- The history list renders 100 rows at a time; use the search field or `더 보기 (N)` for
  older sessions.
- The delete dialog is in-app, not a native macOS confirmation. A native dialog in a
  screenshot belongs to a different action.
- Relaunch with the explicit environment, never `open -a Gajae`. The macOS app launcher
  does not carry `GAJAE_USER_DATA_DIR`, `GJC_CODING_AGENT_DIR`, or `GJC_BIN`, so the
  relaunched app silently uses the real profile and the history journey becomes invalid.
- `SESSION-HISTORY` must use the same launch path as the baseline. Do not quit a Vite
  instance and relaunch with `npm run desktop` unless `npm run build` produced a current
  `dist-electron`; otherwise the app opens an older or missing bundle.
- `/new`, `⌘T`, and the composer workspace switcher can create a session immediately,
  without the `새 GJC 세션` dialog. Do not use them to prove the dialog's fields. Only the
  rail `+` and the empty workspace `새 세션` button are guaranteed to open the dialog.
