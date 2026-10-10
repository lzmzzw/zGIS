use reqwest::{header, redirect::Policy, StatusCode};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, time::Duration};

const RELEASE_ENDPOINT: &str = "https://api.github.com/repos/lzmzzw/zGIS/releases/latest";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY: usize = 256 * 1024;
const USER_AGENT: &str = "zGIS (public release check)";
const HTTP_ERROR: &str = "更新服务暂不可用，请稍后重试";
const TIMEOUT_ERROR: &str = "检查更新超时";
const BODY_ERROR: &str = "更新信息超过大小限制";
const RELEASE_ERROR: &str = "更新版本信息无效";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    current_version: String,
    status: UpdateStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_version: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum UpdateStatus {
    Current,
    Available,
    Unpublished,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        TIMEOUT_ERROR.into()
    } else {
        HTTP_ERROR.into()
    }
}

async fn check_release(
    current_version: &str,
    endpoint: &str,
    timeout: Duration,
) -> Result<AppUpdate, String> {
    let current = Version::parse(current_version).map_err(|_| "当前应用版本无效")?;
    let client = reqwest::Client::builder()
        .tls_backend_native()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .connect_timeout(timeout)
        .referer(false)
        .redirect(Policy::none())
        .build()
        .map_err(|_| HTTP_ERROR)?;
    let mut response = client
        .get(endpoint)
        .header(header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(request_error)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(AppUpdate {
            current_version: current.to_string(),
            status: UpdateStatus::Unpublished,
            latest_version: None,
        });
    }
    if !response.status().is_success() {
        return Err(HTTP_ERROR.into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY as u64)
    {
        return Err(BODY_ERROR.into());
    }
    let mut bytes = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if chunk.len() > MAX_BODY - bytes.len() {
            return Err(BODY_ERROR.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let release: Release = serde_json::from_slice(&bytes).map_err(|_| RELEASE_ERROR)?;
    let tag = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name);
    let latest = Version::parse(tag).map_err(|_| RELEASE_ERROR)?;
    Ok(AppUpdate {
        current_version: current.to_string(),
        status: if latest.cmp_precedence(&current) == Ordering::Greater {
            UpdateStatus::Available
        } else {
            UpdateStatus::Current
        },
        latest_version: Some(latest.to_string()),
    })
}

#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> Result<AppUpdate, String> {
    check_release(
        &app.package_info().version.to_string(),
        RELEASE_ENDPOINT,
        REQUEST_TIMEOUT,
    )
    .await
}

fn project_link(target: &str) -> Result<&'static str, String> {
    match target {
        "github" => Ok("https://github.com/lzmzzw/zGIS"),
        "license" => Ok("https://www.gnu.org/licenses/gpl-3.0.html"),
        "releases" => Ok("https://github.com/lzmzzw/zGIS/releases"),
        _ => Err("链接目标无效".into()),
    }
}

#[cfg(windows)]
fn open_link(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let url: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err("无法打开系统浏览器".into())
    }
}

#[cfg(target_os = "macos")]
fn open_link(url: &str) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url).status().map_err(|_| "无法打开系统浏览器")?;
    if status.success() { Ok(()) } else { Err("无法打开系统浏览器".into()) }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_link(_url: &str) -> Result<(), String> {
    Err("当前系统不支持打开项目链接".into())
}

