use crate::staged_file::StagedFile;
use std::time::{Duration, Instant};
use tauri::http::HeaderMap;
use uuid::Uuid;

pub(crate) const MAX_CHUNK_BYTES: usize = 1024 * 1024;
pub(crate) const UPLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const HEADER_NAMES: [&str; 3] = [
    "x-zgis-recovery-id",
    "x-zgis-recovery-part",
    "x-zgis-recovery-final",
];
const OUTPUT_HEADER_NAMES: [&str; 3] = [
    "x-zgis-output-id",
    "x-zgis-output-part",
    "x-zgis-output-final",
];

#[derive(Debug)]
pub(crate) struct RecoveryPart {
    id: Uuid,
    index: usize,
    final_part: bool,
}

impl RecoveryPart {
    pub(crate) fn id(&self) -> Uuid {
        self.id
    }

    pub(crate) fn is_start(&self) -> bool {
        self.index == 0
    }
}

#[derive(Clone, Copy)]
enum UploadFormat {
    Json,
    Utf8,
}

impl UploadFormat {
    fn error(self, message: &str) -> String {
        format!(
            "{}{message}",
            match self {
                Self::Json => "恢复",
                Self::Utf8 => "输出",
            }
        )
    }
}

pub(crate) fn parse_headers(headers: &HeaderMap) -> Result<Option<RecoveryPart>, String> {
    parse_headers_for(headers, HEADER_NAMES, UploadFormat::Json)
}

pub(crate) fn parse_output_headers(headers: &HeaderMap) -> Result<Option<RecoveryPart>, String> {
    parse_headers_for(headers, OUTPUT_HEADER_NAMES, UploadFormat::Utf8)
}

fn parse_headers_for(
    headers: &HeaderMap,
    names: [&str; 3],
    format: UploadFormat,
) -> Result<Option<RecoveryPart>, String> {
    if names.iter().all(|name| !headers.contains_key(*name)) {
        return Ok(None);
    }
    let mut values = Vec::with_capacity(names.len());
    for name in names {
        let mut entries = headers.get_all(name).iter();
        let value = entries
            .next()
            .ok_or_else(|| format.error("分片请求头无效"))?;
        if entries.next().is_some() {
            return Err(format.error("分片请求头无效"));
        }
        values.push(value.to_str().map_err(|_| format.error("分片请求头无效"))?);
    }
    let id = Uuid::parse_str(values[0]).map_err(|_| format.error("分片标识无效"))?;
    if values[1].is_empty() || !values[1].bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format.error("分片序号无效"));
    }
    let index = values[1]
        .parse()
        .map_err(|_| format.error("分片序号无效"))?;
    let final_part = match values[2] {
        "true" => true,
        "false" => false,
        _ => return Err(format.error("分片结束标记无效")),
    };
    Ok(Some(RecoveryPart {
        id,
        index,
        final_part,
    }))
}

struct PendingUpload {
    id: Uuid,
    next_index: usize,
    file: StagedFile,
    last_activity: Instant,
}

pub(crate) struct RecoveryUpload {
    pending: Option<PendingUpload>,
    max_chunk_bytes: usize,
    max_bytes: usize,
    idle_timeout: Duration,
    format: UploadFormat,
}

impl RecoveryUpload {
    pub(crate) fn new(max_bytes: usize) -> Self {
        Self::with_limits(MAX_CHUNK_BYTES, max_bytes, UPLOAD_IDLE_TIMEOUT)
    }

    pub(crate) fn new_text(max_bytes: usize) -> Self {
        Self {
            format: UploadFormat::Utf8,
            ..Self::new(max_bytes)
        }
    }

    fn with_limits(max_chunk_bytes: usize, max_bytes: usize, idle_timeout: Duration) -> Self {
        Self {
            pending: None,
            max_chunk_bytes,
            max_bytes,
            idle_timeout,
            format: UploadFormat::Json,
        }
    }

    pub(crate) fn clear(&mut self) {
        self.pending = None;
    }

    /// 返回下一次清理期限；到期关闭并删除暂存文件。
    pub(crate) fn expiration_delay(&mut self, now: Instant) -> Option<Duration> {
        let elapsed = now.saturating_duration_since(self.pending.as_ref()?.last_activity);
        if elapsed >= self.idle_timeout {
            self.clear();
            None
        } else {
            Some(self.idle_timeout - elapsed)
        }
    }

    /// None 只表示分片已接受；Some 才是通过完整 JSON 或 UTF-8 校验的内容。
    pub(crate) fn accept(
        &mut self,
        part: Option<RecoveryPart>,
        bytes: Vec<u8>,
        now: Instant,
    ) -> Result<Option<StagedFile>, String> {
        let result = self.accept_inner(part, bytes, now);
        if result.is_err() {
            self.clear();
        }
        result
    }

