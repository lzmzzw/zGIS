//! GDB sources are registered read-only. GDAL runs in a bounded, cancellable child process.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{Manager, State};
pub(crate) use crate::gdb_contract::{source_path, validate_read};

const MAX_OUTPUT: usize = 100 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const MAX_SOURCES: usize = 64;

#[derive(Clone)]
struct Source { path: PathBuf, fingerprint: String }
#[derive(Clone)]
struct Job {
    id: String,
    cancelled: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}
#[derive(Clone, Default)]
pub struct GdbState {
    sources: Arc<Mutex<HashMap<String, Source>>>,
    active: Arc<Mutex<Option<Job>>>,
}
impl GdbState {
    fn begin(&self, id: &str) -> Result<Job, String> {
        if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err("GDB_REQUEST_INVALID: invalid request identifier".into());
        }
        let mut active = self.active.lock().map_err(|_| "GDB_STATE_UNAVAILABLE")?;
        if active.is_some() { return Err("GDB_BUSY: another GDB operation is running".into()); }
        let job = Job { id: id.into(), cancelled: Arc::new(AtomicBool::new(false)), child: Arc::new(Mutex::new(None)) };
        *active = Some(job.clone());
        Ok(job)
    }
    fn finish(&self, id: &str) {
        if let Ok(mut active) = self.active.lock() {
            if active.as_ref().is_some_and(|j| j.id == id) { *active = None; }
        }
    }
    pub fn shutdown(&self) {
        if let Ok(active) = self.active.lock() {
            if let Some(job) = active.as_ref() { stop_job(job); }
        }
    }
}
fn stop_job(job: &Job) {
    job.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut child) = job.child.lock() {
        if let Some(child) = child.as_mut() { let _ = child.kill(); let _ = child.wait(); }
    }
}
fn cancelled(job: &Job) -> Result<(), String> {
    if job.cancelled.load(Ordering::SeqCst) { Err("GDB_CANCELLED: operation cancelled".into()) } else { Ok(()) }
}

/// Metadata fingerprint: detects normal external edits, not same-size/time deliberate tampering.
#[cfg(test)]
fn fingerprint(path: &Path) -> Result<String, String> {
    fingerprint_checked(path, None)
}
fn fingerprint_checked(path: &Path, cancellation: Option<&AtomicBool>) -> Result<String, String> {
    fn walk(root: &Path, path: &Path, entries: &mut Vec<(String, u64, u128)>, visited: &mut usize, depth: usize, cancellation: Option<&AtomicBool>) -> Result<(), String> {
        if cancellation.is_some_and(|c| c.load(Ordering::SeqCst)) { return Err("GDB_CANCELLED: operation cancelled".into()); }
        *visited += 1;
        if *visited > MAX_FILES { return Err("GDB_SOURCE_LIMIT: too many source files or directories".into()); }
        if depth > 16 { return Err("GDB_SOURCE_LIMIT: source directory is too deep".into()); }
        let metadata = fs::symlink_metadata(path).map_err(|_| "GDB_SOURCE_MISSING: cannot inspect source")?;
        if metadata.file_type().is_symlink() { return Err("GDB_SOURCE_INVALID: source contains a symbolic link".into()); }
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(|_| "GDB_SOURCE_MISSING: cannot inspect source directory")? {
                let entry = entry.map_err(|_| "GDB_SOURCE_MISSING: cannot inspect source directory")?;
                if entry.file_name().to_string_lossy().to_lowercase().ends_with(".lock") {
                    *visited += 1;
                    if *visited > MAX_FILES { return Err("GDB_SOURCE_LIMIT: too many source files or directories".into()); }
                    continue;
                }
                if entries.len() >= MAX_FILES { return Err("GDB_SOURCE_LIMIT: too many source files".into()); }
                walk(root, &entry.path(), entries, visited, depth + 1, cancellation)?;
            }
        } else if metadata.is_file() {
            let name = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
            let stamp = metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|t| t.as_nanos()).unwrap_or(0);
            entries.push((name, metadata.len(), stamp));
        } else { return Err("GDB_SOURCE_INVALID: unsupported source file type".into()); }
        Ok(())
    }
    let mut entries = Vec::new();
    walk(path, path, &mut entries, &mut 0, 0, cancellation)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hash = Sha256::new();
    for (name, len, stamp) in entries {
        hash.update(name.as_bytes()); hash.update([0]); hash.update(len.to_le_bytes()); hash.update(stamp.to_le_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn runtime_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let packaged = app.path().resource_dir().map_err(|_| "GDB_RUNTIME_MISSING: cannot locate application resources")?.join("gdal");
    if packaged.join("native").is_dir() { return Ok(packaged); }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/gdal");
        if development.join("native").is_dir() { return Ok(development); }
    }
    Err("GDB_RUNTIME_MISSING: bundled GDAL runtime is unavailable; repair the application installation".into())
}

