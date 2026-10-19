# Conversation turns

A user can run a GJC turn from the composer at the bottom of an open session. The request
appears immediately, the assistant reply streams into the transcript, and the same session
files remain readable by the GJC CLI. While a turn is live the composer can hold follow-up
work locally, steer the open turn, or stop it; after the turn ends the window returns to
idle and any held work is released.

## Sub-features

- `TURN-SEND` — submit a prompt and stream the assistant reply into the transcript.
- `TURN-QUEUE` — hold follow-up text locally while a turn runs, then release it on turn end or empty Enter.
- `TURN-STEER` — deliver `/steer <text>` immediately to the open turn.
- `TURN-STOP` — cancel the open turn and its owned work from the Stop slot, Escape, or `/abort`.
- `TURN-ATTACH` — attach up to 6 images and 5 files; images are read by GJC before the model answers.
- `TURN-COMMAND` — open the slash palette and run bundled, SDK, or skill commands.
- `TURN-FIND` — find text inside the open conversation with `⌘F`.

## How to get to it (user POV)

- Desktop: select a session in the left rail; the composer is at the bottom of the
  conversation. With no session selected, use `새 세션` or the rail `+` first.
- The composer textarea is labelled `<session title>에게 메시지 보내기` and shows the
  placeholder `무엇이든 요청하세요`.
- Enter submits. `Shift+Enter` inserts a newline. The submit slot holds one button: the
  send arrow when there is a draft, otherwise the Stop button while a turn runs.
- While a turn runs, a plain Enter holds work under the default `queue` behavior; an
  explicit `/queue` always holds, and `/steer` sends immediately. The held-work chip
  appears above the composer. Empty Enter releases held work. `Esc` or the Stop slot
  cancels.
- Attach through `이미지 첨부` and `파일 첨부`, the native file picker, or drag-and-drop
  onto the composer. Each attachment chip has a `Remove <name>` button.
- Type `/` to open the command palette. Bundled commands include `/steer`, `/queue`,
  `/abort`, `/compact`, `/new`, `/model`, and `/effort`; live SDK commands and
  `/skill:<name>` rows appear when the runtime advertises them.
- `⌘F` opens the in-conversation find bar. `Esc` closes it.
- Remote control clients render the same composer. A `보기 전용` device shows
  `보기 전용 기기입니다` and cannot submit; a `조작 가능` device can send, steer, queue,
  and cancel.

## Driving it with Codex Computer Use

Preconditions: the baseline instance from `README.md` is running and connected; a live
session named `MAP-SESSION` is selected; `TURN-SEND` has completed at least once so a
unique token exists in the transcript; tool-using prompts require
`설정 → GJC → 도구 승인 → 항상 허용` saved before session creation; no modal or dialog is
open; `MAP_ROOT` is exported.

- **TURN-SEND — send a prompt.**
  Action: click the composer for `MAP-SESSION`, type the literal prompt, press Enter.
  ```bash
  cu "In the Gajae window, select the session MAP-SESSION. Click the composer whose accessible label ends with '에게 메시지 보내기', type exactly 'MAP-TURN-1 reply with exactly MAP-OK and do not edit files', and press Enter. Save $MAP_ROOT/evidence/TURN-SEND-01.png. Report the visible user bubble, header status, submit-slot tooltip, and final assistant text."
  ```
  Observable: the composer clears and the exact user bubble appears immediately; header
  status becomes `Working`; with an empty draft the submit slot shows
  `title="작업 중단 (Esc)"`. On completion the assistant text contains `MAP-OK`, header
  status returns to `Idle`, and the send arrow returns.
  Cross-check:
  ```bash
  grep -RlF 'MAP-TURN-1' "$MAP_ROOT/agent/sessions"
  ```
  must print at least one session JSONL file.

- **TURN-SEND — submit with the arrow.**
  Action: type `MAP-TURN-2 reply with exactly MAP-ARROW-OK`, then click the send arrow
  instead of pressing Enter.
  ```bash
  cu "In the Gajae composer, type exactly 'MAP-TURN-2 reply with exactly MAP-ARROW-OK' and click the send button whose tooltip is '메시지 보내기'. Save $MAP_ROOT/evidence/TURN-SEND-02.png and report whether the bubble appeared and the composer cleared."
  ```
  Observable: same state transition as keyboard submit. This is a separate entry point;
  do not count it as proven by the Enter step.

