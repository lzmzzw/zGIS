import { t, useLocale } from "./i18n";
import type { CategorizedStyle, DocumentLayer } from "./domain/types";
import {
  categoryKey,
  createCategorizedStyle,
  displayFields,
} from "./layerDisplay";
import "./layer-display.css";

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
          <div className="layer-category-list" role="group" aria-label={t("分类颜色")}>
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