fn run_worker(root: &Path, request: &Value, job: &Job, timeout: Duration) -> Result<Value, String> {
    cancelled(job)?;
    let executable = std::env::current_exe().map_err(|_| "GDB_WORKER_FAILED: cannot locate application executable")?;
    let mut command = Command::new(executable);
    command.args(["--gdb-worker"]).arg(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Ok(existing) = std::env::var("PATH") {
        let mut paths = vec![root.join("native")]; paths.extend(std::env::split_paths(&existing));
        if let Ok(value) = std::env::join_paths(paths) { command.env("PATH", value); }
    }
    command.env("PROJ_NETWORK", "OFF").env("GDAL_DRIVER_PATH", "disable");
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|_| "GDB_WORKER_FAILED: cannot start read-only GDAL worker")?;
    let mut input = child.stdin.take().ok_or("GDB_WORKER_FAILED: missing input pipe")?;
    let stdout = child.stdout.take().ok_or("GDB_WORKER_FAILED: missing output pipe")?;
    let stderr = child.stderr.take().ok_or("GDB_WORKER_FAILED: missing error pipe")?;
    *job.child.lock().map_err(|_| "GDB_STATE_UNAVAILABLE")? = Some(child);
    let write_result = serde_json::to_writer(&mut input, request).and_then(|_| input.flush().map_err(serde_json::Error::io));
    drop(input);
    if write_result.is_err() { stop_job(job); return Err("GDB_WORKER_FAILED: cannot send read request".into()); }
    let overflow = Arc::new(AtomicBool::new(false));
    let output_overflow = overflow.clone();
    let output_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut source = stdout;
        let mut chunk = [0_u8; 65536];
        loop {
            let count = source.read(&mut chunk).map_err(|_| "GDB_WORKER_FAILED: cannot read worker output")?;
            if count == 0 { break; }
            if bytes.len() + count > MAX_OUTPUT { output_overflow.store(true, Ordering::SeqCst); return Err("GDB_OUTPUT_LIMIT: result exceeds 100 MiB"); }
            bytes.extend_from_slice(&chunk[..count]);
        }
        Ok::<_, &str>(bytes)
    });
    let error_reader = std::thread::spawn(move || {
        let mut source = stderr; let mut chunk = [0_u8; 4096]; let mut total = 0usize;
        loop {
            match source.read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => { total += n; if total > 65536 { break; } } }
        }
    });
    let started = Instant::now();
    let status = loop {
        if job.cancelled.load(Ordering::SeqCst) { stop_job(job); break Err("GDB_CANCELLED: operation cancelled".to_string()); }
        if overflow.load(Ordering::SeqCst) { stop_job(job); break Err("GDB_OUTPUT_LIMIT: result exceeds 100 MiB".to_string()); }
        if started.elapsed() >= timeout { stop_job(job); break Err("GDB_TIMEOUT: operation exceeded its time budget; reduce the selected range or fields".to_string()); }
        let result = job.child.lock().map_err(|_| "GDB_STATE_UNAVAILABLE")?.as_mut().ok_or("GDB_WORKER_FAILED: worker process unavailable")?.try_wait();
        match result { Ok(Some(exit)) => break Ok(exit), Ok(None) => std::thread::sleep(Duration::from_millis(20)), Err(_) => { stop_job(job); break Err("GDB_WORKER_FAILED: cannot inspect worker process".into()); } }
    };
    let output = output_reader.join().map_err(|_| "GDB_WORKER_FAILED: output reader failed")?;
    let _ = error_reader.join();
    if let Ok(mut child) = job.child.lock() { if let Some(mut child) = child.take() { let _ = child.wait(); } }
    let exit = status?;
    let bytes = output?;
    let mut envelope: Value = serde_json::from_slice(&bytes).map_err(|_| "GDB_WORKER_FAILED: invalid worker response")?;
    if envelope["ok"] != true {
        return Err(envelope["error"].as_str().unwrap_or("GDB_WORKER_FAILED: GDAL could not read source").to_string());
    }
    if !exit.success() { return Err("GDB_WORKER_FAILED: read-only GDAL worker exited unsuccessfully".into()); }
    cancelled(job)?;
    Ok(envelope["result"].take())
}

