// Proves three things about a long session that no unit test can hold, because all of
// them are layout properties of a real render:
//
//   1. The detail panel gets its own column instead of covering the transcript. Making
//      it an overlay was tried as a performance fix: it removed a 65ms reflow but hid up
//      to 157px of every visible row, cutting sentences off mid-line.
//   2. The transcript is virtualized. Keeping ~800 entries and 20,000 nodes live is what
//      made every width change re-wrap the whole document in one frame. Only rows near
//      the viewport may be mounted.
//   3. The model popover scrolls its own options. It is the tallest popover in the app
//      and the only one whose contents can outgrow it: at 37 profiles an unconstrained
//      menu is clamped by its max-height while the option list itself never overflows,
//      so the profiles past the clip cannot be reached at any window size.
//   4. Toggling that panel keeps the transcript where it was reading. The width change
//      re-wraps every block and throws every measured row height away, so the view has to
//      hold the block the viewport top sits on -- or, when it was following, the bottom.
//   5. A small downward wheel notch, inside the slack band under the newest content, moves
//      the view by a notch and leaves it there, and submitting a prompt hands the view back
//      to the newest content. Both corrections that keep the newest content in view are
//      deferred (80ms of chase, 120ms of settle timer), so this is the one case a scripted
//      scrollTop cannot stand in for: the intent comes from real input, and what arrives
//      afterwards on its own (a streamed reply under a reader who scrolled away) may not
//      move them.
//
// Below 980px there is no room for a third column, so the panel is deliberately an
// overlay; there it must be fully opaque instead of clear of the text.
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const failAfter = setTimeout(() => {
  console.error('Inspector open smoke timed out')
  app.exit(1)
}, 90_000)

// Enough entries that a non-virtualized transcript is obvious, and enough that the
// estimated scroll height is far off the real one -- the error is what made returning to
// the bottom land short. At 400 the estimate was close enough to hide that bug.
const SEEDED_ITEMS = 1200
// Must match estimateSize in transcript.tsx: a row still reserved at exactly this height
// is one the virtualizer never measured.
const ESTIMATED_ROW_PX = 140

const probe = `(async (seeded, ESTIMATED_ROW_PX) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !document.querySelector('.session-row'); i += 1) await wait(100);
  const row = document.querySelector('.session-row');
  if (!row) return { error: 'no session rows' };
  row.click();
  for (let i = 0; i < 80 && !document.querySelector('.transcript-column'); i += 1) await wait(100);
  const column = document.querySelector('.transcript-column');
  if (!column) return { error: 'transcript never rendered' };
  for (let i = 0; i < 80 && column.getBoundingClientRect().width < 100; i += 1) await wait(50);

  const transcript = document.querySelector('.transcript');
  const toggle = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('title') === '세션 정보',
  );
  if (!toggle) return { error: 'inspector toggle not found' };
  if (!document.querySelector('.inspector')) {
    toggle.click();
    for (let i = 0; i < 80 && !document.querySelector('.inspector'); i += 1) await wait(25);
  }
  const panel = document.querySelector('.inspector');
  if (!panel) return { error: 'inspector never rendered' };
  await wait(600);

  const slots = [...document.querySelectorAll('.transcript-slot')];
  if (slots.length === 0) return { error: 'no virtualized slots found' };
  const panelBox = panel.getBoundingClientRect();

  let visibleRows = 0;
  let overlappingRows = 0;
  let worstOverlapPx = 0;
  for (const slot of slots) {
    const box = slot.getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight || box.width === 0) continue;
    visibleRows += 1;
    const overlap = Math.min(box.right, panelBox.right) - Math.max(box.left, panelBox.left);
    if (overlap > 0) {
      overlappingRows += 1;
      worstOverlapPx = Math.max(worstOverlapPx, Math.round(overlap));
    }
  }

  const bodyBox = document.querySelector('.workspace-body').getBoundingClientRect();
  // Re-query: resizing between passes can leave the earlier reference detached, which
  // reports a zero-width box and would let the overlap checks pass on nothing.
  const liveColumn = document.querySelector('.transcript-column');
  const columnBox = liveColumn.getBoundingClientRect();
  const bg = window.getComputedStyle(panel).backgroundColor;
  const gap = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;

  // Scroll away and come back: rows above unmount, so the scroll height is an estimate
  // and returning used to land hundreds of pixels short, leaving a blank band under the
  // newest message with the 최신 내용으로 button stuck on screen.
  transcript.scrollTop = transcript.scrollHeight * 0.3;
  await wait(500);
  transcript.scrollTop = transcript.scrollHeight;
  await wait(1600);
  const gapAfterReturn =
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  const followButtonAfterReturn = [...document.querySelectorAll('button')].some((b) =>
    (b.textContent || '').includes('최신 내용으로'),
  );

  // Blank space below the last painted pixel, which is what a gap actually looks like.
  const viewport = transcript.getBoundingClientRect();
  let deepestPainted = -1e9;
  for (const slot of document.querySelectorAll('.transcript-slot')) {
    const slotBox = slot.getBoundingClientRect();
    if (slotBox.bottom < viewport.top || slotBox.top > viewport.bottom) continue;
    for (const node of slot.querySelectorAll('*')) {
      const box = node.getBoundingClientRect();
      if (box.height > 0 && box.bottom > deepestPainted) deepestPainted = box.bottom;
    }
  }
  const blankBelowContent = Math.round(viewport.bottom - deepestPainted);

  // Blocks must not overlap or drift apart. A row is only measured once mounted, so any
  // row still sitting on the 140px estimate is positioned wrong: measured live, that put
  // rows up to 549px on top of each other with the text stacked, and left gaps between
  // -154px and +81px where they should be uniform.
  const ordered = [...document.querySelectorAll('.transcript-slot')].sort(
    (a, b) => Number(a.dataset.index) - Number(b.dataset.index),
  );
  let overlappingBlocks = 0;
  let worstBlockOverlapPx = 0;
  let unmeasuredRows = 0;
  let worstBlockGapPx = 0;
  const blockGaps = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const current = ordered[i];
    const next = ordered[i + 1];
    if (Number(next.dataset.index) !== Number(current.dataset.index) + 1) continue;
    const startOf = (el) => Number.parseFloat((el.style.transform.match(/-?[\d.]+/) || [0])[0]);
    const reserved = startOf(next) - startOf(current);
    // A row still holding the flat estimate was never measured, so its position is wrong.
    if (Math.abs(reserved - ESTIMATED_ROW_PX) < 1 && current.offsetHeight !== ESTIMATED_ROW_PX)
      unmeasuredRows += 1;
    const overlap =
      current.getBoundingClientRect().bottom - next.getBoundingClientRect().top;
    if (overlap > 1) {
      overlappingBlocks += 1;
      worstBlockOverlapPx = Math.max(worstBlockOverlapPx, Math.round(overlap));
    }
    // Measured between painted pixels, not slot boxes. Cards used to add their own bottom
    // margins on top of the slot's padding, which is invisible in the box geometry -- the
    // margin is inside the measured height -- but doubled the gap a reader sees, so
    // spacing alternated between 20px and 40px down the transcript.
    const paintedEdge = (element, edge) => {
      let value = edge === 'bottom' ? -1e9 : 1e9
      for (const node of element.querySelectorAll('*')) {
        const box = node.getBoundingClientRect()
        if (box.height <= 0) continue
        if (edge === 'bottom') {
          if (box.bottom > value) value = box.bottom
        } else if (box.top < value) value = box.top
      }
      return value
    }
    // New user turns intentionally add top padding. Keep detecting accidental
    // gaps within turns by removing only that measured, explicit contribution.
    const scale = next.offsetHeight > 0 ? next.getBoundingClientRect().height / next.offsetHeight : 1;
    const turnGap = next.dataset.turnStart === 'true'
      ? Number.parseFloat(getComputedStyle(next).paddingTop) * scale : 0;
    const contentGap = Math.round(paintedEdge(next, 'top') - paintedEdge(current, 'bottom') - turnGap)
    worstBlockGapPx = Math.max(worstBlockGapPx, contentGap)
    blockGaps.push(contentGap)
  }

  return {
    windowWidth: window.innerWidth,
    mountedSlots: slots.length,
    seededItems: seeded,
    visibleRows,
    overlappingRows,
    worstOverlapPx,
    columnWidth: Math.round(columnBox.width),
    columnRight: Math.round(columnBox.right),
    panelLeft: Math.round(panelBox.left),
    panelOpaque: !/rgba\\([^)]*,\\s*0?\\.\\d+\\s*\\)/.test(bg),
    panelVisible: panelBox.width > 200,
    panelInsideBody:
      panelBox.right <= bodyBox.right + 1 &&
      panelBox.top >= bodyBox.top - 1 &&
      panelBox.bottom <= bodyBox.bottom + 1,
    bottomGapPx: Math.round(gap),
    atBottom: Math.abs(gap) < 60,
    gapAfterReturnPx: Math.round(gapAfterReturn),
    followButtonAfterReturn,
    blankBelowContentPx: blankBelowContent,
    overlappingBlocks,
    worstBlockOverlapPx,
    worstBlockGapPx,
    // Spacing must be uniform: one rule owns it, so every pair reads the same.
    blockGapSpreadPx: blockGaps.length
      ? Math.max(...blockGaps) - Math.min(...blockGaps)
      : 0,
    unmeasuredRows,
  };
})(${SEEDED_ITEMS}, ${ESTIMATED_ROW_PX})`

