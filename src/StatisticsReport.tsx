import { useEffect, useState } from "react";
import { t, useLocale } from "./i18n";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const scalar = (value: unknown): string => value === null || value === undefined ? "—" : typeof value === "string" ? JSON.stringify(value) : String(value);
export default function StatisticsReport({ report }: { report: Record<string, unknown> }) {
  useLocale();
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [report]);
  const rows = Array.isArray(report.rows) ? report.rows.map(record) : [];
  const metrics = Array.isArray(report.metrics) ? report.metrics.map(record) : [];
  const pages = Math.max(1, Math.ceil(rows.length / 100));
  return <div className="processing-report">
    <p>{t("统计 {0} 个输入要素，共 {1} 组。", Number(report.inputCount ?? 0), Number(report.groupCount ?? rows.length))}</p>
    <p className="processing-note">{t("仅统计本次输入范围；数值使用浮点计算，不用于要求精确小数的财务结算。")}</p>
    <div className="processing-table-scroll"><table aria-label={t("字段统计结果")}><thead><tr><th>{t("分组值")}</th><th>{t("记录数")}</th>{metrics.map(m => <th key={String(m.name)}>{String(m.name)}</th>)}</tr></thead><tbody>
      {rows.slice(page * 100, page * 100 + 100).map((row, i) => {
        const group = record(row.group), values = record(row.values), counts = record(row.counts);
        const key = group.type === "all" ? t("全部") : group.type === "missing" ? t("字段缺失") : group.type === "null" ? "null" : `${scalar(group.value)} (${group.type})`;
        return <tr key={i}><td>{key}</td><td>{String(row.inputCount)}</td>{metrics.map(m => { const name = String(m.name), count = record(counts[name]); return <td key={name}>{scalar(values[name])}<small className="statistics-counts">{t("有效 {0} · 空值 {1} · 缺失 {2}", Number(count.validCount ?? 0), Number(count.nullCount ?? 0), Number(count.missingCount ?? 0))}</small></td>; })}</tr>;
      })}
    </tbody></table></div>
    <div className="statistics-pagination"><button type="button" disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t("上一页")}</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}>{t("下一页")}</button></div>
  </div>;
}
