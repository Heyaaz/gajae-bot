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
}, 120_000);
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
  finishUnrelatedWork: () => {
    transcript = transcript.map(item =>
      item.id === 'unrelated-assistant-live' ? { ...item, streaming: false } :
      item.id === 'unrelated-tool-running' ? { ...item, status: 'completed' } : item,
    );
    emit({ type: 'transcript.synced', sessionId, items: transcript.map(copyItem) });
    updateSession('idle');
  },
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
      const sendNumber = calls.length;
      if (sendNumber === 1) {
        updateSession('running');
        await new Promise(resolve => setTimeout(resolve, 80));
        updateSession('idle');
        call.result = 'prompt';
        return 'prompt';
      }
      if (sendNumber === 4) {
        updateSession('running');
        const assistant = {
          id: 'unrelated-assistant-live',
          kind: 'message',
          sessionId,
          role: 'assistant',
          content: 'An unrelated assistant turn is still working.',
          streaming: true,
          createdAt: new Date().toISOString(),
        };
        const tool = {
          id: 'unrelated-tool-running',
          kind: 'tool',
          sessionId,
          name: 'Fixture tool',
          description: 'Unrelated work still running',
          command: 'fixture unrelated work',
          status: 'running',
          output: '',
          createdAt: new Date().toISOString(),
        };
        transcript = [...transcript, assistant, tool];
        emit({ type: 'transcript.appended', item: copyItem(assistant) });
        emit({ type: 'transcript.appended', item: copyItem(tool) });
        await new Promise(resolve => setTimeout(resolve, 80));
        call.result = { kind: 'not_executed', detail: 'Prompt preflight was cancelled before execution.' };
        return call.result;
      }
      if (sendNumber === 6) {
        updateSession('running');
        call.result = undefined;
        return new Promise(resolve => { call.resolve = resolve; });
      }
      if (![2, 3, 5, 7].includes(sendNumber))
        throw Error('Unexpected additional message send: ' + sendNumber);
      if (sendNumber === 2 || sendNumber === 3) updateSession('running');
      await new Promise(resolve => setTimeout(resolve, 80));
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
          : sendNumber === 3
            ? 'Fixture assistant confirmed the live prompt.'
            : sendNumber === 5
              ? 'Fixture assistant confirmed the running-session retry.'
              : 'Fixture assistant confirmed the manually approved retry.',
        createdAt: new Date().toISOString(),
      };
      transcript = [...transcript, user, assistant];
      revision++;
      emit({ type: 'transcript.appended', item: copyItem(user) });
      emit({ type: 'transcript.appended', item: copyItem(assistant) });
      await new Promise(resolve => setTimeout(resolve, 80));
      if (sendNumber === 2 || sendNumber === 3) updateSession('idle');
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
      const notExecutedPrompt = 'message-delivery-smoke-not-executed-while-running';
      const unknownPrompt = 'message-delivery-smoke-unknown-running-send';
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const assert = (condition, message) => { if (!condition) throw Error(message); };
      const until = async (predicate, timeoutMs = 15_000, stage = 'requested message-delivery state') => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          if (predicate()) return;
          await wait(25);
        }
        throw Error('Message delivery condition timed out: ' + stage);
      };
      const probe = () => __messageDeliveryProbe.snapshot();
      const normalRetryLabels = new Set(['전달 안 됨 · 다시 보내기', 'Not delivered · Resend']);
      const unknownRetryLabels = new Set(['결과 알 수 없음 · 다시 시도', 'Outcome unknown · Retry']);
      const retryButtons = () => [...document.querySelectorAll('button')]
        .filter(button => normalRetryLabels.has(button.textContent.trim()));
      const unknownRetryButtons = () => [...document.querySelectorAll('button')]
        .filter(button => unknownRetryLabels.has(button.textContent.trim()));
      const userRows = text => [...document.querySelectorAll('.message--user')]
        .filter(row => row.querySelector('.message-body')?.textContent.trim() === text);
      const deliveryRow = text => [...document.querySelectorAll('.message--delivery-failed')]
        .find(row => row.querySelector('.message-body')?.textContent.trim() === text);
      const submitPrompt = async text => {
        const input = document.querySelector('.composer textarea') ?? document.querySelector('textarea');
        assert(input, 'Composer textarea did not render for ' + text);
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(60);
        const button = input.closest('form')?.querySelector('button[type="submit"]');
        assert(button && !button.disabled, 'Composer send button was unavailable for ' + text);
        button.click();
      };
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      await until(() => document.querySelector('.app-shell') && document.querySelector('textarea'), 15_000, 'app shell and composer mount');
      await until(() => probe().counts.listSessions > 0 && probe().counts.getTranscriptPage > 0,
        15_000, 'initial session list and transcript page');
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
      await until(() => probe().calls.length === 1, 15_000, 'first prompt submission');
      await until(() => retryButtons().length === 1, 20_000, 'idle-grace retry for unconfirmed first prompt');

      const failed = probe();
      assert(failed.calls.length === 1, 'The failed request was sent more than once before retry');
      assert(failed.calls[0].text === prompt, 'The first send changed the original prompt');
      assert(failed.calls[0].result === 'prompt', 'The first send did not resolve as a prompt');
      assert(failed.durableUserRows.length === 0, 'The fixture unexpectedly confirmed the first send');
      assert(retryButtons()[0] && !retryButtons()[0].disabled, 'Failed delivery did not offer an actionable retry');
      const fullReadsAtFailure = failed.counts.getTranscript;
      retryButtons()[0].click();

      await until(() => probe().calls.length === 2, 15_000, 'manual retry submission');
      await until(() => probe().calls[1]?.result === 'prompt', 15_000, 'durable retry response');
      await until(() => document.body.textContent.includes('Fixture assistant confirmed the retried prompt.') &&
        userRows(prompt).length === 1 && retryButtons().length === 0, 15_000, 'durable retry row and assistant response');
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
      await until(() => probe().calls.length === 3, 15_000, 'ordinary success submission');
      await until(() => probe().calls[2]?.result === 'prompt', 15_000, 'ordinary success response');
      await until(() => document.body.textContent.includes('Fixture assistant confirmed the live prompt.') &&
        userRows(livePrompt).length === 1 && retryButtons().length === 0, 15_000, 'ordinary durable success row');
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

      await submitPrompt(notExecutedPrompt);
      await until(() => probe().calls.length === 4, 15_000, 'not-executed prompt submission while a turn is live');
      await until(() => probe().calls[3]?.result?.kind === 'not_executed', 15_000, 'known-not-executed adapter result');
      await until(() => retryButtons().some(button => deliveryRow(notExecutedPrompt)?.contains(button)),
        15_000, 'request-specific retry while the unrelated session remains working');
      const notExecuted = probe();
      assert(notExecuted.calls.length === 4, 'Known-not-executed request was sent before its manual retry');
      assert(notExecuted.calls[3].text === notExecutedPrompt,
        'Known-not-executed result was attached to the wrong request');
      assert(notExecuted.calls[3].result?.kind === 'not_executed' &&
        notExecuted.calls[3].result?.detail === 'Prompt preflight was cancelled before execution.',
      'Fixture did not return the exact known-not-executed outcome');
      assert(!notExecuted.durableUserRows.some(item => item.content === notExecutedPrompt),
        'Known-not-executed request unexpectedly had a durable user row');
      const notExecutedRow = deliveryRow(notExecutedPrompt);
      const notExecutedStatus = notExecutedRow?.querySelector('[role="status"]')?.textContent.trim() ?? '';
      assert(notExecutedStatus.includes('Prompt preflight was cancelled before execution.') &&
        (notExecutedStatus.includes('요청이 실행되지 않았습니다') ||
          notExecutedStatus.includes('The request was not executed')),
      'The request-specific not-executed explanation was not rendered');
      const runningAssistant = notExecuted.transcript.find(item => item.id === 'unrelated-assistant-live');
      const runningTool = notExecuted.transcript.find(item => item.id === 'unrelated-tool-running');
      assert(runningAssistant?.kind === 'message' && runningAssistant.streaming === true &&
        runningAssistant.content === 'An unrelated assistant turn is still working.',
      'Unrelated assistant stream was not live when the request was rejected');
      assert(runningTool?.kind === 'tool' && runningTool.status === 'running',
        'Unrelated tool was not still running when the request was rejected');
      assert(document.querySelector('.conversation--running'),
        'Session stopped working after the prompt preflight was cancelled');
      assert(!unknownRetryButtons().length,
        'Known-not-executed request was mislabeled with the unknown-outcome retry');
      const notExecutedRetry = retryButtons().find(button => deliveryRow(notExecutedPrompt)?.contains(button));
      assert(notExecutedRetry && !notExecutedRetry.disabled,
        'Known-not-executed request did not offer an actionable retry while work continued');
      notExecutedRetry.click();
      await until(() => probe().calls.length === 5, 15_000, 'not-executed request retry submission');
      await until(() => probe().calls[4]?.result === 'prompt', 15_000, 'not-executed retry response');
      await until(() => document.body.textContent.includes('Fixture assistant confirmed the running-session retry.') &&
        userRows(notExecutedPrompt).length === 1 && !deliveryRow(notExecutedPrompt),
      15_000, 'durable running-session retry confirmation');
      const runningRetry = probe();
      assert(runningRetry.calls[3].text === notExecutedPrompt &&
        runningRetry.calls[4].text === notExecutedPrompt && runningRetry.calls.length === 5,
      'Manual retry did not preserve the original not-executed request exactly');
      assert(runningRetry.durableUserRows.filter(item => item.content === notExecutedPrompt).length === 1,
        'Retry did not durably confirm exactly one copy of the rejected request');
      const assistantAfterRetry = runningRetry.transcript.find(item => item.id === 'unrelated-assistant-live');
      const toolAfterRetry = runningRetry.transcript.find(item => item.id === 'unrelated-tool-running');
      assert(assistantAfterRetry?.kind === 'message' && assistantAfterRetry.streaming === true &&
        assistantAfterRetry.content === runningAssistant.content,
      'Retry finalized or replaced the unrelated assistant stream');
      assert(toolAfterRetry?.kind === 'tool' && toolAfterRetry.status === 'running' &&
        toolAfterRetry.output === runningTool.output,
      'Retry finalized or replaced the unrelated running tool');
      assert(document.querySelector('.conversation--running'),
        'Manual retry ended the unrelated session work');

      await window.__messageDeliveryProbe.finishUnrelatedWork();
      await until(() => document.querySelector('.conversation--idle'), 15_000, 'unrelated fixture turn completion');
      const unknownStartedAt = Date.now();
      await submitPrompt(unknownPrompt);
      await until(() => probe().calls.length === 6, 15_000, 'active unknown-outcome send submission');
      await until(() => unknownRetryButtons().some(button => deliveryRow(unknownPrompt)?.contains(button)),
        40_000, 'honest unknown status after the 30-second threshold');
      assert(Date.now() - unknownStartedAt >= 30_000,
        'Active send was marked unknown before the 30-second uncertainty threshold');
      const unknown = probe();
      assert(unknown.calls.length === 6 && unknown.calls[5].text === unknownPrompt,
        'Unknown outcome was not attached to the active request');
      const unknownRow = deliveryRow(unknownPrompt);
      const unknownStatus = unknownRow?.querySelector('[role="status"]')?.textContent.trim() ?? '';
      const normalizedUnknownStatus = unknownStatus.toLowerCase();
      assert(unknownStatus === '전달 결과를 알 수 없습니다. 아직 대기 중일 수 있습니다.' ||
        (normalizedUnknownStatus.includes('outcome') && normalizedUnknownStatus.includes('unknown') &&
          normalizedUnknownStatus.includes('queued')),
      'Active unresolved send was not labeled honestly as an unknown outcome');
      assert(!retryButtons().some(button => unknownRow?.contains(button)),
        'Unknown active send was mislabeled as definitely not delivered');
      const unknownRetry = unknownRetryButtons().find(button => unknownRow?.contains(button));
      assert(unknownRetry && !unknownRetry.disabled,
        'Unknown outcome did not offer a manual retry behind its confirmation');

      const confirmationQuestions = [];
      const confirmationAnswers = [false, true];
      Object.defineProperty(window, 'confirm', {
        configurable: true,
        value: question => {
          confirmationQuestions.push(question);
          return confirmationAnswers.shift() ?? false;
        },
      });
      unknownRetry.click();
      assert(confirmationQuestions.length === 1, 'Unknown retry did not ask for confirmation');
      const confirmationText = confirmationQuestions[0].toLowerCase();
      assert(confirmationQuestions[0].includes('전달 결과를 확인할 수 없습니다') ||
        (confirmationText.includes('outcome') && confirmationText.includes('queued') &&
          confirmationText.includes('retrying') && confirmationText.includes('twice')),
      'Unknown retry confirmation did not explain possible duplicate execution');
      assert(probe().calls.length === 6,
        'Cancelling unknown-outcome confirmation still submitted a retry');
      await wait(120);
      assert(probe().calls.length === 6,
        'Cancelling unknown-outcome confirmation submitted a delayed retry');
      assert(unknownRetryButtons().some(button => deliveryRow(unknownPrompt)?.contains(button)),
        'Cancelling the dialog discarded the recoverable unknown request');
      const approvedRetry = unknownRetryButtons().find(button => deliveryRow(unknownPrompt)?.contains(button));
      assert(approvedRetry, 'Unknown retry disappeared before explicit approval');
      approvedRetry.click();
      await until(() => probe().calls.length === 7, 15_000, 'approved unknown-outcome retry submission');
      await until(() => probe().calls[6]?.result === 'prompt', 15_000, 'approved unknown-outcome retry response');
      await until(() => document.body.textContent.includes('Fixture assistant confirmed the manually approved retry.') &&
        userRows(unknownPrompt).length === 1 && !deliveryRow(unknownPrompt),
      15_000, 'durable approved retry confirmation');
      const completed = probe();
      assert(confirmationQuestions.length === 2,
        'Unknown retry did not ask again after the user cancelled the first confirmation');
      assert(completed.calls.filter(call => call.text === unknownPrompt).length === 2,
        'Unknown request was not sent exactly once initially and once after approval');
      assert(completed.durableUserRows.filter(item => item.content === unknownPrompt).length === 1,
        'Approved unknown retry did not produce one durable confirmation');
      assert(completed.counts.getTranscript === fullReadsAtConfirmation,
        'Delivery recovery fell back to a full transcript read');
      return {
        passed: true,
        sessionId: ${JSON.stringify('message-delivery-smoke-session')},
        pageReads: completed.counts.getTranscriptPage,
        fullTranscriptReadsBeforeSend: beforeSend.counts.getTranscript,
        fullTranscriptReadsForDelivery: fullReadsAtConfirmation,
        fullTranscriptReadsAtFailure: fullReadsAtFailure,
        scenarios: {
          idleGraceRetry: { sends: 2, preservedPrompt: true, durableConfirmation: true },
          ordinarySuccess: { sends: 1, durableConfirmation: true },
          notExecutedWhileRunning: { sends: 2, exactRequestRetried: true, unrelatedWorkPreserved: true },
          unknownActiveSend: { elapsedMs: Date.now() - unknownStartedAt, cancelledConfirmationSent: false, approvedRetry: true },
        },
        sendTexts: completed.calls.map(call => call.text),
        durableUserRows: completed.durableUserRows.length,
        visiblePromptRows: userRows(prompt).length,
        visibleLiveConfirmationRows: userRows(livePrompt).length,
        retryButtonAfterConfirmation: retryButtons().length,
        retryAssistantConfirmed: document.body.textContent.includes('Fixture assistant confirmed the retried prompt.'),
        liveAssistantConfirmed: document.body.textContent.includes('Fixture assistant confirmed the live prompt.'),
        runningSessionRetryAssistantConfirmed: document.body.textContent.includes('Fixture assistant confirmed the running-session retry.'),
        approvedUnknownRetryAssistantConfirmed: document.body.textContent.includes('Fixture assistant confirmed the manually approved retry.'),
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