function check(result) {
  if (result.error) return [`error: ${result.error}`]
  const failures = []

  // Virtualization: a windowful of rows, not the whole session. The bound is a multiple
  // of what is actually on screen rather than the seeded total -- a transcript that drops
  // only its last few rows is still paying to lay out hundreds.
  const allowedSlots = Math.max(result.visibleRows * 6, 30)
  if (result.mountedSlots > allowedSlots) {
    failures.push(
      `${result.mountedSlots} rows mounted for ${result.visibleRows} on screen ` +
        `(max ${allowedSlots}) -- transcript is not windowed`,
    )
  }
  if (result.visibleRows === 0) failures.push('no transcript rows on screen')

  // The transcript must open on the newest message, which is the whole point of the view.
  if (!result.atBottom) {
    failures.push(`transcript sits ${result.bottomGapPx}px above the newest message`)
  }

  // ...and must get back there after scrolling away, without the follow button sticking.
  if (Math.abs(result.gapAfterReturnPx) > 60) {
    failures.push(
      `returning to the bottom landed ${result.gapAfterReturnPx}px short`,
    )
  }
  if (result.followButtonAfterReturn) {
    failures.push('최신 내용으로 button still showing after returning to the bottom')
  }
  // A negative value means the last row is cut off under the composer. Too small and the
  // newest message reads as glued to it: the gap has to be at least the 18px that
  // separates blocks from each other, or the last one looks attached to the input.
  if (result.blankBelowContentPx > 120 || result.blankBelowContentPx < 16) {
    failures.push(
      `${result.blankBelowContentPx}px between the last message and the composer`,
    )
  }

  // Blocks sit flush against each other: no stacking, no ragged spacing.
  if (result.overlappingBlocks > 0) {
    failures.push(
      `${result.overlappingBlocks} blocks overlap by up to ${result.worstBlockOverlapPx}px`,
    )
  }
  if (result.unmeasuredRows > 0) {
    failures.push(
      `${result.unmeasuredRows} rows positioned on the size estimate instead of measured`,
    )
  }
  // The slot's own padding is the only spacing, so anything much beyond it is a stray gap.
  if (result.worstBlockGapPx > 24) {
    failures.push(`${result.worstBlockGapPx}px gap between blocks`)
  }
  // And it must be the same gap everywhere, not alternating.
  if (result.blockGapSpreadPx > 6) {
    failures.push(
      `block spacing varies by ${result.blockGapSpreadPx}px instead of being uniform`,
    )
  }

  // A zero-width column means the measurement missed the element, not that the layout is
  // correct; without this the overlap checks below would pass vacuously.
  if (result.columnWidth <= 100) {
    failures.push(`reading column measured ${result.columnWidth}px wide`)
  }

  if (result.windowWidth >= 980) {
    // Wide enough for a third column: the panel must be clear of the text.
    if (result.overlappingRows > 0) {
      failures.push(
        `panel covers ${result.overlappingRows} rows (${result.worstOverlapPx}px)`,
      )
    }
    if (result.columnRight > result.panelLeft) {
      failures.push('reading column extends past the panel edge')
    }
  } else if (!result.panelOpaque) {
    // Narrow: the panel is an overlay by design, so it must not be see-through.
    failures.push('narrow-window panel overlays the transcript while translucent')
  }

  if (!result.panelVisible) failures.push('panel did not open')
  if (!result.panelInsideBody) failures.push('panel escaped the conversation area')
  return failures
}

// The model popover with an install-sized profile list. It is the tallest popover in
// the app and the only one whose contents can outgrow it, which is what broke: the
// option list grew the menu past its max-height, overflow: hidden clipped the menu, and
// the list itself never overflowed -- so the profiles past the clip could not be reached
// at any window size. The mock backend ships six profiles, so the list is padded to an
// install-sized one (a real config has around 37), then scrolled with real wheel input:
// a list that is clipped and one that scrolls look identical to a scripted scrollTop.
const MODEL_PROFILES = 37
const WHEEL_STEP_PX = 200

const openModelMenuProbe = `(async (profiles) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !document.querySelector('.composer-model > button'); i += 1) await wait(100);
  const trigger = document.querySelector('.composer-model > button');
  if (!trigger) return { error: 'model menu trigger not found' };
  if (!document.querySelector('.config-option-menu--model')) trigger.click();
  for (let i = 0; i < 80 && !document.querySelector('.config-option-menu--model'); i += 1) await wait(25);
  const menu = document.querySelector('.config-option-menu--model');
  if (!menu) return { error: 'model menu never opened' };
  const header = menu.querySelector('header');
  const scroll = menu.querySelector('.config-option-scroll');
  if (!header || !scroll) return { error: 'model menu has no header or option list' };

  const groups = [...scroll.querySelectorAll('.config-option-group')];
  const rowsIn = () => scroll.querySelectorAll('.config-option-group > button').length;
  if (groups.length === 0 || rowsIn() === 0) return { error: 'model menu has no options' };
  for (let i = 1, copies = Math.ceil(profiles / rowsIn()); i < copies; i += 1) {
    for (const group of groups) scroll.append(group.cloneNode(true));
  }
  await wait(120);

  // The app zooms its shell (.app-shell { zoom: 1.1 }), so rects inside it are in root
  // pixels while the styles they are checked against are in the shell's own pixels: a
  // menu sitting exactly on max-height reads 10% taller than its cap without this.
  const shell = document.querySelector('.app-shell');
  const appZoom = shell ? Number.parseFloat(window.getComputedStyle(shell).zoom) || 1 : 1;

  const menuBox = menu.getBoundingClientRect();
  const headerBox = header.getBoundingClientRect();
  const scrollBox = scroll.getBoundingClientRect();
  // Point at the list where a user can see it, which is not its centre while it is
  // running past the clipped edge.
  const visibleTop = Math.max(scrollBox.top, menuBox.top, 0);
  const visibleBottom = Math.min(scrollBox.bottom, menuBox.bottom, window.innerHeight);
  return {
    viewportHeight: Math.round(window.innerHeight),
    appZoom,
    optionCount: rowsIn(),
    menuTop: Math.round(menuBox.top),
    menuBottom: Math.round(menuBox.bottom),
    menuHeight: Math.round(menuBox.height),
    menuMaxHeight: Math.round(Number.parseFloat(window.getComputedStyle(menu).maxHeight)),
    headerTop: Math.round(headerBox.top),
    headerBottom: Math.round(headerBox.bottom),
    listTop: Math.round(scrollBox.top),
    listBottom: Math.round(scrollBox.bottom),
    listClientHeight: scroll.clientHeight,
    listContentHeight: scroll.scrollHeight,
    scrollRange: scroll.scrollHeight - scroll.clientHeight,
    listCenterX: Math.round((scrollBox.left + scrollBox.right) / 2),
    listCenterY: Math.round((visibleTop + Math.max(visibleTop, visibleBottom)) / 2),
  };
})(${MODEL_PROFILES})`

