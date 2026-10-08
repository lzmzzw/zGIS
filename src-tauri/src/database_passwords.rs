use std::collections::BTreeMap;
use tauri::{Manager, State};

#[derive(Default)]
pub struct PasswordStore(std::sync::Mutex<()>);

fn entry_key(engine: &str, source_id: &str) -> Result<String, String> {
    if !["postgis", "mysql"].contains(&engine) || source_id.is_empty() || source_id.len() > 512 || source_id.chars().any(char::is_control) {
        return Err("数据源标识无效".into());
    }
    Ok(format!("{engine}:{source_id}"))
}
fn location(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|_| "密码存储目录不可用")?.join("database-passwords.dat"))
}
fn read(path: &std::path::Path) -> Result<BTreeMap<String, String>, String> {
    if !path.exists() { return Ok(BTreeMap::new()); }
    if std::fs::metadata(path).map_err(|_| "密码存储不可读")?.len() > 1024 * 1024 + 4096 { return Err("密码存储过大".into()); }
    let encrypted = std::fs::read(path).map_err(|_| "密码存储不可读")?;
    let bytes = super::preferences::crypt(&encrypted, false).map_err(|_| "密码存储解密失败")?;
    serde_json::from_slice(&bytes).map_err(|_| "密码存储无效".into())
}
fn write(path: &std::path::Path, passwords: &BTreeMap<String, String>) -> Result<(), String> {
    let bytes = serde_json::to_vec(passwords).map_err(|_| "密码存储无效")?;
    if bytes.len() > 1024 * 1024 { return Err("密码存储过大".into()); }
    let encrypted = super::preferences::crypt(&bytes, true).map_err(|_| "密码加密失败")?;
    std::fs::create_dir_all(path.parent().ok_or("密码存储目录不可用")?).map_err(|_| "密码存储目录不可写")?;
    super::atomic_write(path, &encrypted).map_err(|_| "密码存储写入失败".into())
}
#[tauri::command]
pub fn load_database_source_password(app: tauri::AppHandle, state: State<'_, PasswordStore>, engine: String, source_id: String) -> Result<Option<String>, String> {
    let key = entry_key(&engine, &source_id)?;
    let _guard = state.0.lock().map_err(|_| "密码存储暂不可用")?;
    Ok(read(&location(&app)?)?.remove(&key))
}
#[tauri::command]
pub fn save_database_source_password(app: tauri::AppHandle, state: State<'_, PasswordStore>, engine: String, source_id: String, password: String) -> Result<(), String> {
    if password.len() > 4096 { return Err("密码超过长度限制".into()); }
    let key = entry_key(&engine, &source_id)?;
    let _guard = state.0.lock().map_err(|_| "密码存储暂不可用")?;
    let path = location(&app)?;
    let mut passwords = read(&path)?;
    passwords.insert(key, password);
    write(&path, &passwords)
}
#[tauri::command]
pub fn delete_database_source_password(app: tauri::AppHandle, state: State<'_, PasswordStore>, engine: String, source_id: String) -> Result<(), String> {
    let key = entry_key(&engine, &source_id)?;
    let _guard = state.0.lock().map_err(|_| "密码存储暂不可用")?;
    let path = location(&app)?;
    let mut passwords = read(&path)?;
    passwords.remove(&key);
    write(&path, &passwords)
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn password_store_encrypts_and_preserves_per_engine_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("passwords.dat");
        let mut values = BTreeMap::new();
        values.insert(entry_key("postgis", "source").unwrap(), "sample-password".into());
        values.insert(entry_key("mysql", "source").unwrap(), "second-sample".into());
        write(&path, &values).unwrap();
        let encrypted = std::fs::read(&path).unwrap();
        assert!(!encrypted.windows(b"sample-password".len()).any(|w| w == b"sample-password"));
        assert_eq!(read(&path).unwrap(), values);
        values.remove("postgis:source"); write(&path, &values).unwrap();
        assert_eq!(read(&path).unwrap().len(), 1);
        std::fs::write(&path, b"corrupt").unwrap();
        assert!(read(&path).is_err());
        assert!(entry_key("unknown", "source").is_err());
    }
}