- **TURN-QUEUE — hold follow-up work.**
  Action: start a slow base turn, then send a plain follow-up while status is `Working`.
  ```bash
  cu "In the Gajae window, send this prompt to MAP-SESSION: 'MAP-TURN-QUEUE-BASE use the bash tool to run sleep 25, then reply exactly MAP-BASE-DONE. Do not edit any file.' While the header still says Working, type exactly 'MAP-TURN-3 reply with exactly MAP-QUEUE-OK' and press Enter. Save $MAP_ROOT/evidence/TURN-QUEUE-01.png. Report the queue chip text and whether a user bubble for MAP-TURN-3 is visible yet."
  ```
  Observable: the second submission is not sent; the composer clears and a chip reading
  `1개 대기 중` appears, with `대기` on the entry. No `MAP-TURN-3` user bubble is visible
  while the base turn runs. When the base turn ends, the queued text is released
  automatically and its bubble appears, followed by `MAP-QUEUE-OK`.
  Cross-check immediately after the screenshot: `grep -RF 'MAP-TURN-3'` over
  `$MAP_ROOT/agent/sessions` must find nothing yet; after release it must find the token.

- **TURN-QUEUE — pull back and discard.**
  Action: click the queue chip to pull it back into the composer, then send it again and
  click the `대기 항목 버리기` button.
  ```bash
  cu "While a Gajae turn is running and a queue chip is visible, click the queue entry to pull it back into the composer. Report the textarea and chip state. Then submit it again with Enter, and click the button labelled '대기 항목 버리기'. Save $MAP_ROOT/evidence/TURN-QUEUE-02.png and report whether the chip disappeared and whether any MAP-TURN-3 bubble exists."
  ```
  Observable: pulling back restores the exact text into the composer and removes the
  chip; discarding removes the chip without sending. Cross-check: no `MAP-TURN-3` user
  message appears in the transcript.

- **TURN-QUEUE — empty Enter releases held work.**
  Action: with a chip still held, click the empty composer and press Enter.
  ```bash
  cu "In Gajae, with a queue chip visibly held, click the empty composer and press Enter once. Save $MAP_ROOT/evidence/TURN-QUEUE-03.png. Report whether the chip disappeared, whether the current turn was interrupted, and whether the held text appeared as a user bubble."
  ```
  Observable: the open turn is aborted through the owned-stop path, the held request is
  released in order, and the chip disappears. Depending on whether the host confirmed
  the stop, the released text arrives as a new prompt or as a steer; record which one the
  transcript shows instead of assuming. A `작업 취소됨` notice may appear.

- **TURN-STEER — steer an open turn.**
  Action: while a slow base turn runs, submit `/steer` text.
  ```bash
  cu "In Gajae, start this prompt in MAP-SESSION: 'MAP-TURN-STEER-BASE use the bash tool to run sleep 30, then reply exactly MAP-BASE-DONE. Do not edit any file.' While the header still says Working, type exactly '/steer MAP-TURN-4 reply with exactly MAP-STEER-OK after the current step' and press Enter. Save $MAP_ROOT/evidence/TURN-STEER-01.png and report whether a user bubble appeared immediately and whether any queue chip exists."
  ```
  Observable: the instruction text after `/steer ` appears as a user bubble immediately
  while the turn is still `Working`; no queue chip is created. The reply contains
  `MAP-STEER-OK`. Cross-check: `grep -RlF 'MAP-TURN-4' "$MAP_ROOT/agent/sessions"`
  finds the transcript.

- **TURN-STOP — stop from the Stop slot.**
  Action: start a long turn, then click the Stop slot with an empty draft.
  ```bash
  cu "In Gajae, send 'MAP-TURN-STOP-BASE use the bash tool to run sleep 60, then reply MAP-BASE-DONE. Do not edit any file.' to MAP-SESSION. Once the header says Working and the draft is empty, click the button whose tooltip is '작업 중단 (Esc)'. Save $MAP_ROOT/evidence/TURN-STOP-01.png and report the header status, the transcript notice, and the submit-slot state."
  ```
  Observable: the `작업 취소됨` notice appears in the transcript, header status returns to
  `Idle`, and the Stop slot becomes the send arrow. The session stays open.
  Cross-check: the session remains listed and can accept a following prompt.

- **TURN-STOP — Escape.**
  Action: repeat the long turn, then press Escape with focus outside a dialog.
  ```bash
  cu "In Gajae, start the sleep-60 prompt again, then click the transcript area and press Escape once. Save $MAP_ROOT/evidence/TURN-STOP-02.png and report the same visible states as the Stop-slot run."
  ```
  Observable: same cancellation notice and idle transition. This is a separate entry
  point; do not count it from the button run.

