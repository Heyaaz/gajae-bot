import './smoke-isolation.mjs'
import { app, BrowserWindow } from 'electron';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const timeout = setTimeout(() => { console.error('Skill UI smoke timed out'); app.exit(1); }, 30_000);
app.whenReady().then(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gajae-skill-ui-'));
  const preload = path.join(directory, 'preload.cjs');
  const content = '# Whip\n\nVerify the result, not the completion claim.\n\n## Verification\n\n' + Array.from({ length: 40 }, (_, index) => `${index + 1}. Preserve the complete instructions and verify observable behavior.`).join('\n') + '\n\nOriginal instructions end here.';
  await writeFile(preload, `
const content = ${JSON.stringify(content)};
const sessionId = 'skill-ui';
const listeners = new Set();
window.__copied = '';
window.__skillSource = content;
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copied = text; } } });
const session = { id: sessionId, title: '스킬 UI 개선', subtitle: 'gajae-bot', workspace: '/repo/gajae-bot', runtime: 'gjc', status: 'idle', updatedAt: 'now', pinned: false, unread: false, accent: '#ff8a34', ownership: 'external', attachment: 'attachable' };
const items = [
 { id: 'request', sessionId, kind: 'message', role: 'user', content: '/skill:whip 조회 성능 개선 결과를 확인해줘', createdAt: '01:41' },
 { id: 'instructions', sessionId, kind: 'system', sourceType: 'skill-prompt', title: '스킬', content, createdAt: '01:41' },
 { id: 'answer', sessionId, kind: 'message', role: 'assistant', content: '요청한 변경과 실제 동작을 확인했습니다.\\n\\n- 초기 목록의 중복 조회를 제거했습니다.\\n- 저장된 대화는 먼저 표시합니다.\\n- 상세 스킬 지침은 위에서 펼쳐볼 수 있습니다.', createdAt: '01:42' },
];
const page = { items, requests: [{ id: 'request', text: '/skill:whip 조회 성능 개선 결과를 확인해줘', createdAt: '01:41' }], hasMoreBefore: false, hasMoreAfter: false, firstId: 'request', lastId: 'answer' };
const emitCommands = () => setTimeout(() => listeners.forEach(fn => fn({ type: 'session.commands', sessionId, commands: [
  { name: 'skill:whip', description: '완료된 작업이 요청대로 반영됐는지 검증합니다', hint: '[검증할 내용]' },
  { name: 'skill:deep-interview', description: '질문을 통해 요구사항과 목표를 구체화합니다', hint: '[주제]' },
  { name: 'skill:frontend-design', description: '완성도 높은 사용자 인터페이스를 설계합니다', hint: '[요청]' },
  { name: 'context', description: '현재 컨텍스트 사용량을 확인합니다', hint: '[검증할 내용]' },
] })), 100);
window.agentControlDesktop = {
 onSessionShortcut: () => () => {}, onAbortRun: () => () => {}, onCycleEffort: () => () => {},
 gjc: {
  getConnection: async () => ({ state: 'connected', backend: 'gjc', label: 'GJC', workspace: '/repo/gajae-bot', modelPreset: 'codex-pro' }),
  listSessions: async () => [session],
  getTranscript: async () => { emitCommands(); return items; },
  getTranscriptPage: async () => { emitCommands(); return page; },
  getTranscriptRevision: async () => undefined,
  getTranscriptChanges: async () => ({ kind: 'patch', items: [] }),
  watchTranscripts: () => {}, refreshSessionContext: async () => {},
  getGoal: async () => ({ enabled: false, completed: 0, total: 0 }), getGitStatus: async () => null,
  markSessionRead: async () => {}, listQueuedMessages: async () => [], listSubagents: async () => [],
  onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); }, dispose: () => {},
 }
};
`);
  let win;
  try {
    win = new BrowserWindow({ width: 1400, height: 960, show: false, webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    await win.loadFile(path.join(root, 'dist/index.html'));
    win.show();
    app.focus({ steal: true });
    win.focus();
    await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(done => setTimeout(done, ms));
      window.__until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await wait(20); } throw Error('Skill UI condition timed out'); };
      window.__assert = (value, message) => { if (!value) throw Error(message); };
      await __until(() => document.querySelector('.skill-activity') && document.querySelector('.skill-invocation'));
      const details = document.querySelector('.skill-activity');
      __assert(!details.open, 'instructions must start collapsed');
      __assert(!details.querySelector('.markdown-body'), 'collapsed instructions mounted full markdown');
      __assert(details.getBoundingClientRect().height <= 74, 'collapsed skill row is too tall');
      __assert(document.querySelector('.skill-invocation-args').textContent.includes('조회 성능'), 'skill arguments were lost');
      document.querySelector('.message--skill .message-copy').click();
      await __until(() => window.__copied === '/skill:whip 조회 성능 개선 결과를 확인해줘');
      details.querySelector('summary').focus();
    })()`);
    console.log('Checking native skill disclosure keyboard interaction');
    win.webContents.focus();
    // A trusted key event exercises native details keyboard behavior.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await win.webContents.executeJavaScript(`(async () => {
      await __until(() => document.querySelector('.skill-activity-content'));
      const details = document.querySelector('.skill-activity');
      const body = details.querySelector('.skill-activity-content');
      __assert(body.textContent.includes('Original instructions end here.'), 'expanded instructions were truncated');
      __assert(body.clientHeight <= 361 && body.scrollHeight > body.clientHeight, 'expanded instructions are not bounded and scrollable');
      details.querySelector('.message-copy').click();
      await __until(() => window.__copied === window.__skillSource);
    })()`);
    await new Promise(done => setTimeout(done, 200));
    await writeFile(path.join(directory, 'expanded.png'), (await win.webContents.capturePage()).toPNG());
    console.log('Checking skill palette selection');
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('.skill-activity summary').click();
      await __until(() => !document.querySelector('.skill-activity-content'));
      const input = document.querySelector('textarea');
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '/skill');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await __until(() => document.querySelectorAll('.command-palette .is-skill').length === 3);
      const option = document.querySelector('.command-palette .is-skill');
      __assert(option.querySelector('strong').textContent === 'whip', 'skill palette still uses raw command as title');
      __assert(option.querySelector('.command-skill-badge').textContent === '스킬', 'skill type missing');
    })()`);
    await new Promise(done => setTimeout(done, 200));
    await writeFile(path.join(directory, 'wide.png'), (await win.webContents.capturePage()).toPNG());
    console.log('Checking selected skill remains a draft');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await win.webContents.executeJavaScript(`(async () => {
      await __until(() => document.querySelector('textarea').value === '/skill:whip ');
      __assert(!document.querySelector('.command-palette'), 'selected skill must remain an editable draft, not an open palette');
    })()`);
    win.setSize(560, 900);
    await new Promise(done => setTimeout(done, 350));
    const result = await win.webContents.executeJavaScript(`(() => {
      const details = document.querySelector('.skill-activity');
      const box = details.getBoundingClientRect();
      __assert(box.width > 100 && box.left >= 0 && box.right <= innerWidth, 'skill row overflows narrow viewport');
      __assert(document.documentElement.scrollWidth <= innerWidth, 'page overflows narrow viewport');
      return { passed: true, collapsedHeight: box.height, narrowWidth: innerWidth, copiedOriginal: window.__copied === window.__skillSource };
    })()`);
    await writeFile(path.join(directory, 'narrow.png'), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ...result, screenshots: directory }));
    win.destroy();
    await rm(preload);
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    win?.destroy();
    await rm(directory, { recursive: true, force: true });
    clearTimeout(timeout);
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
