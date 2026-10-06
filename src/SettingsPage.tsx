import { useEffect, useRef } from "react";
import { ArrowLeft, Palette, Map, Plug, Info } from "lucide-react";
import McpPanel from "./McpPanel";
import { desktop } from "./bridge";

export type SettingsCategory = "appearance" | "map" | "mcp" | "about";
interface Props {
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
                  <option value="osm">OpenStreetMap</option>
                  <option value="tdt-vec">天地图 · 矢量</option>
                  <option value="tdt-img">天地图 · 影像</option>
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
                      天地图 tk<small>仅在本次运行保留。</small>
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
                <dd>编辑不会自动覆盖源文件；退出时可保存或保留恢复副本。</dd>
              </dl>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
