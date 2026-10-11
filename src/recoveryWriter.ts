// Only unsent autosaves may coalesce. Explicit save/exit barriers retain order.
export function createRecoveryWriter(write: (content: string) => Promise<unknown>) {
  type Entry = { content: string; barrier: boolean; resolve: ((content: string) => void)[]; reject: ((error: unknown) => void)[] };
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
  return (content: string, barrier = false): Promise<string> => new Promise((resolve, reject) => {
    const last = queue.at(-1);
    if (!barrier && last && !last.barrier) {
      last.content = content;
      last.resolve.push(resolve); last.reject.push(reject);
    } else queue.push({ content, barrier, resolve: [resolve], reject: [reject] });
    void drain();
  });
}
