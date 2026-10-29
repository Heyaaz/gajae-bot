# Model and effort

A user can choose the model profile, reasoning effort, and Fast service tier for the open
session without leaving the composer. The composer summary shows the current model,
effort, context usage, and a Fast badge when the runtime reports a fast tier. The same
controls are available through slash commands and keyboard shortcuts, and the Settings
screen chooses the default model profile for new sessions.

## Sub-features

- `MODEL-PICK` — open the model-profile menu and select a profile for the open session.
- `MODEL-SLASH` — `/model` opens the picker; `/model <name|prefix>` switches immediately and rejects unknown or ambiguous names.
- `MODEL-DEFAULT` — set the default preset used by newly created sessions in Settings.
- `EFFORT-CYCLE` — cycle reasoning effort with `Shift+Tab`.
- `EFFORT-MENU` — open `추론 Effort` with `/effort` and select a level.
- `FAST-TIER` — turn Fast on or off from the model menu or `/fast` commands; the badge follows the service tier the session reports.

## How to get to it (user POV)

- Composer summary button: `title="Model: /model · Effort: ⇧⇥"`. It shows the model
  display name, current effort, context usage, and a `Fast` badge when active.
- Clicking the summary opens the `모델 프로필` menu. It lists profiles in scrollable
  groups, shows `N개 사용 가능`, and includes a `Fast 모드` group when the runtime
  advertises `/fast`. The `추론 Effort` menu opens from `/effort`; `Shift+Tab` cycles
  effort without opening it.
- Slash commands: type `/model` and press Enter to open the profile menu, or type
  `/model codex-medium` (an exact value/name or a unique prefix) to switch immediately.
  Type `/effort` to open the effort menu.
- Keyboard: `Shift+Tab` cycles effort from anywhere in the window, including the composer.
- Fast: click `Fast on` or `Fast off` in the model menu while it is offered, or send
  `/fast`, `/fast toggle`, `/fast on`, `/fast off`, or `/fast status`.
- Default for new sessions: `설정 → GJC → 모델 프로필`, then `저장`. The field accepts a
  built-in preset or a custom ID from `models.yml`.
- Remote control clients render the same composer. View-only devices cannot submit or
  change these controls; the host enforces the paired permission and the remote surface
  is not mapped here.

## Driving it with Codex Computer Use

Preconditions: the baseline instance from `README.md` is running and connected;
`MAP-SESSION` is selected and attached; the runtime has advertised at least two model
options and at least one effort option; the session's current model is not
`codex-medium`; `MAP_ROOT` is exported. Check the actual menu contents in a screenshot
before choosing values, because profiles depend on the disposable GJC profile.

- **MODEL-PICK — switch from the composer menu.**
  Action: open the summary button, screenshot the profile list, select a different
  profile.
  ```bash
  cu "In Gajae, click the composer button whose tooltip is 'Model: /model · Effort: ⇧⇥'. Save $MAP_ROOT/evidence/MODEL-PICK-01.png and report the '모델 프로필' header, the available count, and every visible profile name. Click a profile different from the current one. Save $MAP_ROOT/evidence/MODEL-PICK-02.png and report the summary text and any error."
  ```
  Observable: the menu lists profiles grouped by source; selecting one closes the menu,
  the composer summary's model name changes, and no user bubble is added. If the runtime
  refuses a mid-turn change, the app error appears and the summary keeps the old profile.
  Reopen the menu to see the check mark on the selected profile; that is a separate
  observation of persisted session config. Cross-check: the next menu open still shows
  the new profile checked. A summary that claims the change while the old profile stays
  checked is a failure.

- **MODEL-SLASH — open the picker.**
  Action: send `/model` with no argument.
  ```bash
  cu "In the Gajae composer, type exactly '/model' and press Enter. Save $MAP_ROOT/evidence/MODEL-SLASH-01.png and report whether the profile menu opened, whether the composer cleared, and whether any user bubble appeared."
  ```
  Observable: the profile menu opens; the composer clears; no prompt is sent to GJC and
  no user bubble appears.

- **MODEL-SLASH — switch immediately.**
  Action: send `/model codex-medium` (or another exact visible value).
  ```bash
  cu "In the Gajae composer, type exactly '/model codex-medium' and press Enter. Save $MAP_ROOT/evidence/MODEL-SLASH-02.png and report the composer summary model name, any error, and whether a user bubble appeared."
  ```
  Observable: the summary updates to the selected profile; no user bubble is added. The
  matcher accepts an exact value or name, is case-insensitive, strips a leading
  `gajae-code/`, and accepts a unique prefix. Prove the exact and prefix forms as separate
  steps if both are claimed.

- **MODEL-SLASH — reject an unknown or ambiguous name.**
  Action: send a deliberately unknown name.
  ```bash
  cu "In the Gajae composer, type exactly '/model map-not-a-profile' and press Enter. Save $MAP_ROOT/evidence/MODEL-SLASH-03.png and report the composer error text, the composer value, and whether the model summary changed."
  ```
  Observable: the composer shows `알 수 없는 모델 프리셋: map-not-a-profile`; the text stays
  in the composer and the summary does not change. An ambiguous prefix produces the same
  error because only one match is accepted.

