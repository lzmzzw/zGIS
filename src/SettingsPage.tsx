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
  {
    id: "appearance",
    label: "外观",
    icon: Palette,
    description: "主题与界面显示",
  },
  { id: "map", label: "地图", icon: Map, description: "底图、注记与服务配置" },
  {
    id: "mcp",
    label: "空间分析 MCP",
    icon: Plug,
    description: "本机服务与外部文件访问",
  },
  {
    id: "about",
    label: "关于",
    icon: Info,
    description: "应用信息与数据处理规则",
  },
] as const;
export default function SettingsPage(props: Props) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [attribution, setAttribution] = useState("");
  const [serviceError, setServiceError] = useState("");
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
          '.header-actions button[aria-label="设置"]',
        )
        ?.focus();
    };
  }, []);
  const selected = categories.find((item) => item.id === props.category)!;
  return (
    <main className="settings-page" aria-label="后台设置">
      <header className="settings-page-heading">
        <button ref={back} className="quiet" onClick={props.onClose}>
          <ArrowLeft size={16} />
          返回地图
        </button>
        <div>
          <h1>设置</h1>
          <p>集中管理应用外观、地图和本机服务。</p>
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
              <Icon size={16} />
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
            <p>{selected.description}</p>
          </header>
          {props.error && (
            <p className="warning" role="alert">
              {props.error}
            </p>
          )}
          {props.category === "appearance" && (
            <div className="settings-fields">
              <label>
                <span>
                  主题<small>即时生效，下次启动保留选择。</small>
                </span>
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
            <div className="settings-fields">
              <label>
                <span>
                  底图类型<small>用于当前地图的背景显示。</small>
                </span>
                <select
                  aria-label="底图类型"
                  value={props.basemap}
                  onChange={(e) => props.onBasemap(e.target.value)}
                >
                  {props.services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                  <option value="none">无底图</option>
                </select>
              </label>
              {
                <>
                  <label>
                    <span>
                      注记<small>叠加地名与道路标注。</small>
                    </span>
                    <span className="checkbox-label">
                      <input
                        aria-label="显示注记"
                        type="checkbox"
                        checked={props.annotations}
                        onChange={(e) => props.onAnnotations(e.target.checked)}
                      />
                      显示注记
                    </span>
                  </label>
                  <label>
                    <span>
                      天地图 tk<small>保存在本机，下次启动继续使用。</small>
                    </span>
                    <input
                      aria-label="天地图 tk"
                      type="password"
                      autoComplete="off"
                      value={props.tdtKey}
                      onChange={(e) => props.onTdtKey(e.target.value)}
                    />
                  </label>
                  {props.basemap.startsWith("tdt") && !props.tdtKey.trim() && (
                    <p className="warning">填写 tk 后可载入天地图。</p>
                  )}
                </>
              }
              <section className="basemap-settings" aria-label="底图服务管理">
                <h3>底图服务</h3>
                <p className="form-note">顺序同步到地图中的底图选项。</p>
                <ol className="basemap-service-list">
                  {props.services.map((service, index) => (
                    <li key={service.id}>
                      <div>
                        <strong>{service.name}</strong>
                        <small>
                          {service.url ? "XYZ 瓦片服务" : service.type}
                        </small>
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
                          <ArrowUp size={15} />
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
                          <ArrowDown size={15} />
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
                            <Trash2 size={15} />
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
                <form
                  className="basemap-add-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!name.trim()) {
                      setServiceError("请输入底图名称。");
                      return;
                    }
                    if (!validateXyzUrl(url.trim())) {
                      setServiceError(
                        "请输入包含 {z}、{x}、{y} 的 HTTP(S) XYZ 瓦片地址。",
                      );
                      return;
                    }
                    props.onServices([
                      ...props.services,
                      {
                        id: `xyz-${crypto.randomUUID()}`,
                        name: name.trim(),
                        type: "XYZ 瓦片服务",
                        preview: "street",
                        url: url.trim(),
                        attribution: attribution.trim(),
                      },
                    ]);
                    setName("");
                    setUrl("");
                    setAttribution("");
                    setServiceError("");
                  }}
                >
                  <h3>添加底图</h3>
                  <label>
                    名称
                    <input
                      aria-label="新底图名称"
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
                  {serviceError && (
                    <p className="warning" role="alert">
                      {serviceError}
                    </p>
                  )}
                  <button type="submit">添加底图</button>
                </form>
              </section>
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
              <p>轻量地理数据查看与编辑器</p>
              <dl className="summary-list">
                <dt>来源坐标系</dt>
                <dd>EPSG:4326 / 4490 / 3857，未指定时默认 4326</dd>
                <dt>高程</dt>
                <dd>WKT / GeoJSON 保留 XYZ；新绘制要素默认 Z=0</dd>
                <dt>工作副本</dt>
                <dd>图层操作自动保存为工作副本，不覆盖源文件。</dd>
              </dl>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
