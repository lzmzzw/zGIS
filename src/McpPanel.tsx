import { useEffect, useState } from "react";
import { api, type McpStatus } from "./bridge";

export default function McpPanel() {
  const [status, setStatus] = useState<McpStatus>({ enabled: false });
  const [paths, setPaths] = useState<string[]>([]);
  const [audit, setAudit] = useState<unknown[]>([]);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    const current = await api.mcpStatus();
    setStatus(current);
    setPaths(current.authorizedPaths ?? []);
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
    <div className="modal-actions">
      <button disabled={busy} onClick={() => void action(async () => {
        setStatus(await api.mcpEnable(!status.enabled));
        setShowToken(false);
      })}>{status.enabled ? "停止 MCP" : "启用 MCP"}</button>
      <button disabled={busy} onClick={() => void action(refresh)}>刷新状态</button>
    </div>
    <dl className="summary-list"><dt>服务</dt><dd>{status.enabled ? "运行中 · 仅本机访问" : "已停止"}</dd>
      <dt>地址</dt><dd>{status.endpoint ?? "启用后显示"}</dd></dl>
    {status.enabled && <>
      <label>访问令牌<input aria-label="MCP 访问令牌" readOnly type={showToken ? "text" : "password"} value={status.token ?? ""} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={showToken} onChange={(e) => setShowToken(e.target.checked)} />显示本次运行令牌</label>
      <p className="form-note">在外部客户端的进程环境中设置 ZGIS_MCP_TOKEN，再添加以下配置。服务重启后需更新令牌与地址；侧栏 Agent 自动连接。</p>
      <pre>{`[mcp_servers.zgis]\nurl = ${JSON.stringify(status.endpoint)}\nbearer_token_env_var = "ZGIS_MCP_TOKEN"`}</pre>
    </>}
    <h3>外部矢量文件</h3>
    <p className="form-note">当前图层直接可用。读取外部文件前，选择文件或授权目录；仅本次运行有效，可随时撤销。支持 GeoJSON、CSV、SHP 和 ZIP，排除 _credentials。</p>
    <div className="modal-actions">
      <button disabled={busy} onClick={() => void action(async () => { const added = await api.mcpAuthorizeFiles(); setPaths((old) => [...new Set([...old, ...added])]); })}>选择可读文件…</button>
      <button disabled={busy} onClick={() => void action(async () => { const added = await api.mcpAuthorizeDirectory(); setPaths((old) => [...new Set([...old, ...added])]); })}>授权可读目录…</button>
      <button disabled={busy} onClick={() => void action(async () => { await api.mcpRevoke(); setPaths([]); })}>撤销外部访问</button>
    </div>
    {paths.length > 0 && <ul>{paths.map((path) => <li key={path}>{path}</li>)}</ul>}
    <h3>最近工具调用</h3>
    <pre className="mcp-audit">{audit.length ? JSON.stringify(audit, null, 2) : "尚无工具调用"}</pre>
    {error && <p role="alert">{error}</p>}
  </div>;
}
