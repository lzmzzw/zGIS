//! 桌面与 MCP 共享的有界计算槽。取消为协作式，库调用返回前不会释放槽位。
use std::{cell::RefCell, collections::HashMap, sync::{Arc, Mutex, OnceLock, atomic::{AtomicU8, Ordering}}, time::{Duration, Instant}};

#[derive(Clone)]
struct Context { state: Arc<AtomicU8>, deadline: Instant }
thread_local! { static CURRENT: RefCell<Option<Context>> = const { RefCell::new(None) }; }
pub fn checkpoint() -> Result<(), String> {
    CURRENT.with(|current| match current.borrow().as_ref() {
        Some(c) if c.state.load(Ordering::Acquire) == 1 => Err("ANALYSIS_CANCELLED: 分析已取消".into()),
        Some(c) if c.state.load(Ordering::Acquire) == 0 && Instant::now() >= c.deadline => Err("ANALYSIS_TIMEOUT: 分析超过时间预算".into()),
        _ => Ok(()),
    })
}
/// 原子提交边界：调用者完成所有可失败校验后，在最终状态锁内调用。
/// 取消与提交只有一方胜出；提交完成后不得再因迟到取消伪报失败。
pub fn commit_checkpoint() -> Result<(), String> {
    CURRENT.with(|current| {
        let current = current.borrow();
        let Some(context) = current.as_ref() else { return Ok(()); };
        if context.state.load(Ordering::Acquire) == 2 { return Ok(()); }
        if Instant::now() >= context.deadline { return Err("ANALYSIS_TIMEOUT: 分析超过时间预算".into()); }
        match context.state.compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) | Err(2) => Ok(()),
            _ => Err("ANALYSIS_CANCELLED: 分析已取消".into()),
        }
    })
}

