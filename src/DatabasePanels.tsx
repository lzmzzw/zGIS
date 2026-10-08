import { useState } from "react";
import { Database, FolderOpen, LockKeyhole, RefreshCw } from "lucide-react";
import type { DbConnection, DbLayer } from "./bridge";
import type { DbChange } from "./dbChanges";

export function SourcePanel({
  layers,
  index,
  connected,
  busy,
  label,
  onIndex,
  onLoad,
  onConnect,
  onRefresh,
}: {
  layers: DbLayer[];
  index: number;
  connected: boolean;
  busy: boolean;
  label: string;
  onIndex: (index: number) => void;
  onLoad: (index: number) => void;
  onConnect: () => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState("");
  return (
    <div className="source-panel">
      <div className="source-heading">
        <Database />
        <span>{connected ? label : "未连接"}</span>
        <button
          className="icon-button"
          aria-label="刷新数据源"
          title="刷新数据源"
          disabled={!connected || busy}
          onClick={onRefresh}
        >
          <RefreshCw />
        </button>
      </div>
      <button
        className="quiet source-connect"
        disabled={busy}
        onClick={onConnect}
      >
        {connected ? "连接设置…" : "连接 PostGIS…"}
      </button>
      {connected && (
        <>
          <input
            aria-label="筛选数据表"
            placeholder="筛选数据表"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="source-tables">
            {layers
              .map((layer, row) => ({ layer, row }))
              .filter(({ layer }) =>
                `${layer.schema}.${layer.table}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map(({ layer, row }) => (
                <button
                  className={`source-table ${index === row ? "active" : ""}`}
                  key={`${layer.schema}.${layer.table}.${layer.geometryColumn}`}
                  disabled={busy}
                  onClick={() => onIndex(row)}
                  onDoubleClick={() => onLoad(row)}
                >
                  <Database />
                  <span>
                    <strong>
                      {layer.schema}.{layer.table}
                    </strong>
                    <small>
                      {layer.geometryColumn || "选择 WKT 列"} ·{" "}
                      {layer.geometryKind === "geometry"
                        ? `EPSG:${layer.srid || 4326}`
                        : "WKT"}
                    </small>
                  </span>
                  {!layer.keyColumns.length && (
                    <LockKeyhole aria-label="无主键只读" />
                  )}
                </button>
              ))}
            {!layers.length && (
              <p className="form-note">未发现可读取的数据表</p>
            )}
          </div>
          <button
            disabled={!layers.length || busy}
            onClick={() => onLoad(index)}
          >
            <FolderOpen />
            加载设置…
          </button>
        </>
      )}
    </div>
  );
}

export function ConnectionPanel({
  config,
  busy,
  connected,
  onChange,
  onConnect,
  onClose,
}: {
  config: DbConnection;
  busy: boolean;
  connected: boolean;
  onChange: (config: DbConnection) => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  const valid =
    config.host.trim() &&
    config.database.trim() &&
    config.user.trim() &&
    Number.isInteger(config.port) &&
    config.port > 0 &&
    config.port <= 65535;
  return (
    <>
      <div className="form-grid">
        <label>
          主机
          <input
            aria-label="主机"
            value={config.host}
            disabled={busy}
            onChange={(event) =>
              onChange({ ...config, host: event.target.value })
            }
          />
        </label>
        <div className="two-columns">
          <label>
            数据库
            <input
              aria-label="数据库"
              value={config.database}
              disabled={busy}
              onChange={(event) =>
                onChange({ ...config, database: event.target.value })
              }
            />
          </label>
          <label>
            用户
            <input
              aria-label="用户"
              value={config.user}
              disabled={busy}
              onChange={(event) =>
                onChange({ ...config, user: event.target.value })
              }
            />
          </label>
        </div>
        <label>
          密码
          <input
            aria-label="密码"
            type="password"
            autoComplete="off"
            value={config.password}
            disabled={busy}
            onChange={(event) =>
              onChange({ ...config, password: event.target.value })
            }
          />
        </label>
        <details className="connection-advanced">
          <summary>
            高级设置{" "}
            <span className="count">
              {config.sslMode === "require" ? "TLS · 校验证书" : "TLS 已禁用"} ·{" "}
              {config.port}
            </span>
          </summary>
          <div className="form-grid">
            <label>
              端口
              <input
                aria-label="端口"
                type="number"
                min={1}
                max={65535}
                value={config.port}
                disabled={busy}
                onChange={(event) =>
                  onChange({ ...config, port: Number(event.target.value) })
                }
              />
            </label>
            <label>
              TLS
              <select
                aria-label="TLS"
                value={config.sslMode}
                disabled={busy}
                onChange={(event) =>
                  onChange({ ...config, sslMode: event.target.value })
                }
              >
                <option value="require">TLS · 校验证书</option>
                <option value="disable">禁用 TLS · 明文连接</option>
              </select>
            </label>
          </div>
        </details>
      </div>
      <div className="modal-actions">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button disabled={busy || !valid} onClick={onConnect}>
          <Database />
          {busy ? "连接中" : connected ? "重新连接" : "连接"}
        </button>
      </div>
    </>
  );
}

export function LoadPanel({
  engine = "postgis",
  layer,
  column,
  srid,
  limit,
  viewport,
  busy,
  onColumn,
  onSrid,
  onLimit,
  onViewport,
  onLoad,
  onClose,
}: {
  engine?: "postgis" | "mysql";
  layer: DbLayer;
  column: string;
  srid: number;
  limit: number;
  viewport: boolean;
  busy: boolean;
  onColumn: (value: string) => void;
  onSrid: (value: number) => void;
  onLimit: (value: number) => void;
  onViewport: (value: boolean) => void;
  onLoad: () => void;
  onClose: () => void;
}) {
  const valid =
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= (engine === "mysql" ? 10000 : 100000) &&
    (layer.geometryKind === "geometry" ||
      (Boolean(column || layer.geometryColumn) &&
        Number.isInteger(srid) &&
        srid > 0));
  return (
    <>
      <div className="data-load-dialog">
        <div className="form-grid">
          <label>
            数据表
            <span>
              {layer.schema}.{layer.table}
            </span>
          </label>
          {layer.geometryKind === "wkt" && (
            <>
              <label>
                WKT 文本列
                <select
                  aria-label="WKT 文本列"
                  disabled={busy}
                  value={column || layer.geometryColumn}
                  onChange={(event) => onColumn(event.target.value)}
                >
                  <option value="">选择列</option>
                  {layer.columns
                    .filter(
                      (item) =>
                        item.type.includes("text") ||
                        item.type.includes("character") ||
                        item.type.includes("varchar") ||
                        item.type.startsWith("char("),
                    )
                    .map((item) => (
                      <option key={item.name}>{item.name}</option>
                    ))}
                </select>
              </label>
              <label>
                来源 SRID
                <select
                  aria-label="来源 SRID"
                  disabled={busy}
                  value={srid}
                  onChange={(event) => onSrid(Number(event.target.value))}
                >
                  <option value={4326}>EPSG:4326 · WGS84</option>
                  {engine !== "mysql" && (
                    <option value={4490}>EPSG:4490 · CGCS2000</option>
                  )}
                  {engine !== "mysql" && (
                    <option value={3857}>EPSG:3857 · Web Mercator</option>
                  )}
                </select>
              </label>
            </>
          )}
          {layer.geometryKind === "geometry" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={viewport}
                disabled={busy}
                onChange={(event) => onViewport(event.target.checked)}
              />
              仅当前地图范围
            </label>
          )}
          <label>
            最多读取记录
            <input
              aria-label="最多读取记录"
              type="number"
              min={1}
              max={engine === "mysql" ? 10000 : 100000}
              value={limit}
              disabled={busy}
              onChange={(event) => onLimit(Number(event.target.value))}
            />
          </label>
        </div>
        <aside className="dialog-summary data-load-summary">
          <header>加载摘要</header>
          <dl>
            <dt>几何来源</dt>
            <dd>
              {layer.geometryKind === "geometry"
                ? layer.geometryColumn
                : column || "待选择"}
            </dd>
            <dt>来源坐标</dt>
            <dd>
              EPSG:
              {layer.geometryKind === "geometry" ? layer.srid || 4326 : srid}
            </dd>
            <dt>读取范围</dt>
            <dd>
              {viewport && layer.geometryKind === "geometry"
                ? "当前地图范围"
                : "数据表"}
            </dd>
            <dt>主键</dt>
            <dd>{layer.keyColumns.join(", ") || "无主键 · 只读"}</dd>
            <dt>读取上限</dt>
            <dd>{limit.toLocaleString()}</dd>
          </dl>
          <p className="form-note">读取受上限限制，未必载入全表。</p>
        </aside>
      </div>
      <div className="modal-actions">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button disabled={busy || !valid} onClick={onLoad}>
          <FolderOpen />
          {busy ? "加载中" : "载入"}
        </button>
      </div>
    </>
  );
}

export function SubmitPanel({
  target,
  changes,
  busy,
  blocked,
  error,
  onSubmit,
  onClose,
}: {
  target: string;
  changes: DbChange[];
  busy: boolean;
  blocked: boolean;
  error: string;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <p className="submit-target">{target}</p>
      <div className="submit-counts">
        {[
          ["insert", "新增"],
          ["update", "修改"],
          ["delete", "删除"],
        ].map(([kind, label]) => (
          <div key={kind}>
            <span className="count">{label}</span>
            <strong>
              {changes.filter((change) => change.kind === kind).length}
            </strong>
          </div>
        ))}
      </div>
      {error && (
        <div className="submit-error">
          <p className="inline-error" role="alert">
            {error.includes("待核对") || error.includes("重读失败")
              ? "提交状态需要核对"
              : "提交未完成，本地修改已保留"}
          </p>
          <details>
            <summary>错误详情</summary>
            <p className="form-note">{error}</p>
          </details>
        </div>
      )}
      {blocked && (
        <p className="warning">当前副本禁止再次提交，请重新载入来源并核对。</p>
      )}
      <div className="modal-actions">
        <button disabled={busy} onClick={onClose}>
          返回编辑
        </button>
        <button
          disabled={busy || blocked || !changes.length}
          onClick={onSubmit}
        >
          <Database />
          {busy ? "提交中" : "提交到数据库"}
        </button>
      </div>
    </>
  );
}
