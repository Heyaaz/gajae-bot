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
  /**
   * A terminal session to show. Its shell keeps running when this view goes
   * away, and a view that comes back replays what it printed meanwhile.
   */
  session?: string;
}

type TerminalPhase = "starting" | "running" | "exited" | "error";

let nextTerminalToken = 1;

export function TerminalView({ cwd, active, hidden, session }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const [phase, setPhase] = useState<TerminalPhase>("starting");
  const [detail, setDetail] = useState("");
  const [shellCwd, setShellCwd] = useState(cwd);
  const [epoch, setEpoch] = useState(0);
  const restartRef = useRef(false);
  const [shellId, setShellId] = useState("");

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
    setShellId("");
    const token = nextTerminalToken++;
    const restart = restartRef.current;
    restartRef.current = false;
    let liveId: string | undefined;
    let disposed = false;
    let removeOutput = (): void => undefined;
    let removeExit = (): void => undefined;
    let resizeObserver: ResizeObserver | undefined;
    const gate = createOutputGate({
      highWater: TERMINAL_OUTPUT_HIGH_WATER,
      lowWater: TERMINAL_OUTPUT_LOW_WATER,
      setPaused: (paused) => {
        if (liveId) bridge.setPaused(liveId, paused);
      },
    });

    let fitAddon: { fit(): void } | null = null;
    let fontsReady = document.fonts.status === "loaded";
    let fontsLoaded: Promise<FontFaceSet>;
    const applySize = (): void => {
      const term = termRef.current;
      if (!term || !fitAddon || !activeRef.current || !fontsReady) return;
      if (host.clientWidth < 8 || host.clientHeight < 8) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      if (liveId) bridge.resize(liveId, term.cols, term.rows);
    };
    fontsLoaded = document.fonts.load('14px "Gajae Terminal Symbols"', "󰆍").then(() => document.fonts.ready).then((loadedFonts) => {
      fontsReady = true;
      applySize();
      return loadedFonts;
    });
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
          '"Fira Code", Menlo, "Gajae Terminal Symbols", monospace',
        fontSize: 14,
        lineHeight: 1.1,
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
      term.onData((data) => {
        if (liveId) bridge.write(liveId, data);
      });
      termRef.current = term;
      resizeObserver = new ResizeObserver(() => applySize());
      resizeObserver.observe(host);
      applySize();
      try {
        const started = await bridge.start({
          token,
          cwd,
          cols: term.cols,
          rows: term.rows,
          ...(session ? { session } : {}),
          ...(session && restart ? { restart: true } : {}),
        });
        if (disposed) return;
        liveId = started.id;
        setShellId(started.id);
        if (started.cwd) setShellCwd(started.cwd);
        if (started.replay) term.write(started.replay);
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
        if (started.exitCode === undefined) {
          setPhase("running");
          setDetail("");
        } else {
          setPhase("exited");
          setDetail(String(started.exitCode));
        }
        if (activeRef.current) {
          await fontsLoaded;
          if (!disposed && activeRef.current) {
            applySize();
            term.focus();
          }
        }
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
      removeOutput();
      removeExit();
      gate.reset();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      // A session's shell keeps running for the next view; only the chat
      // surface's shell ends with its view.
      if (!session) void bridge.dispose(token);
    };
  }, [cwd, epoch, session]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    void document.fonts.ready.then(() => {
      if (!activeRef.current) return;
      fitRef.current?.();
      termRef.current?.focus();
    });
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
      data-terminal-id={shellId || undefined}
      aria-label={t("터미널")}
    >
      <div className="terminal-pane__host" ref={hostRef} />
      <footer className="terminal-pane__bar">
        <span className="terminal-pane__cwd" title={shellCwd}>
          {status || shellCwd}
          {phase === "exited" && detail ? ` (${detail})` : ""}
        </span>
        {phase === "error" || phase === "exited" ? (
          <button
            type="button"
            onClick={() => {
              restartRef.current = true;
              setEpoch((value) => value + 1);
            }}
          >
            {t("터미널 다시 시작")}
          </button>
        ) : null}
      </footer>
    </section>
  );
}

export function readTerminalTheme(): ITheme {
  return {
    background: "#17191d",
    foreground: "#e6e8eb",
    cursor: "#ffad66",
    cursorAccent: "#17191d",
    selectionBackground: "rgba(240, 100, 22, 0.35)",
    black: "#343840",
    red: "#ff7b72",
    green: "#7ee787",
    yellow: "#e3b341",
    blue: "#79c0ff",
    magenta: "#d2a8ff",
    cyan: "#56d4dd",
    white: "#e6e8eb",
    brightBlack: "#8b949e",
    brightRed: "#ffa198",
    brightGreen: "#aff5b4",
    brightYellow: "#f2cc60",
    brightBlue: "#a5d6ff",
    brightMagenta: "#e2c5ff",
    brightCyan: "#a5f3fc",
    brightWhite: "#ffffff",
  };
}
