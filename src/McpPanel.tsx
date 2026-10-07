import { useEffect, useState } from "react";
import { api, type McpStatus } from "./bridge";
import McpToolCatalog from "./McpToolCatalog";

export default function McpPanel() {
  const [status, setStatus] = useState<McpStatus>({ enabled: false });
  const [audit, setAudit] = useState<unknown[]>([]);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    const current = await api.mcpStatus();
    setStatus(current);
    setAudit((await api.mcpAudit()) ?? []);
  }
  useEffect(() => { void refresh().catch((e) => setError(String(e))); }, []);
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await work(); await refresh(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <div className="mcp-panel">
    <p>本机 AI 客户端可对当前图层执行空间查询、关联与拓扑检查。分析生成独立结果，不自动改写原图层或源文件。</p>
    <p className="form-note">MCP 随应用启动；手动停止仅本次有效。</p>
    <div className="modal-actions">
      <button disabled={busy} onClick={() => void action(async () => {
        setStatus(await api.mcpEnable(!status.enabled));
        setShowToken(false);
      })}>{status.enabled ? "停止 MCP" : "启用 MCP"}</button>
      <button disabled={busy} onClick={() => void action(refresh)}>刷新状态</button>
    </div>
    <dl className="summary-list"><dt>服务</dt><dd>{status.enabled ? "运行中 · 仅本机访问" : "已停止"}</dd>
      <dt>地址</dt><dd>{status.endpoint ?? "启用后显示"}</dd></dl>
    {status.startupError && <p role="alert">{status.startupError}</p>}
    {status.enabled && <>
      <label>访问令牌<input aria-label="MCP 访问令牌" readOnly type={showToken ? "text" : "password"} value={status.token ?? ""} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={showToken} onChange={(e) => setShowToken(e.target.checked)} />显示固定令牌</label>
      <p className="form-note">认证助手从 Windows 凭据管理器读取固定令牌；服务重启后无需重新配置 Codex。</p>
      <pre>{`[mcp_servers.zgis]\nurl = ${JSON.stringify(status.endpoint)}\nhttp_headers_helper = ${JSON.stringify(status.headersHelper)}`}</pre>
    </>}
    <McpToolCatalog />
    <h3>外部矢量文件</h3>
    <p className="form-note">支持 GeoJSON、CSV、SHP 和 ZIP 路径；Agent 负责文件访问授权。</p>
    <h3>最近工具调用</h3>
    <pre className="mcp-audit">{audit.length ? JSON.stringify(audit, null, 2) : "尚无工具调用"}</pre>
    {error && <p role="alert">{error}</p>}
  </div>;
}
