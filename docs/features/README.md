# Gajae feature map

**Map status: partially proven (2026-10-29).** The seven core journeys below were driven
against the built app and real GJC 0.19.0 by `scripts/live-journeys.cjs`. Every other journey
in the feature files remains a claim derived from source; treat it as unproven.

### Journey status

The driver calls the app's real preload bridge (`window.agentControlDesktop`) inside the real
window. It does not click rail rows, so the visual entry points stay unproven. Only the
region picker (`screencapture -i`) and the native confirmation dialog are stubbed.
Evidence lives in `<LIVE_ROOT>/evidence/<journey>.json` (kept outside the repository); each
file records the observed state and its cross-check.

| Journey | Status | Evidence on 2026-10-29 |
| --- | --- | --- |
| Create, send, abort | verified | `j1.json`: reply `OK` in the transcript and in the session file under the isolated agent dir; a 4000-line turn aborted mid-stream (status back to `idle`, output cut at 928) and the same session answered `AFTER`. |
| Resume a past session | verified | `j2.json`: after a full relaunch with every GJC process stopped, the session from the first launch is in the history list, opens with its 19 earlier items, and answers a question that needs them. The row reads `live: true` at launch, so the app re-adopts it rather than offering a cold file-only resume. |
| Worktree session | verified | `j3.json`: `git worktree list` shows the session workspace on branch `live-179/worktree-journey`, the main checkout stays on `main`, and the session answers inside the worktree. |
| Remote pairing | verified over loopback; Tailscale and phone unproven | `j4.json`: real host on `127.0.0.1:48791` serves the web client, `/api/state` is 401 without a token, a `view` device sees exactly the host's sessions and is refused a send with 403, a `control` device sends a message that the real session answers, and a revoked token reads 401. Tailscale was stubbed out on purpose; HTTPS over the tailnet and a real phone were not driven. |
| Menu bar and Dock badge | verified | `j5.json`: Tray title `▶︎1` and a running-session menu while the turn ran, Dock badge rising from `1` to `2` when the turn finished unread while another session was viewed, and falling back to `1` after it was read. |
| Best-of-N | verified | `j6.json`: two attempts, each with its own worktree and branch, session models `kimi-k3` and `deepseek-v4-flash` for presets `opencodego` and `open-weights-deepseek`; adopting attempt 1 removed nothing; cleanup answered Cancel changed nothing and Continue removed only attempt 2's worktree and branch. The confirmation dialog was a stub that recorded the exact text shown. |
| Quick input capture | verified for downscaling; Space overlay unproven | `j7.json`: a 5120x2880 PNG of 30,330,516 bytes became an 8,016,679 byte attachment at 2509x1411 through the app's own nativeImage path. Showing over another Space or a fullscreen app was not observed. |

Gajae is a macOS Electron desktop client for GJC sessions. The primary surface mapped
here is the desktop app. Secondary surfaces are the paired remote web/PWA client (same
shell over HTTPS, with `보기 전용` or `조작 가능` permission) and the GJC CLI, which shares
session files but never the live TUI connection. There is no public HTTP API in scope.

## Baseline preconditions

- macOS arm64, Node.js 24 or newer, `npm install` complete.
- GJC CLI 0.18.12 or newer on `PATH`; the map was written against `gjc/0.18.12`.
  `gjc --version` must report a compatible version before driving.
- Every run must be isolated. The app writes settings, session metadata, search index,
  artifacts, automations, and desktop services under `GAJAE_USER_DATA_DIR`; GJC writes
  sessions and model configuration under `GJC_CODING_AGENT_DIR`.
- Prepare one disposable root:

```bash
MAP_ROOT="$(mktemp -d /tmp/gajae-map.XXXXXX)"
mkdir -p "$MAP_ROOT/user-data" "$MAP_ROOT/agent" "$MAP_ROOT/workspace" "$MAP_ROOT/evidence"
git -C "$MAP_ROOT/workspace" init -q
printf '# synthetic map workspace\n' > "$MAP_ROOT/workspace/README.md"
git -C "$MAP_ROOT/workspace" add -A
git -C "$MAP_ROOT/workspace" -c user.email=map@example.invalid -c user.name=Map commit -qm init
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS8AAAAASUVORK5CYII=' \
  | base64 -d > "$MAP_ROOT/workspace/map-pixel.png"
export MAP_ROOT
```

- Start the app with the isolated roots. The documented development path is two
  processes: Vite in one terminal, Electron in another.

```bash
# terminal A
npm run dev

# terminal B
GAJAE_USER_DATA_DIR="$MAP_ROOT/user-data" \
GJC_CODING_AGENT_DIR="$MAP_ROOT/agent" \
AGENT_CONTROL_WORKSPACE="$MAP_ROOT/workspace" \
GJC_BIN="$(command -v gjc)" \
npm run dev:desktop
```

- For a built, non-hot-reload instance, use `npm run build` once and then the same
  environment with `npm run desktop` instead of the two-process pair.
- `GAJAE_USER_DATA_DIR` must be absolute. A relative value is ignored and the app falls
  back to the real `~/Library/Application Support/Agent Control`; stop if that happens.
- Verify isolation before driving. After launch, `$MAP_ROOT/user-data/productivity.sqlite`
  must exist. After the first session is created, its files must appear under
  `$MAP_ROOT/agent/sessions`; a session landing anywhere else means the agent directory
  was not isolated. If either check fails, quit and fix the environment. The settings
  and session-metadata JSON files appear only after the first save or metadata change.
