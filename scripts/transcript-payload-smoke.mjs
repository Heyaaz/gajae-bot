import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GjcSdkController } from '../dist-electron/electron/gjc-sdk-controller.js';
import { selectTranscriptPage } from '../dist-electron/shared/transcript-page.js';
import { projectTranscriptItemForDelivery } from '../dist-electron/electron/transcript-body-preview.js';

const sessionId = process.argv[2];
if (!sessionId) throw new Error('Usage: node scripts/transcript-payload-smoke.mjs <existing-session-id>');
const artifacts = await mkdtemp(path.join(tmpdir(), 'gajae-payload-read-'));
const controller = new GjcSdkController({
  workspace: process.cwd(), executable: process.env.GJC_BIN || 'gjc',
  permissionHandling: 'prompt', artifactDirectory: artifacts, emit: () => {},
});
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const digest = text => createHash('sha256').update(text).digest('hex');
try {
  // Read-only: this harness never creates, sends to, stops, or deletes a session.
  const full = await controller.getTranscript(sessionId);
  const original = selectTranscriptPage(full);
  const projected = { ...original, items: original.items.map(projectTranscriptItemForDelivery) };
  if (projected.items.map(item => item.id).join('\0') !== original.items.map(item => item.id).join('\0'))
    throw new Error('Projection changed request boundaries or item identity');
  const before = bytes(original);
  const after = bytes(projected);
  if (after >= before * 0.5) throw new Error(`Expected at least 50% reduction for this long-session probe: ${before} -> ${after}`);
  const originals = new Map(original.items.map(item => [item.id, item]));
  const samples = [];
  for (const item of projected.items) {
    if (item.kind !== 'tool') continue;
    const source = originals.get(item.id);
    for (const [field, ref] of [['output', item.outputArtifactId], ['command', item.inputArtifactId]]) {
      if (!ref?.startsWith('gajae-transcript-body-') || typeof source?.[field] !== 'string') continue;
      samples.push({ field, ref, text: source[field] });
    }
  }
  samples.sort((left, right) => right.text.length - left.text.length);
  if (!samples.length) throw new Error('No lazy body references were produced');
  const verified = [];
  for (const sample of samples.slice(0, 3)) {
    const artifact = await controller.readArtifact(sessionId, sample.ref);
    if (!artifact.complete || artifact.text !== sample.text || artifact.totalBytes !== Buffer.byteLength(sample.text))
      throw new Error('Lazy retrieval did not preserve the complete redacted source');
    verified.push({ field: sample.field, bytes: artifact.totalBytes, sha256: digest(artifact.text) });
  }
  const transportPage = await controller.getTranscriptPage(sessionId);
  for (const item of transportPage.items) {
    if (item.kind !== 'tool' || !['completed', 'failed', 'cancelled', 'denied'].includes(item.status)) continue;
    if (item.output && Buffer.byteLength(item.output) > 2048 && !item.outputArtifactId)
      throw new Error('Public page leaked a large settled output without a lazy reference');
  }
  console.log(JSON.stringify({ passed: true, readOnly: true, items: original.items.length,
    originalBytes: before, projectedBytes: after, reductionPercent: Math.round((1 - after / before) * 100),
    actualPageBytes: bytes(transportPage), lazyReferences: samples.length, verifiedOriginals: verified }, null, 2));
} finally {
  controller.dispose();
  await rm(artifacts, { recursive: true, force: true });
}
