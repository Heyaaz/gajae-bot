import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GjcSdkCli } from "./gjc-sdk-cli.js";

async function fixture(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "gajae-observer-test-"));
  const executable = path.join(root, "gjc.cjs");
  await writeFile(executable, `#!/usr/bin/env node\n${source}`);
  await chmod(executable, 0o755);
  const client = new GjcSdkCli({ executable, repo: root, env: process.env });
  return { root, client, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("SDK tool observer transport", () => {
  it("forwards SDK live reply snapshots instead of filtering them out", async () => {
    const test = await fixture(`
      process.stdout.write('{"type":"hello"}\\n');
      process.stdin.once('data', chunk => {
        const request = JSON.parse(String(chunk));
        process.stdout.write(JSON.stringify({type:'event_replay_result',id:request.id,ok:true})+'\\n');
        process.stdout.write(JSON.stringify({type:'event',kind:'turn_stream',payload:{type:'turn_stream',sessionId:'s1',phase:'live',text:'answer growing',messageRef:'42'}})+'\\n');
        process.exit(0);
      });
    `);
    const events: unknown[] = [];
    try {
      await test.client.observeTools("s1", (kind, payload) => events.push({ kind, payload }), new AbortController().signal);
      expect(events).toEqual([{ kind: "turn_stream", payload: { type: "turn_stream", sessionId: "s1", phase: "live", text: "answer growing", messageRef: "42" } }]);
    } finally { await test.cleanup(); }
  });

  it("negotiates both observer capabilities and reads fragmented JSONL snapshots", async () => {
    const test = await fixture(`
      process.stdout.write('{"type":"hello"}\\n');
      process.stdin.once('data', chunk => {
        const request = JSON.parse(String(chunk));
        process.stdout.write(JSON.stringify({type:'event_replay_result', id:request.id, ok:true})+'\\n');
        process.stdout.write('{"type":"event","kind":"tool_execution_update","pay');
        setTimeout(() => {
          process.stdout.write('load":'+JSON.stringify({event:{type:'tool_execution_update', toolCallId:'t1',toolName:'bash',partialResult:{content:[{type:'text',text:'line1\\n'}]}},capabilities:request.capabilities})+'}\\n');
          process.stdout.write(JSON.stringify({type:'activity',state:'idle'})+'\\n');
          process.exit(0);
        }, 10);
      });
    `);
    const events: unknown[] = [];
    try {
      await test.client.observeTools("s1", (kind, payload) => events.push({ kind, payload }), new AbortController().signal);
      expect(events).toEqual([{ kind: "tool_execution_update", payload: {
        event: { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "line1\n" }] } },
        capabilities: ["turn_stream", "session_host_observer_v1"],
      } }]);
    } finally { await test.cleanup(); }
  });

  it("terminates only its relay when detached", async () => {
    const test = await fixture(`process.stdout.write('{"type":"hello"}\\n'); setInterval(()=>{},1000);`);
    const abort = new AbortController();
    try {
      const read = test.client.observeTools("s1", () => undefined, abort.signal);
      abort.abort();
      await read;
      await test.client.observeTools("s1", () => { throw new Error("Unexpected frame"); }, abort.signal);
    } finally { await test.cleanup(); }
  });

  it("rejects malformed framing rather than silently losing stream updates", async () => {
    const test = await fixture(`process.stdout.write('not-json\\n'); setInterval(()=>{},1000);`);
    try {
      await expect(test.client.observeTools("s1", () => undefined, new AbortController().signal)).rejects.toThrow();
    } finally { await test.cleanup(); }
  });
});
