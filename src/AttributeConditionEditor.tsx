import { t } from "./i18n";

export type ConditionDraft = { kind: "all" | "any"; children: ConditionDraft[] } | { kind: "rule"; field: string; op: string; type: "string" | "number" | "boolean"; text: string };
export const newCondition = (field = ""): ConditionDraft => ({ kind: "rule", field, op: "eq", type: "string", text: "" });
const operations = [["eq", "等于"], ["ne", "不等于"], ["gt", "大于"], ["gte", "大于等于"], ["lt", "小于"], ["lte", "小于等于"], ["contains", "包含文本"], ["in", "属于列表"], ["is_null", "为空值"], ["is_missing", "字段缺失"]];
export function conditionValue(draft: ConditionDraft, fields: string[], depth = 1): Record<string, unknown> {
  if (depth > 4 || conditionLeaves(draft) > 32) throw new Error("条件最多四层、32项。");
  if (draft.kind !== "rule") {
    if (!draft.children.length) throw new Error("条件组不能为空。");
    return { [draft.kind]: draft.children.map(child => conditionValue(child, fields, depth + 1)) };
  }
  if (!fields.includes(draft.field)) throw new Error("请选择有效的条件字段。");
  const base = { field: draft.field, op: draft.op };
  if (["is_null", "is_missing"].includes(draft.op)) return base;
  const finite = (v: unknown) => typeof v !== "number" || (Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)));
  let value: unknown;
  if (draft.op === "in") {
    try { value = JSON.parse(draft.text); } catch { throw new Error("列表须为含1至100个标量值的JSON数组。"); }
    if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some(v => !["string", "number", "boolean"].includes(typeof v) || !finite(v)))
      throw new Error("列表须为含1至100个标量值的JSON数组。");
  } else if (["gt", "gte", "lt", "lte"].includes(draft.op) || draft.type === "number") {
    value = Number(draft.text);
    if (!draft.text.trim() || !finite(value)) throw new Error("请输入有限数值，整数须在安全范围内。");
  } else value = draft.type === "boolean" && draft.op !== "contains" ? draft.text === "true" : draft.text;
  return { ...base, value };
}
export const conditionLeaves = (draft: ConditionDraft): number => draft.kind === "rule" ? 1 : draft.children.reduce((sum, node) => sum + conditionLeaves(node), 0);

export default function AttributeConditionEditor({ value, fields, onChange, depth = 1 }: { value: ConditionDraft; fields: string[]; onChange: (value: ConditionDraft) => void; depth?: number }) {
  const kind = value.kind;
  return <fieldset className="attribute-condition">
    <legend>{t("属性条件")}</legend>
    <label><span>{t("条件方式")}</span><select aria-label={t("条件方式")} value={kind} onChange={e => {
      const next = e.target.value as ConditionDraft["kind"];
      onChange(next === "rule" ? newCondition(fields[0]) : { kind: next, children: [newCondition(fields[0])] });
    }}>
      <option value="rule">{t("单个条件")}</option><option value="all" disabled={depth >= 4}>{t("全部满足（AND）")}</option><option value="any" disabled={depth >= 4}>{t("任一满足（OR）")}</option>
    </select></label>
    {value.kind === "rule" ? <>
      <label><span>{t("条件字段")}</span><select aria-label={t("条件字段")} value={value.field} onChange={e => onChange({ ...value, field: e.target.value })}><option value="">{t("请选择字段")}</option>{fields.map(field => <option key={field} value={field}>{field}</option>)}</select></label>
      <label><span>{t("比较方式")}</span><select aria-label={t("比较方式")} value={value.op} onChange={e => onChange({ ...value, op: e.target.value, ...(e.target.value === "contains" ? { type: "string" as const } : {}) })}>{operations.map(([op,label]) => <option key={op} value={op}>{t(label)}</option>)}</select></label>
      {["eq","ne"].includes(value.op) && <label><span>{t("值类型")}</span><select aria-label={t("值类型")} value={value.type} onChange={e => onChange({ ...value, type: e.target.value as "string" | "number" | "boolean", text: e.target.value === "boolean" ? "true" : "" })}><option value="string">{t("文本")}</option><option value="number">{t("数值")}</option><option value="boolean">{t("布尔值")}</option></select></label>}
      {!["is_null","is_missing"].includes(value.op) && <label><span>{t("比较值")}</span>{value.type === "boolean" && ["eq","ne"].includes(value.op) ? <select aria-label={t("比较值")} value={value.text} onChange={e => onChange({ ...value, text: e.target.value })}><option value="true">true</option><option value="false">false</option></select> : <input aria-label={t("比较值")} maxLength={10000} value={value.text} placeholder={value.op === "in" ? '["A", "B"]' : undefined} onChange={e => onChange({ ...value, text: e.target.value })} />}</label>}
    </> : <>
      {value.children.map((child, i) => <div key={i}><AttributeConditionEditor depth={depth + 1} value={child} fields={fields} onChange={next => onChange({ ...value, children: value.children.map((old, index) => index === i ? next : old) })} /><button type="button" disabled={value.children.length === 1} onClick={() => onChange({ ...value, children: value.children.filter((_, index) => index !== i) })}>{t("移除条件")}</button></div>)}
      <button type="button" disabled={conditionLeaves(value) >= 32} onClick={() => onChange({ ...value, children: [...value.children, newCondition(fields[0])] })}>{t("添加条件")}</button>
    </>}
  </fieldset>;
}
