import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Trash2,
  Palette,
  Map,
  Plug,
  Info,
  Plus,
  X,
} from "lucide-react";
import McpPanel from "./McpPanel";
import { desktop } from "./bridge";
import { moveBasemap, validateXyzUrl, type BasemapService } from "./basemaps";
import "./basemap-settings.css";

export type SettingsCategory = "appearance" | "map" | "mcp" | "about";
interface Props {
  services: BasemapService[];
  onServices: (services: BasemapService[]) => void;
  category: SettingsCategory;
  onCategory: (value: SettingsCategory) => void;
  theme: "light" | "dark";
  onTheme: (value: "light" | "dark") => void;
  basemap: string;
  onBasemap: (value: string) => void;
  annotations: boolean;
  onAnnotations: (value: boolean) => void;
  tdtKey: string;
  onTdtKey: (value: string) => void;
  error: string;
  onClose: () => void;
}
const categories = [
  { id: "appearance", label: "外观", icon: Palette },
  { id: "map", label: "地图", icon: Map },
  { id: "mcp", label: "空间分析 MCP", icon: Plug },
  { id: "about", label: "关于", icon: Info },
] as const;

function BasemapAddDialog({
  onAdd,
  onClose,
  returnFocus,
}: {
  onAdd: (service: BasemapService) => void;
  onClose: () => void;
  returnFocus: HTMLButtonElement | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [attribution, setAttribution] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    nameInput.current?.focus();
    return () => {
      element?.close();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);
  return (
    <dialog
      ref={dialog}
      className="modal basemap-add-dialog"
      aria-label="添加底图"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>添加底图</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <form
        className="basemap-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) {
            setError("请输入底图名称。");
            return;
          }
          if (!validateXyzUrl(url.trim())) {
            setError("XYZ 地址须为 HTTP(S)，并包含 {z}、{x}、{y}。");
            return;
          }
          onAdd({
            id: `xyz-${crypto.randomUUID()}`,
            name: name.trim(),
            type: "XYZ 瓦片服务",
            preview: "street",
            url: url.trim(),
            attribution: attribution.trim(),
          });
          onClose();
        }}
      >
        <label>
          名称
          <input
            aria-label="新底图名称"
            ref={nameInput}
            autoFocus
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          XYZ 地址
          <input
            aria-label="XYZ 瓦片地址"
            type="text"
            placeholder="https://example.com/{z}/{x}/{y}.png"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label>
          来源说明
          <input
            aria-label="底图来源说明"
            maxLength={300}
            value={attribution}
            onChange={(event) => setAttribution(event.target.value)}
          />
        </label>
        {error && (
          <p className="warning" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit">添加</button>
        </div>
      </form>
    </dialog>
  );
}