const readModelMenuProbe = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(250);
  const menu = document.querySelector('.config-option-menu--model');
  if (!menu) return { error: 'model menu closed while scrolling' };
  const header = menu.querySelector('header');
  const scroll = menu.querySelector('.config-option-scroll');
  const rows = [...scroll.querySelectorAll('.config-option-group > button')];
  if (rows.length === 0) return { error: 'model list is empty' };
  const lastBox = rows[rows.length - 1].getBoundingClientRect();
  const menuBox = menu.getBoundingClientRect();
  const headerBox = header.getBoundingClientRect();
  const scrollBox = scroll.getBoundingClientRect();
  const result = {
    optionCount: rows.length,
    scrollTop: Math.round(scroll.scrollTop),
    scrollRange: scroll.scrollHeight - scroll.clientHeight,
    menuTop: Math.round(menuBox.top),
    menuBottom: Math.round(menuBox.bottom),
    headerTop: Math.round(headerBox.top),
    headerBottom: Math.round(headerBox.bottom),
    listTop: Math.round(scrollBox.top),
    listBottom: Math.round(scrollBox.bottom),
    lastOptionTop: Math.round(lastBox.top),
    lastOptionBottom: Math.round(lastBox.bottom),
  };
  // Leave the page as the next pass expects it: menu closed, transcript back at the
  // newest message (a wheel that escapes the popover lands behind it).
  const trigger = document.querySelector('.composer-model > button');
  if (trigger) trigger.click();
  await wait(150);
  const transcript = document.querySelector('.transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
  return result;
})()`

const BOTTOM_TOLERANCE_PX = 60
// Rendered pixels, and the whole point of the check: the same block has to stay at the
// same place on screen. A block that moved to a different offset is a different sentence
// under the reader's eye, which is the jump being asserted against.
const HISTORY_TOLERANCE_PX = 4

// Opening and closing the detail panel changes the reading width, which re-wraps every
// block and discards every measured row height: the view then has to keep the block the
// viewport top sits on, and its offset, or stay at the bottom when it was following. Only
// a real click on the panel toggle produces that reflow, and nothing may scroll the
// transcript between a case's before and after readings -- doing so would mask the jump.
const toggleProbe = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const transcript = document.querySelector('.transcript');
  const toggle = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('title') === '세션 정보',
  );
  if (!transcript || !toggle) return { error: 'transcript or inspector toggle is missing' };

  const panelOpen = () => Boolean(document.querySelector('.inspector'));
  const columnWidth = () => {
    const column = document.querySelector('.transcript-column');
    return column ? Math.round(column.getBoundingClientRect().width) : 0;
  };
  const bottomGap = () =>
    Math.round(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight);
  const followButton = () =>
    [...document.querySelectorAll('button')].some((b) =>
      (b.textContent || '').includes('최신 내용으로'),
    );
  // The first entry the viewport top edge actually reaches, including one it only
  // partially shows. Re-queried every reading: a re-measure remounts rows.
  const topEntry = () => {
    const viewport = transcript.getBoundingClientRect();
    for (const node of document.querySelectorAll('[id^="transcript-"]')) {
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.bottom <= viewport.top + 1) continue;
      return { id: node.id, top: Math.round((box.top - viewport.top) * 10) / 10 };
    }
    return null;
  };
  // The reflow lands over several frames, so nothing is read until the position, the
  // height and the reading width have held still for two ticks in a row.
  const settle = async () => {
    let previous = '';
    let stable = 0;
    for (let i = 0; i < 40; i += 1) {
      await wait(40);
      const now = [
        Math.round(transcript.scrollTop),
        transcript.scrollHeight,
        transcript.clientHeight,
        columnWidth(),
      ].join(':');
      stable = now === previous ? stable + 1 : 0;
      previous = now;
      if (stable >= 2) return;
    }
  };
  const snapshot = () => ({

    open: panelOpen(),
    gap: bottomGap(),
    follow: followButton(),
    width: columnWidth(),
    entry: topEntry(),
    sameTranscript: transcript === document.querySelector('.transcript'),
  });
  const togglePanel = async () => {
    toggle.click();
    await wait(60);
    await settle();
    return snapshot();
  };

  const cases = {};
  if (panelOpen()) await togglePanel();

  // Following the newest message: opening the panel, then closing it, must leave the view
  // at the bottom both times.
  transcript.scrollTop = transcript.scrollHeight;
  await wait(700);
  cases.bottomOpen = { before: snapshot(), after: await togglePanel() };
  cases.bottomClose = { before: snapshot(), after: await togglePanel() };

  // Reading older content: the block at the viewport top is the reading position, and it
  // has to survive both directions of the toggle.
  transcript.scrollTop = Math.round(transcript.scrollHeight * 0.35);
  await wait(700);
  cases.historyOpen = { before: snapshot(), after: await togglePanel() };
  cases.historyClose = { before: snapshot(), after: await togglePanel() };
  return cases;
})()`

function checkToggles(cases, reflow) {
  if (cases.error) return [`panel toggle: ${cases.error}`]
  const failures = []
  const widthCheck = (label, before, after, expectWider) => {
    // Without a real width change there is no re-wrap, and the case would pass on an
    // overlay that never reflowed the text at all.
    if (!reflow) return
    const changed = expectWider ? after.width > before.width + 20 : after.width < before.width - 20
    if (!changed) {
      failures.push(
        `${label}: reading column did not ${expectWider ? 'widen' : 'narrow'} ` +
          `(${before.width} -> ${after.width})`,
      )
    }
  }
  const panelCheck = (label, after, expectOpen) => {
    if (after.open !== expectOpen) {
      failures.push(`${label}: panel is ${after.open ? 'open' : 'closed'} after the toggle`)
    }
    if (!after.sameTranscript) {
      failures.push(`${label}: the transcript was remounted by the toggle`)
    }
  }
  const bottomCase = (label, before, after, expectOpen, expectWider) => {
    panelCheck(label, after, expectOpen)
    if (Math.abs(after.gap) > BOTTOM_TOLERANCE_PX) {
      failures.push(
        `${label}: view sits ${after.gap}px from the newest message after the toggle`,
      )
    }
    if (after.follow) {
      failures.push(`${label}: 최신 내용으로 is showing while following the bottom`)
    }
    widthCheck(label, before, after, expectWider)
  }
  const historyCase = (label, before, after, expectOpen, expectWider) => {
    panelCheck(label, after, expectOpen)
    if (!before.follow) {
      failures.push(`${label}: older content was not detected before the toggle`)
    }
    if (!after.follow) {
      failures.push(`${label}: the view went to the bottom instead of keeping its place`)
    }
    if (!before.entry || !after.entry) {
      failures.push(`${label}: no entry at the viewport top to compare`)
    } else if (after.entry.id !== before.entry.id) {
      failures.push(
        `${label}: the block at the viewport top changed ` +
          `(${before.entry.id} -> ${after.entry.id})`,
      )
    } else {
      const moved = Math.abs(after.entry.top - before.entry.top)
      if (moved > HISTORY_TOLERANCE_PX) {
        failures.push(
          `${label}: the block at the viewport top moved ${moved.toFixed(1)}px`,
        )
      }
    }
    widthCheck(label, before, after, expectWider)
  }

  bottomCase('closed -> open at the bottom', cases.bottomOpen.before, cases.bottomOpen.after, true, false)
  bottomCase('open -> closed at the bottom', cases.bottomClose.before, cases.bottomClose.after, false, true)
  historyCase('closed -> open in history', cases.historyOpen.before, cases.historyOpen.after, true, false)
  historyCase('open -> closed in history', cases.historyClose.before, cases.historyClose.after, false, true)
  return failures
}

// The reported bug: typing in the composer made the blocks shake. Typing grows the
// composer, the composer takes its height from the transcript, and the transcript's
// scrollbar state flips as the two heights cross. The restoration was watching the
// column's clientWidth, which a scrollbar changes by its own width -- the column is a
// percentage of the scroller's content box -- so every flick ran a multi-frame anchored
// restoration on top of the keyboard, reading as the blocks jumping up and down.
//
// Two facts are measured. First, the space the transcript was given does not move while
// the scrollbar flickers, so nothing re-wraps and nothing may run: the restoration writes
// its correction into `scrollTop` from inside a frame loop, and that is what `restores`
// counts. Second, the two blocks under the reader's eye keep their offsets. The composer
// is grown the way typed lines grow it -- the same height rule the composer applies to
// itself, past the 196px where it starts scrolling its own text -- so the height that
// makes the scrollbar flicker is real rather than scripted.
const TYPED_LINES =
  'typing into the composer while the scrollbar flickers must not move the blocks below '.repeat(24)
// Matches the composer's own ceiling (composer.tsx): past this its textarea scrolls
// instead of growing, so the transcript keeps the height it had.
const COMPOSER_MAX_HEIGHT_PX = 196
const TYPING_SETTLE_MS = 250

