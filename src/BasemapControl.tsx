import { useEffect, useRef, useState } from "react";
import { Map as MapIcon, Check, X } from "lucide-react";
import "./basemap-control.css";
import { isTdtService, type BasemapService } from "./basemaps";
interface Props {
  services: BasemapService[];
  value: string;
  visible: boolean;
  tdtConfigured: boolean;
  onChange(value: string): void;
  onVisible(visible: boolean): void;
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
  const available = props.services.filter(
    (s) => !isTdtService(s) || props.tdtConfigured,
  );
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
              <X size={15} />
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
                <span
                  className={`basemap-preview ${service.preview}`}
                  aria-hidden="true"
                >
                  <svg
                    viewBox="0 0 160 82"
                    preserveAspectRatio="xMidYMid slice"
                  >
                    <path className="land" d="M0 0h160v82H0z" />
                    <path
                      className="park"
                      d="m4 7 49-7 25 27-22 22L6 33ZM115 44l42-11 3 49h-59z"
                    />
                    <path
                      className="water"
                      d="M91-8c-25 27 8 29-9 50S51 72 73 94l18-5C61 70 119 49 101 32S85 19 108-3z"
                    />
                    <path
                      className="road"
                      d="M-5 56 165 20M25-8l89 98M-10 25l53 13 104 39M132-10 7 93"
                    />
                    <path
                      className="street-line"
                      d="m10 0 23 82m20-90 41 97m34-89 27 81M0 13l160 40M0 75 160 43"
                    />
                  </svg>
                  {props.value === service.id && (
                    <span className="basemap-check">
                      <Check size={13} />
                    </span>
                  )}
                </span>
                <strong>{service.name}</strong>
                <small>{service.type}</small>
              </label>
            ))}
          </div>
          <p className="basemap-source">
            {props.value === "osm" ? (
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
          {!props.tdtConfigured && (
            <p className="form-note">天地图服务需先在设置中配置 tk。</p>
          )}
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
        <MapIcon size={21} />
      </button>
    </div>
  );
}