#[tauri::command]
pub fn open_project_link(target: String) -> Result<(), String> {
    open_link(project_link(&target)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
        task::JoinHandle,
    };

    struct Server {
        url: String,
        task: JoinHandle<()>,
        request: oneshot::Receiver<String>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    async fn server(bytes: Vec<u8>, delay: Duration) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/latest", listener.local_addr().unwrap());
        let (sender, request) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while request.len() <= 16384 && !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let size = socket.read(&mut buffer).await.unwrap();
                if size == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..size]);
            }
            let _ = sender.send(String::from_utf8(request).unwrap());
            tokio::time::sleep(delay).await;
            let _ = socket.write_all(&bytes).await;
        });
        Server { url, task, request }
    }

    async fn release(current: &str, tag: &str) -> AppUpdate {
        let body = serde_json::json!({ "tag_name": tag }).to_string();
        let server = server(response("200 OK", body.as_bytes()), Duration::ZERO).await;
        check_release(current, &server.url, Duration::from_secs(2))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn newer_release_and_request_headers() {
        let mut server = server(
            response("200 OK", br#"{"tag_name":"v1.2.0"}"#),
            Duration::ZERO,
        )
        .await;
        let update = check_release("1.1.0", &server.url, Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(update.status, UpdateStatus::Available);
        assert_eq!(update.current_version, "1.1.0");
        assert_eq!(update.latest_version.as_deref(), Some("1.2.0"));
        let request = (&mut server.request).await.unwrap().to_ascii_lowercase();
        assert!(request.contains(&format!("user-agent: {}", USER_AGENT.to_ascii_lowercase())));
        assert!(request.contains("accept: application/vnd.github+json"));
        assert!(!request.contains("authorization:"));
        assert_eq!(
            serde_json::to_value(update).unwrap(),
            serde_json::json!({"currentVersion":"1.1.0","status":"available","latestVersion":"1.2.0"})
        );
    }

    #[tokio::test]
    async fn same_and_older_versions_are_current() {
        for tag in ["1.2.0", "v1.1.0"] {
            assert_eq!(release("1.2.0", tag).await.status, UpdateStatus::Current);
        }
    }

    #[tokio::test]
    async fn semver_prerelease_precedence() {
        for (current, latest, expected) in [
            ("1.0.0-beta.2", "v1.0.0-beta.11", UpdateStatus::Available),
            ("1.0.0-rc.1", "v1.0.0", UpdateStatus::Available),
            ("1.0.0", "v1.0.0-rc.1", UpdateStatus::Current),
        ] {
            assert_eq!(release(current, latest).await.status, expected);
        }
    }

    #[tokio::test]
    async fn build_metadata_does_not_make_an_update() {
        for (current, latest) in [("1.0.0+one", "v1.0.0+two"), ("1.0.0", "v1.0.0+one")] {
            assert_eq!(release(current, latest).await.status, UpdateStatus::Current);
        }
    }

    #[tokio::test]
    async fn missing_public_release_is_unpublished() {
        let server = server(response("404 Not Found", b"{}"), Duration::ZERO).await;
        let update = check_release("0.1.0", &server.url, Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(update.status, UpdateStatus::Unpublished);
        assert_eq!(update.latest_version, None);
        assert_eq!(
            serde_json::to_value(update).unwrap(),
            serde_json::json!({"currentVersion":"0.1.0","status":"unpublished"})
        );
    }

    #[tokio::test]
    async fn http_errors_and_redirects_are_not_current() {
        for status in ["403 Forbidden", "500 Internal Server Error", "302 Found"] {
            let server = server(response(status, b"{}"), Duration::ZERO).await;
            assert_eq!(
                check_release("0.1.0", &server.url, Duration::from_secs(2)).await,
                Err(HTTP_ERROR.into())
            );
        }
    }

    #[tokio::test]
    async fn timeout_is_reported() {
        let server = server(response("200 OK", b"{}"), Duration::from_secs(1)).await;
        assert_eq!(
            check_release("0.1.0", &server.url, Duration::from_millis(50)).await,
            Err(TIMEOUT_ERROR.into())
        );
    }

    #[tokio::test]
    async fn declared_oversize_is_rejected() {
        let server = server(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_BODY + 1
            )
            .into_bytes(),
            Duration::ZERO,
        )
        .await;
        assert_eq!(
            check_release("0.1.0", &server.url, Duration::from_secs(2)).await,
            Err(BODY_ERROR.into())
        );
    }

    #[tokio::test]
    async fn chunked_oversize_is_rejected() {
        let body = vec![b' '; MAX_BODY + 1];
        let mut bytes = format!(
            "HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n{:X}\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(&body);
        bytes.extend_from_slice(b"\r\n0\r\n\r\n");
        let server = server(bytes, Duration::ZERO).await;
        assert_eq!(
            check_release("0.1.0", &server.url, Duration::from_secs(2)).await,
            Err(BODY_ERROR.into())
        );
    }

    #[tokio::test]
    async fn malformed_release_information_is_rejected() {
        for body in [
            "not JSON",
            "{}",
            r#"{"tag_name":12}"#,
            r#"{"tag_name":"latest"}"#,
            r#"{"tag_name":"v1.2"}"#,
            r#"{"tag_name":"v1.02.3"}"#,
        ] {
            let server = server(response("200 OK", body.as_bytes()), Duration::ZERO).await;
            assert_eq!(
                check_release("0.1.0", &server.url, Duration::from_secs(2)).await,
                Err(RELEASE_ERROR.into())
            );
        }
    }

    #[test]
    fn only_fixed_project_links_are_allowed() {
        assert_eq!(
            project_link("github").unwrap(),
            "https://github.com/lzmzzw/zGIS"
        );
        assert_eq!(
            project_link("license").unwrap(),
            "https://www.gnu.org/licenses/gpl-3.0.html"
        );
        assert_eq!(
            project_link("releases").unwrap(),
            "https://github.com/lzmzzw/zGIS/releases"
        );
        for target in [
            "",
            "https://example.com",
            "Github",
            "file:///C:/",
            "github&calc",
        ] {
            assert_eq!(project_link(target), Err("链接目标无效".into()));
        }
    }
}