    fn accept_inner(
        &mut self,
        part: Option<RecoveryPart>,
        bytes: Vec<u8>,
        now: Instant,
    ) -> Result<Option<StagedFile>, String> {
        self.expiration_delay(now);
        let format = self.format;
        let Some(part) = part else {
            self.clear();
            if bytes.len() > self.max_bytes {
                return Err(format.error("数据过大"));
            }
            let mut file = StagedFile::new()?;
            file.append(&bytes).map_err(|error| format.error(&error))?;
            return self.complete(file);
        };
        if bytes.len() > self.max_chunk_bytes {
            return Err(format.error("分片超过 1 MiB"));
        }
        if part.index == 0 {
            self.clear();
            if bytes.len() > self.max_bytes {
                return Err(format.error("数据过大"));
            }
            let mut file = StagedFile::new()?;
            file.append(&bytes).map_err(|error| format.error(&error))?;
            self.pending = Some(PendingUpload {
                id: part.id,
                next_index: 1,
                file,
                last_activity: now,
            });
        } else {
            let pending = self
                .pending
                .as_mut()
                .ok_or_else(|| format.error("分片不存在或已过期，请重新保存"))?;
            if pending.id != part.id || pending.next_index != part.index {
                return Err(format.error("分片顺序或标识不匹配，请重新保存"));
            }
            if pending
                .file
                .len()
                .checked_add(bytes.len() as u64)
                .is_none_or(|length| length > self.max_bytes as u64)
            {
                return Err(format.error("数据过大"));
            }
            pending
                .file
                .append(&bytes)
                .map_err(|error| format.error(&error))?;
            pending.next_index = pending
                .next_index
                .checked_add(1)
                .ok_or_else(|| format.error("分片序号无效"))?;
            pending.last_activity = now;
        }
        if part.final_part {
            let file = self
                .pending
                .take()
                .ok_or_else(|| format.error("分片状态无效"))?
                .file;
            self.complete(file)
        } else {
            Ok(None)
        }
    }