const typingProbe = `(async (typed, settleMs, maxComposerPx) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !document.querySelector('.session-row'); i += 1) await wait(100);
  const row = document.querySelector('.session-row');
  if (!row) return { error: 'no session rows' };
  row.click();
  for (let i = 0; i < 80 && !document.querySelector('.transcript-column'); i += 1) await wait(100);
  const transcript = document.querySelector('.transcript');
  const column = document.querySelector('.transcript-column');
  const textarea = document.querySelector('.composer textarea');
  if (!transcript || !column || !textarea) return { error: 'transcript or composer is missing' };
  await wait(1200);

  // Reading older content, so the restoration has an anchor to preserve and a jump is
  // visible as a moved block rather than as a scroll position nobody can see.
  transcript.scrollTop = Math.round(transcript.scrollHeight * 0.45);
  await wait(900);

  // The correction loop writes from inside a requestAnimationFrame callback, while the
  // only scrollTop assignment a gesture or the follow correction makes happens outside
  // one, so the flag separates the restoration's writes from everything else.
  let inFrame = false;
  const restores = [];
  const requestFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    requestFrame((time) => {
      inFrame = true;
      try {
        return callback(time);
      } finally {
        inFrame = false;
      }
    });
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return descriptor.get.call(this);
    },
    set(value) {
      if (inFrame && this.classList && this.classList.contains('transcript')) {
        restores.push({ at: Math.round(performance.now()), value: Math.round(value) });
      }
      return descriptor.set.call(this, value);
    },
  });

  // The two blocks whose bounding boxes this is about: the first two entries painted in
  // the viewport, re-read every frame because a re-wrap remounts rows.
  // The two blocks the reader is looking at: the block the viewport top edge falls on, and the
  // one after it -- the same rule the transcript's own anchor uses. Deliberately not "every
  // entry intersecting the viewport": this case grows the composer by 159px, and the viewport's
  // bottom edge moves up with it, which dropped a block that was still there and still where it
  // was and read as a 999px move. The offset from the viewport top is what the reader's eye is
  // on; the bottom edge is the composer's business.
  const visiblePair = () => {
    const viewport = transcript.getBoundingClientRect();
    return [...document.querySelectorAll('.transcript-entry')]
      .map((entry) => ({ id: entry.id || 'tool-run', box: entry.getBoundingClientRect() }))
      .filter((entry) => entry.box.width > 0 && entry.box.height > 0 && entry.box.bottom > viewport.top + 1)
      .slice(0, 2)
      .map((entry) => ({ id: entry.id, top: Math.round((entry.box.top - viewport.top) * 100) / 100 }));
  };
  const geometry = () => ({
    readingWidth: transcript.offsetWidth,
    scrollTop: Math.round(transcript.scrollTop * 100) / 100,
    pair: visiblePair(),
  });

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  if (textarea.disabled) return { error: 'the composer is read-only in this window' };
  // The composer owns its own growth; this runs the same rule against the text it is
  // holding, so the height the transcript loses is the height typing really costs it.
  const growComposer = () => {
    textarea.style.height = 'auto';
    textarea.style.height = 
      \`\${Math.min(Math.max(textarea.scrollHeight, 52), maxComposerPx)}px\`;
  };
  // Emptied first: this probe runs at more than one window size against the same
  // renderer, and a composer left full from the previous case cannot grow again.
  textarea.focus();
  setter.call(textarea, '');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  growComposer();
  await wait(200);
  const composerHeightStart = Math.round(textarea.getBoundingClientRect().height);
  if (composerHeightStart >= maxComposerPx) {
    return { error: 'the composer starts at its ceiling (' + composerHeightStart + 'px)' };
  }
  const before = geometry();
  restores.length = 0;
  let stop = false;
  let driftPx = 0;
  const ticker = (async () => {
    while (!stop) {
      const pair = visiblePair();
      if (pair.length !== before.pair.length) {
        driftPx = Math.max(driftPx, 999);
      } else {
        for (let i = 0; i < pair.length; i += 1) {
          if (pair[i].id !== before.pair[i].id) {
            driftPx = Math.max(driftPx, 999);
          } else {
            driftPx = Math.max(driftPx, Math.abs(pair[i].top - before.pair[i].top));
          }
        }
      }
      await wait(16);
    }
  })();

  // Typed in two halves: the first grows the composer by a line, the second crosses the
  // height where the scrollbar flips.
  const half = Math.floor(typed.length / 2);
  let composerGrowthPx = 0;
  for (const chunk of [typed.slice(0, half), typed.slice(half)]) {
    textarea.focus();
    setter.call(textarea, chunk);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    growComposer();
    await wait(500);
    composerGrowthPx = Math.max(
      composerGrowthPx,
      Math.round(textarea.getBoundingClientRect().height) - composerHeightStart,
    );
    // The flicker itself: the scrollbar comes and goes without the transcript being
    // given a different width. The real composer does this to itself as lines are added.
    transcript.style.overflowY = 'hidden';
    await wait(300);
    transcript.style.overflowY = '';
    await wait(300);
  }
  await wait(settleMs);
  stop = true;
  await ticker;
  const after = geometry();
  return {
    restores: restores.length,
    // Bounded: only the frame times and values are useful in the log, and a long
    // restoration would otherwise print sixty of them.
    restoreWrites: restores.slice(0, 6),
    driftPx: Math.round(driftPx * 100) / 100,
    readingWidth: before.readingWidth,
    readingWidthAfter: after.readingWidth,
    textareaHeightBefore: composerHeightStart,
    textareaHeightAfter: Math.round(textarea.getBoundingClientRect().height),
    composerGrowthPx,
    composerValue: textarea.value.length,
    composerScrollHeight: textarea.scrollHeight,
    composerDisabled: textarea.disabled,
    columnWidth: column.clientWidth,
    columnWidthAfter: Math.round(column.getBoundingClientRect().width),
    scrollTopMoved: Math.abs(after.scrollTop - before.scrollTop) > 0.5,
    before,
    after,
  };
})(${JSON.stringify(TYPED_LINES)}, ${TYPING_SETTLE_MS}, ${COMPOSER_MAX_HEIGHT_PX})`

function checkTyping(result) {
  if (result.error) return [`typing: ${result.error}`]
  const failures = []
  // Without a composer that actually grew there is no height change and the case would
  // pass on a still frame. More typed text than 196px of it is what guarantees that.
  if (result.composerScrollHeight <= COMPOSER_MAX_HEIGHT_PX) {
    failures.push(
      `typing: the typed text is too short to grow the composer ` +
        `(${result.composerScrollHeight}px of it)`,
    )
  }
  if (result.composerGrowthPx <= 0) {
    failures.push(
      `typing: the composer did not grow (${result.textareaHeightBefore}px throughout)`,
    )
  }
  // The scrollbar flicker is the point of the case: the column's clientWidth moves while
  // the space the transcript was given does not.
  if (result.columnWidth === result.columnWidthAfter) {
    failures.push(
      `typing: the flicker did not reach the column (${result.columnWidth}px throughout)`,
    )
  }
  if (result.readingWidthAfter !== result.readingWidth) {
    failures.push(
      `typing: the reading width changed (${result.readingWidth} -> ` +
        `${result.readingWidthAfter}px)`,
    )
  }
  if (result.restores > 0) {
    failures.push(
      `typing: ${result.restores} anchored restoration frames ran for a layout the ` +
        `reading width does not depend on (first wrote ${result.restoreWrites[0]?.value})`,
    )
  }
  if (result.driftPx > HISTORY_TOLERANCE_PX) {
    failures.push(`typing: a block moved ${result.driftPx}px under the reader`)
  }
  return failures
}

// The report: a reader a little above the newest content scrolls down one notch and the view
// jumps all the way to the bottom.
//
// One notch lands inside the slack that unmounted rows need -- a whole viewport of it, because
// a drag to the end can land hundreds of pixels short of an estimated total -- so the position
// on its own reads as "already near the bottom". What separates the two is the reading intent,
// and it used to be cleared by any downward delta: the notch switched following back on, and
// the deferred corrections (80ms of follow chase, 120ms of settle timer) carried the view the
// rest of the way. The intent is a latch now, so the notch is measured as one gesture: it moves
// the view by a notch, and nothing moves it the rest of the way.
//
// The other half is the request. Following the newest content is what a reader working at the
// bottom of a session wants, and the send is the gesture that asks for it: it hands the view
// back -- latch cleared, following resumed, the view on the newest block -- because the request
// and the reply to it have to appear where the reader is looking. Only the request may do that,
// which is what the rest of the case measures: the reply then streams in under a reader who
// scrolled away, and their block and its offset have to survive every chunk of it.
//
// The gestures have to be real input: a scripted scrollTop carries no intent, and the intent is
// half of what is being measured. The notches go through the same debugger path as the model
// menu's, interleaved with the snapshots from here.
const FOLLOW_NOTCH_PX = 120
// Notches up until the reader is inside the slack band. Capped so a transcript that will not
// scroll fails as a case instead of looping.
const FOLLOW_UP_STEPS = 5
// How much of the band to aim for. Deep enough that an unfixed decision would carry the view
// a long way from the text it is reading, shallow enough to stay inside the band -- which is a
// whole viewport, so the two ends of the range are far apart.
const FOLLOW_BAND_TARGET = 0.7
const FOLLOW_WHEEL_SETTLE_MS = 260
// Past the two corrections that did the jumping: 80ms of follow chase and 120ms of settle
// timer, plus a measurement pass for the rows the gesture mounted.
const FOLLOW_JUMP_SETTLE_MS = 900
// What the send gets to reach the newest content before that counts as having failed, and how
// often the page reads the position while it does. The requirement is that the submit *ends* on
// the newest content, not that it is there by a given frame: the hand-back writes the bottom
// over a few frames while the composer and the request's own row are still settling, so it is
// read as a bounded poll on the page's own clock and the latency it took comes back with the
// verdict. Short of the mock backend's own reply block (360ms after the submit), so a run that
// passes is the request handing the view over before the reply arrives under it.
const FOLLOW_SEND_POLL_MS = 700
const FOLLOW_SEND_POLL_STEP_MS = 25
// Notches up after the send. Two, because the send has just put the view on the newest content
// and this is the gesture that takes it off again.
const FOLLOW_AWAY_NOTCHES = 2
const FOLLOW_AWAY_NOTCH_GAP_MS = 40
const FOLLOW_AWAY_SETTLE_MS = 200
// Past the mock backend's own reply, which streams its last delta 1490ms after the submit
// (its block at 360ms, then deltas at 650, 1070 and 1490ms). Measured from the submit, so the
// reader is scrolled away for the chunks of it, and the window they sit through is reported
// with the verdict instead of being left implicit.
const FOLLOW_STREAM_END_MS = 1700
// The same budget the scripted return to the bottom gets in the first pass: the correction
// closes the estimate gap over a few measurement frames.
const FOLLOW_LATEST_SETTLE_MS = 1600

