import { useMemo, useState } from "react";
import { X, ArrowRight } from "lucide-react";
import type { DocumentLayer } from "./domain/types";
import { t, useLocale } from "./i18n";
import {
  profileField,
  profileFields,
  type ProfileValueType,
} from "./fieldProfile";
import "./field-profile.css";

export interface FieldProfileProps {
  layer: DocumentLayer | null;
  initialField?: string;
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
    new Intl.NumberFormat(locale, { maximumSignificantDigits: 8 }).format(
      value,
    );
  const profile = result?.status === "complete" ? result : undefined;
  const numeric = profile?.numeric;
  const blockedReason =
    directory?.status === "blocked" ? directory.reason : undefined;
  return (
    <section className="field-profile" aria-label={t("字段概览")}>
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
      {!layer ? (
        <p className="field-profile-note">{t("请选择一个已加载图层")}</p>
      ) : (
        <>
          <p className="field-profile-note">
            {t("统计当前已加载图层的全部要素，不随地图范围或选择变化。")}
          </p>
          {blockedReason ? (
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
                  <dl className="field-profile-counts">
                    <div>
                      <dt>{t("有效（非空）")}</dt>
                      <dd>{format(profile.validCount)}</dd>
                    </div>
                    <div>
                      <dt>{t("空值")}</dt>
                      <dd>{format(profile.nullCount)}</dd>
                    </div>
                    <div>
                      <dt>{t("缺失")}</dt>
                      <dd>{format(profile.missingCount)}</dd>
                    </div>
                  </dl>
                  <p className="field-profile-scope">
                    {t("已统计 {0} 个要素", profile.totalCount)}
                  </p>
                  <div
                    className="field-profile-types"
                    aria-label={t("类型分布")}
                  >
                    {Object.entries(profile.types)
                      .filter(([, count]) => count > 0)
                      .map(([type, count]) => (
                        <span key={type}>
                          {t(typeNames[type as ProfileValueType])}
                          <strong>{format(count)}</strong>
                        </span>
                      ))}
                  </div>
                  {numeric ? (
                    <>
                      <dl className="field-profile-numeric">
                        <div>
                          <dt>{t("最小值")}</dt>
                          <dd title={String(numeric.min)}>
                            {format(numeric.min)}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("最大值")}</dt>
                          <dd title={String(numeric.max)}>
                            {format(numeric.max)}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("均值")}</dt>
                          <dd title={String(numeric.mean)}>
                            {format(numeric.mean)}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("中位数")}</dt>
                          <dd title={String(numeric.median)}>
                            {format(numeric.median)}
                          </dd>
                        </div>
                      </dl>
                      <h3>{t("数值分布")}</h3>
                      <div
                        className="field-profile-histogram"
                        role="img"
                        aria-label={t(
                          "等间隔直方图，合计 {0} 个数值",
                          profile.validCount,
                        )}
                      >
                        {numeric.histogram.map((bin, index) => (
                          <div
                            className="field-profile-bin"
                            key={index}
                            title={`${format(bin.min)} – ${format(bin.max)} · ${bin.count}`}
                            style={{
                              height: `${Math.max(2, (bin.count / Math.max(...numeric.histogram.map((entry) => entry.count))) * 100)}%`,
                            }}
                          />
                        ))}
                      </div>
                      <div className="field-profile-axis">
                        <span>{format(numeric.min)}</span>
                        <span>{format(numeric.max)}</span>
                      </div>
                      <details className="field-profile-detail">
                        <summary>{t("查看分布数据")}</summary>
                        <table>
                          <thead>
                            <tr>
                              <th>{t("区间")}</th>
                              <th>{t("数量")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {numeric.histogram.map((bin, index) => (
                              <tr key={index}>
                                <td>
                                  {format(bin.min)} ≤ x{" "}
                                  {index === numeric.histogram.length - 1
                                    ? "≤"
                                    : "<"}{" "}
                                  {format(bin.max)}
                                </td>
                                <td>{bin.count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </details>
                      <p className="field-profile-note">
                        {t(
                          "均值与中位数使用浮点近似，不用于精确财务计算；显示舍入不修改原值。",
                        )}
                      </p>
                    </>
                  ) : (
                    <>
                      {profile.unsafeNumberCount > 0 && (
                        <p className="field-profile-warning">
                          {t("存在非有限数值或不安全整数，未计算数值统计。")}
                        </p>
                      )}
                      {profile.validCount > 0 && !profile.unsafeNumberCount && (
                        <p className="field-profile-note">
                          {t(
                            "仅纯数值字段计算数值统计；文本不会自动转换为数字。",
                          )}
                        </p>
                      )}
                      <h3>{t("常见值")}</h3>
                      {profile.commonValues.length ? (
                        <>
                          <ol className="field-profile-values">
                            {profile.commonValues.map((entry) => (
                              <li key={`${entry.type}:${String(entry.value)}`}>
                                <span
                                  className="field-profile-value"
                                  title={String(entry.value)}
                                >
                                  {entry.type === "string"
                                    ? `“${String(entry.value)}”`
                                    : String(entry.value)}
                                  <small>{t(typeNames[entry.type])}</small>
                                </span>
                                <strong>{format(entry.count)}</strong>
                              </li>
                            ))}
                          </ol>
                          <p className="field-profile-note">
                            {t(
                              "显示频次最高的8个标量值，共 {0} 个不同标量值。",
                              profile.distinctScalarCount,
                            )}
                          </p>
                        </>
                      ) : (
                        <p className="field-profile-note">
                          {t("没有可展示的标量值")}
                        </p>
                      )}
                    </>
                  )}
                  {onGraduated && (
                    <button
                      type="button"
                      className="field-profile-graduate"
                      disabled={!numeric}
                      onClick={() => onGraduated(field)}
                      title={
                        !numeric
                          ? t("请选择包含安全数值的纯数值字段")
                          : undefined
                      }
                    >
                      {t("按此字段分级着色")}
                      <ArrowRight size={14} />
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
