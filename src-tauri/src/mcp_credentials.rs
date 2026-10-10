//! 固定 MCP 令牌保存在 Windows Credential Manager 或 macOS Keychain。
pub const TARGET: &str = "zGIS/MCP";

#[cfg(windows)]
fn read() -> Result<Option<String>, String> {
    use windows_sys::Win32::{Foundation::{GetLastError, ERROR_NOT_FOUND}, Security::Credentials::*};
    let target: Vec<u16> = TARGET.encode_utf16().chain(Some(0)).collect();
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        return if unsafe { GetLastError() } == ERROR_NOT_FOUND { Ok(None) }
            else { Err("无法读取 Windows 凭据管理器中的 MCP 固定令牌".into()) };
    }
    let result = unsafe {
        let c = &*credential;
        if c.CredentialBlobSize != 72 || c.CredentialBlob.is_null() {
            Err("MCP 固定令牌格式无效，请检查 Windows 凭据管理器的 zGIS/MCP 条目".into())
        } else {
            let blob = std::slice::from_raw_parts(c.CredentialBlob.cast::<u16>(), 36);
            String::from_utf16(blob).ok()
                .filter(|value| uuid::Uuid::parse_str(value).is_ok())
                .map(Some).ok_or_else(|| "MCP 固定令牌格式无效".to_string())
        }
    };
    unsafe { CredFree(credential.cast()); }
    result
}

#[cfg(windows)]
pub fn load_or_create() -> Result<String, String> {
    use windows_sys::Win32::Security::Credentials::*;
    if let Some(token) = read()? { return Ok(token); }
    let token = uuid::Uuid::new_v4().to_string();
    let mut target: Vec<u16> = TARGET.encode_utf16().chain(Some(0)).collect();
    let mut blob: Vec<u16> = token.encode_utf16().collect();
    let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = target.as_mut_ptr();
    credential.CredentialBlobSize = (blob.len() * 2) as u32;
    credential.CredentialBlob = blob.as_mut_ptr().cast();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    let ok = unsafe { CredWriteW(&credential, 0) };
    blob.fill(0);
    if ok == 0 { Err("MCP 固定令牌无法保存到 Windows 凭据管理器".into()) } else { Ok(token) }
}

#[cfg(target_os = "macos")]
pub fn load_or_create() -> Result<String, String> { super::macos_security::mcp_token() }

#[cfg(not(any(windows, target_os = "macos")))]
pub fn load_or_create() -> Result<String, String> { Err("MCP 外部客户端鉴权仅支持 Windows".into()) }
