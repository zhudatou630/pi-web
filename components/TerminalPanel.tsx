"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { createPageEventSource } from "@/lib/page-debug";
import { createSilenceWatchdog } from "@/lib/sse-watchdog";
import { createTerminalWriter, terminalRequest } from "@/lib/terminal-client";
import {
  applyTerminalModifiers,
  NO_TERMINAL_MODIFIERS,
  terminalExtraKeySequence,
  type TerminalExtraKey,
  type TerminalModifier,
  type TerminalModifiers,
} from "@/lib/terminal-extra-keys";
import type { TerminalEvent } from "@/lib/terminal-manager";
import { TerminalExtraKeys, useTerminalExtraKeysVisible } from "./TerminalExtraKeys";
import type { TerminalTab } from "./terminal-tab-state";
import { isTerminalLight, setTerminalLight, subscribeTerminalTheme, TERMINAL_THEMES } from "./terminal-theme";

interface Props {
  tab: TerminalTab;
  active: boolean;
  /** Workspace header slot for this tab's actions; set only while the tab is selected. */
  actionsSlot: HTMLElement | null;
  onRestart: () => void;
  onClosed: () => void;
  onCloseError: () => void;
}

export function TerminalPanel({ tab, active, actionsSlot, onRestart, onClosed, onCloseError }: Props) {
  const { t } = useI18n();
  const { id, cwd, restored } = tab;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const startRef = useRef<Promise<void>>(Promise.resolve());
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null);
  const callbacksRef = useRef({ onClosed, onCloseError });
  callbacksRef.current = { onClosed, onCloseError };
  const [status, setStatus] = useState<"connecting" | "ready" | "exited" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  // CTRL / ALT are one-shot: they modify the next extra key or soft-keyboard character.
  const [modifiers, setModifiers] = useState<TerminalModifiers>(NO_TERMINAL_MODIFIERS);
  const modifiersRef = useRef(modifiers);
  const showExtraKeys = useTerminalExtraKeysVisible();
  const light = useSyncExternalStore(subscribeTerminalTheme, isTerminalLight, () => false);
  const theme = light ? "light" : "dark";
  const { palette } = useTheme();
  const themeLabel = light ? "terminal.darkTheme" : "terminal.lightTheme";

  const consumeModifiers = useCallback(() => {
    const current = modifiersRef.current;
    if (current.ctrl || current.alt) {
      modifiersRef.current = NO_TERMINAL_MODIFIERS;
      setModifiers(NO_TERMINAL_MODIFIERS);
    }
    return current;
  }, []);
  // Through terminal.input(), so a key takes the same onData path (and checks) as typing.
  const sendExtraKey = (key: TerminalExtraKey) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.input(terminalExtraKeySequence(key, consumeModifiers(), terminal.modes.applicationCursorKeysMode), true);
  };
  const toggleModifier = (modifier: TerminalModifier) => {
    const next = { ...modifiersRef.current, [modifier]: !modifiersRef.current[modifier] };
    modifiersRef.current = next;
    setModifiers(next);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let events: EventSource | null = null;
    let offset: number | undefined;
    let connected = false;
    let exited = false;
    let inputFailed = false;
    setStatus("connecting");
    setError(null);
    setExitCode(null);

    const terminal = new Terminal({
      // Neutral 2px bar (theme cursor = foreground); programs like vim still switch shapes themselves.
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "bar",
      fontFamily: getComputedStyle(container).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 8000,
      screenReaderMode: true,
      // Programs can send their own colors; keep their text readable on our backgrounds.
      minimumContrastRatio: 4.5,
      disableStdin: true,
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if ((event.ctrlKey || event.metaKey) && key === "c" && terminal.hasSelection()) return false;
      return true;
    });

    const writer = createTerminalWriter(id, (reason) => {
      if (disposed) return;
      inputFailed = true;
      terminal.options.disableStdin = true;
      setError(reason.message);
      setStatus("error");
    });
    writerRef.current = writer;
    const onData = terminal.onData((data) => {
      if (connected && !exited && !inputFailed) writer.write(applyTerminalModifiers(data, consumeModifiers()));
    });
    const fitAndResize = () => {
      if (!container.offsetWidth || !container.offsetHeight) return;
      fit.fit();
    };
    // A panel drag changes cols every few pixels; each PTY resize makes the shell or TUI redraw.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = terminal.onResize(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (connected && !exited && !inputFailed) writer.resize(terminal.cols, terminal.rows);
      }, 150);
    });
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(container);

    const watchdog = createSilenceWatchdog(() => connect());
    const connect = () => {
      if (disposed || exited || !navigator.onLine) return;
      events?.close();
      events = createPageEventSource(`/api/terminal/${encodeURIComponent(id)}/events${offset === undefined ? "" : `?after=${offset}`}`, "terminal", id);
      events.addEventListener("heartbeat", () => watchdog.touch());
      watchdog.touch();
      events.onmessage = (message) => {
        watchdog.touch();
        const event = JSON.parse(message.data) as TerminalEvent;
        if (event.type === "output") {
          if (event.reset) terminal.reset();
          else if (offset !== undefined && event.offset <= offset) return;
          terminal.write(event.data);
          offset = event.offset;
        } else {
          exited = true;
          connected = false;
          terminal.options.disableStdin = true;
          events?.close();
          watchdog.stop();
          setExitCode(event.type === "exit" ? event.exitCode : null);
          setStatus("exited");
        }
      };
      events.onopen = () => {
        connected = true;
        if (inputFailed) return;
        terminal.options.disableStdin = false;
        setStatus("ready");
        fitAndResize();
        writer.resize(terminal.cols, terminal.rows);
        if (container.offsetWidth && container.offsetHeight) terminal.focus();
      };
      events.onerror = () => {
        if (disposed || exited) return;
        connected = false;
        terminal.options.disableStdin = true;
        setStatus(events?.readyState === EventSource.CLOSED ? "error" : "connecting");
      };
    };

    startRef.current = (async () => {
      fitAndResize();
      if (restored || reconnectKey > 0) {
        // Restoring a tab must never silently launch a replacement shell.
        await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`);
      } else {
        await terminalRequest("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, cwd, cols: terminal.cols, rows: terminal.rows }),
        });
      }
      connect();
    })().catch((reason: Error) => {
      if (disposed) return;
      setError(reason.message);
      setStatus("error");
    });

    const pageHide = () => {
      connected = false;
      terminal.options.disableStdin = true;
      events?.close();
      watchdog.stop();
      if (!exited && !inputFailed) setStatus("connecting");
    };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) connect(); };
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("offline", pageHide);
    window.addEventListener("online", connect);
    return () => {
      disposed = true;
      watchdog.stop();
      events?.close();
      void writer.stop();
      resizeObserver.disconnect();
      clearTimeout(resizeTimer);
      onData.dispose();
      onResize.dispose();
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("offline", pageHide);
      window.removeEventListener("online", connect);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [id, cwd, restored, reconnectKey, consumeModifiers]);

  useEffect(() => {
    // Also sets the initial theme: runs right after creation, before xterm's first frame.
    if (terminalRef.current) terminalRef.current.options.theme = TERMINAL_THEMES[palette][theme];
  }, [palette, theme, id, cwd, restored, reconnectKey]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!tab.closing) return;
    let cancelled = false;
    if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    void (async () => {
      await startRef.current;
      await writerRef.current?.stop();
      await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true });
      if (!cancelled) callbacksRef.current.onClosed();
    })().catch((reason: Error) => {
      if (cancelled) return;
      setError(reason.message);
      setStatus("error");
      callbacksRef.current.onCloseError();
    });
    return () => { cancelled = true; };
  }, [id, tab.closing]);

  return (
    <section className={`terminal-panel${showExtraKeys ? " has-extra-keys" : ""}`} data-terminal-theme={theme} aria-label={t("terminal.title")}>
      {actionsSlot && createPortal(
        <>
          {status !== "ready" && (
            <span className="terminal-header-status" role="img" title={t(`terminal.${status}`)} aria-label={t(`terminal.${status}`)}>
              <span className={`terminal-status-dot is-${status}`} />
            </span>
          )}
          <button type="button" className="workspace-header-action terminal-header-action" onClick={() => setTerminalLight(!isTerminalLight())} title={t(themeLabel)} aria-label={t(themeLabel)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {light ? (
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              ) : (
                <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></>
              )}
            </svg>
          </button>
          {status === "error" && (
            <button type="button" className="workspace-header-action terminal-header-action" onClick={() => setReconnectKey((key) => key + 1)} disabled={Boolean(tab.closing)} title={t("terminal.reconnect")} aria-label={t("terminal.reconnect")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
              </svg>
            </button>
          )}
          <button type="button" className="workspace-header-action terminal-header-action" onClick={onRestart} disabled={Boolean(tab.closing)} title={t("terminal.restart")} aria-label={t("terminal.restart")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" />
            </svg>
          </button>
        </>,
        actionsSlot,
      )}
      <div>
        {error && <div className="terminal-panel-error" role="alert">{error}</div>}
        {status === "exited" && <div className="terminal-panel-exit" role="status">{exitCode === null ? t("terminal.exited") : t("terminal.exitCode", { code: exitCode })}</div>}
      </div>
      <div className="terminal-xterm"><div ref={containerRef} className="terminal-xterm-host" /></div>
      {showExtraKeys && <TerminalExtraKeys modifiers={modifiers} onKey={sendExtraKey} onToggleModifier={toggleModifier} />}
    </section>
  );
}
