import { app, BrowserWindow } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let directory;
let win;
let finished = false;
const timeout = setTimeout(() => {
  console.error('Transcript page smoke timed out');
  void finish(1);
}, 60_000);

async function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  try {
    win?.destroy();
  } catch (error) {
    console.error('Could not destroy transcript page smoke window', error);
    code = 1;
  }
  win = undefined;
  try {
    if (directory) await rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.error('Could not remove transcript page smoke fixture', error);
    code = 1;
  }
  process.exitCode = code;
  app.exit(code);
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'gajae-transcript-page-smoke-'));
    const preload = path.join(directory, 'preload.cjs');
    await writeFile(preload, `
const listeners = new Set();
const sessionId = 'transcript-page-smoke';
const session = { id: sessionId, title: 'Transcript paging fixture', subtitle: 'isolated smoke fixture', workspace: '/transcript-page-smoke', runtime: 'gjc', status: 'idle', updatedAt: 'now', pinned: false, unread: false, accent: '#ff8a34', ownership: 'external', attachment: 'attached' };
const items = [];
for (let number = 1; number <= 45; number++) {
  const suffix = String(number).padStart(2, '0');
  items.push(
    { id: 'request-' + number, kind: 'message', sessionId, role: 'user', content: 'USER-BODY-' + suffix, createdAt: '2026-10-21T00:' + suffix + ':00.000Z' },
    { id: 'tool-' + number, kind: 'tool', sessionId, name: 'Fixture tool', description: 'Tool output for request ' + number, command: 'fixture ' + number, status: 'completed', output: 'TOOL-OUTPUT-' + suffix, createdAt: '2026-10-21T00:' + suffix + ':01.000Z' },
    { id: 'assistant-' + number, kind: 'message', sessionId, role: 'assistant', content: 'ASSISTANT-BODY-' + suffix, createdAt: '2026-10-21T00:' + suffix + ':02.000Z' },
  );
}
const copy = value => JSON.parse(JSON.stringify(value));
const requestSummaries = items.filter(item => item.kind === 'message' && item.role === 'user').map(item => ({ id: item.id, text: item.content, createdAt: item.createdAt }));
const blocks = items.length / 3;
const pageCalls = [];
const fullCalls = [];
const changeCalls = [];
let nextPageId = 1;
const pageFor = request => {
  let startBlock;
  let endBlock;
  if (request?.beforeId) {
    const anchor = items.findIndex(item => item.id === request.beforeId);
    if (anchor < 0) throw Error('Unknown beforeId ' + request.beforeId);
    endBlock = Math.floor(anchor / 3);
    startBlock = Math.max(0, endBlock - 20);
  } else if (request?.aroundId) {
    const anchor = items.findIndex(item => item.id === request.aroundId);
    if (anchor < 0) throw Error('Unknown aroundId ' + request.aroundId);
    const target = Math.floor(anchor / 3);
    startBlock = Math.max(0, Math.min(blocks - 20, target - 10));
    endBlock = Math.min(blocks, startBlock + 20);
  } else {
    endBlock = blocks;
    startBlock = Math.max(0, endBlock - 20);
  }
  const pageItems = copy(items.slice(startBlock * 3, endBlock * 3));
  return {
    items: pageItems,
    requests: copy(requestSummaries),
    hasMoreBefore: startBlock > 0,
    hasMoreAfter: endBlock < blocks,
    ...(pageItems.length ? { firstId: pageItems[0].id, lastId: pageItems.at(-1).id } : {}),
  };
};
const emit = event => listeners.forEach(listener => listener(event));
window.__transcriptPages = {
  snapshot: () => ({
    pages: pageCalls.map(call => ({ callId: call.callId, request: call.request, itemIds: call.page.items.map(item => item.id), requestIds: call.page.requests.map(request => request.id), hasMoreBefore: call.page.hasMoreBefore, hasMoreAfter: call.page.hasMoreAfter })),
    fullReads: [...fullCalls],
    changes: [...changeCalls],
  }),
  resolve: callId => {
    const call = pageCalls.find(candidate => candidate.callId === callId);
    if (!call || !call.resolve) throw Error('Page call is not pending: ' + callId);
    call.resolve(copy(call.page));
    call.resolve = undefined;
  },
  appendLatest: () => {
    emit({ type: 'transcript.appended', item: { id: 'request-46', kind: 'message', sessionId, role: 'user', content: 'USER-BODY-46', createdAt: '2026-10-21T00:46:00.000Z' } });
    emit({ type: 'transcript.appended', item: { id: 'assistant-46', kind: 'message', sessionId, role: 'assistant', content: 'ASSISTANT-BODY-46', createdAt: '2026-10-21T00:46:02.000Z' } });
  },
};
window.agentControlDesktop = {
  onSessionShortcut: () => () => {}, onAbortRun: () => () => {}, onCycleEffort: () => () => {},
  gjc: {
    getConnection: async () => ({ state: 'connected', backend: 'gjc', label: 'Isolated transcript paging fixture', workspace: '/transcript-page-smoke' }),
    listSessions: async () => [copy(session)],
    getTranscriptPage: (id, request) => {
      if (id !== sessionId) throw Error('Unexpected transcript page session: ' + id);
      const call = { callId: nextPageId++, request: request ? copy(request) : null, page: pageFor(request) };
      pageCalls.push(call);
      return new Promise(resolve => { call.resolve = resolve; });
    },
    getTranscript: async id => {
      fullCalls.push(id);
      return copy(items);
    },
    getTranscriptRevision: async () => undefined,
    getTranscriptChanges: async id => {
      changeCalls.push(id);
      await new Promise(resolve => setTimeout(resolve, 30));
      return { kind: 'patch', items: [] };
    },
    watchTranscripts: () => {}, refreshSessionContext: async () => {},
    getGoal: async () => ({ enabled: false, completed: 0, total: 0 }),
    getGitStatus: async () => null, markSessionRead: async () => {},
    listQueuedMessages: async () => [], listSubagents: async () => [],
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); }, dispose: () => {},
  },
};
`);
    const rendererErrors = [];
    win = new BrowserWindow({ width: 430, height: 900, show: false, webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    win.webContents.on('console-message', details => {
      if (details.level === 'error') rendererErrors.push(details.message);
    });
    win.webContents.on('preload-error', (_event, _path, error) => rendererErrors.push(String(error)));
    win.webContents.on('did-fail-load', (_event, code, description) => rendererErrors.push(`${code} ${description}`));
    win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(JSON.stringify(details)));
    await win.loadFile(path.join(root, 'dist/index.html'));

    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const rendererUntil = async expression => {
      console.log('Checking paging UI:', expression);
      return win.webContents.executeJavaScript(`(async () => {
      const until = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Transcript page renderer condition timed out: ' + ${JSON.stringify(expression)}); };
      await until(() => ${expression});
    })()`);
    };
    const pageCalls = async () => win.webContents.executeJavaScript('window.__transcriptPages.snapshot().pages');
    const waitForPage = async (predicate, afterCallId = 0) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        const calls = await pageCalls();
        const call = calls.find(candidate => candidate.callId > afterCallId && predicate(candidate));
        if (call) return call;
        await wait(20);
      }
      throw new Error('Timed out waiting for transcript page call');
    };
    const resolvePage = call => win.webContents.executeJavaScript(`window.__transcriptPages.resolve(${call.callId})`);
    const assertRenderer = expression => win.webContents.executeJavaScript(`(() => {
      const assert = (value, message) => { if (!value) throw Error(message); };
      ${expression}
    })()`);
    const openTimeline = async () => {
      await assertRenderer(`assert(document.querySelector('.recent-requests-timeline-toggle'), 'Full request timeline toggle is missing');`);
      await win.webContents.executeJavaScript(`document.querySelector('.recent-requests-timeline-toggle').click()`);
      await rendererUntil("document.querySelectorAll('.prompt-timeline li button').length >= 45");
    };
    const clickRequest = number => win.webContents.executeJavaScript(`(() => {
      const title = 'USER-BODY-' + String(${number}).padStart(2, '0');
      const button = [...document.querySelectorAll('.prompt-timeline li button')].find(candidate => candidate.title === title);
      if (!button) throw Error('Timeline request is missing: ' + title);
      button.click();
    })()`);
    const transcriptText = () => win.webContents.executeJavaScript("document.querySelector('.transcript')?.textContent ?? ''");
    const pageSnapshot = await waitForPage(call => call.request === null);
    if (pageSnapshot.itemIds.length !== 60 || pageSnapshot.requestIds.length !== 45 || pageSnapshot.itemIds[0] !== 'request-26' || pageSnapshot.itemIds.at(-1) !== 'assistant-45')
      throw new Error('Initial page was not the latest 20 complete request blocks');
    await resolvePage(pageSnapshot);
    await rendererUntil("document.querySelector('.recent-requests-timeline-toggle')");
    await openTimeline();
    if (await win.webContents.executeJavaScript("document.querySelectorAll('.prompt-timeline li').length") !== 45)
      throw new Error('Timeline did not index all 45 user requests');
    await clickRequest(45);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-45')");
    await openTimeline();
    await clickRequest(26);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-26')");

    await openTimeline();
    const oldestCallCount = (await pageCalls()).length;
    await clickRequest(1);
    const oldest = await waitForPage(call => call.request?.aroundId === 'request-1', oldestCallCount);
    await resolvePage(oldest);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-01')");
    await rendererUntil("document.querySelector('.scroll-to-latest, .transcript-follow-button')");
    const oldLatestCallCount = (await pageCalls()).length;
    await assertRenderer(`(document.querySelector('.scroll-to-latest, .transcript-follow-button')).click()`);
    const oldLatest = await waitForPage(call => call.request === null, oldLatestCallCount);
    await resolvePage(oldLatest);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-45')");

    await openTimeline();
    const initialCallCount = (await pageCalls()).length;
    await clickRequest(25);
    const around = await waitForPage(call => call.request?.aroundId === 'request-25', initialCallCount);
    await resolvePage(around);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-25')");
    await assertRenderer(`
      const button = document.querySelector('.transcript-load-earlier button');
      assert(button && button.textContent.includes('이전 대화 불러오기'), 'Earlier-page control is missing');
      button.click();
    `);
    const before = await waitForPage(call => call.request?.beforeId === 'request-15', around.callId);
    const overlap = before.itemIds.filter(id => around.itemIds.includes(id));
    if (overlap.length) throw new Error('Fixture before page overlaps the displayed page: ' + overlap.join(', '));
    await resolvePage(before);
    await rendererUntil("!document.querySelector('.transcript-load-earlier button')");
    await openTimeline();
    await clickRequest(1);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-01')");
    await assertRenderer(`
      const ids = [...document.querySelectorAll('.transcript-entry[id]')].map(row => row.id);
      assert(ids.length === new Set(ids).size, 'Visible transcript row ids are duplicated after prepend');
    `);

    await rendererUntil("document.querySelector('.scroll-to-latest, .transcript-follow-button')");
    const beforeLatestCallCount = (await pageCalls()).length;
    await assertRenderer(`(document.querySelector('.scroll-to-latest, .transcript-follow-button')).click()`);
    const latest = await waitForPage(call => call.request === null, beforeLatestCallCount);
    await resolvePage(latest);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-45')");
    if ((await transcriptText()).includes('USER-BODY-01')) throw new Error('Latest navigation retained the older page');

    await openTimeline();
    const historyCallCount = (await pageCalls()).length;
    await clickRequest(25);
    const history = await waitForPage(call => call.request?.aroundId === 'request-25', historyCallCount);
    await resolvePage(history);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-25')");
    await win.webContents.executeJavaScript('window.__transcriptPages.appendLatest()');
    await wait(150);
    const historicalText = await transcriptText();
    if (!historicalText.includes('USER-BODY-25') || historicalText.includes('USER-BODY-46') || historicalText.includes('ASSISTANT-BODY-46') || historicalText.includes('USER-BODY-45'))
      throw new Error('Incremental latest event moved the historical view to the newest request');

    await openTimeline();
    const staleCallCount = (await pageCalls()).length;
    await clickRequest(45);
    const stale = await waitForPage(call => call.request?.aroundId === 'request-45', staleCallCount);
    await rendererUntil("document.querySelector('.scroll-to-latest, .transcript-follow-button')");
    const latestRaceCallCount = (await pageCalls()).length;
    await assertRenderer(`(document.querySelector('.scroll-to-latest, .transcript-follow-button')).click()`);
    const latestRace = await waitForPage(call => call.request === null, latestRaceCallCount);
    await resolvePage(latestRace);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-45')");
    await resolvePage(stale);
    await wait(100);
    const finalText = await transcriptText();
    if (!finalText.includes('USER-BODY-45') || finalText.includes('USER-BODY-25'))
      throw new Error('A stale around-page response overrode the latest page');
    // Virtualization deliberately does not mount both ends of a 20-request page.
    // Reveal its first request and verify it is already loaded, without an around read.
    const callsBeforeReveal = (await pageCalls()).length;
    await openTimeline();
    await clickRequest(26);
    await rendererUntil("document.querySelector('.transcript')?.textContent.includes('USER-BODY-26')");
    if ((await pageCalls()).slice(callsBeforeReveal).some(call => call.request?.aroundId === 'request-26'))
      throw new Error('Stale around page replaced the loaded latest-page beginning');

    const final = await win.webContents.executeJavaScript('window.__transcriptPages.snapshot()');
    if (final.fullReads.length) throw new Error('Display called getTranscript instead of using pages');
    if (rendererErrors.length) throw new Error(`Renderer reported errors: ${rendererErrors.join('; ')}`);
    console.log(JSON.stringify({ passed: true, mobileViewport: '430x900', calls: final }, null, 2));
    console.log('Transcript page smoke passed');
    await finish(0);
  } catch (error) {
    console.error('Transcript page smoke failed', error);
    if (win && !win.isDestroyed()) console.error(await win.webContents.executeJavaScript(`JSON.stringify({ calls: window.__transcriptPages?.snapshot().pages.map(p => ({id:p.callId,request:p.request})), text: document.querySelector('.transcript')?.textContent?.slice(0,1500), scroll: document.querySelector('.transcript')?.scrollTop })`));
    await finish(1);
  }
}).catch(async error => {
  console.error('Transcript page smoke failed to start', error);
  await finish(1);
});
