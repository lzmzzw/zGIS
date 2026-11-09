import { t, useLocale } from "./i18n";
import { useEffect, useId, useMemo, useState } from "react";
import { LayerSymbol } from "./LayerSymbol";
import { layerGeometryKinds, type GeometryKind } from "./geometryStyle";
import type {
  CategorizedStyle,
  DocumentLayer,
  LayerLabels,
  GraduatedStyle,
} from "./domain/types";
import {
  categoryKey,
  createCategorizedStyle,
  displayFields,
  createLayerLabels,
  createGraduatedStyle,
  graduatedRangeLabel,
  isDisplayNumber,
  parseManualBreaks,
} from "./layerDisplay";
import "./layer-display.css";

function SymbolColorInput({
  layer,
  kinds,
  value,
  label,
  onChange,
}: {
  layer: DocumentLayer;
  kinds: GeometryKind[];
  value: string;
  label: string;
  onChange: (color: string) => void;
}) {
  return (
    <span className="symbol-color-input" title={label}>
      <LayerSymbol layer={layer} kinds={kinds} color={value} />
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}

export function GraduatedStyleControls({
  layer,
  value,
  onChange,
}: {
  layer: DocumentLayer;
  value: GraduatedStyle;
  onChange: (value: GraduatedStyle) => void;
}) {
  useLocale();
  const fields = displayFields(layer);
  const kinds = useMemo(
    () => layerGeometryKinds(layer),
    [layer.features, layer.geometryType],
  );

  const [manual, setManual] = useState(value.breaks.join(", "));
  const manualId = useId();
  const [error, setError] = useState("");
  useEffect(() => {
    setManual(value.breaks.join(", "));
    setError("");
  }, [value.field, value.method, value.breaks]);
  const rebuild = (
    field: string,
    method: GraduatedStyle["method"],
    classes: number,
    breaks = value.breaks,
  ) => {
    try {
      onChange(createGraduatedStyle(layer, field, method, classes, breaks));
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  return (
    <>
      <label>
        <span>{t("分级字段")}</span>
        <select
          aria-label={t("分级字段")}
          value={value.field}
          onChange={(event) =>
            rebuild(event.target.value, value.method, value.colors.length)
          }
        >
          {!fields.includes(value.field) && (
            <option value={value.field}>{value.field}</option>
          )}
          {fields.map((field) => (
            <option key={field} value={field}>
              {field}
            </option>
          ))}
        </select>
      </label>
      {!fields.includes(value.field) && (
        <p role="status">
          {t("分级字段已不存在，暂用缺失颜色；可重新选择字段。")}
        </p>
      )}
      <label>
        <span>{t("分级方法")}</span>
        <select
          aria-label={t("分级方法")}
          value={value.method}
          onChange={(event) =>
            rebuild(
              value.field,
              event.target.value as GraduatedStyle["method"],
              value.colors.length,
            )
          }
        >
          <option value="equal_interval">{t("等间隔")}</option>
          <option value="quantile">{t("分位数")}</option>
          <option value="manual">{t("手动断点")}</option>
        </select>
      </label>
      {value.method !== "manual" ? (
        <label>
          <span>{t("分级数量")}</span>
          <select
            aria-label={t("分级数量")}
            value={value.colors.length}
            onChange={(event) =>
              rebuild(value.field, value.method, Number(event.target.value))
            }
          >
            {Array.from({ length: 32 }, (_, index) => (
              <option key={index} value={index + 1}>
                {index + 1}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label htmlFor={manualId}>{t("内部分割点")}</label>
          <textarea
            id={manualId}
            aria-label={t("内部分割点")}
            maxLength={4096}
            value={manual}
            onChange={(event) => setManual(event.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              try {
                const breaks = parseManualBreaks(manual);
                rebuild(value.field, "manual", breaks.length + 1, breaks);
              } catch (reason) {
                setError((reason as Error).message);
              }
            }}
          >
            {t("应用断点")}
          </button>
        </>
      )}
      {error && <p role="alert">{t(error)}</p>}
      <div
        className="layer-category-list"
        role="group"
        aria-label={t("分级颜色")}
      >
        {value.colors.map((color, index) => (
          <label key={index}>
            <span>{t(graduatedRangeLabel(value, index))}</span>
            <SymbolColorInput
              kinds={kinds}
              layer={layer}
              label={t("分级 {0} 颜色", index + 1)}
              value={color}
              onChange={(nextColor) =>
                onChange({
                  ...value,
                  colors: value.colors.map((old, i) =>
                    i === index ? nextColor : old,
                  ),
                })
              }
            />
          </label>
        ))}
        {(
          [
            ["otherColor", "非数值或超出安全范围"],
            ["nullColor", "空值（null）"],
            ["missingColor", "字段缺失"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <span>{t(label)}</span>
            <SymbolColorInput
              kinds={kinds}
              layer={layer}
              label={t(label)}
              value={value[key]}
              onChange={(color) => onChange({ ...value, [key]: color })}
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        onClick={() => rebuild(value.field, value.method, value.colors.length)}
      >
        {t("按当前数据重建分级")}
      </button>
    </>
  );
}

export function LabelStyleControls({
  layer,
  value,
  onChange,
}: {
  layer: DocumentLayer;
  value?: LayerLabels;
  onChange: (value: LayerLabels | undefined) => void;
}) {
  useLocale();
  const fields = displayFields(layer);
  return (
    <fieldset className="layer-display-controls">
      <legend>{t("字段标注")}</legend>
      <label>
        <span>{t("显示标注")}</span>
        <input
          type="checkbox"
          aria-label={t("显示标注")}
          checked={Boolean(value)}
          disabled={!fields.length && !value}
          onChange={(event) =>
            onChange(
              event.target.checked ? createLayerLabels(fields[0]) : undefined,
            )
          }
        />
      </label>
      {value && (
        <>
          <label>
            <span>{t("标注字段")}</span>
            <select
              aria-label={t("标注字段")}
              value={value.field}
              onChange={(event) =>
                onChange({ ...value, field: event.target.value })
              }
            >
              {!fields.includes(value.field) && (
                <option value={value.field}>{value.field}</option>
              )}
              {fields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          </label>
          {!fields.includes(value.field) && (
            <p role="status">
              {t("标注字段已不存在，暂不显示文字；可重新选择字段。")}
            </p>
          )}
          <label className="layer-label-range">
            <span>{t("标注字号")}</span>
            <output>{value.fontSize} px</output>
            <input
              type="range"
              aria-label={t("标注字号")}
              min="8"
              max="32"
              step="1"
              value={value.fontSize}
              onChange={(event) =>
                onChange({ ...value, fontSize: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span>{t("标注颜色")}</span>
            <input
              type="color"
              aria-label={t("标注颜色")}
              value={value.color}
              onChange={(event) =>
                onChange({ ...value, color: event.target.value })
              }
            />
          </label>
          <label>
            <span>{t("标注描边颜色")}</span>
            <input
              type="color"
              aria-label={t("标注描边颜色")}
              value={value.haloColor}
              onChange={(event) =>
                onChange({ ...value, haloColor: event.target.value })
              }
            />
          </label>
          <label className="layer-label-range">
            <span>{t("标注描边宽度")}</span>
            <output>{value.haloWidth} px</output>
            <input
              type="range"
              aria-label={t("标注描边宽度")}
              min="0"
              max="6"
              step="0.5"
              value={value.haloWidth}
              onChange={(event) =>
                onChange({ ...value, haloWidth: Number(event.target.value) })
              }
            />
          </label>
        </>
      )}
    </fieldset>
  );
}

export function CategorizedStyleControls({
  layer,
  value,
  graduatedValue,
  onChange,
}: {
  layer: DocumentLayer;
  value?: CategorizedStyle;
  graduatedValue?: GraduatedStyle;
  onChange: (
    value: CategorizedStyle | undefined,
    graduatedValue?: GraduatedStyle,
  ) => void;
}) {
  useLocale();
  const fields = displayFields(layer);
  const kinds = useMemo(
    () => layerGeometryKinds(layer),
    [layer.features, layer.geometryType],
  );

  const numericField = fields.find((field) =>
    layer.features.some(
      (feature) =>
        Object.hasOwn(feature.properties, field) &&
        isDisplayNumber(feature.properties[field]),
    ),
  );
  return (
    <fieldset className="layer-display-controls">
      <legend>{t("分类着色")}</legend>
      <label>
        <span>{t("着色方式")}</span>
        <select
          aria-label={t("着色方式")}
          value={graduatedValue ? "graduated" : value ? "unique" : "single"}
          onChange={(event) => {
            if (event.target.value === "graduated" && numericField)
              onChange(undefined, createGraduatedStyle(layer, numericField));
            else
              onChange(
                event.target.value === "single"
                  ? undefined
                  : createCategorizedStyle(layer, fields[0]),
              );
          }}
        >
          <option value="single">{t("单色")}</option>
          <option value="unique" disabled={!fields.length}>
            {t("字段唯一值")}
          </option>
          <option value="graduated" disabled={!numericField}>
            {t("数值分级")}
          </option>
        </select>
      </label>
      {graduatedValue && (
        <GraduatedStyleControls
          layer={layer}
          value={graduatedValue}
          onChange={(next) => onChange(undefined, next)}
        />
      )}
      {value && !graduatedValue && (
        <>
          <label>
            <span>{t("分类字段")}</span>
            <select
              aria-label={t("分类字段")}
              value={value.field}
              onChange={(event) =>
                onChange(createCategorizedStyle(layer, event.target.value))
              }
            >
              {!fields.includes(value.field) && (
                <option value={value.field}>{value.field}</option>
              )}
              {fields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          </label>
          {!fields.includes(value.field) && (
            <p role="status">
              {t("分类字段已不存在，可重新选择字段或切回单色。")}
            </p>
          )}
          <div
            className="layer-category-list"
            role="group"
            aria-label={t("分类颜色")}
          >
            {value.categories.map((category, index) => (
              <label key={categoryKey(category.value)}>
                <span title={String(category.value)}>
                  {JSON.stringify(category.value)}{" "}
                  <small>({typeof category.value})</small>
                </span>
                <SymbolColorInput
                  kinds={kinds}
                  layer={layer}
                  label={t("类别 {0} 颜色", index + 1)}
                  value={category.color}
                  onChange={(color) =>
                    onChange({
                      ...value,
                      categories: value.categories.map((item, i) =>
                        i === index ? { ...item, color } : item,
                      ),
                    })
                  }
                />
              </label>
            ))}
            {(
              [
                ["otherColor", "其他"],
                ["nullColor", "空值（null）"],
                ["missingColor", "字段缺失"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <span>{t(label)}</span>
                <SymbolColorInput
                  kinds={kinds}
                  layer={layer}
                  label={t(label)}
                  value={value[key]}
                  onChange={(color) => onChange({ ...value, [key]: color })}
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onChange(createCategorizedStyle(layer, value.field))}
          >
            {t("按当前数据重建分类")}
          </button>
        </>
      )}
    </fieldset>
  );
}
