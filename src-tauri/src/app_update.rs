use reqwest::redirect::Policy;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;

const MAX_INSTALLER: usize = 512 * 1024 * 1024;
const MAX_METADATA: usize = 256 * 1024;
#[derive(Default)]
pub struct UpdateState(Mutex<Option<Prepared>>);
struct Prepared {
    version: String,
    path: PathBuf,
    hash: String,
}
#[derive(Serialize)]
pub struct DownloadedUpdate {
    version: String,
    installation: &'static str,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
}

fn validate_version(current: &str, expected: &str) -> Result<Version, String> {
    let version = Version::parse(expected).map_err(|_| "更新版本无效")?;
    let current = Version::parse(current).map_err(|_| "当前版本无效")?;
    if version.cmp_precedence(&current) != std::cmp::Ordering::Greater || !version.pre.is_empty() {
        return Err("仅允许安装更新的正式版本".into());
    }
    Ok(version)
}
fn asset_name(version: &Version) -> Result<String, String> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Ok(format!("zGIS_{version}_x64-setup.exe"))
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok(format!("zGIS_{version}_aarch64.dmg"))
    } else {
        Err("当前平台尚不支持下载更新".into())
    }
}
fn asset_url(asset: &Asset, version: &Version) -> Result<(), String> {
    let prefix = format!("https://github.com/lzmzzw/zGIS/releases/download/v{version}/");
    if asset.browser_download_url != format!("{prefix}{}", asset.name) {
        return Err("更新下载地址无效".into());
    }
    Ok(())
}
fn checksum(text: &str, name: &str) -> Result<String, String> {
    let mut matched = None;
    for line in text.lines() {
        let Some((hash, file)) = line.split_once("  ") else {
            continue;
        };
        if file == name {
            if matched.is_some() || hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("更新校验信息无效".into());
            }
            matched = Some(hash.to_ascii_lowercase());
        }
    }
    matched.ok_or_else(|| "更新包缺少 SHA-256 校验信息".into())
}
async fn bounded(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "下载更新失败或超时")?;
    if !response.status().is_success() {
        return Err("下载更新服务暂不可用".into());
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("更新下载超过大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "下载更新失败或超时")? {
        if chunk.len() > limit - bytes.len() {
            return Err("更新下载超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn verify_download(bytes: &[u8], size: u64, hash: &str) -> Result<(), String> {
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(bytes)) != hash {
        Err("更新包校验失败，请重新下载".into())
    } else {
        Ok(())
    }
}
fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "无法读取已下载更新包")?;
    let mut hash = Sha256::new();
    let mut total = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        let size = file.read(&mut buffer).map_err(|_| "无法读取已下载更新包")?;
        if size == 0 {
            break;
        }
        total += size;
        if total > MAX_INSTALLER {
            return Err("更新包超过大小限制".into());
        }
        hash.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[tauri::command]
pub async fn download_app_update(
    app: tauri::AppHandle,
    expected_version: String,
    state: tauri::State<'_, UpdateState>,
) -> Result<DownloadedUpdate, String> {
    // Async mutex guards cannot cross awaits: the slot is temporarily reserved by a sentinel.
    let version = validate_version(&app.package_info().version.to_string(), &expected_version)?;
    let name = asset_name(&version)?;
    {
        let mut slot = state.0.lock().map_err(|_| "更新状态不可用")?;
        if slot.as_ref().is_some_and(|p| p.version.is_empty()) {
            return Err("更新任务正在执行".into());
        }
        if let Some(old) = slot.take() {
            let _ = fs::remove_file(old.path);
        }
        *slot = Some(Prepared {
            version: String::new(),
            path: PathBuf::new(),
            hash: String::new(),
        });
    }
    let result = async {
        let client = reqwest::Client::builder()
            .tls_backend_native()
            .user_agent("zGIS (public release update)")
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .referer(false)
            .redirect(Policy::custom(|attempt| {
                let url = attempt.url();
                if attempt.previous().len() >= 5
                    || url.scheme() != "https"
                    || !matches!(
                        url.host_str(),
                        Some(
                            "github.com"
                                | "release-assets.githubusercontent.com"
                                | "objects.githubusercontent.com"
                        )
                    )
                {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| "无法初始化更新下载")?;
        let endpoint = format!("https://api.github.com/repos/lzmzzw/zGIS/releases/tags/v{version}");
        let metadata = bounded(&client, &endpoint, MAX_METADATA).await?;
        let release: Release = serde_json::from_slice(&metadata).map_err(|_| "更新发布信息无效")?;
        if release.tag_name != format!("v{version}") || release.draft || release.prerelease {
            return Err("更新发布版本不匹配".into());
        }
        let find = |name: &str| -> Result<&Asset, String> {
            let mut matches = release.assets.iter().filter(|a| a.name == name);
            let asset = matches
                .next()
                .ok_or("发布版本缺少当前平台安装包或校验文件")?;
            if matches.next().is_some() {
                return Err("发布资源重复".into());
            }
            asset_url(asset, &version)?;
            Ok(asset)
        };
        let installer = find(&name)?;
        let sums = find("SHA256SUMS.txt")?;
        if installer.size == 0
            || installer.size > MAX_INSTALLER as u64
            || sums.size > MAX_METADATA as u64
        {
            return Err("发布资源大小无效".into());
        }
        let sums = bounded(&client, &sums.browser_download_url, MAX_METADATA).await?;
        let hash = checksum(
            std::str::from_utf8(&sums).map_err(|_| "更新校验信息无效")?,
            &name,
        )?;
        let bytes = bounded(&client, &installer.browser_download_url, MAX_INSTALLER).await?;
        verify_download(&bytes, installer.size, &hash)?;
        let directory = app
            .path()
            .app_cache_dir()
            .map_err(|_| "无法定位更新缓存")?
            .join("updates");
        fs::create_dir_all(&directory).map_err(|_| "无法创建更新缓存")?;
        let path = directory.join(format!("{}-{name}", uuid::Uuid::new_v4()));
        fs::write(&path, bytes).map_err(|_| "无法保存更新包")?;
        Ok(Prepared {
            version: version.to_string(),
            path,
            hash,
        })
    }
    .await;
    let mut slot = state.0.lock().map_err(|_| "更新状态不可用")?;
    match result {
        Ok(prepared) => {
            *slot = Some(prepared);
            Ok(DownloadedUpdate {
                version: version.to_string(),
                installation: if cfg!(windows) { "restart" } else { "manual" },
            })
        }
        Err(error) => {
            *slot = None;
            Err(error)
        }
    }
}

#[tauri::command]
pub fn install_app_update(
    expected_version: String,
    state: tauri::State<'_, UpdateState>,
) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|_| "更新状态不可用")?;
    let prepared = slot
        .as_ref()
        .filter(|p| p.version == expected_version)
        .ok_or("请先下载并校验该版本更新")?;
    if file_hash(&prepared.path)? != prepared.hash {
        return Err("更新包已变化，请重新下载".into());
    }
    launch_installer(&prepared.path, &prepared.hash, &prepared.version)?;
    if cfg!(windows) {
        *slot = None;
    }
    Ok(())
}

#[cfg(windows)]
fn launch_installer(path: &Path, hash: &str, version: &str) -> Result<(), String> {
    use base64::Engine;
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|_| "无法定位当前应用")?;
    let directory = exe.parent().ok_or("无法定位安装目录")?;
    // Fixed code and environment inputs avoid interpreting paths as PowerShell code.
    let script = r#"$ErrorActionPreference='Stop'
$success = $false
$errorCode = 'helper_failed'
$detail = $null
$restart = $false
try {
try { Wait-Process -Id ([int]$env:ZGIS_UPDATE_PID) -Timeout 120 -ErrorAction Stop } catch { if (Get-Process -Id ([int]$env:ZGIS_UPDATE_PID) -ErrorAction SilentlyContinue) { $errorCode='application_exit_timeout'; throw 'stop' } }
$restart = $true
if (Get-Process -Name zgis -ErrorAction SilentlyContinue) { $errorCode='other_instance_running'; throw 'stop' }
$errorCode = 'checksum_read_failed'
if ((Get-FileHash -LiteralPath $env:ZGIS_UPDATE_PACKAGE -Algorithm SHA256).Hash -ne $env:ZGIS_UPDATE_HASH) { $errorCode='checksum_mismatch'; throw 'stop' }
$errorCode = 'installer_prepare_failed'
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $env:ZGIS_UPDATE_PACKAGE
$info.Arguments = '/S /UPDATE /D=' + $env:ZGIS_UPDATE_DIRECTORY
$info.UseShellExecute = $false
$errorCode = 'installer_launch_failed'
$process = [System.Diagnostics.Process]::Start($info)
$restart = $false
if (-not $process.WaitForExit(300000)) { $errorCode='installer_timeout'; throw 'stop' }
$restart = $true
if ($process.ExitCode -ne 0) { $errorCode='installer_failed'; throw 'stop' }
$success = $true
$errorCode = $null
Remove-Item -LiteralPath $env:ZGIS_UPDATE_PACKAGE -Force -ErrorAction SilentlyContinue
} catch { $detail = $_.FullyQualifiedErrorId }
try { @{version=$env:ZGIS_UPDATE_VERSION;success=$success;error=$errorCode;detail=$detail} | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:ZGIS_UPDATE_RESULT -Encoding UTF8 } catch { }
if ($restart) { Start-Process -FilePath $env:ZGIS_UPDATE_EXE }
"#;
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let powershell =
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法定位系统 PowerShell")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    std::process::Command::new(powershell)
        // PowerShell 7 launchers can export an incompatible module search path.
        // Let Windows PowerShell initialize its own built-in modules.
        .env_remove("PSModulePath")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            &encoded,
        ])
        .env("ZGIS_UPDATE_PID", std::process::id().to_string())
        .env("ZGIS_UPDATE_PACKAGE", path)
        .env("ZGIS_UPDATE_HASH", hash)
        .env("ZGIS_UPDATE_DIRECTORY", directory)
        .env("ZGIS_UPDATE_EXE", &exe)
        .env("ZGIS_UPDATE_VERSION", version)
        .env(
            "ZGIS_UPDATE_RESULT",
            path.parent()
                .ok_or("无法定位更新缓存")?
                .join("install-result.json"),
        )
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|_| "无法启动更新安装，请重试")?;
    Ok(())
}
#[cfg(target_os = "macos")]
fn launch_installer(path: &Path, _hash: &str, _version: &str) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(path)
        .status()
        .map_err(|_| "无法打开更新安装包")?;
    if status.success() {
        Ok(())
    } else {
        Err("无法打开更新安装包".into())
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
fn launch_installer(_path: &Path, _hash: &str, _version: &str) -> Result<(), String> {
    Err("当前平台不支持安装更新".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn download_timeout_is_reported() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let _socket = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(30))
            .build()
            .unwrap();
        assert_eq!(
            bounded(&client, &url, 8).await.unwrap_err(),
            "下载更新失败或超时"
        );
        server.abort();
    }
    #[test]
    fn downloaded_content_must_match_size_and_hash() {
        let bytes = b"installer";
        let hash = format!("{:x}", Sha256::digest(bytes));
        assert!(verify_download(bytes, bytes.len() as u64, &hash).is_ok());
        assert!(verify_download(bytes, 1, &hash).is_err());
        assert!(verify_download(b"tampered!", bytes.len() as u64, &hash).is_err());
    }
    #[tokio::test]
    async fn download_bounds_and_network_failures_are_enforced() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        for (response, expected) in [
            ("HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\n123456789", "更新下载超过大小限制"),
            ("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n9\r\n123456789\r\n0\r\n\r\n", "更新下载超过大小限制"),
            ("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", "下载更新服务暂不可用"),
            ("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nabc", "下载更新失败或超时"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096]; socket.read(&mut buffer).await.unwrap();
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().unwrap();
            assert_eq!(bounded(&client, &url, 8).await.unwrap_err(), expected);
            server.await.unwrap();
        }
    }
    #[test]
    fn refuses_downgrade_same_prerelease_and_invalid_versions() {
        for expected in ["0.1.0", "1.0.0", "1.0.1-beta.1", "../setup.exe", "v1.0.1"] {
            assert!(validate_version("1.0.0", expected).is_err());
        }
        assert!(validate_version("1.0.0", "1.0.1").is_ok());
    }
    #[test]
    fn checksum_must_match_exact_filename_once() {
        let hash = "ab".repeat(32);
        assert_eq!(
            checksum(&format!("{hash}  setup.exe\n"), "setup.exe").unwrap(),
            hash
        );
        assert!(checksum(&format!("{hash}  ../setup.exe"), "setup.exe").is_err());
        assert!(checksum("xx  setup.exe", "setup.exe").is_err());
        assert!(checksum(
            &format!("{hash}  setup.exe\n{hash}  setup.exe"),
            "setup.exe"
        )
        .is_err());
    }
    #[test]
    fn rejects_foreign_release_asset_urls() {
        let version = Version::parse("1.0.1").unwrap();
        for url in [
            "https://evil.example/setup.exe",
            "https://github.com/lzmzzw/zGIS/releases/download/v1.0.0/setup.exe",
            "file:///setup.exe",
        ] {
            assert!(asset_url(
                &Asset {
                    name: "setup.exe".into(),
                    browser_download_url: url.into(),
                    size: 1
                },
                &version
            )
            .is_err());
        }
    }
    #[test]
    fn verifies_cached_bytes_again_before_install() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("installer");
        fs::write(&path, b"original").unwrap();
        let hash = file_hash(&path).unwrap();
        fs::write(&path, b"changed").unwrap();
        assert_ne!(file_hash(&path).unwrap(), hash);
    }
}
