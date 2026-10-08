import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  desktop,
  type DatabaseSource,
  type DatabaseTable,
  type DatabaseCatalog,
  type DatabasePreview,
  type DbConnection,
  type DbLayer,
} from "./bridge";
import "./postgis-manager.css";

const defaults: DbConnection = {
  host: "",
  port: 5432,
  database: "",
  user: "",
  password: "",
  sslMode: "require",
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const key = (t: DatabaseTable) => JSON.stringify([t.schema, t.table]);
type Session = { connectionId: string; catalog: DatabaseCatalog };
function ManagerDialog({
  title,
  children,
  onClose,
  busy,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,button")?.focus();
    const guard = (e: FocusEvent) => {
      if (!ref.current?.contains(e.target as Node))
        ref.current?.querySelector<HTMLElement>("input,button")?.focus();
    };
    document.addEventListener("focusin", guard);
    return () => {
      document.removeEventListener("focusin", guard);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="pg-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (!busy) onClose();
        }
        if (e.key === "Tab") {
          const items = [
            ...ref.current!.querySelectorAll<HTMLElement>(
              "input:not(:disabled),textarea:not(:disabled),select:not(:disabled),button:not(:disabled)",
            ),
          ];
          const first = items[0],
            last = items.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div
        className="pg-dialog"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="pg-line pg-spread">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export default function PostgisManager({
  open,
  onClose,
  onLoad,
  onActive,
  inUseConnectionIds,
  engine = "postgis",
}: {
  engine?: "postgis" | "mysql";
  open: boolean;
  onClose(): void;
  onLoad(connectionId: string, config: DbConnection, layer: DbLayer): void;
  onActive(connectionId: string, config: DbConnection): void;
  inUseConnectionIds: string[];
}) {
  const mysql = engine === "mysql";
  const engineLabel = mysql ? "Mysql" : "PostGIS";
  const engineApi = mysql
    ? {
        sources: api.mysqlSources,
        save: api.saveMysqlSources,
        connect: api.connectMysql,
        disconnect: api.disconnectMysql,
        catalog: api.mysqlCatalog,
        preview: api.previewMysqlTable,
      }
    : {
        sources: api.databaseSources,
        save: api.saveDatabaseSources,
        connect: api.connect,
        disconnect: api.disconnect,
        catalog: api.databaseCatalog,
        preview: api.previewDatabaseTable,
      };
  const initialDraft = { ...defaults, port: mysql ? 3306 : 5432 };
  const [sources, setSources] = useState<DatabaseSource[]>([]);
  const [ready, setReady] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [schema, setSchema] = useState("");
  const [tableKey, setTableKey] = useState("");
  const [search, setSearch] = useState("");
  const [onlyGeometry, setOnlyGeometry] = useState(true);
  const [limit, setLimit] = useState(20);
  const [preview, setPreview] = useState<DatabasePreview>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<"add" | "connect" | "delete">();
  const [draft, setDraft] = useState(initialDraft);
  const [name, setName] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [testStatus, setTestStatus] = useState("");
  const [assumedSrid, setAssumedSrid] = useState("");
  const [geometryColumn, setGeometryColumn] = useState("");
  const sequence = useRef(0);
  const alive = useRef(true);
  const source = sources.find((s) => s.id === sourceId);
  const session = sessions[sourceId];
  const tables = session?.catalog.tables ?? [];
  const available = tables.filter(
    (t) =>
      (!onlyGeometry || t.geometryColumns.length > 0) &&
      `${t.schema}.${t.table}`.toLowerCase().includes(search.toLowerCase()),
  );
  const table = available.find(
    (t) => key(t) === tableKey && (mysql || t.schema === schema),
  );
  const geom =
    table?.geometryColumns.find((c) => c.name === geometryColumn) ??
    table?.geometryColumns[0];
  const configValid =
    !!draft.host.trim() &&
    !!draft.database.trim() &&
    !!draft.user.trim() &&
    Number.isInteger(draft.port) &&
    draft.port > 0 &&
    draft.port <= 65535 &&
    (dialog !== "add" || !!name.trim());
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    const load = async () => {
      try {
        const result = desktop ? await engineApi.sources() : [];
        if (!disposed) {
          setSources(result);
          setSourceId(result[0]?.id ?? "");
          setReady(true);
        }
      } catch (e) {
        if (!disposed) {
          setError(message(e));
          setReady(false);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    if (!table || !session || !open) {
      setPreview(undefined);
      setPreviewBusy(false);
      setPreviewError("");
      return;
    }
    let disposed = false;
    setPreview(undefined);
    setPreviewBusy(true);
    setPreviewError("");
    void engineApi
      .preview(session.connectionId, table.schema, table.table, limit)
      .then((result) => {
        if (!disposed) setPreview(result);
      })
      .catch((e) => {
        if (!disposed) setPreviewError(message(e));
      })
      .finally(() => {
        if (!disposed) setPreviewBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [session, table, limit, open, revision]);
  function activate(id: string) {
    setSourceId(id);
    setSchema("");
    setTableKey("");
    setGeometryColumn("");
    setSearch("");
    setError("");
    const s = sources.find((s) => s.id === id),
      runtime = sessions[id];
    if (s) onActive(runtime?.connectionId ?? "", { ...s, password: "" });
  }
  function startDialog(kind: "add" | "connect" | "delete") {
    setDialogError("");
    setShowPassword(false);
    setTestStatus("");
    setName(kind === "connect" ? (source?.name ?? "") : "");
    setDraft(
      kind === "connect" && source ? { ...source, password: "" } : initialDraft,
    );
    setDialog(kind);
    if (kind === "connect" && source) {
      setBusy(true);
      void api
        .databaseSourcePassword(engine, source.id)
        .then((password) => {
          if (alive.current)
            setDraft((old) => ({ ...old, password: password ?? "" }));
        })
        .catch((e) => {
          if (alive.current) setDialogError(message(e));
        })
        .finally(() => {
          if (alive.current) setBusy(false);
        });
    }
  }
  function closeDialog() {
    if (busy) return;
    setDraft(initialDraft);
    setDialog(undefined);
    setDialogError("");
    setTestStatus("");
  }
  async function connect(test = false) {
    if (busy || !configValid || !ready) return;
    if (!test && session && inUseConnectionIds.includes(session.connectionId)) {
      setDialogError("请先移除引用此数据源的图层，再重新连接");
      return;
    }
    setBusy(true);
    setDialogError("");
    setTestStatus("");
    let id: string | undefined;
    let pendingPasswordId: string | undefined;
    try {
      id = await engineApi.connect(draft);
      if (test) {
        await engineApi.disconnect(id);
        id = undefined;
        setTestStatus("连接测试成功");
        return;
      }
      const catalog = await engineApi.catalog(id);
      const { password: _password, ...safeConfig } = draft;
      const saved: DatabaseSource = {
        id: dialog === "connect" ? sourceId : crypto.randomUUID(),
        name: name.trim(),
        host: safeConfig.host.trim(),
        port: safeConfig.port,
        database: safeConfig.database.trim(),
        user: safeConfig.user.trim(),
        sslMode: safeConfig.sslMode,
      };
      const next =
        dialog === "connect"
          ? sources.map((s) => (s.id === saved.id ? saved : s))
          : [...sources, saved];
      await api.saveDatabaseSourcePassword(engine, saved.id, draft.password);
      if (dialog === "add") {
        pendingPasswordId = saved.id;
        await engineApi.save(next);
      }
      pendingPasswordId = undefined;
      if (!alive.current) {
        await engineApi.disconnect(id);
        id = undefined;
        return;
      }
      if (dialog === "connect" && session)
        await engineApi.disconnect(session.connectionId);
      const connectionId = id;
      setSources(next);
      setSessions((old) => ({ ...old, [saved.id]: { connectionId, catalog } }));
      setSourceId(saved.id);
      setSchema(catalog.schemas[0] ?? "");
      setTableKey("");
      setSearch("");
      onActive(connectionId, { ...saved, password: "" });
      id = undefined;
      setDraft(initialDraft);
      setDialog(undefined);
      setError("");
    } catch (e) {
      if (alive.current) setDialogError(message(e));
    } finally {
      if (pendingPasswordId)
        await api
          .deleteDatabaseSourcePassword(engine, pendingPasswordId)
          .catch(() => {});
      if (id) await engineApi.disconnect(id).catch(() => {});
      if (alive.current) setBusy(false);
    }
  }
  async function remove() {
    if (!source || busy || !ready) return;
    if (session && inUseConnectionIds.includes(session.connectionId)) {
      setDialogError("请先移除引用此数据源的图层，再删除数据源");
      return;
    }
    setBusy(true);
    setDialogError("");
    try {
      const next = sources.filter((s) => s.id !== sourceId);
      await engineApi.save(next);
      try {
        await api.deleteDatabaseSourcePassword(engine, source.id);
      } catch (e) {
        await engineApi.save(sources);
        throw e;
      }
      if (session) await engineApi.disconnect(session.connectionId);
      setSources(next);
      setSessions((old) => {
        const copy = { ...old };
        delete copy[sourceId];
        return copy;
      });
      const nextId = next[0]?.id ?? "";
      setSourceId(nextId);
      setSchema("");
      setTableKey("");
      setPreview(undefined);
      setDialog(undefined);
      const nextSession = sessions[nextId];
      onActive(
        nextSession?.connectionId ?? "",
        next[0] ? { ...next[0], password: "" } : defaults,
      );
    } catch (e) {
      setDialogError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    if (!session || busy) return;
    const requested = ++sequence.current;
    const targetId = sourceId;
    setBusy(true);
    setError("");
    try {
      const catalog = await engineApi.catalog(session.connectionId);
      if (requested === sequence.current && alive.current)
        setSessions((old) => ({ ...old, [targetId]: { ...session, catalog } }));
    } catch (e) {
      if (requested === sequence.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className="pg-manager"
      hidden={!open}
      aria-label={engineLabel + " 数据源管理"}
    >
      <header className="pg-heading">
        <button className="quiet" disabled={busy} onClick={onClose}>
          <ArrowLeft />
          返回地图
        </button>
        <span className="pg-divider" />
        <h1>{engineLabel} 数据源</h1>
        <div className="pg-grow" />
        <button
          className="quiet danger"
          disabled={!source || busy || !ready}
          onClick={() => startDialog("delete")}
        >
          <Trash2 />
          删除数据源
        </button>
        <button
          disabled={busy || !ready || !desktop}
          onClick={() => startDialog("add")}
        >
          <Plus />
          新增数据源
        </button>
        <button
          className="quiet"
          disabled={!source || busy}
          onClick={() => startDialog("connect")}
        >
          连接设置
        </button>
      </header>
      <div className="pg-body">
        <aside className="pg-sources">
          <div className="pg-section-title">
            <strong>数据源</strong>
            <span className="count">{sources.length || ""}</span>
          </div>
          {sources.map((s) => (
            <button
              key={s.id}
              className={`pg-source ${sourceId === s.id ? "selected" : ""}`}
              disabled={busy}
              onClick={() => activate(s.id)}
            >
              <Database />
              <span>
                <strong title={s.name}>{s.name}</strong>
                <small title={s.database}>
                  {s.database} · {sessions[s.id] ? "已连接" : "未连接"}
                </small>
              </span>
            </button>
          ))}
          {!sources.length && ready && (
            <p className="pg-note">
              {mysql
                ? "添加数据源以浏览数据表。"
                : "添加数据源以浏览 Schema 和数据表。"}
            </p>
          )}
        </aside>
        <section className="pg-catalog">
          <div className="pg-section-title">
            <strong>{mysql ? "数据表" : "Schema / 数据表"}</strong>
            <button
              className="icon-button"
              aria-label="刷新表列表"
              disabled={!session || busy}
              onClick={() => void refresh()}
            >
              <RefreshCw />
            </button>
          </div>
          <input
            aria-label="搜索数据表"
            placeholder="搜索表名称"
            value={search}
            disabled={!session}
            onChange={(e) => {
              setSearch(e.target.value);
              setTableKey("");
            }}
          />
          <div className="pg-filter">
            <button
              aria-pressed={!onlyGeometry}
              onClick={() => {
                setOnlyGeometry(false);
                setTableKey("");
              }}
            >
              全部表
            </button>
            <button
              aria-pressed={onlyGeometry}
              onClick={() => {
                setOnlyGeometry(true);
                setTableKey("");
              }}
            >
              仅含 geometry
            </button>
          </div>
          <div className="pg-schema-list">
            {mysql
              ? available.map((t) => (
                  <button
                    className={`pg-table ${tableKey === key(t) ? "selected" : ""}`}
                    key={key(t)}
                    onClick={() => {
                      setTableKey(key(t));
                      setAssumedSrid("");
                      setSchema(t.schema);
                      setGeometryColumn(t.geometryColumns[0]?.name ?? "");
                    }}
                  >
                    <Table2 />
                    <span title={t.table}>{t.table}</span>
                    {!t.geometryColumns.length && <small>普通表</small>}
                  </button>
                ))
              : session?.catalog.schemas.map((s) => (
                  <div key={s}>
                    <button
                      className="pg-schema"
                      aria-expanded={schema === s}
                      onClick={() => {
                        setSchema(schema === s ? "" : s);
                        setTableKey("");
                      }}
                    >
                      {schema === s ? <ChevronDown /> : <ChevronRight />}
                      <span title={s}>{s}</span>
                      <small>
                        {available.filter((t) => t.schema === s).length}
                      </small>
                    </button>
                    {schema === s &&
                      available
                        .filter((t) => t.schema === s)
                        .map((t) => (
                          <button
                            className={`pg-table ${tableKey === key(t) ? "selected" : ""}`}
                            key={key(t)}
                            onClick={() => {
                              setTableKey(key(t));
                              setGeometryColumn(
                                t.geometryColumns[0]?.name ?? "",
                              );
                            }}
                          >
                            <Table2 />
                            <span title={t.table}>{t.table}</span>
                            {!t.geometryColumns.length && <small>普通表</small>}
                          </button>
                        ))}
                    {schema === s && !available.some((t) => t.schema === s) && (
                      <p className="pg-note">
                        {search ? "没有匹配的数据表" : "此筛选下没有数据表"}
                      </p>
                    )}
                  </div>
                ))}
            {mysql && session && !available.length && (
              <p className="pg-note">此筛选下没有数据表</p>
            )}
          </div>
        </section>
        <section className="pg-preview" aria-busy={previewBusy}>
          {error && (
            <div className="pg-message">
              <p className="inline-error" role="alert">
                {error}
              </p>
              {session && (
                <button disabled={busy} onClick={() => void refresh()}>
                  重试列表
                </button>
              )}
            </div>
          )}
          {!ready ? (
            <div className="pg-empty">
              {error
                ? "数据源配置未能读取，请重新启动后重试。"
                : "读取数据源配置…"}
            </div>
          ) : !source ? (
            <div className="pg-empty">选择或新增一个{engineLabel} 数据源。</div>
          ) : !session ? (
            <div className="pg-empty">
              <Database />
              <h2>{source.name}</h2>
              <p>
                {mysql
                  ? "连接后浏览数据表和预览记录。"
                  : "连接后浏览 Schema、数据表和预览记录。"}
              </p>
              <button disabled={busy} onClick={() => startDialog("connect")}>
                连接数据源
              </button>
            </div>
          ) : !table ? (
            <div className="pg-empty">从左侧选择一个数据表以预览。</div>
          ) : (
            <>
              <div className="pg-preview-heading">
                <small>
                  {source.name} / {table.schema}
                </small>
                <div className="pg-line pg-spread">
                  <h2 title={table.table}>{table.table}</h2>
                  <button
                    disabled={
                      !geom ||
                      busy ||
                      (mysql && geom.srid === 0 && !assumedSrid)
                    }
                    onClick={() => {
                      if (geom)
                        onLoad(
                          session.connectionId,
                          { ...source, password: "" },
                          {
                            schema: table.schema,
                            table: table.table,
                            columns: table.columns,
                            keyColumns: table.keyColumns,
                            geometryColumn: geom.name,
                            geometryKind: "geometry",
                            srid:
                              mysql && geom.srid === 0
                                ? Number(assumedSrid)
                                : geom.srid,
                          },
                        );
                    }}
                  >
                    添加到地图
                  </button>
                </div>
                {!geom &&
                  table.columns.some((c) =>
                    /text|character|varchar|char\(/i.test(c.type),
                  ) && (
                    <button
                      className="quiet pg-wkt"
                      disabled={busy}
                      onClick={() =>
                        onLoad(
                          session.connectionId,
                          { ...source, password: "" },
                          {
                            schema: table.schema,
                            table: table.table,
                            columns: table.columns,
                            keyColumns: table.keyColumns,
                            geometryColumn: table.columns.find((c) =>
                              /text|character|varchar|char\(/i.test(c.type),
                            )!.name,
                            geometryKind: "wkt",
                            srid: 4326,
                          },
                        )
                      }
                    >
                      从 WKT 列加载
                    </button>
                  )}
                <div className="pg-meta">
                  {geom
                    ? `${geom.type} · EPSG:${geom.srid}`
                    : "普通表 · 无 geometry 列"}
                  <span>主键 {table.keyColumns.join(", ") || "无主键"}</span>
                </div>
                {mysql && geom?.srid === 0 && (
                  <label className="pg-geometry">
                    来源坐标系
                    <select
                      aria-label="来源坐标系"
                      value={assumedSrid}
                      onChange={(e) => setAssumedSrid(e.target.value)}
                    >
                      <option value="">请选择</option>
                      <option value="4326">EPSG:4326 · WGS84</option>
                    </select>
                  </label>
                )}
                {table.geometryColumns.length > 1 && (
                  <label className="pg-geometry">
                    几何列{" "}
                    <select
                      aria-label="几何列"
                      value={geom?.name}
                      onChange={(e) => {
                        setGeometryColumn(e.target.value);
                        setAssumedSrid("");
                      }}
                    >
                      {table.geometryColumns.map((g) => (
                        <option key={g.name}>{g.name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <div className="pg-preview-toolbar">
                <strong>数据预览</strong>
                <div className="pg-grow" />
                <label>
                  预览{" "}
                  <select
                    aria-label="预览条数"
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                  >
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                  </select>{" "}
                  条
                </label>
                <button
                  className="icon-button"
                  aria-label="刷新预览"
                  disabled={previewBusy}
                  onClick={() => setRevision((n) => n + 1)}
                >
                  <RefreshCw />
                </button>
              </div>
              {previewError ? (
                <div className="pg-empty">
                  <p className="inline-error" role="alert">
                    {previewError}
                  </p>
                  <button onClick={() => setRevision((n) => n + 1)}>
                    重试预览
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => startDialog("connect")}
                  >
                    重新连接
                  </button>
                </div>
              ) : previewBusy ? (
                <div className="pg-empty">读取预览…</div>
              ) : (
                <div className="pg-preview-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        {preview?.columns.map((c) => (
                          <th key={c.name} title={`${c.name} · ${c.type}`}>
                            {c.name}
                            <small>
                              {c.type}
                              {table.keyColumns.includes(c.name) ? " · PK" : ""}
                            </small>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview?.rows.map((row, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          {row.map((value, j) => (
                            <td key={j} title={value ?? "NULL"}>
                              {value === null ? (
                                <span className="pg-null">NULL</span>
                              ) : (
                                value
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview && !preview.rows.length && (
                    <p className="pg-note">此表没有记录。</p>
                  )}
                </div>
              )}
              <footer className="pg-preview-footer">
                <span>
                  {preview
                    ? `显示 ${preview.rows.length} 条${preview.truncated ? ` · 前 ${limit} 条` : ""}`
                    : ""}{" "}
                  · 只读预览
                </span>
                <span>
                  {geom ? "geometry 以类型摘要显示" : "普通表仅供预览"}
                </span>
              </footer>
            </>
          )}
        </section>
      </div>
      {dialog && (
        <ManagerDialog
          title={
            dialog === "delete"
              ? "删除数据源"
              : dialog === "add"
                ? `新增 ${engineLabel} 数据源`
                : "连接数据源"
          }
          busy={busy}
          onClose={closeDialog}
        >
          {dialog === "delete" ? (
            <>
              <p>从列表移除“{source?.name}”？数据库中的表和数据保持不变。</p>
              {dialogError && (
                <p className="inline-error" role="alert">
                  {dialogError}
                </p>
              )}
              <div className="modal-actions">
                <button disabled={busy} onClick={closeDialog}>
                  取消
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  删除
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
            >
              <div className="pg-form">
                {dialog === "add" && (
                  <label>
                    数据源名称
                    <input
                      aria-label="数据源名称"
                      value={name}
                      disabled={busy}
                      maxLength={120}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                )}
                {(
                  [
                    ["host", "主机"],
                    ["database", "数据库"],
                    ["user", "用户名"],
                    ["password", "密码"],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <input
                      aria-label={label}
                      type={
                        field === "password" && !showPassword
                          ? "password"
                          : "text"
                      }
                      autoComplete="off"
                      value={draft[field]}
                      disabled={
                        busy || (dialog === "connect" && field !== "password")
                      }
                      onChange={(e) => {
                        setDraft((old) => ({
                          ...old,
                          [field]: e.target.value,
                        }));
                        setTestStatus("");
                      }}
                    />
                    {field === "password" && (
                      <button
                        className="pg-password-toggle quiet"
                        type="button"
                        disabled={busy}
                        aria-label={showPassword ? "隐藏密码" : "显示密码"}
                        onClick={() => setShowPassword((value) => !value)}
                      >
                        {showPassword ? <EyeOff /> : <Eye />}
                        {showPassword ? "隐藏密码" : "显示密码"}
                      </button>
                    )}
                  </label>
                ))}
                <div className="pg-two">
                  <label>
                    端口
                    <input
                      aria-label="端口"
                      type="number"
                      min={1}
                      max={65535}
                      value={draft.port}
                      disabled={busy || dialog === "connect"}
                      onChange={(e) =>
                        setDraft((old) => ({
                          ...old,
                          port: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    TLS
                    <select
                      aria-label="TLS"
                      value={draft.sslMode}
                      disabled={busy || dialog === "connect"}
                      onChange={(e) =>
                        setDraft((old) => ({ ...old, sslMode: e.target.value }))
                      }
                    >
                      <option value="require">校验证书</option>
                      <option value="disable">禁用 TLS</option>
                    </select>
                  </label>
                </div>
              </div>
              <p className="pg-note">
                密码使用 Windows 当前用户加密存储，可点击显示。
              </p>
              {dialogError && (
                <p className="inline-error" role="alert">
                  {dialogError}
                </p>
              )}
              {testStatus && <p role="status">{testStatus}</p>}
              <div className="modal-actions">
                <button
                  type="button"
                  disabled={busy || !configValid}
                  onClick={() => void connect(true)}
                >
                  测试连接
                </button>
                <div className="pg-grow" />
                <button type="button" disabled={busy} onClick={closeDialog}>
                  取消
                </button>
                <button disabled={busy || !configValid}>
                  {busy ? "连接中" : dialog === "add" ? "添加并连接" : "连接"}
                </button>
              </div>
            </form>
          )}
        </ManagerDialog>
      )}
    </section>
  );
}
