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
    const contentGap = Math.round(paintedEdge(next, 'top') - paintedEdge(current, 'bottom'))
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
  const visiblePair = () => {
    const viewport = transcript.getBoundingClientRect();
    return [...document.querySelectorAll('.transcript-entry')]
      .map((entry) => ({ id: entry.id || 'tool-run', box: entry.getBoundingClientRect() }))
      .filter((entry) => entry.box.width > 0 && entry.box.height > 0 && entry.box.bottom > viewport.top + 1 && entry.box.top < viewport.bottom)
      .slice(0, 2)
      .map((entry) => ({ id: entry.id, top: Math.round(entry.box.top * 100) / 100 }));
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

  clearTimeout(failAfter)
  for (const failure of failures) console.error(`  ${failure}`)
  console.log(
    failures.length === 0
      ? 'Inspector open smoke passed'
      : 'Inspector open smoke FAILED',
  )
  app.exit(failures.length === 0 ? 0 : 1)
})
