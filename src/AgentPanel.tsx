import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./agent.css";

type Info = { sessionId: string; running: boolean };
export default function AgentPanel({ onClose }: { onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const session = useRef<string | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attach = useRef<(info: Info) => Promise<void>>(async () => {});

  useEffect(() => {
    let disposed = false;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "Consolas, monospace",
      cursorBlink: true,
      scrollback: 5000,
    });
    const syncTheme = () => {
      const styles = getComputedStyle(document.documentElement);
      term.options.theme = {
        background: styles.getPropertyValue("--panel").trim(),
        foreground: styles.getPropertyValue("--text").trim(),
        cursor: styles.getPropertyValue("--accent").trim(),
        selectionBackground: styles.getPropertyValue("--selected").trim(),
      };
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    terminal.current = term;
    const resize = () => {
      if (disposed) return;
      fit.fit();
      if (session.current)
        void invoke("agent_resize", {
          sessionId: session.current,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    const input = term.onData((data) => {
      if (session.current)
        void invoke("agent_write", { sessionId: session.current, data }).catch(
          (e) => setError(String(e)),
        );
    });
    // Subscribe before attaching/launching so the first CLI output is never lost.
    const waiting: { sessionId: string; data: string; sequence: number }[] = [];
    let replaying = true;
    let lastSequence = 0;
    const subscriptions = Promise.all([
      listen<{ sessionId: string; data: string; sequence: number }>(
        "zgis-agent-output",
        (e) => {
          if (disposed) return;
          if (replaying) waiting.push(e.payload);
          else if (
            e.payload.sessionId === session.current &&
            e.payload.sequence > lastSequence
          ) {
            term.write(e.payload.data);
            lastSequence = e.payload.sequence;
          }
        },
      ),
      listen<Info>("zgis-agent-exit", (e) => {
        if (!disposed && e.payload.sessionId === session.current)
          setRunning(false);
      }),
    ]);
    attach.current = async (info) => {
      await subscriptions;
      if (disposed) return;
      replaying = true;
      session.current = info.sessionId;
      term.reset();
      const history = await invoke<{ data: string; sequence: number }>(
        "agent_read",
        { sessionId: info.sessionId },
      );
      if (disposed) return;
      term.write(history.data);
      lastSequence = history.sequence;
      for (const output of waiting)
        if (
          output.sessionId === info.sessionId &&
          output.sequence > lastSequence
        ) {
          term.write(output.data);
          lastSequence = output.sequence;
        }
      waiting.length = 0;
      replaying = false;
      const current = await invoke<Info | null>("agent_current");
      if (disposed) return;
      setRunning(current?.sessionId === info.sessionId && current.running);
      resize();
      term.focus();
    };
    void subscriptions
      .then(async () => {
        const info = await invoke<Info | null>("agent_current");
        if (info) await attach.current(info);
        else replaying = false;
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      themeObserver.disconnect();
      observer.disconnect();
      input.dispose();
      void subscriptions.then((handles) => handles.forEach((stop) => stop()));
      terminal.current = null;
      term.dispose();
    };
  }, []);

  const open = async () => {
    setBusy(true);
    setError("");
    try {
      await attach.current(await invoke<Info>("agent_open"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!session.current) return;
    setBusy(true);
    setError("");
    try {
      await invoke("agent_close", { sessionId: session.current });
      session.current = null;
      setRunning(false);
      terminal.current?.writeln("\r\n会话已停止。");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="gis-agent-panel" aria-label="Codex 空间分析助手">
      <header>
        <div>
          <strong>Codex Agent</strong>
          <span>{running ? "运行中" : "未连接"}</span>
        </div>
        <button
          aria-label="隐藏助手侧栏"
          onClick={onClose}
          title="隐藏侧栏，保留会话"
        >
          ×
        </button>
      </header>
      <div className="gis-agent-toolbar">
        <button disabled={busy || running} onClick={() => void open()}>
          {busy ? "请稍候…" : "连接 Codex"}
        </button>
        <button disabled={busy || !running} onClick={() => void stop()}>
          停止会话
        </button>
      </div>
      <p className="gis-agent-hint">
        先开启 MCP，再连接本机已安装并登录的 Codex
        CLI。分析结果留在图层中，由你决定是否另存。
      </p>
      {error && (
        <p role="alert" className="gis-agent-error">
          {error}
        </p>
      )}
      <div className="gis-agent-terminal" ref={host} />
    </section>
  );
}
