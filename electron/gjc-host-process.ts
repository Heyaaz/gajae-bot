import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

/** A running GJC that hosts a session, usually an interactive `gjc` in a terminal. */
export interface GjcHostProcess {
  pid: number;
  /** The controlling terminal, such as `ttys002`; absent for a detached host. */
  terminal?: string;
}

export type ReadProcess = (pid: number) => Promise<string>;

const readProcess: ReadProcess = async (pid) =>
  (await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "tty=,args="])).stdout;

/**
 * The GJC process behind a broker row's `pid`, or undefined when that pid is gone
 * or now belongs to something else. A broker row can keep `live: true` after its
 * host died, and a pid can be reused, so the pid alone never names a process to
 * stop.
 */
export async function gjcHostProcess(
  pid: number,
  read: ReadProcess = readProcess,
): Promise<GjcHostProcess | undefined> {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  let line: string;
  try {
    line = (await read(pid)).trim();
  } catch {
    return undefined;
  }
  const match = /^(\S+)\s+(\S+)(.*)$/u.exec(line);
  if (!match) return undefined;
  const [, tty, command, rest] = match as unknown as [string, string, string, string];
  const isGjc = path.basename(command) === "gjc" || /gajae-code/u.test(command + rest);
  if (!isGjc) return undefined;
  return tty === "??" || tty === "-" ? { pid } : { pid, terminal: tty };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Asks a GJC host to exit the way closing its terminal would, and waits for it.
 * False when it is still running after `timeoutMs`; it is never killed outright,
 * since it may be someone's working terminal session.
 */
export async function stopGjcHostProcess(
  pid: number,
  { timeoutMs = 10_000, pollMs = 100 } = {},
): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !alive(pid);
  }
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !alive(pid);
}
