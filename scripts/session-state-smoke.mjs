import { GjcSdkController } from '../dist-electron/electron/gjc-sdk-controller.js';
const sessionId = process.argv[2];
if (!sessionId) throw new Error('Usage: node scripts/session-state-smoke.mjs <existing-idle-session-id>');
const events = [];
const controller = new GjcSdkController({
  workspace: process.cwd(), executable: process.env.GJC_BIN || 'gjc', permissionHandling: 'prompt',
  emit: event => {
    if (event.session?.id !== sessionId && event.sessionId !== sessionId) return;
    if (event.type === 'session.updated' || event.type === 'session.activity')
      events.push({ type: event.type, status: event.session?.status, category: event.category });
  },
});
try {
  const sessions = await controller.listSessions();
  const row = sessions.find(session => session.id === sessionId);
  if (!row || row.status !== 'idle') throw new Error('Target must be an existing idle session; no controls were sent');
  const started = events.length;
  await controller.getTranscriptPage(sessionId);
  // The real SDK performs repeated bounded catch-up reads during this interval.
  for (let i = 0; i < 10; i++) {
    await controller.listSessions();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const observed = events.slice(started);
  const falseRuns = observed.filter(event => event.status === 'running');
  const falseCompletions = observed.filter(event => event.category === 'completed');
  if (falseRuns.length || falseCompletions.length)
    throw new Error('Idle history replay fabricated work/completion: ' + JSON.stringify(observed));
  console.log(JSON.stringify({ passed: true, readOnly: true, sessionId, polls: 10,
    falseRunningTransitions: falseRuns.length, falseCompletionNotifications: falseCompletions.length,
    sessionUpdates: observed.length }, null, 2));
} finally { controller.dispose(); }
