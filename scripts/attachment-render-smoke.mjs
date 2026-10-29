// Proves what a user sees on a message that carried an attachment.
//
// The paths travel inside a block addressed to the agent, and the bubble strips that
// block so the instructions do not read as the user's own words. Stripping it also
// removed the only evidence a file was sent, and a transcript resync used to drop the
// inline thumbnail on top of that. Unit tests can only pin the functions; this asserts
// the rendered result.
import './smoke-isolation.mjs'
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const indexHtml = path.join(root, 'dist', 'index.html')

// A hung Electron window reports nothing and blocks the pipeline, so the whole probe is
// bounded rather than trusted to settle.
const failAfter = setTimeout(() => {
  console.error('Attachment render smoke timed out')
  app.exit(1)
}, 60_000)

// Exactly what a persisted user row holds, taken from a real session transcript.
const PROMPT = [
  '이 스크린샷 봐줘',
  '',
  '<local-images>',
  '- "/Users/tester/Desktop/스크린샷 2026-08-28 오후 6.19.03.png"',
  '</local-images>',
  'The user attached these images. You MUST inspect every image with the read tool before responding.',
].join('\n')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false })
  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.includes('Error')) console.error('renderer:', message)
  })
  await win.loadFile(indexHtml, { query: { backend: 'mock' } })

  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 60 && !document.querySelector('.session-row'); i += 1) await wait(100);
    // A message needs a session to land in, and the transcript only renders the selected
    // one, so the probe picks a row before typing.
    const row = document.querySelector('.session-row');
    if (!row) return { error: 'no session rows' };
    row.click();
    for (let i = 0; i < 60 && !document.querySelector('.composer textarea'); i += 1) await wait(100);
    const box = document.querySelector('.composer textarea');
    if (!box) return { error: 'composer never mounted' };
    // Session selection resets the virtualized transcript on its next frame. This
    // probe mutates React's private value tracker rather than sending trusted keyboard
    // input, so doing both in the same frame lets the controlled textarea restore its
    // prior empty DOM value before React observes the synthetic event. Attachment
    // rendering is the behavior under test here; session switching has its own smoke.
    await wait(150);
    // React tracks the last value it wrote and drops an input event whose value it
    // believes it already has, so the tracker is cleared before setting the draft.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, ${JSON.stringify(PROMPT)});
    if (box._valueTracker) box._valueTracker.setValue('');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector('.send-button[type="submit"]'); i += 1)
      await wait(50);
    // Submit through the button, not a synthetic Enter: the composer's Enter handling is
    // a React onKeyDown, which a dispatched native KeyboardEvent never reaches.
    const send = document.querySelector('.send-button[type="submit"]');
    if (!send) return { error: 'send button never enabled' };
    send.click();

    let bubble = null;
    for (let i = 0; i < 60; i += 1) {
      await wait(100);
      bubble = Array.from(document.querySelectorAll('.message--user')).find((row) =>
        row.textContent.includes('이 스크린샷 봐줘'),
      );
      if (bubble && bubble.querySelector('.message-attachments li')) break;
    }
    if (!bubble)
      return {
        error: 'user bubble never rendered',
        userBubbles: Array.from(document.querySelectorAll('.message--user')).map((r) =>
          r.textContent.trim().slice(0, 60),
        ),
        composerValue: box.value.slice(0, 60),
        sendStillPresent: Boolean(document.querySelector('.send-button[type="submit"]')),
      };
    return {
      attachmentChips: Array.from(bubble.querySelectorAll('.message-attachments li')).map((li) =>
        li.textContent.trim(),
      ),
      showsRequestText: bubble.textContent.includes('이 스크린샷 봐줘'),
      leaksAgentInstructions: bubble.textContent.includes('You MUST inspect'),
      leaksRawBlock: bubble.textContent.includes('<local-images>'),
    };
  })()`)

  clearTimeout(failAfter)
  console.log(JSON.stringify(result, null, 2))

  const ok =
    !result.error &&
    result.attachmentChips.length === 1 &&
    result.attachmentChips[0].includes('스크린샷 2026-08-28 오후 6.19.03.png') &&
    result.showsRequestText &&
    !result.leaksAgentInstructions &&
    !result.leaksRawBlock

  console.log(ok ? 'Attachment render smoke passed' : 'Attachment render smoke FAILED')
  app.exit(ok ? 0 : 1)
})