// Opens the session and hands back the point to wheel at: the middle of the transcript, clear
// of the sticky 최신 내용으로 button at its bottom edge.
const followSetupProbe = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !document.querySelector('.session-row'); i += 1) await wait(100);
  const row = document.querySelector('.session-row');
  if (!row) return { error: 'no session rows' };
  row.click();
  for (let i = 0; i < 80 && !document.querySelector('.transcript-column'); i += 1) await wait(100);
  const transcript = document.querySelector('.transcript');
  if (!transcript) return { error: 'transcript never rendered' };
  await wait(1200);
  // Following the newest message, whatever the previous case left behind; a scripted
  // scrollTop carries no intent, so the gesture below is the only claim on the view.
  transcript.scrollTop = transcript.scrollHeight;
  await wait(900);
  const box = transcript.getBoundingClientRect();
  return {
    centerX: Math.round((box.left + box.right) / 2),
    centerY: Math.round((box.top + box.bottom) / 2),
  };
})()`

// The reading state, read the same way at every step of the case -- including from inside the
// send's own poll, which needs the same numbers on the page's own clock. Layout pixels
// throughout: the position, the gap under it, the block the viewport top edge is on -- which is
// the text the reader is looking at -- and when it was read.
const followReading = `(() => {
  const transcript = document.querySelector('.transcript');
  if (!transcript) return { error: 'transcript is missing', atMs: performance.now() };
  const viewport = transcript.getBoundingClientRect();
  // Geometrically topmost, not first in DOM order: mounted slots are in arbitrary order, and
  // the point is the sentence under the reader's eye.
  let entry = null;
  for (const node of document.querySelectorAll('[id^="transcript-"]')) {
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (box.bottom <= viewport.top + 1) continue;
    if (box.top >= viewport.bottom) continue;
    if (!entry || box.top < entry.top) entry = { id: node.id, top: box.top };
  }
  const slots = [...document.querySelectorAll('.transcript-slot')];
  const last = slots.length
    ? slots.reduce((newest, slot) =>
        Number(slot.dataset.index) > Number(newest.dataset.index) ? slot : newest,
      )
    : null;
  const lastEntry = last?.querySelector('[id^="transcript-"]') ?? null;
  return {
    atMs: performance.now(),
    gap: Math.round(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight),
    scrollTop: Math.round(transcript.scrollTop * 10) / 10,
    clientHeight: transcript.clientHeight,
    chip: [...document.querySelectorAll('button')].some((b) =>
      (b.textContent || '').includes('최신 내용으로'),
    ),
    entry: entry
      ? { id: entry.id, offset: Math.round((entry.top - viewport.top) * 10) / 10 }
      : null,
    // The newest block, where it sits, and how much text it renders. Content arriving under the
    // reader is what this has to be able to name: either a newer row appeared, or the reply's own
    // text grew -- it is one block whose height changes, not a new row per chunk.
    newest: lastEntry
      ? {
          id: lastEntry.id,
          index: Number(last.dataset.index),
          chars: (lastEntry.textContent || '').trim().length,
        }
      : null,
  };
})`

const followSnapshotProbe = followReading + '()'

// Submits a prompt the way the composer is submitted -- the native value setter, then a real
// click on its send button -- so the view is handed the newest content by the gesture the app
// answers, and the reply that arrives under the reader is a real arrival rather than a scripted
// edit. The text is more than the composer's own ceiling, so the send does not also change the
// transcript's height before it is submitted. The send is then read where it happens: the poll
// runs on the page's own clock until the view is on the newest content or its budget is gone,
// and the latency that took, the reading it ended on, and when the click landed all come back.
const followPromptProbe = `(async (pollMs, stepMs) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = () => ${followReading}();
  const startedAtMs = performance.now();
  const textarea = document.querySelector('.composer textarea');
  if (!textarea) return { error: 'the composer is missing' };
  if (textarea.disabled) return { error: 'the composer is read-only in this window' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  textarea.focus();
  setter.call(textarea, '읽던 자리를 지킨다. '.repeat(60));
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(250);
  // The button is the click a user makes; the Enter is the same submit for a composer whose
  // send slot has not re-rendered from the typed text yet. Either way the arrival is what the
  // case reads, not the submission.
  const send = document.querySelector('.composer .send-button:not(.send-button--stop)');
  const clickedAtMs = performance.now();
  if (send) send.click();
  else textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  let state = read();
  let readings = 1;
  while (
    state.gap > ${BOTTOM_TOLERANCE_PX} ||
    state.chip
  ) {
    if (state.atMs - clickedAtMs >= pollMs) break;
    await wait(stepMs);
    state = read();
    readings += 1;
  }
  const convergedAtMs =
    state.gap <= ${BOTTOM_TOLERANCE_PX} && !state.chip
      ? Math.round(state.atMs - clickedAtMs)
      : null;
  return { submitted: true, startedAtMs, clickedAtMs, convergedAtMs, readings, state };
})(${FOLLOW_SEND_POLL_MS}, ${FOLLOW_SEND_POLL_STEP_MS})`

// The other half of the requirement: asking for the newest content outright hands the view
// back, so the latch above may not leave the reader stuck short of it.
const followLatestProbe = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const chip = [...document.querySelectorAll('button')].find((b) =>
    (b.textContent || '').includes('최신 내용으로'),
  );
  if (!chip) return { error: '최신 내용으로 is not showing while reading' };
  chip.click();
  await wait(${FOLLOW_LATEST_SETTLE_MS});
  return { clicked: true };
})()`

async function runFollowCase(win, wheel) {
  const setup = await win.webContents.executeJavaScript(followSetupProbe)
  if (setup.error) return { error: setup.error }
  const snapshot = () => win.webContents.executeJavaScript(followSnapshotProbe)

  let before = await snapshot()
  for (let step = 0; step < FOLLOW_UP_STEPS; step += 1) {
    if (before.error) break
    if (before.gap >= before.clientHeight * FOLLOW_BAND_TARGET) break
    await wheel(setup.centerX, setup.centerY, -FOLLOW_NOTCH_PX)
    await new Promise((r) => setTimeout(r, FOLLOW_WHEEL_SETTLE_MS))
    before = await snapshot()
  }

  // The gesture from the report: one notch back down, then nothing until every timer the
  // transcript runs has had its say.
  await wheel(setup.centerX, setup.centerY, FOLLOW_NOTCH_PX)
  await new Promise((r) => setTimeout(r, FOLLOW_JUMP_SETTLE_MS))
  const afterNotch = await snapshot()

  // The request. The probe owns the click and polls for the view on the newest content on its
  // own clock, so what is left here is the reader: back off the bottom through real notches
  // while the reply is still streaming in under them.
  const sentAt = Date.now()
  const prompted = await win.webContents.executeJavaScript(followPromptProbe)
  const afterSend = prompted.error ? prompted : prompted.state
  // The case's own clock for the reply, timed from the click rather than from the submit
  // probe's round trip: the page reported when inside the probe the click landed.
  const clickAt = sentAt + (prompted.clickedAtMs ?? 0) - (prompted.startedAtMs ?? 0)

  // A reader who asked for the newest content and then started reading an older block. Real
  // notches, because an upward gesture is what takes the view off the bottom.
  for (let step = 0; step < FOLLOW_AWAY_NOTCHES; step += 1) {
    await wheel(setup.centerX, setup.centerY, -FOLLOW_NOTCH_PX)
    await new Promise((r) => setTimeout(r, FOLLOW_AWAY_NOTCH_GAP_MS))
  }
  await new Promise((r) => setTimeout(r, FOLLOW_AWAY_SETTLE_MS))
  const scrolledAway = await snapshot()

  // The rest of the reply, arriving under a reader who is not following it.
  await new Promise((r) =>
    setTimeout(r, Math.max(0, FOLLOW_STREAM_END_MS - (Date.now() - clickAt))),
  )
  const afterStream = await snapshot()

  const latest = await win.webContents.executeJavaScript(followLatestProbe)
  const afterButton = latest.error ? latest : await snapshot()
  // Page-clock distances from the click, so the numbers in the verdict read against the reply's
  // own timing: its block at 360ms, its deltas at 650, 1070 and 1490ms.
  const sinceClick = (reading) =>
    reading.atMs === undefined || prompted.error ? null : Math.round(reading.atMs - prompted.clickedAtMs)
  const awayAtMs = sinceClick(scrolledAway)
  const streamEndAtMs = sinceClick(afterStream)
  return {
    before,
    afterNotch,
    prompted,
    afterSend,
    scrolledAway,
    afterStream,
    latest,
    afterButton,
    // What the assertions above rest on: how long the send took to reach the newest content,
    // when the reader left the bottom, and how much of the reply's stream they were off it for.
    timing: {
      sendToNewestMs: prompted.convergedAtMs ?? null,
      awayAtMs,
      streamEndAtMs,
      streamedForMs:
        awayAtMs === null || streamEndAtMs === null ? null : streamEndAtMs - awayAtMs,
    },
  }
}

