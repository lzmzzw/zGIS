use crate::recovery_upload::{self, RecoveryPart, RecoveryUpload, UPLOAD_IDLE_TIMEOUT};
use crate::staged_file::StagedFile;
use std::{
    sync::{Arc, OnceLock},
    time::Instant,
};
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

struct CompletedContent {
    id: Uuid,
    content: StagedFile,
    completed_at: Instant,
}

struct FileContentUpload {
    receiver: RecoveryUpload,
    completed: Option<CompletedContent>,
}

impl FileContentUpload {
    fn new(max_bytes: usize) -> Self {
        Self {
            receiver: RecoveryUpload::new_text(max_bytes),
            completed: None,
        }
    }

    fn clear(&mut self) {
        self.receiver.clear();
        self.completed = None;
    }

    fn expiration_delay(&mut self, now: Instant) -> Option<std::time::Duration> {
        let receiving = self.receiver.expiration_delay(now);
        let completed = self.completed.as_ref().and_then(|content| {
            UPLOAD_IDLE_TIMEOUT.checked_sub(now.saturating_duration_since(content.completed_at))
        });
        if self.completed.is_some() && completed.is_none_or(|delay| delay.is_zero()) {
            self.completed = None;
        }
        match (receiving, completed.filter(|delay| !delay.is_zero())) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left, right) => left.or(right),
        }
    }

    fn accept(&mut self, part: RecoveryPart, bytes: Vec<u8>, now: Instant) -> Result<(), String> {
        self.expiration_delay(now);
        let id = part.id();
        if part.is_start() {
            // 同时最多保留一个上传或一个完整正文，避免累计多份大输出。
            self.clear();
        }
        let result = self.receiver.accept(Some(part), bytes, now).map(|file| {
            if let Some(content) = file {
                self.completed = Some(CompletedContent {
                    id,
                    content,
                    completed_at: now,
                });
            }
        });
        if result.is_err() {
            self.clear();
        }
        result
    }

    fn take(&mut self, id: Uuid, now: Instant) -> Result<StagedFile, String> {
        self.expiration_delay(now);
        let content = self
            .completed
            .take()
            .ok_or("输出正文不存在或已过期，请重新保存")?;
        if content.id != id {
            return Err("输出正文标识不匹配，请重新保存".into());
        }
        Ok(content.content)
    }
}

struct UploadState {
    upload: Arc<Mutex<FileContentUpload>>,
    wake: Arc<Notify>,
}

fn state() -> &'static UploadState {
    static STATE: OnceLock<UploadState> = OnceLock::new();
    STATE.get_or_init(|| {
        let upload = Arc::new(Mutex::new(FileContentUpload::new(crate::MAX_FILE as usize)));
        let wake = Arc::new(Notify::new());
        let cleaner_upload = upload.clone();
        let cleaner_wake = wake.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let notified = cleaner_wake.notified();
                let delay = cleaner_upload.lock().await.expiration_delay(Instant::now());
                if let Some(delay) = delay {
                    let _ = tokio::time::timeout(delay, notified).await;
                } else {
                    notified.await;
                }
            }
        });
        UploadState { upload, wake }
    })
}

fn request_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, String> {
    let limit = recovery_upload::MAX_CHUNK_BYTES;
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            if bytes.len() > limit {
                return Err("输出分片超过 1 MiB".into());
            }
            Ok(bytes.clone())
        }
        // WebView2 postMessage 降级路径把二进制正文转换为字节数组。
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(values)) => {
            if values.len() > limit {
                return Err("输出分片超过 1 MiB".into());
            }
            values
                .iter()
                .map(|value| {
                    value
                        .as_u64()
                        .filter(|number| *number <= 255)
                        .map(|number| number as u8)
                        .ok_or_else(|| "输出分片结构无效".to_string())
                })
                .collect()
        }
        _ => Err("输出分片结构无效".into()),
    }
}

pub(crate) async fn stage(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let packet = recovery_upload::parse_output_headers(request.headers()).and_then(|part| {
        let part = part.ok_or("输出分片请求头缺失")?;
        request_bytes(request.body()).map(|bytes| (part, bytes))
    });
    let state = state();
    let mut guard = state.upload.clone().lock_owned().await;
    let wake = state.wake.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        let result = match packet {
            Ok((part, bytes)) => guard.accept(part, bytes, Instant::now()),
            Err(error) => {
                guard.clear();
                Err(error)
            }
        };
        wake.notify_one();
        result
    })
    .await
    {
        Ok(result) => result,
        Err(_) => {
            state.upload.lock().await.clear();
            state.wake.notify_one();
            Err("输出正文接收失败".into())
        }
    }
}

