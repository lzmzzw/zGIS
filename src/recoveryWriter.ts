import { smallText, type TextContent, type TextInput } from "./textContent";
// 本地日志只覆盖小快照；大字符串不发送到 DOMStorage 的跨进程通道。
export const MAX_LOCAL_RECOVERY_CHARS = 2 * 1024 * 1024;
const journalCache = new WeakMap<TextContent, string | undefined>();
export function recoveryJournalText(content: TextInput): string | undefined {
  if (typeof content === "string") return smallText(content, MAX_LOCAL_RECOVERY_CHARS);
  if (!journalCache.has(content)) journalCache.set(content, smallText(content, MAX_LOCAL_RECOVERY_CHARS));
  return journalCache.get(content);
}
export function writeRecoveryJournal(content: TextInput, storage?: Pick<Storage, "setItem">): boolean {
  const value = recoveryJournalText(content);
  if (value === undefined) return false;
  try {
    (storage ?? localStorage).setItem("zgis.editRecovery", value);
    return true;
  } catch {
    return false;
  }
}

// Only unsent autosaves may coalesce. Explicit save/exit barriers retain order.
export function createRecoveryWriter<T = string>(write: (content: T) => Promise<unknown>) {
  type Entry = { content: T; barrier: boolean; resolve: ((content: T) => void)[]; reject: ((error: unknown) => void)[] };
  const queue: Entry[] = [];
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const entry = queue.shift()!;
        try { await write(entry.content); entry.resolve.forEach(resolve => resolve(entry.content)); }
        catch (error) { entry.reject.forEach(reject => reject(error)); }
      }
    } finally { running = false; }
  }
  return (content: T, barrier = false): Promise<T> => new Promise((resolve, reject) => {
    const last = queue.at(-1);
    if (!barrier && last && !last.barrier) {
      last.content = content;
      last.resolve.push(resolve); last.reject.push(reject);
    } else queue.push({ content, barrier, resolve: [resolve], reject: [reject] });
    void drain();
  });
}
