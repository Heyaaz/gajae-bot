// Proves two things about a long session that no unit test can hold, because both are
// layout properties of a real render:
//
//   1. The detail panel gets its own column instead of covering the transcript. Making
//      it an overlay was tried as a performance fix: it removed a 65ms reflow but hid up
//      to 157px of every visible row, cutting sentences off mid-line.
//   2. The transcript is virtualized. Keeping ~800 entries and 20,000 nodes live is what
//      made every width change re-wrap the whole document in one frame. Only rows near
//      the viewport may be mounted.
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

const probe = `(async (seeded) => {
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
    if (Math.abs(reserved - 140) < 1 && current.offsetHeight !== 140) unmeasuredRows += 1;
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
})(${SEEDED_ITEMS})`

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
  // A negative value means the last row is cut off under the composer.
  if (result.blankBelowContentPx > 120 || result.blankBelowContentPx < -8) {
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