    fn complete(&self, mut file: StagedFile) -> Result<Option<StagedFile>, String> {
        file.finish(matches!(self.format, UploadFormat::Json))
            .map_err(|error| self.format.error(&error))?;
        Ok(Some(file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "56be7bdd-0f21-4ec3-b9ee-482ec27f6242";
    const OTHER_ID: &str = "36e3bfb5-ec46-42cd-bbfe-ea0055879bb7";

    fn headers(id: &str, index: &str, final_part: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in HEADER_NAMES.into_iter().zip([id, index, final_part]) {
            headers.insert(name, value.parse().unwrap());
        }
        headers
    }

    fn part(id: &str, index: usize, final_part: bool) -> Option<RecoveryPart> {
        Some(RecoveryPart {
            id: Uuid::parse_str(id).unwrap(),
            index,
            final_part,
        })
    }

    fn receiver() -> RecoveryUpload {
        RecoveryUpload::with_limits(16, 32, Duration::from_secs(10))
    }

    #[test]
    fn headers_require_complete_unique_and_strict_values() {
        assert!(parse_headers(&HeaderMap::new()).unwrap().is_none());
        assert!(parse_headers(&headers(ID, "0", "false")).unwrap().is_some());
        for invalid in [
            headers("bad", "0", "false"),
            headers(ID, "-1", "false"),
            headers(ID, "1.0", "false"),
            headers(ID, "+1", "false"),
            headers(ID, "184467440737095516160", "false"),
            headers(ID, "0", "TRUE"),
        ] {
            assert!(parse_headers(&invalid).is_err());
        }
        let mut missing = headers(ID, "0", "true");
        missing.remove(HEADER_NAMES[2]);
        assert!(parse_headers(&missing).is_err());
        let mut duplicate = headers(ID, "0", "true");
        duplicate.append(HEADER_NAMES[0], ID.parse().unwrap());
        assert!(parse_headers(&duplicate).is_err());
    }

    #[test]
    fn accepts_utf8_across_chunks_and_only_returns_complete_json() {
        let mut upload = receiver();
        let now = Instant::now();
        let bytes = "{\"note\":\"中文\"}".as_bytes();
        let split = 10;
        assert!(std::str::from_utf8(&bytes[..split]).is_err());
        assert!(upload
            .accept(part(ID, 0, false), bytes[..split].to_vec(), now)
            .unwrap()
            .is_none());
        assert_eq!(
            upload
                .accept(part(ID, 1, true), bytes[split..].to_vec(), now)
                .unwrap()
                .map(|mut file| file.test_bytes()),
            Some(bytes.to_vec())
        );
        assert!(upload.pending.is_none());
    }

    #[test]
    fn rejects_out_of_order_duplicate_cross_id_and_clears_buffer() {
        let now = Instant::now();
        for invalid in [part(ID, 2, true), part(OTHER_ID, 1, true)] {
            let mut upload = receiver();
            upload
                .accept(part(ID, 0, false), b"[".to_vec(), now)
                .unwrap();
            assert!(upload.accept(invalid, b"]".to_vec(), now).is_err());
            assert!(upload.pending.is_none());
            assert!(upload
                .accept(part(ID, 1, true), b"]".to_vec(), now)
                .is_err());
        }
        let mut upload = receiver();
        upload
            .accept(part(ID, 0, false), b"[".to_vec(), now)
            .unwrap();
        upload
            .accept(part(ID, 1, false), b"1".to_vec(), now)
            .unwrap();
        assert!(upload
            .accept(part(ID, 1, true), b"]".to_vec(), now)
            .is_err());
        assert!(upload.pending.is_none());
    }

    #[test]
    fn bounds_individual_and_total_bytes_without_partial_completion() {
        let now = Instant::now();
        let mut upload = receiver();
        upload
            .accept(part(ID, 0, false), vec![b' '; 16], now)
            .unwrap();
        upload
            .accept(part(ID, 1, false), vec![b' '; 16], now)
            .unwrap();
        assert_eq!(upload.pending.as_ref().unwrap().file.len(), 32);
        assert!(upload
            .accept(part(ID, 2, true), b"0".to_vec(), now)
            .unwrap_err()
            .contains("过大"));
        assert!(upload.pending.is_none());
        assert!(upload
            .accept(part(ID, 0, false), vec![b' '; 17], now)
            .is_err());
        assert!(upload.pending.is_none());
        assert!(upload.accept(None, vec![b' '; 33], now).is_err());
    }

    #[test]
    fn stages_small_chunks_on_disk_and_accepts_exact_budget_boundary() {
        let now = Instant::now();
        let bytes = b"[0,0,0,0,0,0,0,0,0,0,0,0]";
        let mut upload = RecoveryUpload::with_limits(8, bytes.len(), Duration::from_secs(10));
        for (index, chunk) in bytes.chunks(3).enumerate() {
            let final_part = index * 3 + chunk.len() == bytes.len();
            let complete = upload
                .accept(part(ID, index, final_part), chunk.to_vec(), now)
                .unwrap();
            if final_part {
                assert_eq!(
                    complete.map(|mut file| file.test_bytes()),
                    Some(bytes.to_vec())
                );
            } else {
                assert!(complete.is_none());
                let pending = upload.pending.as_ref().unwrap();
                assert!(pending.file.len() as usize <= bytes.len());
            }
        }
    }

    #[test]
    fn first_chunk_and_legacy_request_replace_incomplete_uploads() {
        let now = Instant::now();
        let mut upload = receiver();
        upload
            .accept(part(ID, 0, false), b"{\"old\":".to_vec(), now)
            .unwrap();
        upload
            .accept(part(OTHER_ID, 0, false), b"[".to_vec(), now)
            .unwrap();
        assert_eq!(
            upload
                .accept(part(OTHER_ID, 1, true), b"]".to_vec(), now)
                .unwrap()
                .map(|mut file| file.test_bytes()),
            Some(b"[]".to_vec())
        );
        upload
            .accept(part(ID, 0, false), b"[".to_vec(), now)
            .unwrap();
        assert_eq!(
            upload
                .accept(None, b"{}".to_vec(), now)
                .unwrap()
                .map(|mut file| file.test_bytes()),
            Some(b"{}".to_vec())
        );
        assert!(upload.pending.is_none());
    }

    #[test]
    fn expires_idle_upload_and_successful_chunks_refresh_deadline() {
        let now = Instant::now();
        let mut upload = receiver();
        upload
            .accept(part(ID, 0, false), b"[".to_vec(), now)
            .unwrap();
        assert_eq!(
            upload.expiration_delay(now + Duration::from_secs(9)),
            Some(Duration::from_secs(1))
        );
        upload
            .accept(
                part(ID, 1, false),
                b"0".to_vec(),
                now + Duration::from_secs(9),
            )
            .unwrap();
        assert_eq!(
            upload.expiration_delay(now + Duration::from_secs(10)),
            Some(Duration::from_secs(9))
        );
        assert!(upload
            .accept(
                part(ID, 2, true),
                b"]".to_vec(),
                now + Duration::from_secs(19)
            )
            .is_err());
        assert!(upload.pending.is_none());
        assert_eq!(
            upload
                .accept(
                    part(OTHER_ID, 0, true),
                    b"[]".to_vec(),
                    now + Duration::from_secs(20)
                )
                .unwrap()
                .map(|mut file| file.test_bytes()),
            Some(b"[]".to_vec())
        );
        upload
            .accept(part(ID, 0, false), b"[".to_vec(), now)
            .unwrap();
        assert_eq!(upload.expiration_delay(now + Duration::from_secs(10)), None);
        assert!(upload.pending.is_none());
    }

    #[test]
    fn invalid_final_json_and_utf8_never_complete() {
        let now = Instant::now();
        let mut upload = receiver();
        upload
            .accept(part(ID, 0, false), b"[".to_vec(), now)
            .unwrap();
        assert!(upload
            .accept(part(ID, 1, true), b"}".to_vec(), now)
            .is_err());
        assert!(upload.pending.is_none());
        assert!(upload.accept(part(ID, 0, true), vec![0xff], now).is_err());
        assert!(upload.pending.is_none());
    }
}