function checkFollowJump(follow) {
  if (follow.error) return [`small downward scroll: ${follow.error}`]
  if (!follow.before || follow.before.error || !follow.afterNotch || follow.afterNotch.error) {
    return [`small downward scroll: the reading position could not be read`]
  }
  const failures = []
  const before = follow.before
  const afterNotch = follow.afterNotch

  // The case is the position one notch leaves the reader at: inside the slack band, so an
  // unfixed decision reads it as "near the bottom" -- and a wheel has to have claimed the
  // view, or the intent the case is about was never set.
  if (!(before.gap > 40 && before.gap < before.clientHeight)) {
    failures.push(
      `small downward scroll: the view is not inside the slack band ` +
        `(${before.gap}px above the bottom of a ${before.clientHeight}px viewport)`,
    )
  }
  if (!before.chip) {
    failures.push(
      'small downward scroll: the wheel up did not take the view off the bottom ' +
        '(최신 내용으로 is not showing)',
    )
  }

  // One notch down means one notch down. A view that lands on the bottom, and a view that does
  // not move at all, are both the gesture being ignored -- the band is what the jump is made
  // of, so an unfixed decision moves the view most of the way to the newest content.
  const notchDownPx = Math.round(afterNotch.scrollTop - before.scrollTop)
  if (notchDownPx < FOLLOW_NOTCH_PX * 0.5 || notchDownPx > FOLLOW_NOTCH_PX * 2) {
    failures.push(
      `small downward scroll: one wheel notch moved the view ${notchDownPx}px ` +
        `(a ${FOLLOW_NOTCH_PX}px notch, from ${before.gap}px above the bottom)`,
    )
  }
  if (afterNotch.gap <= 40) {
    failures.push(
      `small downward scroll: the view jumped to ${afterNotch.gap}px above the newest content`,
    )
  }
  if (!afterNotch.chip) {
    failures.push(
      'small downward scroll: the view started following again on a downward notch',
    )
  }

  // The request: the send is the gesture that says the reader is done with the block they were
  // on, so it has to leave the view on the newest content with the way back gone.
  if (follow.prompted.error) {
    failures.push(`sent request: ${follow.prompted.error}`)
  } else if (!follow.afterSend || follow.afterSend.error) {
    failures.push('sent request: the reading position could not be read')
  } else {
    const sent = follow.afterSend
    // The request's own bubble lands in the transcript right after the send, and the reply
    // after it, so the distance to the bottom is read on the DOM the reader is looking at. The
    // reading is the one the poll ended on: the send has to *end* on the newest content, and
    // how long it took to get there is reported, not asserted away.
    if (sent.gap > BOTTOM_TOLERANCE_PX) {
      failures.push(
        `sent request: the view stayed where it was instead of the newest content ` +
          `(${sent.gap}px above the bottom after ${FOLLOW_SEND_POLL_MS}ms, ` +
          `tolerance ${BOTTOM_TOLERANCE_PX}px)`,
      )
    }
    if (sent.chip) {
      failures.push(
        'sent request: the view did not hand back to the newest content ' +
          '(최신 내용으로 is still showing)',
      )
    }
  }

  // The reader who scrolled away while the reply streamed -- the regression this case was
  // written for. Its chunks land below the viewport, so the block at the viewport top and its
  // offset both have to survive them, and with them the 80ms chase and the 120ms settle timer
  // the request just started. Painted geometry, not scrollTop: re-measuring the rows the
  // arriving chunks mount moves the position without moving what the reader is looking at.
  if (!follow.scrolledAway || follow.scrolledAway.error) {
    failures.push('reading while the reply streamed: the reading position could not be read')
  } else if (!follow.afterStream || follow.afterStream.error) {
    failures.push('reading while the reply streamed: the reading position could not be read')
  } else {
    const away = follow.scrolledAway
    const after = follow.afterStream
    const streamedForMs = follow.timing?.streamedForMs ?? 0
    if (!away.chip) {
      failures.push(
        'reading while the reply streamed: the wheel up did not take the view off the ' +
          'newest content (최신 내용으로 is not showing)',
      )
    }
    // A block under the reader that nobody can name is not a position, and the reply growing
    // is what has to leave it where it is.
    if (!away.entry || !after.entry) {
      failures.push('reading while the reply streamed: no block at the viewport top to compare')
    } else if (after.entry.id !== away.entry.id) {
      failures.push(
        `reading while the reply streamed: the text under the reader changed ` +
          `(${away.entry.id} -> ${after.entry.id})`,
      )
    } else {
      const drifted = Math.abs(after.entry.offset - away.entry.offset)
      if (drifted > HISTORY_TOLERANCE_PX) {
        failures.push(
          `reading while the reply streamed: the block under the reader moved ` +
            `${drifted.toFixed(1)}px in ${streamedForMs}ms of chunks`,
        )
      }
    }
    if (!away.newest || !after.newest) {
      failures.push(
        'reading while the reply streamed: no reply under the reader to watch ' +
          `(${away.newest?.id ?? 'none'} -> ${after.newest?.id ?? 'none'})`,
      )
    } else if (
      after.newest.index < away.newest.index ||
      (after.newest.index === away.newest.index &&
        after.newest.chars <= away.newest.chars)
    ) {
      failures.push(
        `reading while the reply streamed: no content arrived under the reader in ` +
          `${streamedForMs}ms (${away.newest.id} at ${away.newest.index} with ` +
          `${away.newest.chars} characters -> ${after.newest.id} at ${after.newest.index} ` +
          `with ${after.newest.chars})`,
      )
    }
    if (!after.chip) {
      failures.push('reading while the reply streamed: 최신 내용으로 went away while reading')
    }
  }

  // ...and the reader can always say "newest content" and get it.
  if (follow.latest.error) {
    failures.push(`newest content: ${follow.latest.error}`)
  } else if (!follow.afterButton || follow.afterButton.error) {
    failures.push('newest content: the reading position could not be read')
  } else if (
    Math.abs(follow.afterButton.gap) > BOTTOM_TOLERANCE_PX ||
    follow.afterButton.chip
  ) {
    failures.push(
      `newest content: the button went to ${follow.afterButton.gap}px ` +
        `above the newest content (tolerance ${BOTTOM_TOLERANCE_PX}px)`,
    )
  }
  return failures
}

function checkModelMenu(opened, scrolled) {
  if (opened.error) return [`model menu: ${opened.error}`]
  if (scrolled.error) return [`model menu: ${scrolled.error}`]
  const failures = []

  // Padding the list is the harness's job; if React re-rendered it away the numbers
  // below would pass on a short list and quietly stop covering the bug.
  if (opened.optionCount < MODEL_PROFILES || scrolled.optionCount < MODEL_PROFILES) {
    failures.push(
      `model list padding was lost (${opened.optionCount}/${scrolled.optionCount} of ${MODEL_PROFILES} rows)`,
    )
  }
  // A menu that runs off screen cannot be pointed at, let alone scrolled.
  if (opened.menuTop < 0 || opened.menuBottom > opened.viewportHeight + 1) {
    failures.push(
      `model menu runs off screen (${opened.menuTop}..${opened.menuBottom} of ${opened.viewportHeight})`,
    )
  }
  if (opened.menuHeight > opened.menuMaxHeight * opened.appZoom + 1) {
    failures.push(
      `model menu is ${opened.menuHeight}px tall against a ` +
        `${Math.round(opened.menuMaxHeight * opened.appZoom)}px cap`,
    )
  }
  // The list has to be shorter than its contents: equal heights are the reported bug,
  // where the menu clipped the list instead of giving it something to scroll.
  if (opened.scrollRange <= 0) {
    failures.push(
      `model list does not scroll: ${opened.listClientHeight}px box for ` +
        `${opened.listContentHeight}px of ${opened.optionCount} profiles`,
    )
  }
  // ...and it has to stay inside the menu rather than running past the clipped edge.
  if (scrolled.listBottom > scrolled.menuBottom + 1) {
    failures.push(
      `model list runs ${scrolled.listBottom - scrolled.menuBottom}px past the menu edge`,
    )
  }
  if (scrolled.listTop < opened.headerBottom - 1) {
    failures.push('model list overlaps the menu header')
  }
  // The header owns its own row, so scrolling the list must not move or clip it.
  if (Math.abs(scrolled.headerTop - opened.headerTop) > 1) {
    failures.push(
      `menu header moved ${scrolled.headerTop - opened.headerTop}px while the list scrolled`,
    )
  }
  if (scrolled.headerTop < scrolled.menuTop - 1 || scrolled.headerBottom > scrolled.menuBottom + 1) {
    failures.push('menu header is clipped by the menu')
  }

  if (scrolled.scrollTop <= 0) {
    failures.push(
      `wheel over the model list did not scroll it (scrollTop ${scrolled.scrollTop})`,
    )
  }
  if (scrolled.scrollTop < scrolled.scrollRange - 4) {
    failures.push(
      `wheel stopped ${scrolled.scrollRange - scrolled.scrollTop}px short of the last profile`,
    )
  }
  if (
    scrolled.lastOptionBottom > scrolled.listBottom + 1 ||
    scrolled.lastOptionTop < scrolled.listTop - 1
  ) {
    failures.push('last profile is outside the list after scrolling to the end')
  }
  return failures
}

// The composer's Enter is owned by one handler, and one branch of it is a refusal:
// Shift+Enter has to reach the textarea un-prevented, or the draft has no way to grow a
// line. That refusal is what a queued request used to hide behind -- the same handler
// submits a plain Enter by holding the request behind the open turn, and treating the
// Shift+Enter signal as that submit queued the line break the user was only making. The
// two halves are measured together here: the keydown that must not be claimed (plain,
// mid-composition, and inside the follow-up window a commit leaves behind), the keydown
// that must still be claimed, and the two ways a held request comes back out -- ⌥↑ pulls
// it into the draft, the chip's × throws it away without touching what is being typed.
// A handler-level test covers the decision; only a real renderer covers the keydown path
// the decision is reached through, the queue strip it renders, and whether the composer
// reads a live turn at the moment the gesture lands.
//
// The turn the queue needs is the rail's own running session. The mock's streamed replies
// end after ~1.5s of chunks, which is shorter than this sequence, and the queue releases
// itself the moment a turn ends -- so a turn that is only starting is no basis for it.
const RUNNING_SESSION_TITLE = 'Codex router cleanup'