#[tauri::command]
pub async fn gdb_open(app: tauri::AppHandle, state: State<'_, GdbState>, request_id: String, zipped: bool) -> Result<Option<Value>, String> {
    let state = state.inner().clone();
    let job = state.begin(&request_id)?;
    let copy = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let selected = if zipped {
                rfd::FileDialog::new().set_title(crate::locale::text("打开 GDB ZIP", "Open GDB ZIP")).add_filter("GDB ZIP", &["zip"]).pick_file()
            } else {
                rfd::FileDialog::new().set_title(crate::locale::text("打开 GDB 文件夹", "Open GDB folder")).pick_folder()
            };
            cancelled(&job)?;
            let Some(selected) = selected else { return Ok(None); };
            let path = source_path(&selected)?;
            let before = fingerprint_checked(&path, Some(&job.cancelled))?;
            let mut catalog = run_worker(&runtime_root(&app)?, &json!({"operation":"catalog", "path":path}), &job, Duration::from_secs(45))?;
            if fingerprint_checked(&path, Some(&job.cancelled))? != before { return Err("GDB_SOURCE_CHANGED: source changed during discovery; reopen it".into()); }
            cancelled(&job)?;
            let id = uuid::Uuid::new_v4().to_string();
            let mut sources = copy.sources.lock().map_err(|_| "GDB_STATE_UNAVAILABLE")?;
            if sources.len() >= MAX_SOURCES { return Err("GDB_SOURCE_LIMIT: too many registered GDB sources; restart the application".into()); }
            sources.insert(id.clone(), Source { path: path.clone(), fingerprint: before.clone() });
            catalog["sourceId"] = json!(id);
            catalog["path"] = json!(path);
            catalog["fingerprint"] = json!(before);
            Ok(Some(catalog))
        })();
        copy.finish(&job.id);
        result
    }).await.map_err(|_| "GDB_WORKER_FAILED: read task failed".to_string())?;
    state.finish(&request_id);
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn gdb_read(app: tauri::AppHandle, state: State<'_, GdbState>, request_id: String, source_id: String, layer_name: String, limit: u32, fields: Option<Vec<String>>, bounds: Option<[f64; 4]>, allow_approximate_datum: Option<bool>) -> Result<Value, String> {
    validate_read(limit, fields.as_deref(), bounds)?;
    let state = state.inner().clone();
    let source = state.sources.lock().map_err(|_| "GDB_STATE_UNAVAILABLE")?.get(&source_id).cloned().ok_or("GDB_SOURCE_EXPIRED: reopen the GDB source")?;
    let job = state.begin(&request_id)?;
    let copy = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            if fingerprint_checked(&source.path, Some(&job.cancelled))? != source.fingerprint { return Err("GDB_SOURCE_CHANGED: source changed since discovery; reopen it".into()); }
            let request = json!({"operation":"read", "path":source.path, "layerName":layer_name, "limit":limit, "fields":fields, "bounds":bounds, "allowApproximateDatum":allow_approximate_datum.unwrap_or(false)});
            let mut result = run_worker(&runtime_root(&app)?, &request, &job, Duration::from_secs(120))?;
            if fingerprint_checked(&source.path, Some(&job.cancelled))? != source.fingerprint { return Err("GDB_SOURCE_CHANGED: source changed during reading; reopen it".into()); }
            cancelled(&job)?;
            result["sourceFingerprint"] = json!(source.fingerprint);
            Ok(result)
        })();
        copy.finish(&job.id);
        result
    }).await.map_err(|_| "GDB_WORKER_FAILED: read task failed".to_string())?;
    state.finish(&request_id);
    result
}

