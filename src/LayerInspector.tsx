import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { DocumentLayer } from "./domain/types";
import {
  CategorizedStyleControls,
  LabelStyleControls,
} from "./LayerDisplayControls";
import {
  isDisplayNumber,
  normalizeCategorizedStyle,
  normalizeGraduatedStyle,
  normalizeLayerLabels,
} from "./layerDisplay";
import { t, useLocale } from "./i18n";
import "./layer-inspector.css";
import LayerLegend from "./LayerLegend";
import { GeometryStyleControls } from "./GeometryStyleControls";

export type LayerDisplayPatch = Pick<
  DocumentLayer,
  | "color"
  | "fillColor"
  | "strokeColor"
  | "fillOpacity"
  | "pointRadius"
  | "linePattern"
  | "opacity"
  | "strokeWidth"
  | "categorizedStyle"
  | "graduatedStyle"
  | "labels"
>;
export interface LayerInspectorProps {
  layer: DocumentLayer;
  disabled?: boolean;
  onPreview: (patch: LayerDisplayPatch | undefined) => void;
  onApply: (patch: LayerDisplayPatch) => void;
  onClose: () => void;
}
export function layerDisplayPatch(layer: DocumentLayer): LayerDisplayPatch {
  return structuredClone({
    color: layer.color,
    fillColor: layer.fillColor,
    strokeColor: layer.strokeColor,
    fillOpacity: layer.fillOpacity ?? 36 / 255,
    pointRadius: layer.pointRadius ?? 5,
    linePattern: layer.linePattern ?? "solid",
    opacity: layer.opacity ?? 1,
    strokeWidth: layer.strokeWidth,
    categorizedStyle: layer.categorizedStyle,
    graduatedStyle: layer.graduatedStyle,
    labels: layer.labels,
  });
}
export function validateLayerDisplayPatch(
  layer: DocumentLayer,
  patch: LayerDisplayPatch,
): string | undefined {
  if (
    !/^#[\da-f]{6}$/i.test(patch.color) ||
    (patch.fillColor !== undefined &&
      !/^#[\da-f]{6}$/i.test(patch.fillColor)) ||
    (patch.strokeColor !== undefined &&
      !/^#[\da-f]{6}$/i.test(patch.strokeColor)) ||
    !Number.isFinite(patch.opacity) ||
    patch.opacity! < 0 ||
    patch.opacity! > 1 ||
    !Number.isFinite(patch.fillOpacity) ||
    patch.fillOpacity! < 0 ||
    patch.fillOpacity! > 1 ||
    !Number.isFinite(patch.pointRadius) ||
    patch.pointRadius! < 2 ||
    patch.pointRadius! > 16 ||
    (patch.strokeWidth !== undefined &&
      (!Number.isFinite(patch.strokeWidth) ||
        patch.strokeWidth < 0 ||
        patch.strokeWidth > 8)) ||
    !["solid", "dashed", "dotted"].includes(patch.linePattern ?? "solid")
  )
    return "颜色、透明度或线宽无效";
  if (patch.categorizedStyle && patch.graduatedStyle)
    return "分类与分级样式不能同时启用";
  if (
    (patch.categorizedStyle &&
      !normalizeCategorizedStyle(patch.categorizedStyle)) ||
    (patch.graduatedStyle && !normalizeGraduatedStyle(patch.graduatedStyle)) ||
    (patch.labels && !normalizeLayerLabels(patch.labels))
  )
    return "样式配置无效，请检查字段与参数";
  const exists = (field: string) =>
    layer.fieldNames?.includes(field) ||
    layer.features.some((feature) => Object.hasOwn(feature.properties, field));
  for (const value of [
    patch.categorizedStyle,
    patch.graduatedStyle,
    patch.labels,
  ]) {
    if (value && !exists(value.field))
      return "样式引用的字段已不存在，请重新选择";
  }
  if (
    patch.graduatedStyle &&
    !layer.features.some(
      (feature) =>
        Object.hasOwn(feature.properties, patch.graduatedStyle!.field) &&
        isDisplayNumber(feature.properties[patch.graduatedStyle!.field]),
    )
  )
    return "分级字段没有安全数值，请重新选择";
}

export function LayerInspector({
  layer,
  disabled = false,
  onPreview,
  onApply,
  onClose,
}: LayerInspectorProps) {
  useLocale();
  const [draft, setDraft] = useState(() => layerDisplayPatch(layer));
  const [actionError, setActionError] = useState("");
  const baseline = useMemo(
    () => layerDisplayPatch(layer),
    [
      layer.color,
      layer.fillColor,
      layer.strokeColor,
      layer.fillOpacity,
      layer.pointRadius,
      layer.linePattern,
      layer.opacity,
      layer.strokeWidth,
      layer.categorizedStyle,
      layer.graduatedStyle,
      layer.labels,
    ],
  );
  const signature = JSON.stringify(baseline);
  const lastSignature = useRef(signature);
  const preview = useRef(onPreview);
  useEffect(() => {
    preview.current = onPreview;
  }, [onPreview]);
  // 别处修改显示设置时，旧草稿不得覆盖新的设置；数据变化不重置草稿。
  const current = lastSignature.current === signature ? draft : baseline;
  const dirty = JSON.stringify(current) !== signature;
  const validationError = useMemo(
    () => validateLayerDisplayPatch(layer, current),
    [layer, current],
  );
  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature;
      setDraft(baseline);
      setActionError("");
    }
  }, [signature, baseline]);
  useEffect(() => {
    preview.current(
      dirty && !validationError && !disabled ? current : undefined,
    );
  }, [current, dirty, validationError, disabled]);
  useEffect(
    () => () => {
      preview.current(undefined);
    },
    [],
  );
  const change = (patch: Partial<LayerDisplayPatch>) => {
    setActionError("");
    setDraft({ ...current, ...patch });
  };
  const close = () => {
    preview.current(undefined);
    onClose();
  };
  return (
    <aside
      className="layer-inspector"
      aria-label={t("图层检查器")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="layer-inspector-header">
        <div>
          <strong title={layer.displayName ?? layer.name}>
            {layer.displayName ?? layer.name}
          </strong>
          {dirty && <span>{t("预览中")}</span>}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={close}
          title={t("关闭检查器")}
          aria-label={t("关闭检查器")}
        >
          <X size={16} />
        </button>
      </header>
      <div className="layer-inspector-scroll" aria-label={t("图层样式")}>
        <div className="layer-inspector-style">
          <GeometryStyleControls
            layer={layer}
            value={current}
            disabled={disabled}
            onChange={change}
          />
          <fieldset disabled={disabled} className="layer-inspector-controls">
            <legend className="sr-only">{t("着色与标注")}</legend>
            <CategorizedStyleControls
              layer={{ ...layer, ...current }}
              value={current.categorizedStyle}
              graduatedValue={current.graduatedStyle}
              onChange={(categorizedStyle, graduatedStyle) => {
                const starting =
                  !current.categorizedStyle &&
                  !current.graduatedStyle &&
                  Boolean(categorizedStyle || graduatedStyle);
                change({
                  categorizedStyle,
                  graduatedStyle,
                  strokeColor: current.strokeColor ?? current.color,
                  ...(starting
                    ? {
                        fillOpacity: Math.max(current.fillOpacity ?? 0, 0.7),
                        opacity: Math.max(current.opacity ?? 1, 0.7),
                      }
                    : {}),
                });
              }}
            />
            <LabelStyleControls
              layer={layer}
              value={current.labels}
              onChange={(labels) => change({ labels })}
            />
          </fieldset>
          <LayerLegend layer={{ ...layer, ...current }} defaultOpen />
        </div>
        {(actionError || validationError) && (
          <p className="layer-inspector-error" role="alert">
            {t(actionError || validationError)}
          </p>
        )}
      </div>
      <footer className="layer-inspector-actions">
        <button type="button" onClick={close}>
          {t("取消")}
        </button>
        <button
          type="button"
          disabled={
            disabled ||
            !dirty ||
            Boolean(validationError) ||
            Boolean(actionError)
          }
          onClick={() => {
            if (!validationError && !disabled) {
              onApply(structuredClone(current));
              preview.current(undefined);
            }
          }}
        >
          {t("应用样式")}
        </button>
      </footer>
    </aside>
  );
}