export default function SettingsPage(props: Props) {
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const [removed, setRemoved] = useState<{
    service: BasemapService;
    index: number;
  } | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useEffect(() => {
    back.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      document
        .querySelector<HTMLButtonElement>(
          '.header-menus button[aria-label="设置"]',
        )
        ?.focus();
    };
  }, []);
  const selected = categories.find((item) => item.id === props.category)!;
  return (
    <main className="settings-page" aria-label="后台设置">
      <header className="settings-page-heading">
        <button
          ref={back}
          className="icon-button"
          aria-label="返回地图"
          title="返回地图"
          onClick={props.onClose}
        >
          <ArrowLeft />
        </button>
        <div>
          <h1>设置</h1>
        </div>
      </header>
      <div className="settings-page-body">
        <nav className="settings-page-nav" aria-label="设置分类">
          {categories.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={props.category === id ? "active" : "quiet"}
              aria-current={props.category === id ? "page" : undefined}
              onClick={() => props.onCategory(id)}
            >
              <Icon />
              {label}
            </button>
          ))}
        </nav>
        <section
          className="settings-page-content"
          aria-labelledby="settings-section-title"
        >
          <header>
            <h2 id="settings-section-title">{selected.label}</h2>
          </header>
          {props.error && (
            <p className="warning" role="alert">
              {props.error}
            </p>
          )}
          {props.category === "appearance" && (
            <div className="settings-fields">
              <label>
                <span>主题</span>
                <select
                  aria-label="主题"
                  value={props.theme}
                  onChange={(e) =>
                    props.onTheme(e.target.value as "light" | "dark")
                  }
                >
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                </select>
              </label>
            </div>
          )}
          {props.category === "map" && (
            <div className="map-settings-grid">
              <section
                className="map-display-settings"
                aria-labelledby="map-display-title"
              >
                <h3 id="map-display-title">地图显示</h3>
                <div className="map-display-fields">
                  <label>
                    <span>底图类型</span>
                    <select
                      aria-label="底图类型"
                      value={props.basemap}
                      onChange={(event) => props.onBasemap(event.target.value)}
                    >
                      {props.services.map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.name}
                        </option>
                      ))}
                      <option value="none">无底图</option>
                    </select>
                  </label>
                  <label className="checkbox-label map-annotation-toggle">
                    <input
                      aria-label="显示注记"
                      type="checkbox"
                      checked={props.annotations}
                      onChange={(event) =>
                        props.onAnnotations(event.target.checked)
                      }
                    />
                    显示注记
                  </label>
                  <label>
                    <span>天地图 tk</span>
                    <input
                      aria-label="天地图 tk"
                      type="password"
                      autoComplete="off"
                      value={props.tdtKey}
                      onChange={(event) => props.onTdtKey(event.target.value)}
                    />
                  </label>
                  {props.basemap.startsWith("tdt") && !props.tdtKey.trim() && (
                    <p className="warning">填写 tk 后可载入天地图。</p>
                  )}
                </div>
              </section>
              <section className="basemap-settings" aria-label="底图服务管理">
                <header className="basemap-settings-heading">
                  <h3>
                    底图服务{" "}
                    <span className="count">{props.services.length}</span>
                  </h3>
                  <button ref={addButton} onClick={() => setAdding(true)}>
                    <Plus />
                    添加底图
                  </button>
                </header>
                <ol className="basemap-service-list">
                  {props.services.map((service, index) => (
                    <li key={service.id}>
                      <div className="basemap-service-name">
                        <strong title={service.name}>{service.name}</strong>
                        <span className="basemap-service-badge">
                          {service.url ? "XYZ" : "内置"}
                        </span>
                      </div>
                      <div className="basemap-service-actions">
                        <button
                          className="icon-button"
                          aria-label={`上移 ${service.name}`}
                          title="上移"
                          disabled={index === 0}
                          onClick={() =>
                            props.onServices(
                              moveBasemap(props.services, service.id, -1),
                            )
                          }
                        >
                          <ArrowUp />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`下移 ${service.name}`}
                          title="下移"
                          disabled={index === props.services.length - 1}
                          onClick={() =>
                            props.onServices(
                              moveBasemap(props.services, service.id, 1),
                            )
                          }
                        >
                          <ArrowDown />
                        </button>
                        {service.url && (
                          <button
                            className="icon-button"
                            aria-label={`删除 ${service.name}`}
                            title="删除"
                            onClick={() => {
                              setRemoved({ service, index });
                              props.onServices(
                                props.services.filter(
                                  (item) => item.id !== service.id,
                                ),
                              );
                            }}
                          >
                            <Trash2 />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
                {removed && (
                  <p className="basemap-undo" role="status">
                    已移除 {removed.service.name}
                    <button
                      className="quiet"
                      onClick={() => {
                        const next = [...props.services];
                        next.splice(
                          Math.min(removed.index, next.length),
                          0,
                          removed.service,
                        );
                        props.onServices(next);
                        setRemoved(null);
                      }}
                    >
                      撤销
                    </button>
                  </p>
                )}
              </section>
              {adding && (
                <BasemapAddDialog
                  returnFocus={addButton.current}
                  onAdd={(service) =>
                    props.onServices([...props.services, service])
                  }
                  onClose={() => setAdding(false)}
                />
              )}
            </div>
          )}
          {props.category === "mcp" &&
            (desktop ? (
              <McpPanel />
            ) : (
              <p className="form-note">
                空间分析 MCP 仅在 Windows 桌面版中提供。
              </p>
            ))}
          {props.category === "about" && (
            <div className="settings-about">
              <h3>
                zGIS <span>0.1.0</span>
              </h3>
              <dl className="summary-list">
                <dt>格式</dt>
                <dd>GeoJSON / CSV / SHP</dd>
                <dt>来源坐标系</dt>
                <dd>EPSG:4326 / 4490 / 3857（默认 4326）</dd>
                <dt>高程</dt>
                <dd>保留 XYZ，新绘制要素默认 Z=0</dd>
                <dt>工作副本</dt>
                <dd>自动保存，不覆盖源文件</dd>
              </dl>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
