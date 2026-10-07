import { useEffect, useRef, useState } from "react";
import { Map as MapIcon, Check, X } from "lucide-react";
import "./basemap-control.css";
import { availableBasemaps, type BasemapService } from "./basemaps";
import { previewTileUrl } from "./basemap-preview";
interface Props {
  services: BasemapService[];
  value: string;
  visible: boolean;
  onChange(value: string): void;
  onVisible(visible: boolean): void;
}
function BasemapPreview({
  service,
  selected,
}: {
  service: BasemapService;
  selected: boolean;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const tileUrl = previewTileUrl(service);
  const source = service.previewImage?.startsWith("data:image/png;base64,")
    ? service.previewImage
    : tileUrl && /^https?:\/\//i.test(tileUrl)
      ? tileUrl
      : undefined;
  return (
    <span className="basemap-preview" aria-hidden="true">
      {source && failedSource !== source ? (
        <img
          src={source}
          alt=""
          aria-hidden="true"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <MapIcon className="basemap-preview-placeholder" />
      )}
      {selected && (
        <span className="basemap-check">
          <Check />
        </span>
      )}
    </span>
  );
}
export default function BasemapControl(props: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const available = availableBasemaps(props.services);
  return (
    <div ref={root} className="basemap-control">
      {open && (
        <section
          id="basemap-services"
          className="basemap-popover"
          aria-label="底图服务"
        >
          <header>
            <h2>底图</h2>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={props.visible}
                onChange={(e) => props.onVisible(e.target.checked)}
              />
              显示底图
            </label>
            <button
              className="icon-button"
              aria-label="关闭底图面板"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X />
            </button>
          </header>
          <div
            role="radiogroup"
            aria-label="底图服务选择"
            className="basemap-cards"
          >
            {available.map((service) => (
              <label
                className={`basemap-card ${props.value === service.id ? "selected" : ""}`}
                key={service.id}
              >
                <input
                  type="radio"
                  name="basemap-service"
                  aria-label={service.name}
                  value={service.id}
                  checked={props.value === service.id}
                  onChange={() => props.onChange(service.id)}
                />
                <BasemapPreview
                  service={service}
                  selected={props.value === service.id}
                />
                <strong>{service.name}</strong>
              </label>
            ))}
          </div>
          <p className="basemap-source">
            {props.services.find((service) => service.id === props.value)
              ?.attribution === "© OpenStreetMap contributors" ? (
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
              >
                © OpenStreetMap contributors
              </a>
            ) : (
              (props.services.find((service) => service.id === props.value)
                ?.attribution ?? "")
            )}
          </p>
          {!available.length && <p className="form-note">暂无可显示的底图</p>}
        </section>
      )}
      <button
        ref={trigger}
        className={`basemap-toggle ${open ? "active" : ""}`}
        aria-label="底图"
        title="底图"
        aria-expanded={open}
        aria-controls="basemap-services"
        onClick={() => setOpen((v) => !v)}
      >
        <MapIcon />
      </button>
    </div>
  );
}