- **MODEL-DEFAULT — change the default for new sessions.**
  Action: open Settings, edit the GJC model profile, save, then create a session.
  ```bash
  cu "In Gajae, click the sidebar button titled '설정'. Open the GJC tab. Save $MAP_ROOT/evidence/MODEL-DEFAULT-01.png and report the current '모델 프로필' value. Change it to codex-eco and click '저장'; confirm the runtime settings confirmation and save $MAP_ROOT/evidence/MODEL-DEFAULT-02.png. Then create a new session in $MAP_ROOT/workspace and report which model profile its composer starts with."
  ```
  Observable: the settings field saves a non-empty profile ID; saving reconnects the GJC
  runtime and opens the host confirmation `런타임 설정을 적용할까요? …` with
  `취소`/`적용`. The `설정` dialog is not that confirmation. A newly created
  session starts from the new preset, while the already-open session keeps its current
  profile.
  Cross-check:
  ```bash
  python3 -c 'import json,os;print(json.load(open(os.path.join(os.environ["MAP_ROOT"],"user-data","agent-control-settings.json")))["modelPreset"])'
  ```
  reports `codex-eco`.

- **EFFORT-CYCLE — Shift+Tab.**
  Action: focus the composer, note the effort label, press `Shift+Tab`.
  ```bash
  cu "In Gajae, click the MAP-SESSION composer and report the effort text shown in the 'Model: /model · Effort: ⇧⇥' button. Press Shift+Tab once. Save $MAP_ROOT/evidence/EFFORT-CYCLE-01.png and report the new effort text and any error."
  ```
  Observable: the effort text changes to the next level the runtime offers; no user bubble
  is added. If the model does not support effort switching, the app error
  `현재 모델은 추론 effort 전환을 지원하지 않습니다.` appears and the value stays. Pressing
  again is a separate step; do not infer the full cycle from one transition.

- **EFFORT-MENU — open from the composer or `/effort`.**
  Action: open the effort menu and select a level.
  ```bash
  cu "In the Gajae composer, type exactly '/effort' and press Enter. Save $MAP_ROOT/evidence/EFFORT-MENU-01.png and report the '추론 Effort' header, the levels, and the checked level. Click a different level. Save $MAP_ROOT/evidence/EFFORT-MENU-02.png and report the composer effort text."
  ```
  Observable: `/effort` opens the `추론 Effort` menu with the current level checked;
  selecting another level updates the composer summary and adds no user bubble. The
  `⇧⇥` hint is a label on that menu, not a second entry point.

- **FAST-TIER — toggle from the model menu.**
  Action: open the model menu, click `Fast on`, observe the badge, then `Fast off`.
  ```bash
  cu "In Gajae, open the model menu from the 'Model: /model · Effort: ⇧⇥' button. If a group labeled 'Fast 모드' is present, save $MAP_ROOT/evidence/FAST-TIER-01.png and click 'Fast on'. Save $MAP_ROOT/evidence/FAST-TIER-02.png and report the button aria-pressed state, the composer Fast badge, and any error. Then click 'Fast off' and save $MAP_ROOT/evidence/FAST-TIER-03.png."
  ```
  Observable: when the runtime advertises Fast, `Fast on` becomes pressed, the summary
  shows a `Fast` badge with tooltip `Fast 모드 켜짐`, and `Fast off` clears both. The badge
  follows the service tier the session reports, not the click itself; a refused request
  leaves it off and surfaces an error. If no `Fast 모드` group exists, record `unreachable`
  with the attempted menu and the missing `/fast` advertisement.

- **FAST-TIER — slash entry points.**
  Action: send `/fast on`, observe, then `/fast off`.
  ```bash
  cu "In the Gajae composer, type exactly '/fast on' and press Enter. Save $MAP_ROOT/evidence/FAST-TIER-04.png and report the Fast badge, any runtime output, and any error. Then type exactly '/fast status' and report the visible output."
  ```
  Observable: `/fast on` and `/fast off` are runtime controls; they add no prompt bubble.
  `/fast status` reports the configured intent. The badge is still the authoritative
  applied-tier indicator. Treat `/fast` and `/fast toggle` as separate claims and verify
  them individually if the proof needs them.

## Gotchas

- The model menu always renders a fallback profile even before the runtime advertises
  config options. A menu with only that one fallback does not prove switching; require at
  least two distinct visible profiles and screenshot them.
- Model switching mid-turn may be refused by the runtime. The menu stays enabled because
  it also carries Fast; an error is expected, not a UI crash.
- `Shift+Tab` is a window-level capture shortcut. It cycles effort even when focus is
  outside the textarea, unless a dialog owns the key.
- `/effort` only opens the local menu when the session advertises a thinking option. On a
  model without one, it can fall through to the runtime command surface; do not assume a
  menu appeared.
- The committed default model affects only new sessions. The open session keeps its own
  profile; using an old session to prove `MODEL-DEFAULT` is invalid.
- Saving Settings may re-run the runtime-settings authorization prompt and reconnect GJC.
  The host confirmation is not the `설정` dialog; a screenshot of the wrong
  surface does not prove the save.
- The Fast badge is driven by the reported service tier. `Fast on` being pressed is not
  proof that the provider applied priority service; read the badge and any refusal.
- Fast controls exist only when the runtime advertises `/fast`. A missing group is an
  unreachable precondition, not a failed `FAST-TIER` action.
- Custom profile IDs come from `models.yml`. The synthetic profile may not define
  `codex-eco` or any other built-in name; read the actual menu and use a visible value
  instead of assuming the examples in this map exist.
- A read-only history session may have no usable config options. Resume it or create a
  fresh session before testing model or effort changes.