pub(crate) async fn take(id: &str) -> Result<StagedFile, String> {
    let id = Uuid::parse_str(id).map_err(|_| "输出正文标识无效".to_string())?;
    let state = state();
    let result = state.upload.lock().await.take(id, Instant::now());
    state.wake.notify_one();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "56be7bdd-0f21-4ec3-b9ee-482ec27f6242";
    const OTHER_ID: &str = "36e3bfb5-ec46-42cd-bbfe-ea0055879bb7";

    fn part(id: &str, index: usize, final_part: bool) -> RecoveryPart {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert("x-zgis-output-id", id.parse().unwrap());
        headers.insert("x-zgis-output-part", index.to_string().parse().unwrap());
        headers.insert(
            "x-zgis-output-final",
            final_part.to_string().parse().unwrap(),
        );
        recovery_upload::parse_output_headers(&headers)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn csv_utf8_can_span_chunks_and_content_is_consumed_once() {
        let mut upload = FileContentUpload::new(64);
        let now = Instant::now();
        let content = "name,value\n中文😀,1\n";
        let bytes = content.as_bytes();
        upload
            .accept(part(ID, 0, false), bytes[..13].to_vec(), now)
            .unwrap();
        assert!(upload.completed.is_none());
        upload
            .accept(part(ID, 1, true), bytes[13..].to_vec(), now)
            .unwrap();
        assert_eq!(
            upload
                .take(Uuid::parse_str(ID).unwrap(), now)
                .unwrap()
                .test_bytes(),
            content.as_bytes()
        );
        assert!(upload.take(Uuid::parse_str(ID).unwrap(), now).is_err());
    }

    #[test]
    fn new_upload_discards_unconsumed_content_and_wrong_ids_cannot_consume_it() {
        let mut upload = FileContentUpload::new(32);
        let now = Instant::now();
        upload
            .accept(part(ID, 0, true), b"old".to_vec(), now)
            .unwrap();
        upload
            .accept(part(OTHER_ID, 0, false), b"new".to_vec(), now)
            .unwrap();
        assert!(upload.completed.is_none());
        assert!(upload.take(Uuid::parse_str(ID).unwrap(), now).is_err());
        upload
            .accept(part(OTHER_ID, 1, true), b"!".to_vec(), now)
            .unwrap();
        assert!(upload.take(Uuid::parse_str(ID).unwrap(), now).is_err());
        assert!(upload.completed.is_none());
    }

    #[test]
    fn incomplete_and_completed_outputs_expire_without_another_upload() {
        let mut upload = FileContentUpload::new(32);
        let now = Instant::now();
        upload
            .accept(part(ID, 0, true), b"csv".to_vec(), now)
            .unwrap();
        assert_eq!(upload.expiration_delay(now), Some(UPLOAD_IDLE_TIMEOUT));
        assert!(upload.expiration_delay(now + UPLOAD_IDLE_TIMEOUT).is_none());
        assert!(upload.completed.is_none());
        assert!(upload
            .take(Uuid::parse_str(ID).unwrap(), now + UPLOAD_IDLE_TIMEOUT)
            .is_err());
        upload
            .accept(part(ID, 0, false), b"csv".to_vec(), now)
            .unwrap();
        assert!(upload.expiration_delay(now + UPLOAD_IDLE_TIMEOUT).is_none());
        assert!(upload
            .accept(part(ID, 1, true), b"!".to_vec(), now + UPLOAD_IDLE_TIMEOUT)
            .is_err());
    }

    #[test]
    fn output_limits_order_and_utf8_failures_release_the_buffer() {
        let mut upload = FileContentUpload::new(8);
        let now = Instant::now();
        upload
            .accept(part(ID, 0, false), b"12345678".to_vec(), now)
            .unwrap();
        assert!(upload
            .accept(part(ID, 1, true), b"9".to_vec(), now)
            .is_err());
        assert!(upload.expiration_delay(now).is_none());
        upload
            .accept(part(ID, 0, false), b"start".to_vec(), now)
            .unwrap();
        assert!(upload
            .accept(part(ID, 2, true), b"end".to_vec(), now)
            .is_err());
        assert!(upload.expiration_delay(now).is_none());
        assert!(upload.accept(part(ID, 0, true), vec![0xff], now).is_err());
        assert!(upload.completed.is_none());
        assert!(upload.expiration_delay(now).is_none());
    }

    #[test]
    fn accepts_only_bounded_raw_or_valid_byte_array_packets() {
        use serde_json::json;
        use tauri::ipc::InvokeBody;
        assert_eq!(
            request_bytes(&InvokeBody::Raw(b"csv".to_vec())).unwrap(),
            b"csv"
        );
        assert_eq!(
            request_bytes(&InvokeBody::Json(json!([0, 255]))).unwrap(),
            [0, 255]
        );
        for value in [
            json!([-1]),
            json!([256]),
            json!([1.5]),
            json!({"content":"csv"}),
        ] {
            assert!(request_bytes(&InvokeBody::Json(value)).is_err());
        }
        assert!(request_bytes(&InvokeBody::Raw(vec![
            0;
            recovery_upload::MAX_CHUNK_BYTES + 1
        ]))
        .is_err());
    }
}