const composerGesturesProbe = `(async (runningTitle) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !document.querySelector('.session-row'); i += 1) await wait(100);
  const row = [...document.querySelectorAll('.session-row')].find(
    (candidate) => (candidate.textContent || '').includes(runningTitle),
  );
  if (!row) return { error: 'the running session (' + runningTitle + ') is not in the rail' };
  row.click();
  let textarea = null;
  for (let i = 0; i < 80; i += 1) {
    textarea = document.querySelector('.composer textarea');
    if (textarea) break;
    await wait(100);
  }
  if (!textarea) return { error: 'the composer never rendered for ' + runningTitle };

  const stopButton = () => document.querySelector('.composer .send-button--stop');
  const sendButton = () => document.querySelector('.composer .send-button');
  // Whether a turn is open is read from the same slot the user reads it from: the stop
  // button only exists while the draft is empty, and the arrow beside a draft only says
  // 이어서 보내기 while a turn is open.
  const turnLive = () => {
    const stop = stopButton();
    if (stop) return !stop.disabled;
    const send = sendButton();
    return !!send && send.title === '이어서 보내기';
  };
  for (let i = 0; i < 80 && !turnLive(); i += 1) await wait(100);
  if (!turnLive()) {
    return { error: 'the composer does not read a running turn for ' + runningTitle };
  }
  await wait(300);

  const chips = () => [...document.querySelectorAll('.composer-queue-item')];
  const chipTexts = () => chips().map((chip) => {
    const label = chip.querySelector('.composer-queue-text');
    return label ? label.textContent : '';
  });
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  const setDraft = (text) => {
    textarea.focus();
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // Every gesture is a real keydown on the textarea, and what the handlers did with it is
  // read from the event itself: dispatchEvent returns false only when a listener prevented
  // the default, and the document-level bubble listener runs after React's root handler has
  // had its say, so defaultPrevented is the composer's own answer and not the record
  // of an unrelated listener.
  const press = (init, key) => {
    const event = new KeyboardEvent('keydown', Object.assign({
      key: key || 'Enter',
      bubbles: true,
      cancelable: true,
    }, init));
    let defaultPrevented = null;
    const record = (seen) => { defaultPrevented = seen.defaultPrevented; };
    document.addEventListener('keydown', record);
    const notCanceled = textarea.dispatchEvent(event);
    document.removeEventListener('keydown', record);
    return { notCanceled, defaultPrevented, live: turnLive() };
  };
  const state = () => ({
    chips: chips().length,
    chipTexts: chipTexts(),
    draft: textarea.value,
    live: turnLive(),
  });

  const texts = {
    lineBreak: '줄바꿈은 요청이 아니다',
    queued: '대기열에 들어갈 요청',
    discarded: '버릴 요청',
    kept: '버리기 전에 쓰던 초안',
    ime: '조합 중에 누른 Enter',
  };

  setDraft('');
  await wait(150);
  const start = state();

  // Shift+Enter, the three states the one branch has to cover. The composition one is the
  // IME delivering a plain Enter for the newline; the last one is the window a commit
  // leaves behind, so the commit and the keydown go out back to back -- the window is
  // 100ms wide and anything in between would be testing a different state.
  setDraft(texts.lineBreak);
  await wait(150);
  const drafted = state();
  const shiftPlain = press({ shiftKey: true });
  await wait(200);
  const afterShiftPlain = state();
  const shiftComposing = press({ shiftKey: true, isComposing: true });
  await wait(200);
  const afterShiftComposing = state();
  textarea.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true, data: texts.lineBreak }),
  );
  const shiftAfterCommit = press({ shiftKey: true });
  await wait(200);
  const afterShiftCommit = state();

  // The other side: a settled plain Enter still has to be claimed, which behind an open
  // turn means the request is held and the draft lets go of the text.
  setDraft(texts.queued);
  await wait(150);
  const plainEnter = press({});
  await wait(300);
  const afterPlain = state();

  // ⌥↑ takes the newest held request back into the draft, so the chip has to be gone and
  // its text has to be what is being edited again.
  const pullKeydown = press({ altKey: true }, 'ArrowUp');
  await wait(300);
  const afterPull = state();

  // The × beside a chip discards that chip alone, with a draft typed beside it -- so
  // "the draft was left alone" is a fact about a non-empty composer rather than about an
  // empty one that a discard could have emptied unnoticed.
  setDraft(texts.discarded);
  await wait(150);
  press({});
  await wait(300);
  setDraft(texts.kept);
  await wait(150);
  const beforeDiscard = state();
  const discardButton = document.querySelector('.composer-queue-discard');
  if (discardButton) discardButton.click();
  await wait(300);
  const afterDiscard = state();

  // An Enter pressed mid-composition submits from the commit that follows it, not from the
  // keydown. Running that pair proves the composer's composition handlers are live in this
  // renderer, which is what makes the follow-up-window keydown above a measurement of that
  // window instead of of a handler that was never reached. The chip it holds is discarded
  // again so the case leaves the queue as it found it.
  textarea.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true, data: texts.ime }),
  );
  setDraft(texts.ime);
  await wait(150);
  const imeComposingEnter = press({});
  const imeBeforeCommit = state();
  textarea.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true, data: texts.ime }),
  );
  await wait(300);
  const afterImeCommit = state();
  const imeDiscard = document.querySelector('.composer-queue-discard');
  if (imeDiscard) imeDiscard.click();
  await wait(250);

  return {
    sessionLabel: textarea.getAttribute('aria-label'),
    texts,
    start,
    drafted,
    shiftPlain,
    afterShiftPlain,
    shiftComposing,
    afterShiftComposing,
    shiftAfterCommit,
    afterShiftCommit,
    plainEnter,
    afterPlain,
    pullKeydown,
    afterPull,
    beforeDiscard,
    afterDiscard,
    imeComposingEnter,
    imeBeforeCommit,
    afterImeCommit,
    final: state(),
  };
})(${JSON.stringify(RUNNING_SESSION_TITLE)})`

