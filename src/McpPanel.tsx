import { t, useLocale } from "./i18n";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api, type McpStatus } from "./bridge";
import McpToolCatalog from "./McpToolCatalog";

export default function McpPanel() {
  useLocale();
  const [status, setStatus] = useState<McpStatus>({ enabled: false });
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    const current = await api.mcpStatus();
    setStatus(current);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mcp-panel">
      <div className="mcp-service-row">
        <strong className={status.enabled ? "mcp-running" : undefined}>
          {status.enabled ? t("运行中") : t("已停止")}
        </strong>
        <div className="mcp-service-actions">
          <button
            title={
              status.enabled ? t("停止本次运行的 MCP 服务") : t("启用 MCP 服务")
            }
            disabled={busy}
            onClick={() =>
              void action(async () => {
                setStatus(await api.mcpEnable(!status.enabled));
                setShowToken(false);
              })
            }
          >
            {status.enabled ? t("停止 MCP") : t("启用 MCP")}
          </button>
          <button
            className="quiet"
            disabled={busy}
            onClick={() => void action(refresh)}
          >
            {t("刷新状态")}
          </button>
        </div>
      </div>
      <dl className="summary-list mcp-address">
        <dt>{t("地址")}</dt>
        <dd>{status.endpoint ?? "—"}</dd>
      </dl>
      {status.startupError && (
        <p className="warning" role="alert">
          {t(status.startupError)}
        </p>
      )}
      {status.enabled && (
        <>
          <div className="mcp-token-row">
            <label>
              {t("访问令牌")}
              <input
                aria-label={t("MCP 访问令牌")}
                readOnly
                type={showToken ? "text" : "password"}
                value={status.token ?? ""}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={showToken}
                onChange={(e) => setShowToken(e.target.checked)}
              />
              {t("显示固定令牌")}
            </label>
          </div>
          <details className="settings-disclosure">
            <summary>
              <ChevronRight />
              {t("连接配置")}
            </summary>
            <div className="settings-disclosure-content">
              <pre>{`[mcp_servers.zgis]\nurl = ${JSON.stringify(status.endpoint)}\nhttp_headers_helper = ${JSON.stringify(status.headersHelper)}`}</pre>
              <dl className="summary-list">
                <dt>{t("文件访问")}</dt>
                <dd>{t("Agent 负责授权")}</dd>
              </dl>
            </div>
          </details>
        </>
      )}
      <McpToolCatalog />
      {error && (
        <p className="warning" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
