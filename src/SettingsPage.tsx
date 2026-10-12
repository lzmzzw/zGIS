import { t, useLocale } from "./i18n";
import { useEffect, useId, useRef, useState } from "react";
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
  onInstallUpdate: (version: string) => void;
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
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [name, setName] = useState(service?.name ?? "");
  const [url, setUrl] = useState(service?.url ?? "");
  const [attribution, setAttribution] = useState(service?.attribution ?? "");
  const [enabled, setEnabled] = useState(service?.enabled !== false);
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState<"name" | "url" | null>(null);
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
      aria-label={service ? t("编辑底图") : t("添加底图")}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <header>
        <h2>{service ? t("编辑底图") : t("添加底图")}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={t("关闭")}
          title={t("关闭")}
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
            setInvalidField("name");
            nameInput.current?.focus();
            return;
          }
          if (!validateXyzUrl(url.trim())) {
            setError("XYZ 地址须为 HTTP(S)，并包含 {z}、{x}、{y}。");
            setInvalidField("url");
            urlInput.current?.focus();
            return;
          }
          const controller = new AbortController();
          request.current = controller;
          setError("");
          setInvalidField(null);
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
        <label>{t("名称")}<input
            aria-label={service ? t("底图名称") : t("新底图名称")}
            ref={nameInput}
            aria-invalid={invalidField === "name" || undefined}
            aria-describedby={invalidField === "name" ? errorId : undefined}
            autoFocus
            disabled={saving}
            maxLength={100}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (invalidField === "name") {
                setInvalidField(null);
                setError("");
              }
            }}
          />
        </label>
        <label>{t("XYZ 地址")}<input
            aria-label={t("XYZ 瓦片地址")}
            ref={urlInput}
            aria-invalid={invalidField === "url" || undefined}
            aria-describedby={invalidField === "url" ? errorId : undefined}
            type="text"
            disabled={saving}
            placeholder="https://example.com/{z}/{x}/{y}.png"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (invalidField === "url") {
                setInvalidField(null);
                setError("");
              }
            }}
          />
        </label>
        <label>{t("来源说明")}<input
            aria-label={t("底图来源说明")}
            maxLength={300}
            disabled={saving}
            value={attribution}
            onChange={(event) => setAttribution(event.target.value)}
          />
        </label>
        <label className="checkbox-label basemap-enabled-toggle">
          <input
            aria-label={t("在地图中显示")}
            type="checkbox"
            disabled={saving}
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />{t("在地图中显示")}</label>
        {error && (
          <p id={errorId} className="warning" role="alert">
            {t(error)}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={cancel}>{t("取消")}</button>
          <button type="submit" disabled={saving}>
            {saving ? t("获取预览…") : service ? t("保存") : t("添加")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function SettingsPage(props: Props) {
  const { locale, setLocale } = useLocale();
  const [previewError, setPreviewError] = useState("");
  const [serviceDialog, setServiceDialog] = useState<{
    service?: BasemapService;
    returnFocus: HTMLButtonElement | null;
  } | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const serviceButtons = useRef(
    new globalThis.Map<string, HTMLButtonElement>(),
  );
  const pendingFocus = useRef<string | "undo" | null>(null);
  const [removed, setRemoved] = useState<{
    service: BasemapService;
    index: number;
  } | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    (target === "undo"
      ? undoButton.current
      : (serviceButtons.current.get(target) ?? addButton.current)
    )?.focus();
  }, [props.services, removed]);
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
          '#settings-trigger',
        )
        ?.focus();
    };
  }, []);
  const selected = categories.find((item) => item.id === props.category)!;
  return (
    <main className="settings-page" aria-label={t("后台设置")}>
      <header className="settings-page-heading">
        <button
          ref={back}
          className="icon-button"
          aria-label={t("返回地图")}
          title={t("返回地图")}
          onClick={props.onClose}
        >
          <ArrowLeft />
        </button>
        <div>
          <h1>{t("设置")}</h1>
        </div>
      </header>
      <div className="settings-page-body">
        <nav className="settings-page-nav" aria-label={t("设置分类")}>
          {categories.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={props.category === id ? "active" : "quiet"}
              aria-current={props.category === id ? "page" : undefined}
              onClick={() => props.onCategory(id)}
            >
              <Icon />
              {t(label)}
            </button>
          ))}
        </nav>
        <section
          className="settings-page-content"
          aria-labelledby="settings-section-title"
        >
          <header>
            <h2 id="settings-section-title">{t(selected.label)}</h2>
          </header>
          {props.error && (
            <p className="warning" role="alert">
              {t(props.error)}
            </p>
          )}
          {props.category === "appearance" && (
            <div className="settings-fields">
              <label>
                <span>{t("语言")}</span>
                <select aria-label={t("界面语言")} value={locale}
                  onChange={(event) => setLocale(event.target.value === "en" ? "en" : "zh-CN")}>
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label>
                <span>{t("主题")}</span>
                <select
                  aria-label={t("主题")}
                  value={props.theme}
                  onChange={(e) =>
                    props.onTheme(e.target.value as "light" | "dark")
                  }
                >
                  <option value="dark">{t("深色")}</option>
                  <option value="light">{t("浅色")}</option>
                </select>
              </label>
            </div>
          )}
          {props.category === "map" && (
            <section className="basemap-settings" aria-label={t("底图服务管理")}>
              <header className="basemap-settings-heading">
                <h3>{t("底图服务")}</h3>
                <button
                  ref={addButton}
                  onClick={(event) =>
                    setServiceDialog({ returnFocus: event.currentTarget })
                  }
                >
                  <Plus />{t("添加底图")}</button>
              </header>
              <ol className="basemap-service-list">
                {props.services.map((service, index) => (
                  <li key={service.id}>
                    <div className="basemap-service-name">
                      <strong title={service.name}>{service.name}</strong>
                      {service.enabled === false && (
                        <span className="basemap-service-badge">{t("已隐藏")}</span>
                      )}
                    </div>
                    <div className="basemap-service-actions">
                      <button
                        className="icon-button"
                        aria-label={t(`上移 ${service.name}`)}
                        title={t("上移")}
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
                        aria-label={t(`下移 ${service.name}`)}
                        title={t("下移")}
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
                        aria-label={t(`编辑 ${service.name}`)}
                        ref={(element) => {
                          if (element)
                            serviceButtons.current.set(service.id, element);
                          else serviceButtons.current.delete(service.id);
                        }}
                        title={t("编辑")}
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
                        aria-label={t(`删除 ${service.name}`)}
                        title={t("删除")}
                        onClick={() => {
                          pendingFocus.current = "undo";
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
                <p className="basemap-empty">{t("暂无底图服务")}</p>
              )}
              {previewError && (
                <p className="warning basemap-preview-warning" role="status">
                  {t(previewError)}
                </p>
              )}
              {removed && (
                <p className="basemap-undo" role="status">{t("已移除 ")}{removed.service.name}
                  <button
                    ref={undoButton}
                    className="quiet"
                    onClick={() => {
                      pendingFocus.current = removed.service.id;
                      const next = [...props.services];
                      next.splice(
                        Math.min(removed.index, next.length),
                        0,
                        removed.service,
                      );
                      props.onServices(next);
                      setRemoved(null);
                    }}
                  >{t("撤销")}</button>
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
              <p className="form-note">{t("MCP 仅在桌面版中提供。")}</p>
            ))}
          {props.category === "about" && (
            <AboutSettings onInstall={props.onInstallUpdate} />
          )}
        </section>
      </div>
    </main>
  );
}
