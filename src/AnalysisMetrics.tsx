import { t } from "./i18n";

export interface AnalysisMetric { name: string; op: string; field?: string }
export const metricOperations = [["count_all", "记录数"], ["count_valid", "非空值数"], ["sum", "求和"], ["mean", "均值"], ["min", "最小值"], ["max", "最大值"]];
export function metricsError(metrics: AnalysisMetric[], fields: string[]): string {
  if (!metrics.length || metrics.length > 8) return "请配置1至8个统计指标。";
  const names = metrics.map(m => m.name.trim());
  if (names.some(n => !n || n.length > 64) || new Set(names).size !== names.length) return "指标名称须为1至64字符且不能重复。";
  if (metrics.some(m => !metricOperations.some(([op]) => op === m.op) || (m.op !== "count_all" && !fields.includes(m.field ?? "")))) return "请选择有效的统计字段。";
  return "";
}
export function normalizedMetrics(metrics: AnalysisMetric[]): AnalysisMetric[] {
  return metrics.map(m => ({ name: m.name.trim(), op: m.op, ...(m.op === "count_all" ? {} : { field: m.field }) }));
}
export default function AnalysisMetrics({ value, fields, onChange }: { value: AnalysisMetric[]; fields: string[]; onChange: (value: AnalysisMetric[]) => void }) {
  return <fieldset className="analysis-metrics"><legend>{t("统计指标")}</legend>
    {value.map((metric, i) => <div className="analysis-metric" key={i}>
      <label><span>{t("指标名称")}</span><input aria-label={t("指标名称")} value={metric.name} maxLength={64} onChange={e => onChange(value.map((m, j) => j === i ? { ...m, name: e.target.value } : m))} /></label>
      <label><span>{t("统计方式")}</span><select aria-label={t("统计方式")} value={metric.op} onChange={e => onChange(value.map((m, j) => j === i ? { ...m, op: e.target.value, field: m.field ?? fields[0] } : m))}>{metricOperations.map(([op, label]) => <option value={op} key={op}>{t(label)}</option>)}</select></label>
      {metric.op !== "count_all" && <label><span>{t("统计字段")}</span><select aria-label={t("统计字段")} value={metric.field ?? ""} onChange={e => onChange(value.map((m, j) => j === i ? { ...m, field: e.target.value } : m))}><option value="">{t("请选择字段")}</option>{fields.map(field => <option key={field} value={field}>{field}</option>)}</select></label>}
      <button type="button" disabled={value.length === 1} onClick={() => onChange(value.filter((_, j) => j !== i))}>{t("移除指标")}</button>
    </div>)}
    <button type="button" disabled={value.length >= 8} onClick={() => { let n = value.length + 1; while(value.some(m => m.name === `metric_${n}`)) n++; onChange([...value, { name: `metric_${n}`, op: "count_all" }]); }}>{t("添加指标")}</button>
  </fieldset>;
}
