// Proves the session detail panel gets its own column instead of covering the transcript.
//
// Making it an overlay was tried as a performance fix: it removed a 65ms reflow, but it
// floated over the conversation and hid up to 157px of every visible row, cutting
// sentences off mid-line. A panel that hides the text being read is worse than a slow
// one, so it keeps its own track and the reflow is a separate, still-open problem.
//
// This is a layout property, so no unit test can hold it: the check is that no visible
// transcript row overlaps the panel's box.
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const failAfter = setTimeout(() => {
  console.error('Inspector open smoke timed out')
  app.exit(1)
}, 60_000)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false })
  await win.loadFile(path.join(root, 'dist', 'index.html'), {
    query: { backend: 'mock' },
  })

  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80 && !document.querySelector('.session-row'); i += 1) await wait(100);
    const row = document.querySelector('.session-row');
    if (!row) return { error: 'no session rows' };
    row.click();
    for (let i = 0; i < 80 && !document.querySelector('.transcript-column'); i += 1) await wait(100);
    for (let i = 0; i < 80 && document.querySelector('.transcript-column').getBoundingClientRect().width < 100; i += 1)
      await wait(50);

    const toggle = [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('title') === '세션 정보',
    );
    if (!toggle) return { error: 'inspector toggle not found' };
    toggle.click();
    for (let i = 0; i < 80 && !document.querySelector('.inspector'); i += 1) await wait(25);
    const panel = document.querySelector('.inspector');
    if (!panel) return { error: 'inspector never rendered' };
    await wait(400);

    const panelBox = panel.getBoundingClientRect();
    const column = document.querySelector('.transcript-column');
    const columnBox = column.getBoundingClientRect();

    // Every row currently on screen must sit clear of the panel.
    let visibleRows = 0;
    let overlappingRows = 0;
    let worstOverlapPx = 0;
    for (const child of column.children) {
      const box = child.getBoundingClientRect();
      if (box.bottom < 0 || box.top > window.innerHeight || box.width === 0) continue;
      visibleRows += 1;
      const overlap = Math.min(box.right, panelBox.right) - Math.max(box.left, panelBox.left);
      if (overlap > 0) {
        overlappingRows += 1;
        worstOverlapPx = Math.max(worstOverlapPx, Math.round(overlap));
      }
    }

    const bodyBox = document.querySelector('.workspace-body').getBoundingClientRect();
    return {
      visibleRows,
      overlappingRows,
      worstOverlapPx,
      columnRight: Math.round(columnBox.right),
      panelLeft: Math.round(panelBox.left),
      panelVisible: panelBox.width > 200,
      panelInsideBody:
        panelBox.right <= bodyBox.right + 1 &&
        panelBox.top >= bodyBox.top - 1 &&
        panelBox.bottom <= bodyBox.bottom + 1,
    };
  })()`)

  clearTimeout(failAfter)
  console.log(JSON.stringify(result, null, 2))

  const ok =
    !result.error &&
    result.visibleRows > 0 &&
    result.overlappingRows === 0 &&
    // The panel starts where the reading column ends rather than on top of it.
    result.columnRight <= result.panelLeft &&
    result.panelVisible &&
    result.panelInsideBody

  console.log(ok ? 'Inspector open smoke passed' : 'Inspector open smoke FAILED')
  app.exit(ok ? 0 : 1)
})
