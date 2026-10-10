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
  Pencil,
} from "lucide-react";
import McpPanel from "./McpPanel";
import AboutSettings from "./AboutSettings";
import { desktop } from "./bridge";
import { moveBasemap, validateXyzUrl, type BasemapService } from "./basemaps";
import { createBasemapPreview } from "./basemap-preview";
import "./basemap-settings.css";

export type SettingsCategory = "appearance" | "map" | "mcp" | "about";
interface Props {
  services: BasemapService[];
  onServices: (services: BasemapService[]) => void;
  category: SettingsCategory;
  onCategory: (value: SettingsCategory) => void;
  theme: "light" | "dark";
  onTheme: (value: "light" | "dark") => void;
  error: string;
  onClose: () => void;
}
const categories = [
  { id: "appearance", label: "外观", icon: Palette },
  { id: "map", label: "地图", icon: Map },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "about", label: "关于", icon: Info },
] as const;

function BasemapServiceDialog({
  service,
  onSave,
  onClose,
  onPreviewError,
  returnFocus,
}: {
  service?: BasemapService;
  onSave: (service: BasemapService) => void;
  onClose: () => void;
  onPreviewError: (message: string) => void;
  returnFocus: HTMLButtonElement | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(service?.name ?? "");
  const [url, setUrl] = useState(service?.url ?? "");
  const [attribution, setAttribution] = useState(service?.attribution ?? "");
  const [enabled, setEnabled] = useState(service?.enabled !== false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    nameInput.current?.focus();
    return () => {
      request.current?.abort();
      element?.close();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);
  const cancel = () => {
    request.current?.abort();
    onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="modal basemap-add-dialog"
      aria-label={service ? "编辑底图" : "添加底图"}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <header>
        <h2>{service ? "编辑底图" : "添加底图"}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭"
          title="关闭"
          onClick={cancel}
        >
          <X />
        </button>
      </header>
      <form
        className="basemap-add-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (request.current) return;
          if (!name.trim()) {
            setError("请输入底图名称。");
            return;
          }
          if (!validateXyzUrl(url.trim())) {
            setError("XYZ 地址须为 HTTP(S)，并包含 {z}、{x}、{y}。");
            return;
          }
          const controller = new AbortController();
          request.current = controller;
          setError("");
          setSaving(true);
          let previewImage =
            service?.url?.trim() === url.trim()
              ? service?.previewImage
              : undefined;
          let previewError = "";
          try {
            previewImage = await createBasemapPreview(
              url.trim(),
              service?.maxZoom,
              controller.signal,
            );
          } catch {
            if (controller.signal.aborted) return;
            previewError = `${name.trim()} 已保存，预览暂不可用。`;
          }
          if (controller.signal.aborted) return;
          onPreviewError(previewError);
          onSave({
            ...(service ?? {
              id: `xyz-${crypto.randomUUID()}`,
              type: "XYZ 瓦片服务",
              preview: "street" as const,
            }),
            name: name.trim(),
            url: url.trim(),
            attribution: attribution.trim(),
            enabled,
            previewImage,
          });
          onClose();
        }}
      >
        <label>
          名称
          <input
            aria-label={service ? "底图名称" : "新底图名称"}
            ref={nameInput}
            autoFocus
            disabled={saving}
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
            disabled={saving}
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
            disabled={saving}
            value={attribution}
            onChange={(event) => setAttribution(event.target.value)}
          />
        </label>
        <label className="checkbox-label basemap-enabled-toggle">
          <input
            aria-label="在地图中显示"
            type="checkbox"
            disabled={saving}
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          在地图中显示
        </label>
        {error && (
          <p className="warning" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={cancel}>
            取消
          </button>
          <button type="submit" disabled={saving}>
            {saving ? "获取预览…" : service ? "保存" : "添加"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function SettingsPage(props: Props) {
  const [previewError, setPreviewError] = useState("");
  const [serviceDialog, setServiceDialog] = useState<{
    service?: BasemapService;
    returnFocus: HTMLButtonElement | null;
  } | null>(null);
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
            <section className="basemap-settings" aria-label="底图服务管理">
              <header className="basemap-settings-heading">
                <h3>底图服务</h3>
                <button
                  ref={addButton}
                  onClick={(event) =>
                    setServiceDialog({ returnFocus: event.currentTarget })
                  }
                >
                  <Plus />
                  添加底图
                </button>
              </header>
              <ol className="basemap-service-list">
                {props.services.map((service, index) => (
                  <li key={service.id}>
                    <div className="basemap-service-name">
                      <strong title={service.name}>{service.name}</strong>
                      {service.enabled === false && (
                        <span className="basemap-service-badge">已隐藏</span>
                      )}
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
                      <button
                        className="icon-button"
                        aria-label={`编辑 ${service.name}`}
                        title="编辑"
                        onClick={(event) =>
                          setServiceDialog({
                            service,
                            returnFocus: event.currentTarget,
                          })
                        }
                      >
                        <Pencil />
                      </button>
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
                    </div>
                  </li>
                ))}
              </ol>
              {props.services.length === 0 && (
                <p className="basemap-empty">暂无底图服务</p>
              )}
              {previewError && (
                <p className="warning basemap-preview-warning" role="status">
                  {previewError}
                </p>
              )}
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
              {serviceDialog && (
                <BasemapServiceDialog
                  service={serviceDialog.service}
                  returnFocus={serviceDialog.returnFocus}
                  onSave={(service) =>
                    props.onServices(
                      serviceDialog.service
                        ? props.services.map((item) =>
                            item.id === service.id ? service : item,
                          )
                        : [...props.services, service],
                    )
                  }
                  onClose={() => setServiceDialog(null)}
                  onPreviewError={setPreviewError}
                />
              )}
            </section>
          )}
          {props.category === "mcp" &&
            (desktop ? (
              <McpPanel />
            ) : (
              <p className="form-note">MCP 仅在桌面版中提供。</p>
            ))}
          {props.category === "about" && <AboutSettings />}
        </section>
      </div>
    </main>
  );
}
