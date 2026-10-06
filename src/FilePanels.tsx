import { useEffect, useState } from "react";
import { Check, Download, FolderOpen, LoaderCircle } from "lucide-react";
import type { DocumentLayer, ImportOptions, InputFile } from "./domain";
import { previewCsvInWorker, type CsvPreview } from "./workers";

export function ImportPanel({
  files,
  busy,
  error,
  onImport,
  onClose,
  onChange,
}: {
  files: InputFile[];
  busy: boolean;
  error: string;
  onImport: (options: ImportOptions[]) => void;
  onClose: () => void;
  onChange: () => void;
}) {
  const [fileIndex, setFileIndex] = useState(0);
  const [configurations, setConfigurations] = useState<ImportOptions[]>(() =>
    files.map((file) => ({ encoding: "utf-8", crs: /\.(geojson|json)$/i.test(file.name) ? undefined : "EPSG:4326" })),
  );
  const [preview, setPreview] = useState<CsvPreview>();
  const [loading, setLoading] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const csvFiles = files.filter((file) => /\.csv$/i.test(file.name));
  const file = csvFiles[fileIndex];
  const originalIndex = files.indexOf(file);
  const options = configurations[originalIndex] ?? {};
  useEffect(() => {
    if (!file) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setPreviewError("");
    const timer = setTimeout(() => {
      previewCsvInWorker(file, options, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setPreview(result);
            setLoading(false);
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted) {
            setPreviewError(String(reason.message ?? reason));
            setLoading(false);
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [file, options]);
  const mode = options.geometryMode ?? preview?.options.geometryMode ?? "xy";
  const change = (key: keyof ImportOptions, value: string) => {
    onChange();
    setConfigurations((old) =>
      old.map((config, index) =>
        index === originalIndex ? { ...config, [key]: value } : config,
      ),
    );
  };
  const column = (key: "wktColumn" | "xColumn" | "yColumn", label: string) => (
    <label>
      {label}
      <select
        aria-label={label}
        aria-invalid={preview?.invalidFields.includes(key) || undefined}
        aria-describedby="import-validation"
        value={options[key] ?? preview?.options[key] ?? ""}
        disabled={busy}
        onChange={(event) => change(key, event.target.value)}
      >
        <option value="">自动识别</option>
        {preview?.fields.map((field) => (
          <option key={field}>{field}</option>
        ))}
      </select>
    </label>
  );
  const issue = error || previewError || preview?.validationError;
  return (
    <>
      <div className="split-dialog file-import">
        <div className="form-grid dialog-config">
          <label>
            文件
            {csvFiles.length > 1 ? (
              <select
                aria-label="预览文件"
                value={fileIndex}
                onChange={(event) => {
                  setFileIndex(Number(event.target.value));
                  setPreview(undefined);
                }}
              >
                {csvFiles.map((item, index) => (
                  <option key={item.name} value={index}>
                    {item.name}
                  </option>
                ))}
              </select>
            ) : (
              <span>{files.map((item) => item.name).join("、")}</span>
            )}
          </label>
          {file && (
            <>
              <label>
                编码
                <select
                  aria-label="编码"
                  value={options.encoding}
                  disabled={busy}
                  onChange={(event) => change("encoding", event.target.value)}
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="gb18030">GB18030 / GBK</option>
                </select>
              </label>
              <label>
                几何来源
                <select
                  aria-label="几何来源"
                  value={mode}
                  disabled={busy}
                  onChange={(event) =>
                    change("geometryMode", event.target.value)
                  }
                >
                  <option value="wkt">WKT 列</option>
                  <option value="xy">X / Y 坐标列</option>
                </select>
              </label>
              {mode === "wkt" ? (
                column("wktColumn", "WKT 列")
              ) : (
                <>
                  {column("xColumn", "X / 经度列")}
                  {column("yColumn", "Y / 纬度列")}
                </>
              )}
              <label>
                来源坐标系
                <select
                  aria-label="来源坐标系"
                  value={options.crs}
                  disabled={busy}
                  onChange={(event) => change("crs", event.target.value)}
                >
                  <option>EPSG:4326</option>
                  <option>EPSG:4490</option>
                  <option>EPSG:3857</option>
                </select>
              </label>
            </>
          )}
          {files.map((item, index) => /\.(geojson|json)$/i.test(item.name) && (
            <div key={index} className="form-grid">
            <label>
              {item.name} · 来源坐标系
              <select aria-label={`${item.name} 来源坐标系`} value={configurations[index]?.crs ?? ""} disabled={busy}
                onChange={(event) => {
                  onChange();
                  setConfigurations(old => old.map((config, i) => i === index ? { ...config, crs: event.target.value || undefined } : config));
                }}>
                <option value="">按文件标记；无标记默认 EPSG:4326</option>
                <option>EPSG:4326</option><option>EPSG:4490</option><option>EPSG:3857</option>
              </select>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" aria-label={`${item.name} 按二维副本导入`}
                checked={Boolean(configurations[index]?.geoJsonXYCopy)} disabled={busy}
                onChange={(event) => {
                  onChange();
                  setConfigurations(old => old.map((config, i) => i === index ? { ...config, geoJsonXYCopy: event.target.checked } : config));
                }} />
              按二维副本导入（忽略 Z/M，不修改原文件）
            </label>
            </div>
          ))}
          {issue && (
            <p id="import-validation" role="alert" className="inline-error">
              {issue}
            </p>
          )}
        </div>
        <aside className="dialog-summary">
          <header>
            数据预览{" "}
            <span className="count">{file ? "前 5 行" : "文件组"}</span>
          </header>
          {file ? (
            <>
              {loading ? (
                <p className="form-note">
                  <LoaderCircle size={14} className="spin" />
                  预览中
                </p>
              ) : (
                <div className="preview-table">
                  <table>
                    <thead>
                      <tr>
                        {preview?.fields.map((field) => (
                          <th key={field}>
                            {field}
                            {mode === "xy" &&
                            (options.xColumn ?? preview.options.xColumn) ===
                              field
                              ? " · X"
                              : mode === "xy" &&
                                  (options.yColumn ??
                                    preview.options.yColumn) === field
                                ? " · Y"
                                : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview?.rows.map((row, index) => (
                        <tr key={index}>
                          {preview.fields.map((field) => (
                            <td key={field} title={row[field]}>
                              {row[field]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <dl>
                <dt>几何类型</dt>
                <dd>{preview?.geometryTypes.join(" / ") || "—"}</dd>
                <dt>工作坐标</dt>
                <dd>WGS84</dd>
                <dt>预览状态</dt>
                <dd>{loading ? "校验中" : issue ? "未通过" : "通过"}</dd>
              </dl>
            </>
          ) : (
            <div className="import-file-list">
              {files.map((item) => (
                <div key={item.name}>
                  <FolderOpen size={15} />
                  <span>{item.name}</span>
                  <span className="count">
                    {(item.bytes.length / 1024).toFixed(1)} KB
                  </span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
      <div className="modal-actions">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          disabled={
            busy ||
            Boolean(
              file && (loading || previewError || preview?.validationError),
            )
          }
          onClick={() => onImport(configurations)}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Check size={15} />
          )}
          {file || !error ? "导入" : "重试导入"}
        </button>
      </div>
    </>
  );
}

export function ExportPanel({
  layer,
  mode,
  crs,
  filename,
  connected,
  schema,
  table,
  desktop,
  busy,
  error,
  onMode,
  onCrs,
  onFilename,
  onSchema,
  onTable,
  onExport,
  onClose,
}: {
  layer: DocumentLayer;
  mode: string;
  crs: string;
  filename: string;
  connected: boolean;
  schema: string;
  table: string;
  desktop: boolean;
  busy: boolean;
  error: string;
  onMode: (value: string) => void;
  onCrs: (value: string) => void;
  onFilename: (value: string) => void;
  onSchema: (value: string) => void;
  onTable: (value: string) => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const xyInvalid =
    mode === "xy" &&
    layer.features.some((feature) => feature.geometry?.type !== "Point");
  const dbInvalid =
    mode === "postgis" && (!connected || !schema.trim() || !table.trim());
  const issue =
    error ||
    (xyInvalid
      ? "CSV X/Y 仅支持点要素，当前图层包含其他几何或空几何。"
      : dbInvalid
        ? "请先连接数据库并填写目标 Schema 和新表名称。"
        : !filename.trim() && mode !== "postgis"
          ? "请填写文件名。"
          : "");
  const formats: Record<string, string> = {
    geojson: "GeoJSON",
    shp: "Shapefile · ZIP",
    wkt: "CSV · WKT",
    xy: "CSV · X/Y",
    postgis: "PostGIS · 新表",
  };
  return (
    <>
      <div className="split-dialog file-export">
        <div className="form-grid dialog-config">
          <label>
            来源图层<span>{layer.displayName ?? layer.name}</span>
          </label>
          <label>
            输出格式
            <select
              aria-label="输出格式"
              value={mode}
              disabled={busy}
              onChange={(event) => onMode(event.target.value)}
            >
              {Object.entries(formats)
                .filter(
                  ([key]) => desktop || (key !== "postgis" && key !== "shp"),
                )
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          {mode === "postgis" ? (
            <>
              <label>
                连接<span>{connected ? "已连接" : "尚未连接"}</span>
              </label>
              <label>
                Schema
                <input
                  aria-label="Schema"
                  value={schema}
                  disabled={busy}
                  onChange={(event) => onSchema(event.target.value)}
                />
              </label>
              <label>
                新表名
                <input
                  aria-label="新表名"
                  value={table}
                  disabled={busy}
                  onChange={(event) => onTable(event.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                文件名
                <input
                  aria-label="文件名"
                  value={filename}
                  disabled={busy}
                  onChange={(event) => onFilename(event.target.value)}
                />
              </label>
              <label>
                保存位置<span>{desktop ? "导出时选择" : "浏览器下载"}</span>
              </label>
              {mode !== "postgis" && (
                <label>
                  目标坐标系
                  <select
                    aria-label="目标坐标系"
                    value={crs}
                    disabled={busy}
                    onChange={(event) => onCrs(event.target.value)}
                  >
                    <option>EPSG:4326</option>
                    <option>EPSG:4490</option>
                    <option>EPSG:3857</option>
                  </select>
                </label>
              )}
            </>
          )}
          {issue && (
            <p className="inline-error" role="alert">
              {issue}
            </p>
          )}
        </div>
        <aside className="dialog-summary">
          <header>导出摘要</header>
          <dl>
            <dt>要素数量</dt>
            <dd>{layer.features.length.toLocaleString()}</dd>
            <dt>几何类型</dt>
            <dd>
              {[
                ...new Set(
                  layer.features.map(
                    (feature) => feature.geometry?.type ?? "空几何",
                  ),
                ),
              ].join(" / ")}
            </dd>
            <dt>格式</dt>
            <dd>{formats[mode]}</dd>
            <dt>输出坐标</dt>
            <dd>
              {mode === "postgis"
                ? "WGS84 · EPSG:4326"
                : crs}
            </dd>
            <dt>目标</dt>
            <dd>
              {mode === "postgis" ? `${schema}.${table || "…"}` : filename}
            </dd>
          </dl>
          {mode === "geojson" && crs !== "EPSG:4326" && (
            <p className="form-note">输出含 crs 标记的传统 GeoJSON；仅接受 RFC 7946 的软件可能不支持此文件。</p>
          )}
          {mode === "postgis" ? (
            <p className="form-note">
              新建 id、properties、geom 三列，不覆盖已有表。
            </p>
          ) : mode === "shp" ? (
            <p className="form-note">
              另存 ZIP（SHP、SHX、DBF、PRJ、CPG），按目标坐标系输出、UTF-8，须选择不存在的新文件。
              每次仅支持一种几何族：Point、MultiPoint、线或面，Point 与
              MultiPoint 不能混合。 DBF 字段名须为 ASCII 字母或下划线开头，最多 10
              字符，可含数字和下划线；
              属性仅支持文本、数值和布尔；空值、缺少字段、嵌套和类型冲突将提示错误。数值最多
              15 位有效数字、8 位小数。文本不接受空字符串或首尾空格。
              导出后保留工作副本和修改状态；退出时可保留恢复副本或另存 GeoJSON。
            </p>
          ) : mode !== "geojson" ? (
            <p className="form-note">
              嵌套属性转换为 JSON 文本；空字符串与 NULL 不保真。
            </p>
          ) : (
            <p className="form-note">属性和几何随工作副本导出。</p>
          )}
        </aside>
      </div>
      <div className="modal-actions">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          disabled={
            busy ||
            xyInvalid ||
            dbInvalid ||
            (mode !== "postgis" && !filename.trim())
          }
          onClick={onExport}
        >
          <Download size={15} />
          {busy ? "导出中" : "导出"}
        </button>
      </div>
    </>
  );
}
