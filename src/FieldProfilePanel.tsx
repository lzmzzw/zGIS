import { useMemo, useState } from "react";
import { X, ArrowRight } from "lucide-react";
import type { DocumentLayer } from "./domain/types";
import { t, useLocale } from "./i18n";
import { profileField, profileFields, type ProfileValueType } from "./fieldProfile";
import "./field-profile.css";

export interface FieldProfileProps {
  layer: DocumentLayer | null;
  initialField?: string;
  embedded?: boolean;
  onGraduated?: (field: string) => void;
  onClose?: () => void;
}
const typeNames: Record<ProfileValueType, string> = {
  number: "数字",
  string: "文本",
  boolean: "布尔值",
  array: "数组",
  object: "对象",
  other: "其他类型",
};
export function FieldProfile({
  layer,
  initialField,
  embedded = false,
  onGraduated,
  onClose,
}: FieldProfileProps) {
  const { locale } = useLocale();
  const [selected, setSelected] = useState(initialField ?? "");
  const directory = useMemo(
    () => (layer ? profileFields(layer) : undefined),
    [layer],
  );
  const fields = directory?.status === "complete" ? directory.fields : [];
  const field = fields.includes(selected) ? selected : (fields[0] ?? "");
  const result = useMemo(
    () => (layer && field ? profileField(layer.features, field) : undefined),
    [layer, field],
  );
  const format = (value: number) =>
    new Intl.NumberFormat(locale, { maximumSignificantDigits: 8 }).format(value);
  const profile = result?.status === "complete" ? result : undefined;
  const numeric = profile?.numeric;
  const types = profile
    ? (Object.keys(profile.types) as ProfileValueType[]).filter(
        (type) => profile.types[type] > 0,
      )
    : [];
  const blockedReason =
    directory?.status === "blocked" ? directory.reason : undefined;
  return (
    <section className="field-profile" aria-label={t("字段概览")}>
      {!embedded && (
        <header className="field-profile-header">
          <div>
            <h2>{t("字段概览")}</h2>
            <span
              className="field-profile-layer"
              title={layer?.displayName ?? layer?.name}
            >
              {layer?.displayName ?? layer?.name ?? t("未选择图层")}
            </span>
          </div>
          {onClose && (
            <button
              type="button"
              className="icon-button"
              aria-label={t("关闭字段概览")}
              title={t("关闭字段概览")}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          )}
        </header>
      )}
      {!layer ? (
        <p className="field-profile-note">{t("请选择一个已加载图层")}</p>
      ) : blockedReason ? (
        <p className="field-profile-warning" role="status">
          {t(blockedReason)}
        </p>
      ) : (
        <>
          <label className="field-profile-selector">
            <span>{t("字段")}</span>
            <select
              aria-label={t("概览字段")}
              value={field}
              disabled={!fields.length}
              onChange={(event) => setSelected(event.target.value)}
            >
              {!fields.length && (
                <option value="">{t("没有可统计字段")}</option>
              )}
              {fields.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {result?.status === "blocked" && (
            <p className="field-profile-warning" role="status">
              {t(result.reason)}
            </p>
          )}
          {profile && (
            <>
              <dl className="field-profile-metadata">
                <div>
                  <dt>{t("字段类型")}</dt>
                  <dd>
                    {types.length
                      ? types.map((type) => t(typeNames[type])).join(" / ")
                      : profile.nullCount > 0
                        ? t("空值")
                        : profile.missingCount > 0
                          ? t("缺失")
                          : "—"}
                  </dd>
                </div>
                {numeric && (
                  <div>
                    <dt>{t("数值范围")}</dt>
                    <dd title={`${numeric.min} – ${numeric.max}`}>
                      {format(numeric.min)} – {format(numeric.max)}
                    </dd>
                  </div>
                )}
              </dl>
              {profile.unsafeNumberCount > 0 && (
                <p className="field-profile-warning" role="status">
                  {t("存在非有限数值或不安全整数，未计算数值统计。")}
                </p>
              )}
              <h3>{t("值示例")}</h3>
              {profile.commonValues.length ? (
                <ul className="field-profile-values">
                  {profile.commonValues.slice(0, 5).map((entry) => (
                    <li key={`${entry.type}:${String(entry.value)}`}>
                      <span
                        className="field-profile-value"
                        title={String(entry.value)}
                      >
                        {entry.type === "string"
                          ? `“${String(entry.value)}”`
                          : String(entry.value)}
                      </span>
                      {types.length > 1 && (
                        <small>{t(typeNames[entry.type])}</small>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="field-profile-note">
                  {t("没有可展示的标量值")}
                </p>
              )}
              {onGraduated && numeric && (
                <button
                  type="button"
                  className="field-profile-graduate"
                  onClick={() => onGraduated(field)}
                >
                  {t("按此字段分级着色")}
                  <ArrowRight size={14} />
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