#[tauri::command]
pub fn gdb_cancel(state: State<'_, GdbState>, request_id: String) -> Result<(), String> {
    let active = state.active.lock().map_err(|_| "GDB_STATE_UNAVAILABLE")?;
    if let Some(job) = active.as_ref().filter(|job| job.id == request_id) { stop_job(job); }
    Ok(())
}

/// Called before Tauri initialization; worker mode never opens a desktop window or database.
pub fn worker_entry() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_none_or(|a| a != "--gdb-worker") { return None; }
    let result = (|| {
        if args.len() != 3 { return Err("GDB_REQUEST_INVALID: missing bundled runtime path".into()); }
        let mut bytes = Vec::new();
        std::io::stdin().take(1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "GDB_REQUEST_INVALID: cannot read input")?;
        if bytes.len() > 1024 * 1024 { return Err("GDB_REQUEST_INVALID: request exceeds 1 MiB".into()); }
        let request: Value = serde_json::from_slice(&bytes).map_err(|_| "GDB_REQUEST_INVALID: invalid input JSON")?;
        crate::gdb_native::execute(Path::new(&args[2]), &request)
    })();
    let (envelope, code) = match result {
        Ok(value) => (json!({"ok":true,"result":value}), 0),
        Err(error) => (json!({"ok":false,"error":error}), 1),
    };
    let mut stdout = std::io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &envelope).is_err() || stdout.flush().is_err() { return Some(1); }
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn read_selection_rejects_invalid_limits_fields_and_date_line() {
        assert!(validate_read(0, None, None).is_err());
        assert!(validate_read(100_001, None, None).is_err());
        assert!(validate_read(10, Some(&["name".into(), "name".into()]), None).is_err());
        assert!(validate_read(10, None, Some([179.0, -10.0, -179.0, 10.0])).is_err());
        assert!(validate_read(10, None, Some([0.0, f64::NAN, 1.0, 2.0])).is_err());
        assert!(validate_read(10, Some(&[]), Some([110.0, 20.0, 120.0, 30.0])).is_ok());
    }
    #[test]
    fn jobs_are_exclusive_and_cancel_is_scoped() {
        let state = GdbState::default();
        let job = state.begin("first").unwrap();
        assert!(state.begin("second").is_err());
        state.finish("other");
        assert!(state.begin("second").is_err());
        stop_job(&job);
        assert!(cancelled(&job).is_err());
        state.finish("first");
        assert!(state.begin("second").is_ok());
    }
    #[test]
    fn fingerprints_detect_changes_but_ignore_lock_files() {
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().join("data.gdb"); fs::create_dir(&path).unwrap();
        fs::write(path.join("a00000001.gdbtable"), b"first").unwrap();
        let initial = fingerprint(&path).unwrap();
        fs::write(path.join("runtime.lock"), b"lock").unwrap();
        assert_eq!(initial, fingerprint(&path).unwrap());
        fs::write(path.join("a00000001.gdbtable"), b"longer value").unwrap();
        assert_ne!(initial, fingerprint(&path).unwrap());
        assert!(source_path(&path).is_ok());
        assert!(source_path(temp.path()).is_err());
    }
}
