import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, appendFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const executable = process.env.GJC_BIN || 'gjc';
const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'gajae-preflight-probe-')));
const nonce = randomUUID();
let sessionId;
let relay;
let relayError;
const frames = [];
const exists = async name => access(path.join(workspace, name)).then(() => true, () => false);
const json = async name => JSON.parse(await readFile(path.join(workspace, name), 'utf8'));
const waitFor = async (predicate, label, timeout = 10_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await predicate();
    if (result) return result;
    if (relayError) throw relayError;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const hook = `import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=realpathSync(fileURLToPath(new URL('../../../',import.meta.url)));
const mark=(name,data)=>writeFileSync(join(root,'probe.'+name+'.json'),JSON.stringify(data));
let used=false;
export default function(api){
 api.on('agent_start',(_event,ctx)=>{ctx.abort();mark('agent-start',{sid:ctx.sessionManager.getSessionId()});});
 api.on('before_agent_start',async(event,ctx)=>{
  let timer;let watchdog=false;
  try{
   const run=JSON.parse(readFileSync(join(root,'probe.run.json'),'utf8'));
   const sid=ctx.sessionManager.getSessionId();
   if(used||sid!==run.sid||realpathSync(ctx.cwd)!==root||event.prompt!==run.text){ctx.abort();mark('failure',{reason:'unexpected invocation',sid});return;}
   used=true;
   timer=setTimeout(()=>{watchdog=true;ctx.abort();mark('watchdog',{sid,nonce:run.nonce});},5000);
   mark('entered',{sid,nonce:run.nonce,text:event.prompt});
   while(!watchdog&&!existsSync(join(root,'probe.release')))await new Promise(resolve=>setTimeout(resolve,10));
   mark('exited',{sid,nonce:run.nonce,watchdog});
  }catch(error){ctx.abort();mark('failure',{reason:String(error)});}
  finally{if(timer!==undefined)clearTimeout(timer);}
 });
 mark('loaded',{root});
}
`;
try {
  await mkdir(path.join(workspace, '.gjc/hooks/pre'), { recursive: true });
  await writeFile(path.join(workspace, '.gjc/hooks/pre/preflight-probe.ts'), hook);
  await exec('git', ['init', '-q', workspace]);
  const version = (await exec(executable, ['--version'])).stdout.trim();
  const created = await exec(executable, ['sdk', 'session', 'raw', 'global', '--op', 'session.create',
    '--json-input', JSON.stringify({ cwd: workspace, modelPreset: process.env.AGENT_CONTROL_GJC_PRESET || 'goat' }),
    '--idempotency-key', randomUUID(), '--json'], { cwd: workspace, timeout: 40_000 });
  await writeFile(path.join(workspace, 'probe.create.json'), created.stdout);
  const receipt = JSON.parse(created.stdout);
  sessionId = receipt.result?.sessionId;
  if (receipt.ok !== true || typeof sessionId !== 'string') throw new Error('New session creation was not confirmed; no prompt sent');
  console.log(JSON.stringify({ version, workspace, sessionId, stage: 'created' }));
  await waitFor(() => exists('probe.loaded.json'), 'native preflight hook discovery', 10_000);
  const text = `DISPOSABLE_PREFLIGHT_PROBE ${nonce}. Do not use tools or modify files. Reply exactly PROBE_NOT_EXPECTED_TO_RUN.`;
  await writeFile(path.join(workspace, 'probe.run.json'), JSON.stringify({ sid: sessionId, nonce, text }));
  relay = spawn(executable, ['sdk', 'serve', '--stdio', '--session', sessionId], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  relay.stdout.setEncoding('utf8');
  relay.stdout.on('data', chunk => {
    void appendFile(path.join(workspace, 'probe.frames.jsonl'), chunk);
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { frames.push(JSON.parse(line)); } catch { /* Non-frame diagnostics are retained verbatim. */ }
    }
  });
  relay.stderr.on('data', chunk => { void appendFile(path.join(workspace, 'probe.stderr.log'), chunk); });
  relay.on('error', error => { relayError = error; });
  relay.on('exit', code => { relayError = new Error(`SDK relay exited (${code})`); });
  const hello = await waitFor(() => frames.find(frame => frame.type === 'hello'), 'persistent SDK connection hello');
  if (typeof hello.connectionId !== 'string') throw new Error('SDK did not identify the requester connection');
  const promptId = randomUUID();
  const abortId = randomUUID();
  const clientRef = randomUUID();
  relay.stdin.write(JSON.stringify({ type: 'control_request', id: promptId, operation: 'turn.prompt', input: { text, clientRef } }) + '\n');
  await waitFor(() => exists('probe.entered.json'), 'real before_agent_start barrier', 10_000);
  const entered = await json('probe.entered.json');
  if (entered.sid !== sessionId || entered.nonce !== nonce || entered.text !== text) throw new Error('Barrier belongs to a different request');
  relay.stdin.write(JSON.stringify({ type: 'control_request', id: abortId, operation: 'turn.abort', input: {} }) + '\n');
  const response = id => frames.find(frame => frame.type === 'control_response' && frame.id === id);
  await waitFor(() => response(promptId) && response(abortId), 'correlated cancellation responses before latch release', 4000);
  const prompt = response(promptId);
  const abort = response(abortId);
  if (prompt.ok !== false || prompt.error?.code !== 'busy' || prompt.error?.message !== 'Prompt preflight was cancelled before execution.' || abort.ok !== true || abort.result?.disposition !== 'preflight_cancelled')
    throw new Error('Observed responses do not prove the required preflight cancellation: ' + JSON.stringify({ prompt, abort }));
  if (await exists('probe.watchdog.json') || await exists('probe.failure.json') || await exists('probe.agent-start.json'))
    throw new Error('Safety guard fired; this is not a successful cancellation reproduction');
  await writeFile(path.join(workspace, 'probe.release'), 'release after correlated cancellation');
  await waitFor(() => exists('probe.exited.json'), 'barrier exit');
  if ((await json('probe.exited.json')).watchdog || await exists('probe.agent-start.json')) throw new Error('Unexpected execution after cancellation');
  const result = { reproduced: true, version, workspace, sessionId, connectionId: hello.connectionId, promptId, abortId, clientRef, prompt, abort };
  await writeFile(path.join(workspace, 'probe.result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = { reproduced: false, workspace, sessionId, error: String(error) };
  await writeFile(path.join(workspace, 'probe.result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  relay?.stdin.end();
  relay?.kill('SIGTERM');
  console.log('Preserved disposable session and raw evidence for reconciliation: ' + workspace);
}
