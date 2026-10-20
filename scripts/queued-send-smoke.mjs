import { app, BrowserWindow } from 'electron';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const timeout = setTimeout(() => { console.error('Queued send smoke timed out'); app.exit(1); }, 45_000);
// The suite owns process exit; closing one fixture must not quit the next one.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gajae-queue-smoke-'));
  let win;
  const results = [];
  try {
    for (const mode of ['endpoint', 'accepted-failure', 'flush', 'switch-success', 'switch-failure']) {
      console.log(`Checking queued send: ${mode}`);
      const preload = path.join(directory, `${mode}.cjs`);
      await writeFile(preload, `
const mode = ${JSON.stringify(mode)};
const listeners = new Set();
const calls = [];
const unhandled = [];
let flushes = 0;
let allow = false;
let settle;
const session = suffix => ({ id: 'queue-' + suffix, title: 'Queue ' + suffix.toUpperCase(), workspace: '/diagnostic', subtitle: 'diagnostic', runtime: 'gjc', status: 'running', updatedAt: 'now', pinned: false, unread: false, ownership: 'external', attachment: 'attachable' });
const sessions = [session('a'), session('b')];
const update = (id, status) => {
 const row = sessions.find(row => row.id === id); row.status = status;
 listeners.forEach(fn => fn({ type: 'session.updated', session: { ...row } }));
};
window.addEventListener('unhandledrejection', event => unhandled.push(String(event.reason)));
window.__probe = {
 update, settle: () => settle(), allow: () => { allow = true; },
 snapshot: () => ({ calls: calls.map(call => ({ ...call })), flushes, unhandled: [...unhandled] }),
};
window.agentControlDesktop = {
 onSessionShortcut: () => () => {}, onAbortRun: () => () => {}, onCycleEffort: () => () => {},
 gjc: {
  getConnection: async () => ({ state: 'connected', backend: 'gjc', label: 'Isolated diagnostic', workspace: '/diagnostic' }),
  listSessions: async () => sessions.map(row => ({ ...row })),
  getTranscript: async () => [], getGoal: async () => ({ enabled: false, completed: 0, total: 0 }),
  getTranscriptRevision: async () => undefined,
  getTranscriptChanges: async () => ({ kind: 'patch', items: [] }),
  watchTranscripts: () => {}, refreshSessionContext: async () => {},
  getGitStatus: async () => null, markSessionRead: async () => {}, listQueuedMessages: async () => [], listSubagents: async () => [],
  sendMessage: async (id, input) => {
   calls.push({ sessionId: id, text: input.text });
   // Bound an unfixed replay loop so the regression cannot run indefinitely.
   if (calls.length > 4) return new Promise(() => {});
   update(id, 'running');
   if (mode.startsWith('switch-') && id === 'queue-a') {
    return new Promise((resolve, reject) => { settle = () => {
     update(id, 'idle');
     if (mode === 'switch-failure') reject(Error('endpoint_stale'));
     else resolve('prompt');
    }; });
   }
   await new Promise(resolve => setTimeout(resolve, 60));
   update(id, 'idle');
   if (allow) return 'prompt';
   throw Error(mode === 'accepted-failure' ? 'prompt_failed after execution started' : 'endpoint_stale');
  },
  flushQueuedNow: async id => { flushes++; update(id, 'idle'); throw Error('Operator stop could not be confirmed'); },
  onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); }, dispose: () => {},
 }
};
`);
      win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
      await win.loadFile(path.join(root, 'dist/index.html'));
      await win.webContents.executeJavaScript(`(async () => {
        window.__wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        window.__assert = (value, message) => { if (!value) throw Error(message); };
        window.__until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await __wait(20); } throw Error('Queued send condition timed out'); };
        window.__submit = () => document.querySelector('textarea').closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        window.__enqueue = async text => {
          const input = document.querySelector('textarea');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await __wait(40); __submit(); await __wait(60);
        };
        window.__select = async name => {
          const row = [...document.querySelectorAll('.session-row')].find(row => row.textContent.includes(name));
          __assert(row, 'Missing session ' + name); row.click(); await __wait(80);
        };
        await __until(() => document.querySelector('textarea'));
        await __wait(100);
        await __enqueue('first request');
        await __enqueue('later request');
        __assert(__probe.snapshot().calls.length === 0, 'Running-session requests were not held');
        __assert(document.querySelectorAll('.composer-queue-item').length === 2, 'Held queue lost a request');
      })()`);

      if (mode.startsWith('switch-')) {
        await win.webContents.executeJavaScript(`(async () => {
          __probe.update('queue-a', 'idle');
          await __until(() => __probe.snapshot().calls.length === 1);
          await __select('Queue B');
          await __enqueue('B request');
          document.querySelector('.composer-queue-pull').click();
          await __wait(50);
          __assert(document.querySelector('textarea').value === 'B request', 'A pending send locked B queue editing');
          __assert(!document.querySelector('.composer-queue'), 'Pulling B request did not remove its chip');
          await __enqueue('B request');
          __probe.settle();
          await __wait(200);
          __assert(__probe.snapshot().calls.length === 1, 'In-flight release sent another session or continued after switching');
          __assert(document.querySelectorAll('.composer-queue-item').length === 1, 'A completion modified B queue');
          __assert(document.querySelector('.composer-queue-text').textContent === 'B request', 'A request leaked into B queue');
          await __select('Queue A');
          const rows = [...document.querySelectorAll('.composer-queue-text')].map(row => row.textContent);
          __assert(JSON.stringify(rows) === JSON.stringify(${mode === 'switch-failure' ? "['first request', 'later request']" : "['later request']"}), 'Original session queue was lost or contaminated');
          __assert(Boolean(document.querySelector('.composer-queue--blocked')) === ${mode === 'switch-failure'}, 'Failure block did not stay with its session');
          await __wait(100);
          __assert(__probe.snapshot().calls.length === 1, 'Selecting a session caused an implicit retry');
        })()`);
      } else {
        await win.webContents.executeJavaScript(`(async () => {
          ${mode === 'flush' ? '__submit();' : "__probe.update('queue-a', 'idle');"}
          await __until(() => document.querySelector('.composer-queue--blocked'));
          await __wait(150);
          __assert(__probe.snapshot().calls.length === ${mode === 'flush' ? 0 : 1}, 'Rejected queued request was automatically retried');
          __assert(document.querySelectorAll('.composer-queue-item').length === 2, 'Failed request text or later queue was lost');
          __assert(document.querySelector('.composer-queue').textContent.includes('이미 처리됐을 수 있습니다'), 'Uncertain delivery warning missing');
          for (let i = 0; i < 5; i++) {
            __probe.update('queue-a', 'running'); await __wait(30);
            __probe.update('queue-a', 'idle'); await __wait(30);
          }
          __submit(); await __wait(100);
          __assert(__probe.snapshot().calls.length === ${mode === 'flush' ? 0 : 1}, 'Idle transitions or empty Enter replayed a blocked request');
          __assert(__probe.snapshot().flushes === ${mode === 'flush' ? 1 : 0}, 'Blocked queue retried an interrupt');
          await __select('Queue B'); await __select('Queue A');
          __assert(document.querySelector('.composer-queue--blocked'), 'Session switching forgot failed delivery state');
          __assert(__probe.snapshot().calls.length === ${mode === 'flush' ? 0 : 1}, 'Session switching retried the failed request');
          ${mode === 'endpoint' ? `
          document.querySelector('.composer-queue-discard').click(); await __wait(50);
          __probe.allow(); __submit();
          await __until(() => !document.querySelector('.composer-queue'));
          __assert(JSON.stringify(__probe.snapshot().calls.map(call => call.text)) === JSON.stringify(['first request', 'later request']), 'Manual discard/release lost ordering');
          ` : `
          document.querySelector('.composer-queue-pull').click(); await __wait(50);
          __assert(document.querySelector('textarea').value === 'first request', 'Review action did not preserve original draft');
          __assert(__probe.snapshot().calls.length === ${mode === 'flush' ? 0 : 1}, 'Pulling a failed request submitted it');
          `}
        })()`);
      }
      const result = await win.webContents.executeJavaScript(`__probe.snapshot()`);
      if (result.unhandled.length) throw Error(`${mode}: ${result.unhandled.join('; ')}`);
      results.push({ mode, ...result });
      win.destroy(); win = undefined;
    }
    console.log(JSON.stringify({ passed: true, results }));
    await rm(directory, { recursive: true, force: true });
    clearTimeout(timeout); app.exit(0);
  } catch (error) {
    console.error(error); win?.destroy();
    await rm(directory, { recursive: true, force: true });
    clearTimeout(timeout); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
