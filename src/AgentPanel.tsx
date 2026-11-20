import { t, useLocale } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./agent.css";

export type AgentCli = "codex" | "claudeCode";
const CLI_LABELS: Record<AgentCli, string> = {
  codex: "Codex CLI",
  claudeCode: "Claude Code CLI",
};
type Info = { sessionId: string; cli: AgentCli; running: boolean };
export default function AgentPanel({ onClose }: { onClose: () => void }) {
  useLocale();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const session = useRef<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(true);
  const running = info?.running === true;
  const [error, setError] = useState("");
  const attach = useRef<(info: Info) => Promise<void>>(async () => {});

  useEffect(() => {
    let disposed = false;
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
    });
    const syncTheme = () => {
      const styles = getComputedStyle(host.current!);
      term.options.fontSize = parseFloat(
        styles.getPropertyValue("--font-size-sm"),
      );
      term.options.fontFamily = styles.getPropertyValue("--font-mono").trim();
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
      if (disposed || !host.current?.offsetWidth) return;
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
      listen<Info>("zgis-agent-exit", ({ payload }) => {
        if (!disposed && payload.sessionId === session.current)
          setInfo(payload);
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
      setInfo(current?.sessionId === info.sessionId ? current : null);
      resize();
      if (current?.sessionId === info.sessionId && current.running && host.current?.offsetWidth)
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
      })
      .finally(() => {
        if (!disposed) setBusy(false);
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

  const open = async (cli: AgentCli) => {
    setBusy(true);
    setError("");
    try {
      await attach.current(await invoke<Info>("agent_open", { cli }));
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
      setInfo(null);
      terminal.current?.writeln(t("\r\n会话已停止。"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="gis-agent-panel" aria-label={t("空间分析助手")}>
      <header className="processing-heading">
        <div>
          <strong>{info ? CLI_LABELS[info.cli] : "Agent"}</strong>
          <span role="status">{busy ? t("请稍候…") : running ? t("运行中") : t("未连接")}</span>
        </div>
        <button
          className="icon-button"
          aria-label={t("隐藏助手侧栏")}
          onClick={onClose}
          title={t("隐藏侧栏，保留会话")}
        >
          <X size={16} />
        </button>
      </header>
      <div className="gis-agent-toolbar">
        {running ? (
          <button disabled={busy} onClick={() => void stop()}>
            {t("停止会话")}
          </button>
        ) : (
          <div className="gis-agent-choices" role="group" aria-label={t("选择要启动的命令行助手")}>
            {(["codex", "claudeCode"] as const).map((cli) => (
              <button key={cli} className="gis-agent-launch" disabled={busy} onClick={() => void open(cli)}>
                {CLI_LABELS[cli]}
              </button>
            ))}
          </div>
        )}
      </div>
      {!running && <p className="gis-agent-hint">
        {t("请先在本机安装并登录所选 CLI。分析结果可作为独立图层添加到地图。")}
      </p>}
      {error && (
        <p role="alert" className="gis-agent-error">
          {t(error)}
        </p>
      )}
      <div className="gis-agent-terminal" ref={host} />
    </section>
  );
}
