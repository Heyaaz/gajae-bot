import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ITheme, Terminal } from "@xterm/xterm";
import { t } from "../i18n";
import type { TerminalExitEvent, TerminalOutputEvent } from "../../shared/terminal-ipc";
import {
  TERMINAL_OUTPUT_HIGH_WATER,
  TERMINAL_OUTPUT_LOW_WATER,
  createOutputGate,
} from "./terminal-flow";
import { TERMINAL_FONTS, TERMINAL_OPTIONS, terminalKeyAction } from "./terminal-ghostty";

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
    setShellId("");
    const token = nextTerminalToken++;
    const restart = restartRef.current;
    restartRef.current = false;
    let liveId: string | undefined;
    let disposed = false;
    let startRequested = false;
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
    fontsLoaded = Promise.all(
      TERMINAL_FONTS.map(([font, sample]) => document.fonts.load(font, sample)),
    ).then(() => document.fonts.ready).then((loadedFonts) => {
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
      // The emulator sizes its cells from the font it can measure when it opens.
      await fontsLoaded;
      if (disposed) return;
      const term = new Terminal({ ...TERMINAL_OPTIONS, theme: readTerminalTheme() });
      const addon = new FitAddon();
      fitAddon = addon;
      term.loadAddon(addon);
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          if (event.metaKey && uri.startsWith("https://")) window.open(uri, "_blank", "noopener,noreferrer");
        }),
      );
      term.open(host);
      term.onData((data) => {
        if (liveId) bridge.write(liveId, data);
      });
      term.attachCustomKeyEventHandler((event) => {
        const action = terminalKeyAction(event);
        if (!action) return true;
        if (event.type === "keydown") {
          event.preventDefault();
          if (action.kind === "send") term.input(action.data);
          else if (action.kind === "clear") term.clear();
          else term.selectAll();
        }
        return false;
      });
      termRef.current = term;
      resizeObserver = new ResizeObserver(() => applySize());
      resizeObserver.observe(host);
      applySize();
      try {
        startRequested = true;
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
      // A session's shell keeps running for the next view, and only needs to
      // hear about a view it was told about. The chat surface's shell ends here.
      if (!session || startRequested) void bridge.dispose(token);
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
    phase === "error"
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
      {status ? (
        <footer className="terminal-pane__bar">
          <span className="terminal-pane__cwd">
            {status}
            {phase === "exited" && detail ? ` (${detail})` : ""}
          </span>
          <button
            type="button"
            onClick={() => {
              restartRef.current = true;
              setEpoch((value) => value + 1);
            }}
          >
            {t("터미널 다시 시작")}
          </button>
        </footer>
      ) : null}
    </section>
  );
}

/** Ghostty's default colors. It draws a selection by swapping the foreground and background. */
export function readTerminalTheme(): ITheme {
  return {
    background: "#282c34",
    foreground: "#ffffff",
    cursor: "#ffffff",
    cursorAccent: "#282c34",
    selectionBackground: "#ffffff",
    selectionForeground: "#282c34",
    black: "#1d1f21",
    red: "#cc6666",
    green: "#b5bd68",
    yellow: "#f0c674",
    blue: "#81a2be",
    magenta: "#b294bb",
    cyan: "#8abeb7",
    white: "#c5c8c6",
    brightBlack: "#666666",
    brightRed: "#d54e53",
    brightGreen: "#b9ca4a",
    brightYellow: "#e7c547",
    brightBlue: "#7aa6da",
    brightMagenta: "#c397d8",
    brightCyan: "#70c0b1",
    brightWhite: "#eaeaea",
    scrollbarSliderBackground: "rgba(255, 255, 255, 0.16)",
    scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.28)",
    scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.36)",
  };
}
