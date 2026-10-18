import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useLocale } from "./i18n";
import { executeUiCommand, matchUiCommands, type UiCommand } from "./uiCommands";
import "./command-palette.css";

export default function CommandPalette({ commands, onClose }: { commands: UiCommand[]; onClose: () => void }) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const hits = useMemo(() => matchUiCommands(commands, query, t), [commands, query, t]);
  const activeIndex = Math.min(index, Math.max(0, hits.length - 1));
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { dialog.current?.querySelector(`[data-command-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" }); }, [activeIndex, query]);
  function choose(command: UiCommand) {
    if (command.disabledReason) return;
    onClose();
    executeUiCommand(command);
  }
  return <dialog ref={dialog} className="command-palette" aria-label={t("搜索操作")} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><Search size={18} /><input ref={input} aria-label={t("搜索操作")} placeholder={t("搜索操作、分析工具…")}
      value={query} onChange={e => { setQuery(e.target.value); setIndex(0); }}
      onKeyDown={e => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setIndex((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + Math.max(1, hits.length)) % Math.max(1, hits.length)); }
        if (e.key === "Enter" && hits[activeIndex]) { e.preventDefault(); choose(hits[activeIndex]); }
      }} /><button type="button" aria-label={t("关闭操作搜索")} onClick={onClose}><X size={17} /></button></header>
    <div className="command-palette-results" aria-label={t("匹配操作")}>
      {hits.map((command, i) => <button type="button" key={command.id} data-command-index={i}
        className={i === activeIndex ? "active" : ""} aria-disabled={Boolean(command.disabledReason)}
        onFocus={() => setIndex(i)} onClick={() => choose(command)}>
        <span>{t(command.label)}<small>{t(command.group)}</small></span>
        <small>{command.disabledReason ? t(command.disabledReason) : t("打开")}</small>
      </button>)}
      {!hits.length && <p role="status">{t("没有匹配操作")}</p>}
    </div><footer>{t("↑ ↓ 选择 · Enter 打开 · Esc 关闭")}</footer>
  </dialog>;
}