struct Entry { context: Context }
#[derive(Default)]
struct Inner { jobs: HashMap<(String, String), Entry>, early: HashMap<(String, String), Instant> }
pub struct AnalysisRuntime { inner: Arc<Mutex<Inner>>, capacity: usize, timeout: Duration }
pub struct JobGuard { inner: Arc<Mutex<Inner>>, key: (String, String), context: Context }
pub fn global() -> &'static AnalysisRuntime {
    static RUNTIME: OnceLock<AnalysisRuntime> = OnceLock::new();
    RUNTIME.get_or_init(|| AnalysisRuntime::new(2, Duration::from_secs(120)))
}
impl AnalysisRuntime {
    pub(crate) fn new(capacity: usize, timeout: Duration) -> Self { Self { inner: Arc::default(), capacity, timeout } }
    pub fn start(&self, owner: &str, job_id: &str) -> Result<JobGuard, String> {
        if owner.is_empty() || job_id.is_empty() || owner.len() > 256 || job_id.len() > 256 { return Err("无效分析任务标识".into()); }
        let key = (owner.to_owned(), job_id.to_owned());
        let mut inner = self.inner.lock().map_err(|_| "分析运行时不可用")?;
        inner.early.retain(|_, expiry| *expiry > Instant::now());
        if inner.jobs.contains_key(&key) { return Err("ANALYSIS_DUPLICATE: 任务标识正在使用".into()); }
        if inner.early.remove(&key).is_some() { return Err("ANALYSIS_CANCELLED: 分析已取消".into()); }
        if inner.jobs.len() >= self.capacity { return Err("ANALYSIS_BUSY: 分析任务正在运行，请稍后重试".into()); }
        let context = Context { state: Arc::new(AtomicU8::new(0)), deadline: Instant::now() + self.timeout };
        inner.jobs.insert(key.clone(), Entry { context: context.clone() });
        Ok(JobGuard { inner: self.inner.clone(), key, context })
    }
    pub fn cancel(&self, owner: &str, job_id: &str) -> bool {
        if owner.is_empty() || job_id.is_empty() || owner.len() > 256 || job_id.len() > 256 { return false; }
        let Ok(mut inner) = self.inner.lock() else { return false; };
        let key = (owner.to_owned(), job_id.to_owned());
        if let Some(job) = inner.jobs.get(&key) { return job.context.state.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire).is_ok() || job.context.state.load(Ordering::Acquire) == 1; }
        inner.early.retain(|_, expiry| *expiry > Instant::now());
        // 容纳 IPC 取消先于启动到达的竞态，不允许未启动 ID 无限占内存。
        if inner.early.len() >= 256 { return false; }
        inner.early.insert(key, Instant::now() + Duration::from_secs(30));
        true
    }
    pub fn cancel_owner(&self, owner: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            for ((job_owner, _), job) in &inner.jobs { if job_owner == owner { let _ = job.context.state.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire); } }
            inner.early.retain(|(job_owner, _), _| job_owner != owner);
        }
    }
}
impl JobGuard {
    pub fn run<T>(self, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        struct Restore(Option<Context>);
        impl Drop for Restore { fn drop(&mut self) { CURRENT.with(|c| *c.borrow_mut() = self.0.take()); } }
        let _restore = Restore(CURRENT.with(|c| c.replace(Some(self.context.clone()))));
        checkpoint()?;
        let result = f()?;
        checkpoint()?;
        Ok(result)
    }
}
impl Drop for JobGuard { fn drop(&mut self) { if let Ok(mut inner) = self.inner.lock() { inner.jobs.remove(&self.key); } } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_and_commit_have_one_winner() {
        let rt = AnalysisRuntime::new(1, Duration::from_secs(1));
        let job = rt.start("desktop", "cancel-first").unwrap();
        let mut mutated = false;
        let result = job.run(|| {
            assert!(rt.cancel("desktop", "cancel-first"));
            commit_checkpoint()?;
            mutated = true;
            Ok(())
        });
        assert!(result.unwrap_err().contains("CANCELLED"));
        assert!(!mutated);
        let job = rt.start("desktop", "commit-first").unwrap();
        job.run(|| {
            commit_checkpoint()?;
            mutated = true;
            assert!(!rt.cancel("desktop", "commit-first"));
            rt.cancel_owner("desktop");
            checkpoint()?;
            Ok(())
        }).unwrap();
        assert!(mutated);
        assert!(rt.inner.lock().unwrap().jobs.is_empty());
    }
    #[test]
    fn shared_capacity_cancellation_and_ownership() {
        let rt = AnalysisRuntime::new(2, Duration::from_secs(1));
        let desktop = rt.start("desktop", "1").unwrap();
        let mcp = rt.start("session-1", "1").unwrap();
        assert!(rt.start("session-2", "1").is_err());
        assert!(rt.start("desktop", "1").is_err());
        rt.cancel_owner("session-1");
        assert!(rt.start("session-2", "1").is_err(), "取消请求不得提前释放仍在计算的槽");
        assert!(mcp.run(|| Ok(())).unwrap_err().contains("CANCELLED"));
        assert!(desktop.run(|| { checkpoint()?; Ok(()) }).is_ok());
        assert!(rt.inner.lock().unwrap().jobs.is_empty());
        assert!(rt.start("session-2", "1").is_ok());
    }
    #[test]
    fn early_cancel_deadline_and_panic_restore() {
        let rt = AnalysisRuntime::new(1, Duration::ZERO);
        assert!(rt.cancel("desktop", "early"));
        assert!(rt.start("desktop", "early").err().unwrap().contains("CANCELLED"));
        assert!(rt.start("desktop", "late").unwrap().run(|| Ok(())).unwrap_err().contains("TIMEOUT"));
        assert!(checkpoint().is_ok());
        let rt = AnalysisRuntime::new(1, Duration::from_secs(1));
        let guard = rt.start("desktop", "panic").unwrap();
        assert!(std::panic::catch_unwind(|| guard.run::<()>(|| panic!("test"))).is_err());
        assert!(rt.inner.lock().unwrap().jobs.is_empty());
        assert!(checkpoint().is_ok());
    }
}
