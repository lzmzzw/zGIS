//! Keychain 保存本机密钥和 MCP 令牌；配置与数据库密码只以认证密文落盘。
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
#[cfg(target_os = "macos")]
use security_framework::passwords::{get_generic_password, set_generic_password};

#[cfg(target_os = "macos")]
const SERVICE: &str = "zGIS";
#[cfg(target_os = "macos")]
const KEY_ACCOUNT: &str = "local-storage-key-v1";
const HEADER: &[u8] = b"zGIS-AES-GCM-v1\0";
#[cfg(target_os = "macos")]
static KEYCHAIN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(target_os = "macos")]
fn read(account: &str) -> Result<Option<Vec<u8>>, String> {
    match get_generic_password(SERVICE, account) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code() == -25300 => Ok(None), // errSecItemNotFound
        Err(_) => Err("无法读取 macOS 钥匙串，请检查钥匙串访问权限".into()),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    let _guard = KEYCHAIN_LOCK.lock().map_err(|_| "安全存储暂不可用")?;
    let mut key = match read(KEY_ACCOUNT)? {
        Some(key) => key,
        None if encrypt => {
            let key = Aes256Gcm::generate_key(&mut OsRng).to_vec();
            set_generic_password(SERVICE, KEY_ACCOUNT, &key)
                .map_err(|_| "无法将本机加密密钥保存到 macOS 钥匙串")?;
            key
        }
        None => return Err("macOS 钥匙串中缺少本机加密密钥".into()),
    };
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "本机加密密钥无效");
    key.fill(0);
    crypt_with_cipher(&cipher?, bytes, encrypt)
}

fn crypt_with_cipher(cipher: &Aes256Gcm, bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    if encrypt {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let encrypted = cipher.encrypt(&nonce, bytes).map_err(|_| "配置加密失败")?;
        Ok([HEADER, &nonce[..], &encrypted].concat())
    } else {
        let payload = bytes.strip_prefix(HEADER).filter(|payload| payload.len() >= 12 + 16)
            .ok_or("配置密文格式无效")?;
        cipher.decrypt(Nonce::from_slice(&payload[..12]), &payload[12..])
            .map_err(|_| "配置解密失败或密文已损坏".into())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn mcp_token() -> Result<String, String> {
    let _guard = KEYCHAIN_LOCK.lock().map_err(|_| "安全存储暂不可用")?;
    if let Some(bytes) = read(super::mcp_credentials::TARGET)? {
        return String::from_utf8(bytes).ok()
            .filter(|token| token.len() == 36 && uuid::Uuid::parse_str(token).is_ok())
            .ok_or_else(|| "macOS 钥匙串中的 MCP 固定令牌格式无效".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    set_generic_password(SERVICE, super::mcp_credentials::TARGET, token.as_bytes())
        .map_err(|_| "无法将 MCP 固定令牌保存到 macOS 钥匙串")?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_ciphertext_roundtrip_and_tampering() {
        let cipher = Aes256Gcm::new_from_slice(&[7; 32]).unwrap();
        let original = b"{\"password\":\"test-only\"}";
        let mut encrypted = crypt_with_cipher(&cipher, original, true).unwrap();
        assert_ne!(encrypted, original);
        assert_eq!(crypt_with_cipher(&cipher, &encrypted, false).unwrap(), original);
        let last = encrypted.len() - 1;
        encrypted[last] ^= 1;
        assert!(crypt_with_cipher(&cipher, &encrypted, false).is_err());
        assert!(crypt_with_cipher(&cipher, b"corrupt", false).is_err());
        let other = Aes256Gcm::new_from_slice(&[8; 32]).unwrap();
        assert!(crypt_with_cipher(&other, &encrypted, false).is_err());
    }
}
