use tauri::Manager;

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if encrypt { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        else { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    };
    if ok == 0 { return Err("底图配置加密或解密失败".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as *mut _); }
    Ok(result)
}
#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> Result<Vec<u8>, String> { Err("底图配置安全存储仅支持 Windows".into()) }

#[tauri::command]
pub fn save_preferences(app: tauri::AppHandle, content: String) -> Result<(), String> {
    if content.len() > 1024 * 1024 { return Err("底图配置过大".into()); }
    let _: serde_json::Value = serde_json::from_str(&content).map_err(|_| "底图配置无效")?;
    let dir = app.path().app_local_data_dir().map_err(|_| "配置目录不可用")?;
    std::fs::create_dir_all(&dir).map_err(|_| "配置目录不可写")?;
    super::atomic_write(&dir.join("basemaps.dat"), &crypt(content.as_bytes(), true)?)
}
#[tauri::command]
pub fn load_preferences(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app.path().app_local_data_dir().map_err(|_| "配置目录不可用")?.join("basemaps.dat");
    if !path.exists() { return Ok(None); }
    if std::fs::metadata(&path).map_err(|_| "配置不可读")?.len() > 1024 * 1024 + 4096 { return Err("底图配置过大".into()); }
    let bytes = std::fs::read(path).map_err(|_| "配置不可读")?;
    String::from_utf8(crypt(&bytes, false)?).map(Some).map_err(|_| "底图配置无效".into())
}
#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn encrypted_roundtrip() {
        let original = b"{\"tk\":\"test-only\"}";
        let encrypted = super::crypt(original, true).unwrap();
        assert_ne!(encrypted, original);
        assert_eq!(super::crypt(&encrypted, false).unwrap(), original);
        assert!(super::crypt(b"corrupt", false).is_err());
    }
}
