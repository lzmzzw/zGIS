import { useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { DocumentLayer } from "./domain/types";
import { FieldProfile } from "./FieldProfilePanel";
import {
  CategorizedStyleControls,
  LabelStyleControls,
} from "./LayerDisplayControls";
import {
  createGraduatedStyle,
  isDisplayNumber,
  normalizeCategorizedStyle,
  normalizeGraduatedStyle,
  normalizeLayerLabels,
} from "./layerDisplay";
import { t, useLocale } from "./i18n";
import "./layer-inspector.css";

export type LayerDisplayPatch = Pick<
  DocumentLayer,
  | "color"
  | "opacity"
  | "strokeWidth"
  | "categorizedStyle"
  | "graduatedStyle"
  | "labels"
>;
export interface LayerInspectorProps {
  layer: DocumentLayer;
  initialTab: "profile" | "style";
  initialField?: string;
  disabled?: boolean;
  onPreview: (patch: LayerDisplayPatch | undefined) => void;
  onApply: (patch: LayerDisplayPatch) => void;
  onClose: () => void;
}
export function layerDisplayPatch(layer: DocumentLayer): LayerDisplayPatch {
  return structuredClone({
    color: layer.color,
    opacity: layer.opacity ?? 1,
    strokeWidth: layer.strokeWidth ?? 2,
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
    !Number.isFinite(patch.opacity) ||
    patch.opacity! < 0 ||
    patch.opacity! > 1 ||
    !Number.isFinite(patch.strokeWidth) ||
    patch.strokeWidth! < 1 ||
    patch.strokeWidth! > 8
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
  initialTab,
  initialField,
  disabled = false,
  onPreview,
  onApply,
  onClose,
}: LayerInspectorProps) {
  useLocale();
  const id = useId();
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState(() => layerDisplayPatch(layer));
  const [actionError, setActionError] = useState("");
  const baseline = useMemo(
    () => layerDisplayPatch(layer),
    [
      layer.color,
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
  const graduate = (field: string) => {
    if (disabled) return;
    try {
      change({
        categorizedStyle: undefined,
        graduatedStyle: createGraduatedStyle(layer, field, "equal_interval", 5),
      });
      setTab("style");
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "无法创建分级样式",
      );
    }
  };
  return (
    <aside className="layer-inspector" aria-label={t("图层检查器")}>
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
      <div
        className="layer-inspector-tabs"
        role="tablist"
        aria-label={t("图层检查器")}
      >
        {(["profile", "style"] as const).map((value) => (
          <button
            type="button"
            key={value}
            role="tab"
            id={`${id}-${value}`}
            data-tab={value}
            aria-selected={tab === value}
            aria-controls={`${id}-content`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "profile"
                  : event.key === "End"
                    ? "style"
                    : value === "profile"
                      ? "style"
                      : "profile";
              setTab(next);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
                ?.focus();
            }}
          >
            {t(value === "profile" ? "字段概览" : "图层样式")}
          </button>
        ))}
      </div>
      <div
        className="layer-inspector-scroll"
        role="tabpanel"
        id={`${id}-content`}
        aria-labelledby={`${id}-${tab}`}
      >
        {tab === "profile" ? (
          <FieldProfile
            key={`${layer.id}:${initialField ?? ""}`}
            layer={layer}
            initialField={initialField}
            onGraduated={disabled ? undefined : graduate}
          />
        ) : (
          <div className="layer-inspector-style">
            <p className="layer-inspector-note">
              {t("修改即时预览；应用后保存显示设置，取消不改变图层。")}
            </p>
            <fieldset disabled={disabled} className="layer-inspector-base">
              <legend>{t("基础样式")}</legend>
              <label>
                <span>{t("颜色")}</span>
                <input
                  type="color"
                  aria-label={t("颜色")}
                  value={current.color}
                  onChange={(event) => change({ color: event.target.value })}
                />
              </label>
              <label>
                <span>{t("不透明度")}</span>
                <output>{Math.round((current.opacity ?? 1) * 100)}%</output>
                <input
                  type="range"
                  aria-label={t("不透明度")}
                  min="0"
                  max="1"
                  step="0.05"
                  value={current.opacity ?? 1}
                  onChange={(event) =>
                    change({ opacity: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                <span>{t("线宽")}</span>
                <output>{current.strokeWidth ?? 2} px</output>
                <input
                  type="range"
                  aria-label={t("线宽")}
                  min="1"
                  max="8"
                  step="1"
                  value={current.strokeWidth ?? 2}
                  onChange={(event) =>
                    change({ strokeWidth: Number(event.target.value) })
                  }
                />
              </label>
            </fieldset>
            <fieldset disabled={disabled} className="layer-inspector-controls">
              <legend className="sr-only">{t("着色与标注")}</legend>
              <CategorizedStyleControls
                layer={layer}
                value={current.categorizedStyle}
                graduatedValue={current.graduatedStyle}
                onChange={(categorizedStyle, graduatedStyle) =>
                  change({ categorizedStyle, graduatedStyle })
                }
              />
              <LabelStyleControls
                layer={layer}
                value={current.labels}
                onChange={(labels) => change({ labels })}
              />
            </fieldset>
          </div>
        )}
        {(actionError || validationError) && (
          <p className="layer-inspector-error" role="alert">
            {t(actionError || validationError)}
          </p>
        )}
      </div>
      {dirty && (
        <p className="layer-inspector-pending">{t("当前预览尚未应用")}</p>
      )}
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
