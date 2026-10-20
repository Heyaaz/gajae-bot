import { app, BrowserWindow } from 'electron';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const timeout = setTimeout(() => { console.error('Session read smoke timed out'); app.exit(1); }, 30_000);
app.whenReady().then(async () => {
const directory = await mkdtemp(path.join(tmpdir(), 'gajae-read-smoke-'));
const preload = path.join(directory, 'preload.cjs');
// Deliberately slow reads let real React effects race against pushed events.
await writeFile(preload, `
const listeners = new Set();
const counts = { list: 0, transcript: {}, goal: 0 };
const waiting = {};
let finishList;
const session = id => ({ id, title: 'Read ' + id, subtitle: 'repo', workspace: '/repo', runtime: 'gjc', status: 'idle', updatedAt: 'now', pinned: false, unread: false, accent: '#ff8a34', ownership: 'external', attachment: 'attachable' });
const sessions = ['A', 'B', 'C'].map(session);
const message = (id, text) => ({ id: 'message-' + id, sessionId: id, kind: 'message', role: 'user', content: text, timestamp: 'now' });
window.__reads = {
 counts,
 list: () => finishList(sessions),
 resolve: (id, text) => waiting[id]?.([message(id, text)]),
 push: (id, text) => listeners.forEach(fn => fn({ type: 'transcript.synced', sessionId: id, items: [message(id, text)] })),
};
window.agentControlDesktop = {
 onSessionShortcut: () => () => {},
 onAbortRun: () => () => {},
 onCycleEffort: () => () => {},
 gjc: {
 getConnection: async () => ({ state: 'connected', backend: 'gjc', label: 'Read test', workspace: '/repo' }),
 sendMessage: (id, input) => new Promise(done => { window.__reads.ack = () => {
  // What the controller really does: echo the prompt as a local row, then a
  // full sync that still carries that echo, then the durable rebuild.
  const echo = { id: 'local-prompt-7', sessionId: id, kind: 'message', role: 'user', content: input.text, createdAt: '13:22' };
  listeners.forEach(fn => fn({ type: 'transcript.appended', item: echo }));
  listeners.forEach(fn => fn({ type: 'transcript.synced', sessionId: id, items: [echo] }));
  listeners.forEach(fn => fn({ type: 'transcript.synced', sessionId: id, items: [{ ...echo, id: 'shared-message-7' }] }));
  done('prompt');
 }; }),
 listSessions: () => { counts.list++; return new Promise(done => { finishList = done; }); },
 getTranscript: id => { counts.transcript[id] = (counts.transcript[id] || 0) + 1; return new Promise(done => { waiting[id] = done; }); },
 getTranscriptRevision: async () => undefined,
 getTranscriptChanges: async () => ({ kind: 'patch', items: [] }),
 watchTranscripts: () => {}, refreshSessionContext: async () => {},
 getGoal: () => { counts.goal++; return new Promise(() => {}); },
 getGitStatus: async () => null,
 markSessionRead: async () => {},
 listQueuedMessages: async () => [],
 listSubagents: async () => [],
 onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); },
 dispose: () => {},
}};
`);
let win;
try {
  await app.whenReady();
  win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error(details.message);
  });
  win.webContents.on('preload-error', (_event, _path, error) => console.error(error));
  win.webContents.on('did-fail-load', (_event, code, description) => console.error(code, description));
  win.webContents.on('render-process-gone', (_event, details) => console.error(details));
  console.log('Loading session read fixture');
  await win.loadFile(path.join(root, 'dist/index.html'));
  console.log('Running session read assertions');
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(done => setTimeout(done, ms));
    const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await wait(20); } throw Error('renderer condition timed out'); };
    const assert = (value, message) => { if (!value) throw Error(message); };
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await until(() => __reads.counts.list > 0);
    const initialList = __reads.counts.list;
    for (let i = 0; i < 10; i++) { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }
    await wait(100);
    assert(__reads.counts.list === initialList, 'overlapping discovery requests');
    __reads.list();
    await until(() => __reads.counts.transcript.A === 1);
    __reads.push('B', 'Other session update');
    await wait(100);
    assert(__reads.counts.transcript.A === 1, 'unrelated push duplicated pending transcript');
    const click = title => { const row = [...document.querySelectorAll('.session-row')].find(row => row.textContent.includes(title)); assert(row, 'missing row ' + title); row.click(); };
    click('Read C');
    await until(() => __reads.counts.transcript.C === 1);
    click('Read A');
    await wait(100);
    assert(__reads.counts.transcript.A === 1, 'switch back duplicated pending transcript');
    __reads.resolve('A', 'Loaded saved A');
    await until(() => document.body.textContent.includes('Loaded saved A'));
    click('Read C');
    await wait(100);
    __reads.push('C', 'Fresh pushed C');
    await until(() => document.body.textContent.includes('Fresh pushed C'));
    __reads.resolve('C', 'Stale saved C');
    await wait(100);
    assert(document.body.textContent.includes('Fresh pushed C'), 'stale response overwrote push');
    assert(!document.body.textContent.includes('Stale saved C'), 'stale history rendered');
    const goal = __reads.counts.goal;
    for (let i = 0; i < 10; i++) document.dispatchEvent(new Event('visibilitychange'));
    await wait(100);
    assert(__reads.counts.goal === goal, 'overlapping goal requests');
    __reads.list();
    await wait(100);
    const list = __reads.counts.list;
    window.dispatchEvent(new Event('focus'));
    await until(() => __reads.counts.list === list + 1);
    __reads.list();
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'VISIBLE-BEFORE-BACKEND-ACK');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(40);
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const bubbles = () => [...document.querySelectorAll('.message')].filter(row => row.textContent.includes('VISIBLE-BEFORE-BACKEND-ACK')).length;
    await until(() => bubbles() === 1);
    __reads.ack();
    await wait(150);
    assert(bubbles() === 1, 'prompt rendered ' + bubbles() + ' times after the controller confirmed it');
    return { passed: true, counts: __reads.counts };
  })()`);
  console.log(JSON.stringify(result));
  win.destroy();
  clearTimeout(timeout);
  await rm(directory, { recursive: true, force: true });
  app.exit(0);
} catch (error) {
  console.error(error);
  win?.destroy();
  clearTimeout(timeout);
  await rm(directory, { recursive: true, force: true });
  app.exit(1);
}
}).catch(error => { console.error(error); app.exit(1); });
