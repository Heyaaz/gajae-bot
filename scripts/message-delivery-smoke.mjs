import { app, BrowserWindow } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const prompt = 'message-delivery-smoke-original-prompt';
const timeout = setTimeout(() => {
  console.error('Message delivery smoke timed out');
  void finish(1);
}, 90_000);
let directory;
let win;
let finished = false;

async function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  try {
    win?.destroy();
  } catch (error) {
    console.error('Could not destroy message delivery smoke window', error);
    code = 1;
  }
  win = undefined;
  try {
    if (directory) await rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.error('Could not remove message delivery smoke fixture', error);
    code = 1;
  }
  app.exit(code);
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'gajae-message-delivery-smoke-'));
    const preload = path.join(directory, 'preload.cjs');
    await writeFile(preload, `
const listeners = new Set();
const sessionId = 'message-delivery-smoke-session';
const counts = { listSessions: 0, getTranscriptPage: 0, getTranscript: 0, getTranscriptChanges: 0, getTranscriptRevision: 0 };
const calls = [];
let revision = 0;
let session = {
  id: sessionId,
  title: 'Message delivery fixture',
  subtitle: 'isolated smoke fixture',
  workspace: '/message-delivery-smoke',
  runtime: 'gjc',
  status: 'idle',
  runRevision: 0,
  updatedAt: 'now',
  pinned: false,
  unread: false,
  accent: '#ff8a34',
  ownership: 'external',
  attachment: 'attached',
};
let transcript = [];
const copyItem = item => ({ ...item });
const copySession = () => ({ ...session });
const copyInput = input => ({
  text: input.text,
  images: (input.images ?? []).map(image => ({ ...image })),
  files: (input.files ?? []).map(file => ({ ...file })),
});
const emit = event => { for (const listener of [...listeners]) listener(event); };
const updateSession = status => {
  session = { ...session, status, runRevision: session.runRevision + 1, updatedAt: new Date().toISOString() };
  emit({ type: 'session.updated', session: copySession() });
};
const userRows = () => transcript.filter(item => item.kind === 'message' && item.role === 'user');
window.__messageDeliveryProbe = {
  snapshot: () => ({
    counts: { ...counts },
    calls: calls.map(call => ({ sessionId: call.sessionId, ...copyInput(call.input), result: call.result })),
    durableUserRows: userRows().map(copyItem),
    transcript: transcript.map(copyItem),
  }),
};
window.agentControlDesktop = {
  onSessionShortcut: () => () => {},
  onAbortRun: () => () => {},
  onCycleEffort: () => () => {},
  gjc: {
    getConnection: async () => ({ state: 'connected', backend: 'gjc', label: 'Isolated message-delivery fixture', detail: '', workspace: '/message-delivery-smoke' }),
    listSessions: async () => { counts.listSessions++; return [copySession()]; },
    getTranscriptPage: async id => {
      if (id !== sessionId) throw Error('Unexpected transcript page session: ' + id);
      counts.getTranscriptPage++;
      const items = transcript.map(copyItem);
      const users = items.filter(item => item.kind === 'message' && item.role === 'user');
      return {
        items,
        hasMoreBefore: false,
        hasMoreAfter: false,
        ...(items.length ? { firstId: items[0].id, lastId: items[items.length - 1].id } : {}),
        requests: users.map(item => ({ id: item.id, text: item.content, createdAt: item.createdAt })),
      };
    },
    getTranscript: async id => {
      if (id !== sessionId) throw Error('Unexpected full transcript session: ' + id);
      counts.getTranscript++;
      return transcript.map(copyItem);
    },
    getTranscriptRevision: async id => {
      if (id !== sessionId) throw Error('Unexpected transcript revision session: ' + id);
      counts.getTranscriptRevision++;
      return String(revision);
    },
    getTranscriptChanges: async id => {
      if (id !== sessionId) throw Error('Unexpected transcript changes session: ' + id);
      counts.getTranscriptChanges++;
      return { kind: 'patch', items: [] };
    },
    watchTranscripts: () => {},
    refreshSessionContext: async () => {},
    sendMessage: async (id, input) => {
      if (id !== sessionId) throw Error('Unexpected send session: ' + id);
      const call = { sessionId: id, input: copyInput(input) };
      calls.push(call);
      if (calls.length === 1) {
        updateSession('running');
        await new Promise(resolve => setTimeout(resolve, 80));
        updateSession('idle');
        call.result = 'prompt';
        return 'prompt';
      }
      if (calls.length > 3) throw Error('Unexpected additional message send: ' + calls.length);
      updateSession('running');
      await new Promise(resolve => setTimeout(resolve, 80));
      const sendNumber = calls.length;
      const user = {
        id: 'shared-message-delivery-smoke-user-' + sendNumber,
        kind: 'message',
        sessionId,
        role: 'user',
        content: input.text,
        createdAt: new Date().toISOString(),
      };
      const assistant = {
        id: 'shared-message-delivery-smoke-assistant-' + sendNumber,
        kind: 'message',
        sessionId,
        role: 'assistant',
        content: sendNumber === 2
          ? 'Fixture assistant confirmed the retried prompt.'
          : 'Fixture assistant confirmed the live prompt.',
        createdAt: new Date().toISOString(),
      };
      transcript = [...transcript, user, assistant];
      revision++;
      emit({ type: 'transcript.appended', item: copyItem(user) });
      emit({ type: 'transcript.appended', item: copyItem(assistant) });
      await new Promise(resolve => setTimeout(resolve, 80));
      updateSession('idle');
      call.result = 'prompt';
      return 'prompt';
    },
    getGoal: async () => ({ enabled: false, completed: 0, total: 0 }),
    getGitStatus: async () => null,
    markSessionRead: async () => {},
    listQueuedMessages: async () => [],
    listSubagents: async () => [],
    flushQueuedNow: async () => false,
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    dispose: () => {},
  },
};
`);

    const rendererErrors = [];
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      webPreferences: {
        preload,
        partition: 'message-delivery-smoke',
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on('console-message', details => {
      if (details.level === 'error') rendererErrors.push(details.message);
    });
    win.webContents.on('preload-error', (_event, _path, error) => rendererErrors.push(String(error)));
    win.webContents.on('did-fail-load', (_event, code, description) => rendererErrors.push(`${code}: ${description}`));
    win.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(JSON.stringify(details)));

    await win.loadFile(path.join(root, 'dist/index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const prompt = ${JSON.stringify(prompt)};
      const livePrompt = 'message-delivery-smoke-live-confirmation';
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const assert = (condition, message) => { if (!condition) throw Error(message); };
      const until = async (predicate, timeoutMs = 15_000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (predicate()) return;
          await wait(25);
        }
        throw Error('Message delivery condition timed out');
      };
      const probe = () => __messageDeliveryProbe.snapshot();
      const retryButtons = () => [...document.querySelectorAll('button')]
        .filter(button => button.textContent.trim() === '전달 안 됨 · 다시 보내기');
      const userRows = text => [...document.querySelectorAll('.message--user')]
        .filter(row => row.querySelector('.message-body')?.textContent.trim() === text);
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      await until(() => document.querySelector('.app-shell') && document.querySelector('textarea'));
      await until(() => probe().counts.listSessions > 0 && probe().counts.getTranscriptPage > 0);
      await wait(150);
      const beforeSend = probe();
      assert(beforeSend.counts.getTranscript === 0,
        'The displayed transcript used a full getTranscript read instead of its page');
      assert(beforeSend.counts.getTranscriptPage > 0, 'The display did not load a transcript page');

      const textarea = document.querySelector('.composer textarea') ?? document.querySelector('textarea');
      assert(textarea, 'Composer textarea did not render');
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(textarea, prompt);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(60);
      const submit = textarea.closest('form')?.querySelector('button[type="submit"]');
      assert(submit && !submit.disabled, 'Composer send button was unavailable');
      submit.click();
      await until(() => probe().calls.length === 1);
      await until(() => retryButtons().length === 1, 20_000);

      const failed = probe();
      assert(failed.calls.length === 1, 'The failed request was sent more than once before retry');
      assert(failed.calls[0].text === prompt, 'The first send changed the original prompt');
      assert(failed.calls[0].result === 'prompt', 'The first send did not resolve as a prompt');
      assert(failed.durableUserRows.length === 0, 'The fixture unexpectedly confirmed the first send');
      assert(retryButtons()[0] && !retryButtons()[0].disabled, 'Failed delivery did not offer an actionable retry');
      const fullReadsAtFailure = failed.counts.getTranscript;
      retryButtons()[0].click();

      await until(() => probe().calls.length === 2);
      await until(() => probe().calls[1]?.result === 'prompt');
      await until(() => document.body.textContent.includes('Fixture assistant confirmed the retried prompt.') &&
        userRows(prompt).length === 1 && retryButtons().length === 0);
      const confirmed = probe();
      assert(confirmed.calls.length === 2, 'The prompt did not result in exactly two sends');
      assert(confirmed.calls[0].text === prompt && confirmed.calls[1].text === prompt,
        'Retry did not preserve the original prompt exactly');
      assert(confirmed.calls[1].result === 'prompt', 'The retried send did not resolve as a prompt');
      assert(confirmed.durableUserRows.length === 1 && confirmed.durableUserRows[0].content === prompt,
        'Retry did not publish exactly one durable user row with the original prompt');
      assert(confirmed.calls.filter(call => call.text === prompt).length === 2,
        'The original request was not sent exactly twice including its retry');
      assert(userRows(prompt).length === 1, 'Confirmed prompt is rendered as duplicate visible user rows');
      assert(document.body.textContent.includes(prompt), 'Original prompt disappeared after retry');
      assert(retryButtons().length === 0, 'Failed-delivery retry button remained after durable confirmation');

      const liveTextarea = document.querySelector('.composer textarea') ?? document.querySelector('textarea');
      nativeSetter.call(liveTextarea, livePrompt);
      liveTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(60);
      const liveSubmit = liveTextarea.closest('form')?.querySelector('button[type="submit"]');
      assert(liveSubmit && !liveSubmit.disabled, 'Composer could not send the live-confirmation request');
      liveSubmit.click();
      await until(() => probe().calls.length === 3);
      await until(() => probe().calls[2]?.result === 'prompt');
      await until(() => document.body.textContent.includes('Fixture assistant confirmed the live prompt.') &&
        userRows(livePrompt).length === 1 && retryButtons().length === 0);
      const liveConfirmed = probe();
      assert(liveConfirmed.calls[2].text === livePrompt && liveConfirmed.calls[2].result === 'prompt',
        'The ordinary live-confirmation send was not preserved and accepted');
      assert(liveConfirmed.durableUserRows.length === 2 &&
        liveConfirmed.durableUserRows.some(item => item.content === livePrompt),
        'The ordinary live-confirmation request did not add durable user evidence');
      assert(userRows(prompt).length === 1 && userRows(livePrompt).length === 1,
        'Live confirmation duplicated one of the visible user requests');
      assert(retryButtons().length === 0, 'A retry appeared after ordinary durable confirmation');

      const fullReadsAtConfirmation = liveConfirmed.counts.getTranscript;
      await wait(10_250);
      const final = probe();
      assert(final.calls.length === 3, 'A send was replayed without another user action');
      assert(retryButtons().length === 0, 'A durable confirmation later became a failed-delivery retry');
      assert(userRows(prompt).length === 1 && userRows(livePrompt).length === 1,
        'A confirmed user prompt became duplicated after the idle grace');
      assert(final.counts.getTranscript === fullReadsAtConfirmation,
        'A full getTranscript read repeated after the paged display and delivery confirmation');
      return {
        passed: true,
        sessionId: ${JSON.stringify('message-delivery-smoke-session')},
        pageReads: final.counts.getTranscriptPage,
        fullTranscriptReadsBeforeSend: beforeSend.counts.getTranscript,
        fullTranscriptReadsForDelivery: fullReadsAtConfirmation,
        fullTranscriptReadsAtFailure: fullReadsAtFailure,
        sendTexts: final.calls.map(call => call.text),
        originalPromptSendCount: final.calls.filter(call => call.text === prompt).length,
        durableUserRows: final.durableUserRows.length,
        visiblePromptRows: userRows(prompt).length,
        visibleLiveConfirmationRows: userRows(livePrompt).length,
        retryButtonAfterConfirmation: retryButtons().length,
        retryAssistantConfirmed: document.body.textContent.includes('Fixture assistant confirmed the retried prompt.'),
        liveAssistantConfirmed: document.body.textContent.includes('Fixture assistant confirmed the live prompt.'),
      };
    })()`);

    if (rendererErrors.length > 0)
      throw new Error(`Renderer reported errors: ${rendererErrors.join('; ')}`);
    console.log(JSON.stringify(result, null, 2));
    console.log('Message delivery smoke passed');
    await finish(0);
  } catch (error) {
    console.error('Message delivery smoke failed', error);
    await finish(1);
  }
}).catch(async error => {
  console.error('Message delivery smoke failed to start', error);
  await finish(1);
});