function checkComposerGestures(result) {
  if (result.error) return [`composer gestures: ${result.error}`]
  const failures = []
  const texts = result.texts

  // The turn is the whole basis of the case: the queue releases itself the moment a turn
  // ends, so a gesture landing after that would be measuring an empty composer rather than
  // a held request. The three readings are the two renderings of the send slot -- the stop
  // button while the draft is empty and the 이어서 보내기 arrow beside a draft -- so both
  // are the state a gesture landed on, not a state assumed before the first one.
  if (!result.start.live || !result.afterPull.live || !result.final.live) {
    failures.push(
      'composer gestures: the turn ended while the gestures ran (the queue releases itself when it does)',
    )
  }

  // The three keydowns that must not be the composer's. `notCanceled` is the textarea's own
  // answer; the draft is what a submit would have taken away, and a chip is what it would
  // have left behind.
  const shiftStates = [
    ['plain', result.shiftPlain, result.afterShiftPlain],
    ['mid-composition', result.shiftComposing, result.afterShiftComposing],
    ['inside the commit follow-up window', result.shiftAfterCommit, result.afterShiftCommit],
  ]
  for (const [label, keydown, after] of shiftStates) {
    if (!keydown.notCanceled || keydown.defaultPrevented === true) {
      failures.push(
        `composer gestures: Shift+Enter (${label}) left the keydown to the textarea ` +
          `(dispatchEvent returned ${keydown.notCanceled}, defaultPrevented ${keydown.defaultPrevented})`,
      )
    }
    if (after.chips !== result.start.chips) {
      failures.push(
        `composer gestures: Shift+Enter (${label}) queued ${after.chips} request(s) ` +
          `(${JSON.stringify(after.chipTexts)}) instead of leaving the line break in the draft`,
      )
    }
    if (after.draft !== texts.lineBreak) {
      failures.push(
        `composer gestures: Shift+Enter (${label}) changed the draft ` +
          `(${JSON.stringify(texts.lineBreak)} -> ${JSON.stringify(after.draft)})`,
      )
    }
  }

  // The guard against the cheap fix, an Enter that stops being handled at all: the settled
  // keydown has to be claimed, and behind an open turn claiming it means the request is
  // held -- the chip with the typed text on it and the emptied draft together.
  if (!result.plainEnter.defaultPrevented) {
    failures.push(
      'composer gestures: a plain Enter was left to the textarea instead of submitting the draft',
    )
  }
  if (result.afterPlain.chips !== result.start.chips + 1 || result.afterPlain.chipTexts[0] !== texts.queued) {
    failures.push(
      `composer gestures: a plain Enter held ${JSON.stringify(result.afterPlain.chipTexts)} ` +
        `instead of the submitted request`,
    )
  }
  if (result.afterPlain.draft !== '') {
    failures.push(
      `composer gestures: a plain Enter left the submitted text in the draft ` +
        `(${JSON.stringify(result.afterPlain.draft)})`,
    )
  }

  // ⌥↑ pulls the newest held request out and into the draft. Consuming the keydown is part
  // of it: the caret has nowhere to go while the queue is what is being reached for.
  if (!result.pullKeydown.defaultPrevented) {
    failures.push(
      'composer gestures: Alt+ArrowUp was left to the textarea instead of pulling the queued request',
    )
  }
  if (result.afterPull.chips !== result.start.chips) {
    failures.push(
      `composer gestures: Alt+ArrowUp left ${result.afterPull.chips} request(s) queued ` +
        `(${JSON.stringify(result.afterPull.chipTexts)})`,
    )
  }
  if (result.afterPull.draft !== texts.queued) {
    failures.push(
      `composer gestures: Alt+ArrowUp put ${JSON.stringify(result.afterPull.draft)} in the draft ` +
        `instead of the pulled request (${JSON.stringify(texts.queued)})`,
    )
  }

  // The chip's × removes exactly its own entry, and the draft beside it is none of its
  // business -- the failure is either a chip that survived or a draft that did not.
  if (result.beforeDiscard.chips !== result.start.chips + 1 || result.beforeDiscard.chipTexts[0] !== texts.discarded) {
    failures.push(
      `composer gestures: the chip to discard was not on the queue ` +
        `(${JSON.stringify(result.beforeDiscard.chipTexts)})`,
    )
  }
  if (result.beforeDiscard.draft !== texts.kept) {
    failures.push(
      `composer gestures: the second draft did not reach the composer ` +
        `(${JSON.stringify(result.beforeDiscard.draft)})`,
    )
  }
  if (result.afterDiscard.chips !== result.start.chips) {
    failures.push(
      `composer gestures: the × left ${result.afterDiscard.chips} request(s) queued ` +
        `(${JSON.stringify(result.afterDiscard.chipTexts)})`,
    )
  }
  if (result.afterDiscard.draft !== texts.kept) {
    failures.push(
      `composer gestures: the × changed the draft it was clicked beside ` +
        `(${JSON.stringify(texts.kept)} -> ${JSON.stringify(result.afterDiscard.draft)})`,
    )
  }

  // The composition pair. The keydown is claimed the moment it lands (the submit waits for
  // the commit) and the chip may only exist after the commit -- so the two readings
  // document where the submission came from, and they are what says the follow-up window
  // above was a real window rather than a handler this renderer never reaches.
  if (!result.imeComposingEnter.defaultPrevented) {
    failures.push(
      'composer gestures: an Enter pressed mid-composition was left to the textarea',
    )
  }
  if (result.imeBeforeCommit.chips !== result.start.chips || result.imeBeforeCommit.draft !== texts.ime) {
    failures.push(
      `composer gestures: the mid-composition Enter submitted on its own ` +
        `(${JSON.stringify(result.imeBeforeCommit.chipTexts)}, draft ${JSON.stringify(result.imeBeforeCommit.draft)})`,
    )
  }
  if (result.afterImeCommit.chips !== result.start.chips + 1 || result.afterImeCommit.chipTexts[0] !== texts.ime) {
    failures.push(
      `composer gestures: the composition commit did not submit the armed Enter ` +
        `(${JSON.stringify(result.afterImeCommit.chipTexts)})`,
    )
  }

  return failures
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false })
  await win.loadFile(path.join(root, 'dist', 'index.html'), {
    query: { backend: 'mock', seedTranscript: String(SEEDED_ITEMS) },
  })
  // Not 1.0 on purpose. getBoundingClientRect is scaled by zoom while the offsets rows
  // are positioned with are not, so measuring with the rect recorded every row too tall
  // and left ragged gaps between blocks -- invisible at 100%, which is why this bug
  // reached the screen.
  win.webContents.setZoomFactor(1.1)
  await new Promise((r) => setTimeout(r, 300))

  // Wheel events go through the debugger protocol rather than sendInputEvent: the
  // latter needs the window focused, and this smoke runs off screen with show: false.
  // Input.dispatchMouseEvent coordinates are CSS pixels of the viewport.
  win.webContents.debugger.attach('1.3')
  const wheel = (x, y, deltaY) =>
    win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
      pointerType: 'mouse',
    })

  const failures = []
  // A wide window (own column) and a narrow one (deliberate overlay) exercise both rules.
  for (const [width, height] of [
    [1400, 900],
    [1000, 820],
    [880, 780],
  ]) {
    win.setSize(width, height)
    await new Promise((r) => setTimeout(r, 900))
    const result = await win.webContents.executeJavaScript(probe)
    console.log(JSON.stringify(result))
    for (const failure of check(result)) failures.push(`${width}px: ${failure}`)

    // The model popover is measured at the same sizes. Wheel input, not a scripted
    // scrollTop: only the wheel proves the gesture is claimed by the list instead of
    // passing through the clipped menu to the transcript behind it.
    const opened = await win.webContents.executeJavaScript(openModelMenuProbe)
    console.log(JSON.stringify(opened))
    if (!opened.error) {
      // Enough steps to reach the end from where it starts; the cap keeps a pathological
      // range from eating the smoke's timeout instead of failing on the assertion.
      const steps = Math.min(Math.ceil(opened.scrollRange / WHEEL_STEP_PX) + 3, 40)
      for (let i = 0; i < steps; i += 1) {
        await wheel(opened.listCenterX, opened.listCenterY, WHEEL_STEP_PX)
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    const scrolled = opened.error
      ? opened
      : await win.webContents.executeJavaScript(readModelMenuProbe)
    console.log(JSON.stringify(scrolled))
    for (const failure of checkModelMenu(opened, scrolled)) {
      failures.push(`${width}px: ${failure}`)
    }
  }

  // The panel toggle on its own. The passes above prove the geometry at each width; these
  // click the toggle and prove the view keeps its place across the reflow it causes, once
  // at a width where the panel takes its own column and once where it overlays.
  for (const [width, height] of [
    [1400, 900],
    [880, 780],
  ]) {
    win.setSize(width, height)
    await new Promise((r) => setTimeout(r, 900))
    const cases = await win.webContents.executeJavaScript(toggleProbe)
    console.log(JSON.stringify(cases))
    for (const failure of checkToggles(cases, width >= 980)) {
      failures.push(`${width}px: ${failure}`)
    }

    // Typing is measured at the same sizes. 880px is where the reading column is no
    // longer capped at 760px, so a scrollbar flicker reaches it; 1400px is the wide case
    // where the restoration must stay out of the keyboard's way for its own reasons.
    const typing = await win.webContents.executeJavaScript(typingProbe)
    console.log(JSON.stringify(typing))
    for (const failure of checkTyping(typing)) failures.push(`${width}px: ${failure}`)
  }

  // The follow case, at the wide size and after the passes above. It is the only case that
  // submits a prompt of its own, and the mock backend answers with a streamed reply, so the
  // transcript is a few blocks longer afterwards -- which moves where the cases above measure
  // the reader in the seeded content. That is a change to their subject, not to this one, so
  // this case runs after all of them rather than inside the loop.
  win.setSize(1400, 900)
  await new Promise((r) => setTimeout(r, 900))
  const follow = await runFollowCase(win, wheel)
  console.log(JSON.stringify(follow))
  for (const failure of checkFollowJump(follow)) failures.push(`1400px: ${failure}`)

  // The composer gestures. The case selects the rail's running session, so the queue it
  // fills belongs to a session no other case reads, and the transcript every case above
  // measures is left as they left it. Last for the same reason: nothing below depends on
  // which session is open.
  win.setSize(1400, 900)
  await new Promise((r) => setTimeout(r, 900))
  const gestures = await win.webContents.executeJavaScript(composerGesturesProbe)
  console.log(JSON.stringify(gestures))
  for (const failure of checkComposerGestures(gestures)) {
    failures.push(`1400px: ${failure}`)
  }

  clearTimeout(failAfter)
  const uiRegression = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const issues = [];
    document.querySelector('.session-row').click();
    await wait(500);
    const toggle = document.querySelector('.recent-requests-timeline-toggle');
    if (!toggle) return ['timeline toggle missing'];
    toggle.click();
    await wait(100);
    const popup = document.querySelector('.prompt-timeline');
    if (!popup) return ['timeline did not open'];
    if (getComputedStyle(popup).display !== 'flex') issues.push('timeline inherited chip grid');
    const header = popup.querySelector('header').getBoundingClientRect();
    const list = popup.querySelector('ol').getBoundingClientRect();
    if (list.top < header.bottom - 1 || Math.abs(list.left - popup.getBoundingClientRect().left) > 12) issues.push('timeline header/list misaligned');
    const button = document.querySelector('.recent-requests-timeline-toggle');
    if (button.scrollWidth > button.clientWidth + 1) issues.push('timeline toggle clips count');
    popup.querySelector('header button').click();
    const mode = document.querySelector('select[aria-label="대화 표시 방식"]');
    if (!mode || mode.options.length !== 3) issues.push('view mode choices missing');
    if (mode && [...mode.options].some(option => /기미|추맠/.test(option.text))) issues.push('corrupted mode text');
    const note = document.querySelector('.inspector-section > p');
    if (note && parseFloat(getComputedStyle(note).fontSize) > 12) issues.push('inspector note oversized');
    if (document.body.textContent.includes('시간 확인 불가')) issues.push('unknown timing placeholder visible');
    const settings = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '설정');
    if (!settings) issues.push('settings entry missing');
    else {
      settings.click();
      await wait(400);
      const trigger = document.querySelector('button[aria-label="실행 중 Enter 동작"]');
      if (!trigger) issues.push('running Enter dropdown missing');
      else {
        trigger.click();
        await wait(100);
        const menu = document.querySelector('[role="listbox"][aria-label="실행 중 Enter 동작"]');
        if (!menu) issues.push('running Enter menu did not open');
        else for (const label of menu.querySelectorAll('button > span')) {
          const text = label.getBoundingClientRect();
          const bounds = menu.getBoundingClientRect();
          if (text.right > bounds.right + 1 || text.left < bounds.left - 1 || label.scrollWidth > label.clientWidth + 1) issues.push('running Enter option overflows');
        }
      }
    }
    return issues;
  })()`)
  failures.push(...uiRegression)
  for (const failure of failures) console.error(`  ${failure}`)
  console.log(
    failures.length === 0
      ? 'Inspector open smoke passed'
      : 'Inspector open smoke FAILED',
  )
  app.exit(failures.length === 0 ? 0 : 1)
})
