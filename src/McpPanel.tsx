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
    <p>向本机 AI 客户端提供当前图层的空间查询、关联和拓扑检查。分析生成独立结果，原图层与源文件不会自动改写。</p>
    <p className="form-note">MCP 随应用自动启动；手动停止仅影响本次运行，下次打开 zGIS 会再次启动。</p>
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
      <p className="form-note">Codex 通过安装包内的认证助手读取 Windows 凭据管理器中的固定令牌；重启服务后无需修改配置。</p>
      <pre>{`[mcp_servers.zgis]\nurl = ${JSON.stringify(status.endpoint)}\nhttp_headers_helper = ${JSON.stringify(status.headersHelper)}`}</pre>
    </>}
    <McpToolCatalog />
    <h3>外部矢量文件</h3>
    <p className="form-note">Agent 可直接传入 GeoJSON、CSV、SHP 或 ZIP 路径。文件访问授权由 Agent 判断，zGIS 提供空间读取与分析能力。</p>
    <h3>最近工具调用</h3>
    <pre className="mcp-audit">{audit.length ? JSON.stringify(audit, null, 2) : "尚无工具调用"}</pre>
    {error && <p role="alert">{error}</p>}
  </div>;
}