- **TURN-ATTACH — image and file.**
  Action: attach the synthetic PNG and a text file, then send.
  ```bash
  cu "In the Gajae composer for MAP-SESSION, click the button titled '이미지 첨부', choose $MAP_ROOT/workspace/map-pixel.png in the native picker, then click '파일 첨부' and choose $MAP_ROOT/workspace/README.md. Type 'MAP-TURN-ATTACH describe the attachments briefly' and press Enter. Save $MAP_ROOT/evidence/TURN-ATTACH-01.png and report both chip labels and the sent bubble."
  ```
  Observable: chips for `map-pixel.png` and `README.md` appear with
  `Remove <name>` buttons; sending clears the chips and appends a user bubble carrying
  the attachments. GJC reads the image before the model answers.
  Cross-check:
  ```bash
  grep -RlF 'map-pixel.png' "$MAP_ROOT/agent/sessions"
  ```

- **TURN-COMMAND — open and apply the palette.**
  Action: type `/`, select an entry, then clear the composer.
  ```bash
  cu "In the Gajae composer, type '/' and report the palette and its help text. Press ArrowDown once and Enter, then report the composer value. Clear the composer with Command+A and Backspace. Save $MAP_ROOT/evidence/TURN-COMMAND-01.png."
  ```
  Observable: the palette opens with `↑↓ 선택 · Enter 적용`; rows are labelled
  `/<command> — <description>`; a command with input leaves `/<name> ` in the composer,
  while a command without input executes immediately and leaves no raw command text.
  The available rows depend on the runtime; screenshot the actual list.
  Cross-check: a local control such as `/model` opens its menu and adds no user bubble
  to the transcript.

- **TURN-FIND — find inside the conversation.**
  Action: press `⌘F`, search for the first turn token, then close.
  ```bash
  cu "In the open MAP-SESSION conversation, press Command+F. Type MAP-TURN-1 into the field with placeholder '이 대화에서 찾기'. Report the match counter and the highlighted message, click the next-result button, then press Escape. Save $MAP_ROOT/evidence/TURN-FIND-01.png."
  ```
  Observable: the find bar appears, the counter shows a non-zero `N/M`, the matching
  message is revealed, next/previous step through matches, and Escape closes the bar.
  Cross-check: no new session file entry is written.

## Gotchas

- The repository README says `/steer` takes the visible held-work step and that empty
  Enter releases held work through steering. The app sends `/steer <text>` immediately
  as a steer; empty Enter first tries to stop the owned turn, then releases the held
  requests in order, and the delivery is a steer only if the stop was not confirmed.
  Expect a user bubble for `/steer`, and record the actual delivery for empty Enter.
  Do not write a proof that waits for a chip or a steer that never appears.
- Plain text while a turn runs is held only when the saved Enter-while-running
  preference is `queue` (the default) and nothing is already held. Explicit `/queue`
  always holds; explicit `/steer` never holds. Check the visible behavior if the
  preference was changed.
- The Stop slot and Escape while the composer is focused discard the composer's held
  queue after cancelling. Escape from elsewhere (for example the transcript) cancels the
  turn without discarding held work. Use a disposable scenario if the journey must show
  both cancellation and retained queue.
- Empty Enter with no held work is a no-op. It does not send an empty prompt.
- A dismissible dialog owns Escape. Close search, settings, resume, new-session, and
  delete dialogs before testing abort.
- The default `매번 확인` permission mode fail-closes tools to deny on GJC 0.18.12.
  Tool-using turns need `항상 허용` saved before the session is created, or a resume
  after the change.
- Queue and steer checks must happen while the header still says `Working`. If the base
  turn has already ended, the follow-up becomes a normal prompt and the queue chip never
  appears.
- Do not reuse the exact same prompt text twice in quick succession. The composer
  suppresses a duplicate submission; use a new MAP token per step.
- Attachments are local paths. A file outside the synthetic workspace may be denied by
  GJC's own tool policy even when the desktop permission is `항상 허용`.
- The image attachment limit is 6 per message and the file limit is 5. The picker
  silently clamps through the composer store; oversized runs are not a valid proof of a
  larger limit.
- A failed send restores the draft and shows an error. A restored draft is not proof
  that GJC received the prompt; check the transcript and session file.
