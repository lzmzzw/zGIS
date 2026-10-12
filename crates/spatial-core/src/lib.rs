//! 桌面与浏览器共享的空间算法与内存导出；取消检查由宿主提供。
use std::cell::Cell;
const MAX_FILE: u64 = 100 * 1024 * 1024;
mod spatial;
pub mod export;
pub mod input;
pub use spatial::{analyze, tool_definitions};
type Checkpoint = fn() -> Result<(), String>;
thread_local! { static CHECKPOINT: Cell<Option<Checkpoint>> = const { Cell::new(None) }; }
pub fn checkpoint() -> Result<(), String> {
    CHECKPOINT.with(|hook| hook.get().map_or(Ok(()), |f| f()))
}
pub fn with_checkpoint<T>(hook: Checkpoint, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<Checkpoint>);
    impl Drop for Restore { fn drop(&mut self) { CHECKPOINT.with(|hook| hook.set(self.0)); } }
    let _restore = Restore(CHECKPOINT.with(|current| current.replace(Some(hook))));
    f()
}
