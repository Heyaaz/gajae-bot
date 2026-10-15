import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

async function source(file: string): Promise<string> {
  return await readFile(path.join(root, file), "utf8");
}

describe("SDK session CLI architecture", () => {
  it("has no resident or private attachment transport", async () => {
    const files = [
      "electron/gjc-sdk-controller.ts",
      "electron/gjc-sdk-cli.ts",
      "electron/main.ts",
      "electron/gjc-ipc-handlers.ts",
      "scripts/gjc-sdk-e2e.mjs",
      "scripts/gjc-cancel-e2e.mjs",
    ];
    const text = (await Promise.all(files.map(source))).join("\n");
    for (const forbidden of [
      "--mode=" + "acp",
      "ClientSide" + "Connection",
      "_gjc/" + "sdk/",
      "GJC_" + "ACP_",
      "@agentclientprotocol/" + "sdk",
      "sdk" + " serve",
      "createAgent" + "Session(",
    ])
      expect(text).not.toContain(forbidden);
  });

  it("spawns GJC only inside the short-lived CLI runner", async () => {
    const controller = await source("electron/gjc-sdk-controller.ts");
    const cli = await source("electron/gjc-sdk-cli.ts");
    expect(controller).not.toMatch(/\bspawn\s*\(/u);
    expect(cli).toMatch(/spawn\(executable, args/u);
    expect(cli).toContain('"sdk"');
    expect(cli).toContain('"session"');
  });

  it("keeps the public product and IPC identity unchanged", async () => {
    const manifest = JSON.parse(await source("package.json"));
    const main = await source("electron/main.ts");
    const ipc = await source("shared/gjc-ipc.ts");
    expect(manifest.productName).toBe("Gajae");
    expect(main).toContain('app.setName("Gajae")');
    expect(main).toContain('path.join(app.getPath("appData"), "Agent Control")');
    expect(ipc).toContain('"agent-control:gjc:');
  });

  it("retires every id the live stream puts on a message row", async () => {
    const [controller, utils] = await Promise.all([
      source("electron/gjc-sdk-controller.ts"),
      source("src/transcript-utils.ts"),
    ]);
    // A persisted rebuild retires the local row by prefix, so an id the stream
    // invents has to appear in the list that match reads. When the stream moved
    // off the ACP-era prefix, the list kept the old one and every reply rendered
    // twice: once streamed, once rebuilt.
    for (const prefix of ["gjc-message-", "local-prompt-"]) {
      expect(controller).toContain(prefix);
      expect(utils).toContain(`"${prefix}"`);
    }
  });
});
