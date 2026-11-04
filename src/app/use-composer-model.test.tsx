/** @vitest-environment happy-dom */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend } from "../backend/agent-backend";
import type { AgentCommand, AgentSession, BackendConnection } from "../backend/types";
import { useComposerModel, type CommandsLoad } from "./use-composer-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = (status: AgentSession["status"]) =>
  ({ id: "s1", status, attachment: "sdk", workspace: "/repo" }) as unknown as AgentSession;

describe("skill palette load state", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
  });

  function mount(backend: Partial<AgentBackend>) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const seen: { load?: CommandsLoad; open?: () => void } = {};
    function Probe(props: { commands: Record<string, AgentCommand[]>; status: AgentSession["status"] }) {
      const model = useComposerModel(
        backend as AgentBackend,
        props.commands,
        {},
        "s1",
        session(props.status),
        {} as BackendConnection,
        "ko",
      );
      useEffect(() => {
        seen.load = model.commandsLoad;
        seen.open = model.onCommandPaletteOpen;
      });
      return null;
    }
    const render = (commands: Record<string, AgentCommand[]>, status: AgentSession["status"]) =>
      act(() => root!.render(createElement(Probe, { commands, status })));
    return { seen, render };
  }

  it("keeps loading while a starting session has not published its list", () => {
    const { seen, render } = mount({});
    render({}, "starting");
    expect(seen.load).toBe("loading");
  });

  it("stops loading once the session is known to have failed, and recovers when a list arrives", () => {
    const { seen, render } = mount({});
    render({}, "failed");
    expect(seen.load).toBe("failed");
    render({ s1: [{ name: "skill:whip", description: "" }] }, "idle");
    expect(seen.load).toBe("ready");
  });

  it("reports a refused read as failed and clears it when a later read succeeds", async () => {
    const refresh = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("no session"))
      .mockResolvedValueOnce(undefined);
    const { seen, render } = mount({ refreshSessionContext: refresh });
    render({}, "idle");
    expect(seen.load).toBe("loading");
    await act(async () => seen.open!());
    expect(seen.load).toBe("failed");
    await act(async () => seen.open!());
    expect(seen.load).toBe("loading");
  });
});
