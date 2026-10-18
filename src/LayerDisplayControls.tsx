import { t, useLocale } from "./i18n";
import type {
  CategorizedStyle,
  DocumentLayer,
  LayerLabels,
} from "./domain/types";
import {
  categoryKey,
  createCategorizedStyle,
  displayFields,
  createLayerLabels,
} from "./layerDisplay";
import "./layer-display.css";

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
          <p>
            {t(
              "每层最多标注前 1000 个有效要素，每条最多 80 个字符；拥挤文字自动避让，空值、缺失和对象不显示。",
            )}
          </p>
        </>
      )}
    </fieldset>
  );
}

export function CategorizedStyleControls({
  layer,
  value,
  onChange,
}: {
  layer: DocumentLayer;
  value?: CategorizedStyle;
  onChange: (value: CategorizedStyle | undefined) => void;
}) {
  useLocale();
  const fields = displayFields(layer);
  return (
    <fieldset className="layer-display-controls">
      <legend>{t("分类着色")}</legend>
      <label>
        <span>{t("着色方式")}</span>
        <select
          aria-label={t("着色方式")}
          value={value ? "unique" : "single"}
          onChange={(event) =>
            onChange(
              event.target.value === "single"
                ? undefined
                : createCategorizedStyle(layer, fields[0]),
            )
          }
        >
          <option value="single">{t("单色")}</option>
          <option value="unique" disabled={!fields.length}>
            {t("字段唯一值")}
          </option>
        </select>
      </label>
      {value && (
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
          <p>
            {t(
              "最多保留前 32 个唯一值；额外值及对象归入其他，空值与缺失分别着色。",
            )}
          </p>
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
                <input
                  type="color"
                  aria-label={t("类别 {0} 颜色", index + 1)}
                  value={category.color}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      categories: value.categories.map((item, i) =>
                        i === index
                          ? { ...item, color: event.target.value }
                          : item,
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
                <input
                  type="color"
                  aria-label={t(label)}
                  value={value[key]}
                  onChange={(event) =>
                    onChange({ ...value, [key]: event.target.value })
                  }
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
