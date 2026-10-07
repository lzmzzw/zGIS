use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{header, redirect::Policy, Url};
use std::time::Duration;

const MAX_URL: usize = 8192;
const MAX_BODY: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

fn valid_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.as_str().len() <= MAX_URL
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "获取瓦片超时".into()
    } else {
        "无法获取瓦片，请检查底图服务".into()
    }
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

async fn fetch_tile(raw_url: &str, timeout: Duration) -> Result<String, String> {
    if raw_url.len() > MAX_URL {
        return Err("瓦片地址过长".into());
    }
    let url = Url::parse(raw_url).map_err(|_| "瓦片地址无效")?;
    if !valid_url(&url) {
        return Err("瓦片地址仅支持无账号密码的 HTTP(S) 地址".into());
    }
    let client = reqwest::Client::builder()
        .tls_backend_native()
        .user_agent("zGIS/0.1.0 (basemap preview)")
        .timeout(timeout)
        .connect_timeout(timeout)
        .referer(false)
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() > 3 || !valid_url(attempt.url()) {
                attempt.error("瓦片重定向无效")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "瓦片请求不可用")?;
    let mut response = client
        .get(url)
        .header(header::ACCEPT, "image/png,image/jpeg,image/webp,image/gif")
        .send()
        .await
        .map_err(request_error)?;
    if !response.status().is_success() {
        return Err(format!(
            "瓦片服务返回错误（HTTP {}）",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BODY as u64)
    {
        return Err("瓦片大小超过 2 MB".into());
    }
    let mime = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .ok_or("瓦片缺少图像类型")?;
    if !matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return Err("瓦片不是支持的图像格式".into());
    }
    let mut bytes = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if chunk.len() > MAX_BODY - bytes.len() {
            return Err("瓦片大小超过 2 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if image_mime(&bytes) != Some(mime.as_str()) {
        return Err("瓦片图像内容无效".into());
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn fetch_basemap_tile(url: String) -> Result<String, String> {
    fetch_tile(&url, REQUEST_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        task::JoinHandle,
    };

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

    struct Server {
        base: String,
        task: JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn response(status: &str, headers: &str, bytes: &[u8]) -> Vec<u8> {
        let mut result = format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
            bytes.len()
        )
        .into_bytes();
        result.extend_from_slice(bytes);
        result
    }

    async fn server() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let base = format!("http://{address}");
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while request.len() <= 16384 && !request.windows(4).any(|part| part == b"\r\n\r\n")
                {
                    let Ok(size) = socket.read(&mut buffer).await else {
                        break;
                    };
                    if size == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..size]);
                }
                let text = String::from_utf8_lossy(&request);
                let path = text
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .split('?')
                    .next()
                    .unwrap();
                let png = STANDARD.decode(PNG).unwrap();
                let data = match path {
                    "/user-agent" if text.lines().any(|line| line.eq_ignore_ascii_case("user-agent: zGIS/0.1.0 (basemap preview)")) => response("200 OK", "Content-Type: image/png\r\n", &png),
                    "/tile" => response("200 OK", "Content-Type: image/png; charset=binary\r\n", &png),
                    "/jpeg" => response("200 OK", "Content-Type: image/jpeg\r\n", b"\xff\xd8\xff\xe0\xff\xd9"),
                    "/webp" => response("200 OK", "Content-Type: image/webp\r\n", b"RIFF\x04\0\0\0WEBP"),
                    "/gif" => response("200 OK", "Content-Type: image/gif\r\n", b"GIF89a\x01\0\x01\0"),
                    "/error" => response("403 Forbidden", "Content-Type: text/plain\r\n", b"query-secret-server-body"),
                    "/html" => response("200 OK", "Content-Type: image/png\r\n", b"<html>query-secret-server-body</html>"),
                    "/mime" => response("200 OK", "Content-Type: text/html\r\n", &png),
                    "/no-mime" => response("200 OK", "", &png),
                    "/mismatch" => response("200 OK", "Content-Type: image/jpeg\r\n", &png),
                    "/declared-large" => format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_BODY + 1).into_bytes(),
                    "/chunked-large" => {
                        let mut bytes = vec![0; MAX_BODY + 1];
                        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
                        let mut result = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n", bytes.len()).into_bytes();
                        result.extend_from_slice(&bytes);
                        result.extend_from_slice(b"\r\n0\r\n\r\n");
                        result
                    }
                    "/slow-headers" => {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        response("200 OK", "Content-Type: image/png\r\n", &png)
                    }
                    "/slow-body" => {
                        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", png.len());
                        let _ = socket.write_all(headers.as_bytes()).await;
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        png
                    }
                    "/redirect" | "/hop3" => response("302 Found", "Location: /tile\r\n", b""),
                    "/hop2" => response("302 Found", "Location: /hop3\r\n", b""),
                    "/hop1" => response("302 Found", "Location: /hop2\r\n", b""),
                    "/hop0" => response("302 Found", "Location: /hop1\r\n", b""),
                    "/loop" => response("302 Found", "Location: /loop\r\n", b""),
                    "/redirect-user" => response("302 Found", &format!("Location: http://query-secret:password-secret@{address}/tile\r\n"), b""),
                    "/redirect-scheme" => response("302 Found", "Location: ftp://invalid.example/tile?token=query-secret\r\n", b""),
                    "/redirect-long" => response("302 Found", &format!("Location: http://{address}/tile?token=query-secret{}\r\n", "x".repeat(MAX_URL)), b""),
                    _ => response("404 Not Found", "", b""),
                };
                let _ = socket.write_all(&data).await;
            }
        });
        Server { base, task }
    }

    fn assert_sanitized(error: &str) {
        for forbidden in [
            "query-secret",
            "password-secret",
            "http://",
            "https://",
            "127.0.0.1",
            "server-body",
        ] {
            assert!(!error.contains(forbidden), "错误应脱敏：{error}");
        }
    }

    #[tokio::test]
    async fn returns_image_data_and_follows_at_most_three_redirects() {
        let server = server().await;
        let expected = format!("data:image/png;base64,{PNG}");
        for path in ["/tile", "/user-agent", "/redirect", "/hop1"] {
            assert_eq!(
                fetch_basemap_tile(format!("{}{path}?token=query-secret", server.base))
                    .await
                    .unwrap(),
                expected
            );
        }
        for (path, mime) in [
            ("/jpeg", "image/jpeg"),
            ("/webp", "image/webp"),
            ("/gif", "image/gif"),
        ] {
            assert!(fetch_basemap_tile(format!("{}{path}", server.base))
                .await
                .unwrap()
                .starts_with(&format!("data:{mime};base64,")));
        }
    }

    #[tokio::test]
    async fn enforces_declared_and_streamed_body_limits() {
        let server = server().await;
        for path in ["/declared-large", "/chunked-large"] {
            let error = fetch_basemap_tile(format!("{}{path}?token=query-secret", server.base))
                .await
                .unwrap_err();
            assert!(error.contains("2 MB"));
            assert_sanitized(&error);
        }
    }

    #[tokio::test]
    async fn rejects_status_non_images_and_mime_mismatch_without_exposing_response_details() {
        let server = server().await;
        for path in ["/error", "/html", "/mime", "/no-mime", "/mismatch"] {
            let error = fetch_basemap_tile(format!("{}{path}?token=query-secret", server.base))
                .await
                .unwrap_err();
            assert_sanitized(&error);
            if path == "/error" {
                assert!(error.contains("403"));
            }
        }
    }

    #[tokio::test]
    async fn rejects_unsafe_redirects_and_excessive_hops() {
        let server = server().await;
        for path in [
            "/redirect-user",
            "/redirect-scheme",
            "/redirect-long",
            "/hop0",
            "/loop",
        ] {
            let error = fetch_basemap_tile(format!("{}{path}?token=query-secret", server.base))
                .await
                .unwrap_err();
            assert_sanitized(&error);
        }
    }

    #[tokio::test]
    async fn timeouts_cover_waiting_for_headers_and_reading_body() {
        for path in ["/slow-headers", "/slow-body"] {
            let server = server().await;
            let error = fetch_tile(
                &format!("{}{path}?token=query-secret", server.base),
                Duration::from_millis(80),
            )
            .await
            .unwrap_err();
            assert!(error.contains("超时"));
            assert_sanitized(&error);
        }
    }

    #[tokio::test]
    async fn rejects_invalid_urls_and_connection_failure_without_leaking_tokens() {
        for url in [
            "not a URL?token=query-secret",
            "file:///query-secret",
            "ftp://invalid.example/query-secret",
            "http://query-secret:password-secret@127.0.0.1/tile",
        ] {
            assert_sanitized(&fetch_basemap_tile(url.into()).await.unwrap_err());
        }
        let long = format!(
            "http://127.0.0.1/tile?token=query-secret{}",
            "x".repeat(MAX_URL)
        );
        assert!(fetch_basemap_tile(long).await.unwrap_err().contains("过长"));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = fetch_basemap_tile(format!("http://{address}/tile?token=query-secret"))
            .await
            .unwrap_err();
        assert_sanitized(&error);
    }
}
