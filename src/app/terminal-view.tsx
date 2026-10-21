import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ITheme, Terminal } from "@xterm/xterm";
import { t } from "../i18n";
import type { TerminalExitEvent, TerminalOutputEvent } from "../../shared/terminal-ipc";
import {
  TERMINAL_OUTPUT_HIGH_WATER,
  TERMINAL_OUTPUT_LOW_WATER,
  createOutputGate,
} from "./terminal-flow";

/**
 * xterm.js host for the desktop login shell.
 *
 * The fit and web-links addons, and refitting when the container changes,
 * follow the mounting approach in herdr-web-ui `src/components/PaneTerminal.tsx`.
 * Copyright (c) 2026 devswha, MIT License. See THIRD_PARTY_NOTICES.md.
 */

interface TerminalViewProps {
  cwd: string;
  active: boolean;
  hidden: boolean;
}

type TerminalPhase = "starting" | "running" | "exited" | "error";

let nextTerminalToken = 1;

export function TerminalView({ cwd, active, hidden }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const [phase, setPhase] = useState<TerminalPhase>("starting");
  const [detail, setDetail] = useState("");
  const [shellCwd, setShellCwd] = useState(cwd);
  const [epoch, setEpoch] = useState(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const bridge = window.agentControlDesktop?.terminal;
    if (!host || !bridge) {
      setPhase("error");
      setDetail(t("터미널은 데스크톱 앱에서만 사용할 수 있습니다"));
      return;
    }

    setPhase("starting");
    setDetail("");
    setShellCwd(cwd);
    const token = nextTerminalToken++;
    let disposed = false;
    let removeOutput = (): void => undefined;
    let removeExit = (): void => undefined;
    let resizeObserver: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    const gate = createOutputGate({
      highWater: TERMINAL_OUTPUT_HIGH_WATER,
      lowWater: TERMINAL_OUTPUT_LOW_WATER,
      setPaused: (paused) => bridge.setPaused(paused),
    });

    let fitAddon: { fit(): void } | null = null;
    const applySize = (): void => {
      const term = termRef.current;
      if (!term || !fitAddon || !activeRef.current) return;
      if (host.clientWidth < 8 || host.clientHeight < 8) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      bridge.resize(term.cols, term.rows);
    };
    fitRef.current = applySize;

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (disposed) return;
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily:
          'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: readTerminalTheme(),
        macOptionClickForcesSelection: true,
      });
      const addon = new FitAddon();
      fitAddon = addon;
      term.loadAddon(addon);
      term.loadAddon(
        new WebLinksAddon((_event, uri) => {
          if (uri.startsWith("https://")) window.open(uri, "_blank", "noopener,noreferrer");
        }),
      );
      term.open(host);
      term.onData((data) => bridge.write(data));
      termRef.current = term;
      resizeObserver = new ResizeObserver(() => applySize());
      resizeObserver.observe(host);
      themeObserver = new MutationObserver(() => {
        term.options.theme = readTerminalTheme();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      applySize();
      try {
        const started = await bridge.start({
          token,
          cwd,
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) return;
        if (started.cwd) setShellCwd(started.cwd);
        const accept = (event: { id: string }): boolean => event.id === started.id;
        removeOutput = bridge.onOutput((event: TerminalOutputEvent) => {
          if (!accept(event)) return;
          gate.push(event.data.length);
          term.write(event.data, () => gate.ack(event.data.length));
        });
        removeExit = bridge.onExit((event: TerminalExitEvent) => {
          if (!accept(event)) return;
          setPhase("exited");
          setDetail(String(event.exitCode));
        });
        setPhase("running");
        setDetail("");
        if (activeRef.current) term.focus();
      } catch (error) {
        if (disposed) return;
        setPhase("error");
        setDetail(error instanceof Error ? error.message : t("터미널을 열지 못했습니다"));
      }
    })().catch((error: unknown) => {
      if (disposed) return;
      setPhase("error");
      setDetail(error instanceof Error ? error.message : t("터미널을 열지 못했습니다"));
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      removeOutput();
      removeExit();
      gate.reset();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      void bridge.dispose(token);
    };
  }, [cwd, epoch]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    fitRef.current?.();
    termRef.current?.focus();
  }, [active]);

  const status =
    phase === "starting"
      ? t("터미널을 여는 중")
      : phase === "error"
        ? detail || t("터미널을 열지 못했습니다")
        : phase === "exited"
          ? t("셸이 종료되었습니다")
          : "";

  return (
    <section
      className="terminal-pane"
      hidden={hidden}
      data-terminal-state={phase}
    >
      <div className="terminal-pane__host" ref={hostRef} />
      <footer className="terminal-pane__bar">
        <span className="terminal-pane__cwd" title={shellCwd}>
          {status || shellCwd}
          {phase === "exited" && detail ? ` (${detail})` : ""}
        </span>
        {phase === "error" || phase === "exited" ? (
          <button type="button" onClick={() => setEpoch((value) => value + 1)}>
            {t("터미널 다시 시작")}
          </button>
        ) : null}
      </footer>
    </section>
  );
}

function readTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: color("--bg-app", "#09090a"),
    foreground: color("--text-primary", "#f1f1f3"),
    cursor: color("--accent-bright", "#ff9238"),
    cursorAccent: color("--bg-app", "#09090a"),
    selectionBackground: "rgba(240, 100, 22, 0.35)",
    black: "#1b1b1e",
    red: "#ee7b7b",
    green: "#67d6a5",
    yellow: "#e3b36a",
    blue: "#8ab4ff",
    magenta: "#d2a8ff",
    cyan: "#7ddec8",
    white: "#f1f1f3",
    brightBlack: "#707077",
    brightRed: "#ff9a9a",
    brightGreen: "#8cf0c0",
    brightYellow: "#f3d08a",
    brightBlue: "#b3cdff",
    brightMagenta: "#e2c2ff",
    brightCyan: "#a8f0e0",
    brightWhite: "#ffffff",
  };
}
