// Proves opening the session detail panel does not reflow the transcript.
//
// The panel used to be a flex sibling of the conversation, so opening it shrank the
// reading column from 836px to 753px. A row's height depends on where its text wraps,
// so every row was re-wrapped and re-measured in one frame -- 65ms on a long session,
// which is what the stutter was. The panel now overlays the conversation instead.
//
// This is a layout property, so no unit test can hold it: the check is that the
// transcript's width is identical before and after the panel opens.
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
    const column = document.querySelector('.transcript-column');
    if (!column) return { error: 'transcript never rendered' };

    // Wait for the column to be laid out; a zero-width column would make the
    // comparison below vacuous.
    for (let i = 0; i < 80 && column.getBoundingClientRect().width < 100; i += 1) await wait(50);
    const widthClosed = Math.round(column.getBoundingClientRect().width);
    if (widthClosed < 100) return { error: 'transcript column never took width' };
    const toggle = [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('title') === '세션 정보',
    );
    if (!toggle) return { error: 'inspector toggle not found' };

    toggle.click();
    for (let i = 0; i < 80 && !document.querySelector('.inspector'); i += 1) await wait(25);
    const panel = document.querySelector('.inspector');
    if (!panel) return { error: 'inspector never rendered' };
    await wait(300);

    // Re-query rather than reuse the earlier node: React can replace the element when
    // the panel mounts, and a detached node measures zero.
    const widthOpen = Math.round(
      document.querySelector('.transcript-column').getBoundingClientRect().width,
    );
    const panelBox = panel.getBoundingClientRect();
    const bodyBox = document.querySelector('.workspace-body').getBoundingClientRect();

    return {
      transcriptWidthClosed: widthClosed,
      transcriptWidthOpen: widthOpen,
      widthUnchanged: widthClosed === widthOpen,
      panelVisible: panelBox.width > 200,
      // An overlay still has to stay inside the conversation area rather than
      // hanging off the window or covering the sidebar.
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
    result.widthUnchanged &&
    result.panelVisible &&
    result.panelInsideBody

  console.log(ok ? 'Inspector open smoke passed' : 'Inspector open smoke FAILED')
  app.exit(ok ? 0 : 1)
})
