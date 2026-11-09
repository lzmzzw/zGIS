import type { DocumentLayer } from "./domain/types";
import { useMemo } from "react";
import type { LayerDisplayPatch } from "./LayerInspector";
import { layerGeometryKinds } from "./geometryStyle";
import { t } from "./i18n";

function RangeControl({
  label,
  value,
  min = 0,
  max,
  step = 1,
  unit = "px",
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="symbol-range">
      <span>{label}</span>
      <output>
        {value}
        {unit === "%" ? "%" : ` ${unit}`}
      </output>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function GeometryStyleControls({
  layer,
  value,
  disabled,
  onChange,
}: {
  layer: DocumentLayer;
  value: LayerDisplayPatch;
  disabled: boolean;
  onChange: (patch: Partial<LayerDisplayPatch>) => void;
}) {
  const kinds = useMemo(
    () => layerGeometryKinds(layer),
    [layer.features, layer.geometryType],
  );
  const point = kinds.includes("point"),
    line = kinds.includes("line"),
    polygon = kinds.includes("polygon");
  const themed = Boolean(value.categorizedStyle || value.graduatedStyle);
  const fill = (color: string) =>
    onChange({
      fillColor: color,
      // Preserve the independent border when editing legacy single-color layers.
      strokeColor: value.strokeColor ?? value.color,
      ...(!line ? { color } : {}),
    });
  return (
    <fieldset disabled={disabled} className="layer-inspector-base">
      <legend>{t("符号")}</legend>
      {(point || polygon) && (
        <>
          <label>
            <span>{t("填充颜色")}</span>
            <input
              type="color"
              aria-label={t("填充颜色")}
              disabled={themed}
              title={themed ? t("颜色由分类或分级控制") : undefined}
              value={value.fillColor ?? value.color}
              onChange={(event) => fill(event.target.value)}
            />
          </label>
          {polygon && (
            <RangeControl
              label={t("填充不透明度")}
              value={Math.round((value.fillOpacity ?? 36 / 255) * 100)}
              max={100}
              unit="%"
              onChange={(fillOpacity) =>
                onChange({ fillOpacity: fillOpacity / 100 })
              }
            />
          )}
          <label>
            <span>{t("边框颜色")}</span>
            <input
              type="color"
              aria-label={t("边框颜色")}
              value={value.strokeColor ?? value.color}
              onChange={(event) =>
                onChange({ strokeColor: event.target.value })
              }
            />
          </label>
        </>
      )}
      {(line || !kinds.length) && (
        <label>
          <span>{t("线条颜色")}</span>
          <input
            type="color"
            aria-label={t("线条颜色")}
            disabled={themed}
            title={themed ? t("颜色由分类或分级控制") : undefined}
            value={value.color}
            onChange={(event) =>
              onChange({
                color: event.target.value,
                ...(point || polygon
                  ? {
                      fillColor: value.fillColor ?? value.color,
                      strokeColor: value.strokeColor ?? value.color,
                    }
                  : {}),
              })
            }
          />
        </label>
      )}
      {point && (
        <RangeControl
          label={t("点直径")}
          value={(value.pointRadius ?? 5) * 2}
          min={4}
          max={32}
          onChange={(diameter) => onChange({ pointRadius: diameter / 2 })}
        />
      )}
      <RangeControl
        label={t(
          line ? (polygon || point ? "线条与边框宽度" : "线宽") : "边框宽度",
        )}
        value={value.strokeWidth ?? (point && !line && !polygon ? 1 : 2)}
        max={8}
        step={0.5}
        onChange={(strokeWidth) => onChange({ strokeWidth })}
      />
      {(line || polygon) && (
        <label>
          <span>{t("线型")}</span>
          <select
            aria-label={t("线型")}
            value={value.linePattern ?? "solid"}
            onChange={(event) =>
              onChange({
                linePattern: event.target.value as DocumentLayer["linePattern"],
              })
            }
          >
            <option value="solid">{t("实线")}</option>
            <option value="dashed">{t("虚线")}</option>
            <option value="dotted">{t("点线")}</option>
          </select>
        </label>
      )}
      <RangeControl
        label={t("图层不透明度")}
        value={Math.round((value.opacity ?? 1) * 100)}
        max={100}
        unit="%"
        onChange={(opacity) => onChange({ opacity: opacity / 100 })}
      />
    </fieldset>
  );
}