- The isolated GJC agent directory starts empty. It needs a test-only provider profile.
  Never copy production credentials into this repository, and never point
  `GJC_CODING_AGENT_DIR` at `~/.gjc/agent` for a mutating journey. If the isolated profile
  cannot answer a prompt, the baseline is unreachable; stop instead of falling back to
  real data.
- For live-reload development, the two-process command above is the documented path.
  `dev:desktop` alone does not start Vite; `npm run build` plus `npm run desktop` is the
  built alternative.
- `npm run desktop:smoke`, `desktop:offline-smoke`, and the other smoke scripts prove
  mocked shell behavior only. They are not evidence for a live runtime journey.

### Permission setup for tool-using journeys

The default `도구 승인` value is `매번 확인`. GJC 0.18.12 has no reverse
permission-request channel to the desktop, so Gajae fail-closes an interactive prompt
into deny mode. Journeys that need a tool must set `설정 → GJC → 도구 승인 →
항상 허용` and save **before creating the session**. The setting is applied after create
or resume; changing it does not retroactively unlock an existing hosted session.

## Driving conventions

Primary driver: Codex Computer Use, as required for local Mac app UI.

```bash
cu() {
  "/Applications/ChatGPT.app/Contents/Resources/codex" exec -C "$PWD" --skip-git-repo-check \
    "Use the installed computer-use skill. $*"
}
```

- One `cu` call performs one action or one tight action cluster, names the exact control,
  and names the evidence path. Do not combine independent journeys.
- Prefer accessible names and visible Korean labels over CSS selectors. Stable handles:

| Handle | Control |
| --- | --- |
| `aria-label="세션 목록"` | mobile-width sidebar toggle |
| `aria-label="세션 검색"` | rail search field; opens global transcript search |
| `title="새 Gajae 세션"` | rail `+` button |
| `title="지난 세션 이어서 진행"` | history picker footer button |
| `title="설정"` | settings button |
| `aria-label="새 GJC 세션"` | new-session dialog |
| `aria-label="지난 세션 이어서 진행"` | history dialog |
| `aria-label="전체 대화 검색"` | global search dialog |
| `aria-label="<session title>에게 메시지 보내기"` | session composer |
| `title="메시지 보내기"` / `title="이어서 보내기"` | submit arrow |
| `title="작업 중단 (Esc)"` | Stop slot when the draft is empty and a turn runs |
| `title="Model: /model · Effort: ⇧⇥"` | model/effort summary button |
| `title="이미지 첨부"` / `title="파일 첨부"` | attachment buttons |
| `title="세션 정보"` | inspector |
| `title="변경 파일 보기"` | diff panel |

- Use `⌘K` for global search, `⌘F` for find-in-conversation, `⌘T` for a new session,
  and `⌘1`–`⌘9` for rail sessions. `⌘1`–`⌘9` follow the filtered rail order after
  project filtering, pinning, and state grouping, not raw creation order.
- Restore after mutation: quit the app (`⌘Q`), then relaunch with the same isolated
  roots to inspect persistence. Remove the whole disposable root only after quitting:
  `rm -rf "$MAP_ROOT"`. Never edit or delete the real `~/.gjc/agent` or the default app
  data directory.
- A modal or dialog owns Escape while open. Close dialogs before testing run abort.
- Setup actions are not proof. If baseline setup creates a session, repeat that entry
  point under its own feature ID before counting it.

## Proof and skip reporting

- Name every artifact `<FEATURE>-<SUB>-<step>`, for example
  `$MAP_ROOT/evidence/TURN-SEND-01.png`. Put the ID in the filename and in the report.
- For each step record: user action, resulting visible state, and one side-effect
  cross-check. A screenshot alone is not proof that GJC accepted the action.
- Useful read-only cross-checks:

```bash
grep -RlF 'MAP-TURN-1' "$MAP_ROOT/agent/sessions"
python3 -c 'import json,os;print(json.load(open(os.path.join(os.environ["MAP_ROOT"],"user-data","agent-control-sessions.json"))))'
python3 -c 'import json,os;print(json.load(open(os.path.join(os.environ["MAP_ROOT"],"user-data","agent-control-settings.json"))))'
```

- Report each step as `ID — action — observed state — cross-check — pass | fail |
  unreachable`. An unreachable path must include the attempted route and the unmet
  precondition or exact error text.
- Never verify one entry point through another. Clicking a rail row does not prove
  `⌘2`; the history dialog does not prove the inspector resume button.
- A timeout, spinner, or optimistic row is not a pass. Wait for the terminal state and
  cross-check the side effect.
- If a journey only reaches `기록 보기 전용 · 실행 연결 없음`, report the journey as
  partially reached, not passed.

## Features

- [Conversation turns](conversation-turns.md) — send, hold/queue, steer, stop,
  attachments, slash commands, and in-conversation find.
- [Session lifecycle](session-lifecycle.md) — create, select, search, open history,
  resume, fork, rename, delete, and hide.
- [Model and effort](model-effort.md) — model profile selection, reasoning effort, and
  Fast service tier.

Not mapped in this first pass: remote pairing and the PWA client, settings beyond the
permission/default-model preconditions, repository/issues/PR/CI views, projects,
worktrees, git stage/commit/push, diff and artifact panels, inspector details, goals,
subagents, automations, notifications, and GJC updates.
