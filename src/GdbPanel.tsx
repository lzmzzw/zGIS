import { useEffect, useRef, useState } from "react";
import { FolderOpen, LoaderCircle } from "lucide-react";
import {
  makeGdbLayer,
  validateGdbBounds,
  type GdbCatalog,
  type GdbReadOptions,
  type GdbAdapter,
} from "./gdb";
import type { DocumentLayer } from "./domain";
import { t, useLocale } from "./i18n";
import "./gdb.css";

export default function GdbPanel({
  onImport,
  onBusy,
  onClose,
  adapter,
  directorySupported = true,
}: {
  onImport: (layer: DocumentLayer) => void;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  adapter: GdbAdapter;
  directorySupported?: boolean;
}) {
  useLocale();
  const [catalog, setCatalog] = useState<GdbCatalog>();
  const [layerName, setLayerName] = useState("");
  const [fields, setFields] = useState<string[]>([]);
  const [limit, setLimit] = useState(10000);
  const [useBounds, setUseBounds] = useState(false);
  const [bounds, setBounds] = useState(["", "", "", ""]);
  const [approximate, setApproximate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onBusy, onClose, onImport, adapter });
  callbacks.current = { onBusy, onClose, onImport, adapter };
  const layer = catalog?.layers.find((item) => item.name === layerName);
  function setWorking(value: boolean) {
    setBusy(value);
    callbacks.current.onBusy(value);
  }
  useEffect(
    () => () => {
      const id = request.current;
      request.current = undefined;
      if (id) void callbacks.current.adapter.cancelGdb(id).catch(() => {});
      callbacks.current.onBusy(false);
    },
    [],
  );
  async function cancel(close = false) {
    const id = request.current;
    request.current = undefined;
    if (id) {
      try {
        await callbacks.current.adapter.cancelGdb(id);
      } catch (reason) {
        if (!close)
          setError(String(reason instanceof Error ? reason.message : reason));
      }
    }
    setWorking(false);
    if (close) callbacks.current.onClose();
  }
  function chooseLayer(name: string, source = catalog) {
    setLayerName(name);
    setFields(
      source?.layers
        .find((item) => item.name === name)
        ?.fields.filter((field) => !/binary|list|unknown/i.test(field.type))
        .map((field) => field.name) ?? [],
    );
    setError("");
  }
  async function open(zipped: boolean) {
    if (request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setWorking(true);
    setError("");
    try {
      const result = await adapter.openGdb(id, zipped);
      if (request.current !== id) return;
      if (result) {
        setCatalog(result);
        chooseLayer(
          result.layers.find((item) => item.supported)?.name ??
            result.layers[0]?.name ??
            "",
          result,
        );
      }
    } catch (reason) {
      if (request.current === id)
        setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      if (request.current === id) {
        request.current = undefined;
        setWorking(false);
      }
    }
  }
  async function read() {
    if (!catalog || !layer?.supported || request.current) return;
    let options: GdbReadOptions;
    try {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000)
        throw new Error("GDB 读取上限须为 1–100000 的整数");
      if (useBounds && bounds.some((value) => !value.trim()))
        throw new Error("请填写完整的 GDB 范围");
      options = {
        layerName,
        limit,
        fields,
        allowApproximateDatum: approximate,
        ...(useBounds ? { bounds: validateGdbBounds(bounds.map(Number)) } : {}),
      };
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
      return;
    }
    const id = crypto.randomUUID();
    request.current = id;
    setWorking(true);
    setError("");
    try {
      const result = await adapter.readGdb(id, catalog.sourceId, options);
      if (request.current !== id) return;
      const added = makeGdbLayer(catalog, options, result);
      // Release global busy before onImport closes/unmounts this panel.
      request.current = undefined;
      setWorking(false);
      callbacks.current.onImport(added);
    } catch (reason) {
      if (request.current === id)
        setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      if (request.current === id) {
        request.current = undefined;
        setWorking(false);
      }
    }
  }
  return (
    <>
      <div className="gdb-panel">
        <p className="form-note">
          {t("GDB 图层只读，可查询、分析和导出；导出仅包含已加载的要素。")}
        </p>
        <div className="gdb-source-actions">
          {directorySupported && (
            <button disabled={busy} onClick={() => void open(false)}>
              <FolderOpen />
              {t("选择 GDB 目录")}
            </button>
          )}
          <button disabled={busy} onClick={() => void open(true)}>
            <FolderOpen />
            {t("选择 GDB ZIP")}
          </button>
        </div>
        {catalog && (
          <>
            <p className="form-note gdb-source-path" title={catalog.path}>
              {catalog.path}
            </p>
            {catalog.warnings.map((warning, index) => (
              <p className="warning" key={index}>
                {t(warning)}
              </p>
            ))}
            {!catalog.layers.length ? (
              <p className="form-note">{t("GDB 中没有可列出的图层")}</p>
            ) : (
              <>
                <label>
                  {t("GDB 图层")}
                  <select
                    aria-label={t("GDB 图层")}
                    value={layerName}
                    disabled={busy}
                    onChange={(event) => chooseLayer(event.target.value)}
                  >
                    {catalog.layers.map((item) => (
                      <option value={item.name} key={item.name}>
                        {item.group ? `${item.group} / ` : ""}
                        {item.alias
                          ? `${item.alias} (${item.name})`
                          : item.name}
                        {item.supported ? "" : ` · ${t("不支持")}`}
                      </option>
                    ))}
                  </select>
                </label>
                {layer && (
                  <>
                    <dl className="gdb-summary">
                      <dt>{t("几何类型")}</dt>
                      <dd>{layer.geometryType}</dd>
                      <dt>{t("要素数量")}</dt>
                      <dd>
                        {layer.featureCount === null
                          ? t("未知（不扫描整层）")
                          : layer.featureCount.toLocaleString()}
                      </dd>
                      <dt>{t("来源 CRS")}</dt>
                      <dd title={layer.sourceCrsWkt}>{layer.sourceCrs}</dd>
                    </dl>
                    {!layer.supported && (
                      <p className="warning" role="alert">
                        {t(layer.reason || "该 GDB 图层暂不支持读取")}
                      </p>
                    )}
                    {layer.warnings.map((warning, index) => (
                      <p className="warning" key={index}>
                        {t(warning)}
                      </p>
                    ))}
                    <label>
                      {t("GDB 读取上限")}
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        step={1}
                        aria-label={t("GDB 读取上限")}
                        value={Number.isNaN(limit) ? "" : limit}
                        disabled={busy}
                        onChange={(event) =>
                          setLimit(event.target.valueAsNumber)
                        }
                      />
                    </label>
                    <label className="gdb-check">
                      <input
                        type="checkbox"
                        checked={useBounds}
                        disabled={busy}
                        onChange={(event) => setUseBounds(event.target.checked)}
                      />
                      {t("按 WGS84 范围读取")}
                    </label>
                    {useBounds && (
                      <div className="gdb-bounds">
                        {["西经度", "南纬度", "东经度", "北纬度"].map(
                          (label, index) => (
                            <label key={label}>
                              {t(label)}
                              <input
                                type="number"
                                step="any"
                                aria-label={t(label)}
                                value={bounds[index]}
                                disabled={busy}
                                onChange={(event) =>
                                  setBounds((old) =>
                                    old.map((value, n) =>
                                      n === index ? event.target.value : value,
                                    ),
                                  )
                                }
                              />
                            </label>
                          ),
                        )}
                      </div>
                    )}
                    <label className="gdb-check">
                      <input
                        type="checkbox"
                        checked={approximate}
                        disabled={busy}
                        onChange={(event) =>
                          setApproximate(event.target.checked)
                        }
                      />
                      {t("允许 CGCS2000 与 WGS84 的近似转换")}
                    </label>
                    <p className="form-note">
                      {t(
                        "仅适用于 CGCS2000 及其投影，不做历元、七参数、格网或高程基准换算，不能用于测绘级转换。",
                      )}
                    </p>
                    <details open>
                      <summary>{t("读取字段与原始类型")}</summary>
                      <div className="gdb-field-actions">
                        <button
                          className="quiet"
                          disabled={busy}
                          onClick={() =>
                            setFields(layer.fields.map((field) => field.name))
                          }
                        >
                          {t("全选字段")}
                        </button>
                        <button
                          className="quiet"
                          disabled={busy}
                          onClick={() => setFields([])}
                        >
                          {t("仅几何")}
                        </button>
                      </div>
                      <div className="gdb-fields">
                        {layer.fields.length ? (
                          layer.fields.map((field) => (
                            <label className="gdb-field" key={field.name}>
                              <input
                                type="checkbox"
                                aria-label={t("读取字段 {0}", field.name)}
                                checked={fields.includes(field.name)}
                                disabled={busy}
                                onChange={(event) =>
                                  setFields((old) =>
                                    event.target.checked
                                      ? [...old, field.name]
                                      : old.filter(
                                          (name) => name !== field.name,
                                        ),
                                  )
                                }
                              />
                              <span>
                                <strong>{field.name}</strong>
                                {field.alias && <span> · {field.alias}</span>}
                                <small>
                                  {field.type} ·{" "}
                                  {t(field.nullable ? "允许 NULL" : "非空")}
                                </small>
                                {field.domain && (
                                  <small title={field.domain}>
                                    {t("字段域")} · {field.domain}
                                  </small>
                                )}
                              </span>
                            </label>
                          ))
                        ) : (
                          <p className="form-note">{t("没有属性字段")}</p>
                        )}
                      </div>
                      <p className="form-note">
                        {t(
                          "编码域保留原始值；二进制等不支持的字段须取消选择，选中时会明确报错。",
                        )}
                      </p>
                    </details>
                  </>
                )}
              </>
            )}
          </>
        )}
        {error && (
          <p className="warning" role="alert">
            {t(error)}
          </p>
        )}
        {busy && (
          <p className="form-note" role="status">
            <LoaderCircle className="spin" />
            {t("正在读取 GDB…")}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button onClick={() => void cancel(true)}>{t("关闭")}</button>
        {busy ? (
          <button onClick={() => void cancel()}>{t("取消读取")}</button>
        ) : (
          <button disabled={!layer?.supported} onClick={() => void read()}>
            {t("添加只读图层")}
          </button>
        )}
      </div>
    </>
  );
}
