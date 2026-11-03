use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};

const BUFFER_BYTES: usize = 64 * 1024;
const MAX_JSON_DEPTH: usize = 128;

pub(crate) enum FileSaveContent {
    Inline(String),
    Staged(StagedFile),
}

impl From<String> for FileSaveContent {
    fn from(content: String) -> Self {
        Self::Inline(content)
    }
}

impl FileSaveContent {
    pub(crate) fn len(&self) -> u64 {
        match self {
            Self::Inline(text) => text.len() as u64,
            Self::Staged(file) => file.len(),
        }
    }

    pub(crate) fn publish(&mut self, path: &Path, new_only: bool) -> Result<(), String> {
        match self {
            Self::Inline(content) if new_only => crate::atomic_write_new(path, content.as_bytes()),
            Self::Inline(content) => crate::atomic_write(path, content.as_bytes()),
            Self::Staged(file) => file.publish(path, new_only),
        }
    }
}

#[derive(Debug, Default)]
struct Utf8Validator {
    tail: [u8; 4],
    tail_len: usize,
}

impl Utf8Validator {
    fn append(&mut self, mut bytes: &[u8]) -> Result<(), String> {
        while self.tail_len > 0 && !bytes.is_empty() {
            self.tail[self.tail_len] = bytes[0];
            self.tail_len += 1;
            bytes = &bytes[1..];
            match std::str::from_utf8(&self.tail[..self.tail_len]) {
                Ok(_) => self.tail_len = 0,
                Err(error) if error.error_len().is_some() => return Err("数据编码无效".into()),
                Err(_) => {}
            }
        }
        if self.tail_len > 0 {
            return Ok(());
        }
        if let Err(error) = std::str::from_utf8(bytes) {
            if error.error_len().is_some() {
                return Err("数据编码无效".into());
            }
            let tail = &bytes[error.valid_up_to()..];
            self.tail[..tail.len()].copy_from_slice(tail);
            self.tail_len = tail.len();
        }
        Ok(())
    }

    fn finish(&self) -> Result<(), String> {
        if self.tail_len == 0 {
            Ok(())
        } else {
            Err("数据编码无效".into())
        }
    }
}

/// 仅持有 OS 临时文件句柄；丢弃、失败或进程退出时由 OS 关闭并删除。
#[derive(Debug)]
pub(crate) struct StagedFile {
    file: File,
    length: u64,
    digest: Sha256,
    utf8: Utf8Validator,
}

impl StagedFile {
    pub(crate) fn new() -> Result<Self, String> {
        Ok(Self {
            file: tempfile::tempfile().map_err(|_| "暂存文件创建失败".to_string())?,
            length: 0,
            digest: Sha256::new(),
            utf8: Utf8Validator::default(),
        })
    }

    pub(crate) fn len(&self) -> u64 {
        self.length
    }

    pub(crate) fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.utf8.append(bytes)?;
        self.file
            .write_all(bytes)
            .map_err(|_| "暂存文件写入失败".to_string())?;
        self.length += bytes.len() as u64;
        self.digest.update(bytes);
        Ok(())
    }

    pub(crate) fn finish(&mut self, json: bool) -> Result<(), String> {
        self.utf8.finish()?;
        self.file
            .flush()
            .map_err(|_| "暂存文件写入失败".to_string())?;
        if json {
            self.file
                .seek(SeekFrom::Start(0))
                .map_err(|_| "暂存文件读取失败".to_string())?;
            let reader =
                BufReader::with_capacity(BUFFER_BYTES, JsonDepthReader::new(&mut self.file));
            let mut deserializer = serde_json::Deserializer::from_reader(reader);
            let _: serde::de::IgnoredAny = Deserialize::deserialize(&mut deserializer)
                .map_err(|_| "数据结构无效或嵌套超过 128 层".to_string())?;
            deserializer.end().map_err(|_| "数据结构无效".to_string())?;
        }
        Ok(())
    }

    /// 跨卷来源先流式写入目标同目录临时文件，再关闭句柄并原子发布。
    pub(crate) fn publish(&mut self, path: &Path, new_only: bool) -> Result<(), String> {
        if new_only && path.exists() {
            return Err("新文件保存失败（目标已存在）".into());
        }
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|_| "暂存文件读取失败".to_string())?;
        let parent = path.parent().ok_or("保存目录无效")?;
        let mut destination = tempfile::Builder::new()
            .prefix(".zgis-")
            .suffix(".tmp")
            .tempfile_in(parent)
            .map_err(|_| "保存临时文件创建失败".to_string())?;
        let mut buffer = [0u8; BUFFER_BYTES];
        let mut written = 0u64;
        loop {
            let read = self
                .file
                .read(&mut buffer)
                .map_err(|_| "暂存文件读取失败".to_string())?;
            if read == 0 {
                break;
            }
            written = written
                .checked_add(read as u64)
                .filter(|length| *length <= self.length)
                .ok_or("暂存文件长度发生变化")?;
            destination
                .write_all(&buffer[..read])
                .map_err(|_| "文件保存失败".to_string())?;
        }
        if written != self.length {
            return Err("暂存文件长度发生变化".into());
        }
        destination
            .as_file()
            .sync_all()
            .map_err(|_| "文件同步失败".to_string())?;
        destination
            .seek(SeekFrom::Start(0))
            .map_err(|_| "写入核验失败".to_string())?;
        let mut digest = Sha256::new();
        let mut verified = 0u64;
        loop {
            let read = destination
                .read(&mut buffer)
                .map_err(|_| "写入核验失败".to_string())?;
            if read == 0 {
                break;
            }
            verified += read as u64;
            digest.update(&buffer[..read]);
        }
        if verified != self.length || digest.finalize() != self.digest.clone().finalize() {
            return Err("写入核验失败".into());
        }
        // Windows ReplaceFileW / MoveFileExW 前先关闭临时文件句柄。
        let temporary_path = destination.into_temp_path();
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                SetFileAttributesW, FILE_ATTRIBUTE_NORMAL,
            };
            let path: Vec<u16> = temporary_path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            // NamedTempFile 默认带 TEMPORARY；正式文件需恢复正常缓存/持久化属性。
            if unsafe { SetFileAttributesW(path.as_ptr(), FILE_ATTRIBUTE_NORMAL) } == 0 {
                return Err("保存临时文件属性设置失败".into());
            }
        }
        if new_only {
            crate::publish_new(&temporary_path, path)
        } else {
            crate::replace_file(&temporary_path, path)
        }
    }

    #[cfg(test)]
    pub(crate) fn test_bytes(&mut self) -> Vec<u8> {
        self.file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        self.file.read_to_end(&mut bytes).unwrap();
        bytes
    }
}

/// IgnoredAny 跳过大字符串而不物化，但其嵌套栈需在读取边界显式限深。
struct JsonDepthReader<R> {
    inner: R,
    depth: usize,
    quoted: bool,
    escaped: bool,
}

impl<R> JsonDepthReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            depth: 0,
            quoted: false,
            escaped: false,
        }
    }
}

impl<R: Read> Read for JsonDepthReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        for byte in &buffer[..read] {
            if self.quoted {
                if self.escaped {
                    self.escaped = false;
                } else if *byte == b'\\' {
                    self.escaped = true;
                } else if *byte == b'"' {
                    self.quoted = false;
                }
            } else {
                match byte {
                    b'"' => self.quoted = true,
                    b'[' | b'{' => {
                        self.depth += 1;
                        if self.depth > MAX_JSON_DEPTH {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "JSON nesting limit",
                            ));
                        }
                    }
                    b']' | b'}' => self.depth = self.depth.saturating_sub(1),
                    _ => {}
                }
            }
        }
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_utf8_at_every_boundary_and_rejects_incomplete_or_invalid_sequences() {
        let bytes = "中文😀".as_bytes();
        for split in 0..=bytes.len() {
            let mut file = StagedFile::new().unwrap();
            file.append(&bytes[..split]).unwrap();
            file.append(&bytes[split..]).unwrap();
            file.finish(false).unwrap();
            assert_eq!(file.test_bytes(), bytes);
        }
        for bytes in [
            vec![0xff],
            vec![0xe4, 0x41],
            vec![0xc0, 0x80],
            vec![0xed, 0xa0, 0x80],
        ] {
            let mut file = StagedFile::new().unwrap();
            assert!(file.append(&bytes).is_err());
        }
        let mut file = StagedFile::new().unwrap();
        file.append(&[0xe4]).unwrap();
        assert!(file.finish(false).is_err());
    }

    #[test]
    fn validates_large_json_strings_without_materializing_them_and_limits_nesting() {
        let mut file = StagedFile::new().unwrap();
        file.append(b"{\"text\":\"").unwrap();
        let block = [b'a'; BUFFER_BYTES];
        for _ in 0..32 {
            file.append(&block).unwrap();
        }
        file.append(b"\\\"[{]}\"}").unwrap();
        file.finish(true).unwrap();
        for bytes in [
            b"{} {}".to_vec(),
            b"[1,]".to_vec(),
            [vec![b'['; 129], vec![b']'; 129]].concat(),
        ] {
            let mut invalid = StagedFile::new().unwrap();
            invalid.append(&bytes).unwrap();
            assert!(invalid.finish(true).is_err());
        }
        let mut boundary = StagedFile::new().unwrap();
        boundary
            .append(&[vec![b'['; 128], b"0".to_vec(), vec![b']'; 128]].concat())
            .unwrap();
        boundary.finish(true).unwrap();
    }

    #[test]
    fn streaming_publish_checks_entire_file_preserves_old_target_and_cleans_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.csv");
        std::fs::write(&path, b"old").unwrap();
        let mut file = StagedFile::new().unwrap();
        let block = [b'a'; BUFFER_BYTES];
        for _ in 0..3 {
            file.append(&block).unwrap();
        }
        file.append("中文😀".as_bytes()).unwrap();
        file.finish(false).unwrap();
        assert!(file.publish(&path, true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        file.publish(&path, false).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), file.len());
        assert_eq!(std::fs::read(&path).unwrap(), file.test_bytes());
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileAttributesW, FILE_ATTRIBUTE_TEMPORARY,
            };
            let fresh = dir.path().join("fresh.csv");
            file.publish(&fresh, true).unwrap();
            let encoded: Vec<u16> = fresh.as_os_str().encode_wide().chain(Some(0)).collect();
            assert_eq!(
                unsafe { GetFileAttributesW(encoded.as_ptr()) } & FILE_ATTRIBUTE_TEMPORARY,
                0
            );
            std::fs::remove_file(fresh).unwrap();
        }
        file.file
            .seek(SeekFrom::Start(BUFFER_BYTES as u64 + 1))
            .unwrap();
        file.file.write_all(b"changed").unwrap();
        assert!(file.publish(&path, false).unwrap_err().contains("核验"));
        file.file.set_len(1).unwrap();
        assert!(file.publish(&path, false).is_err());
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            3 * BUFFER_BYTES as u64 + 10
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        assert!(file
            .publish(&dir.path().join("missing").join("fail.csv"), false)
            .is_err());
    }

    #[test]
    fn file_io_errors_preserve_formal_file_and_drop_destination_temporary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.csv");
        std::fs::write(&path, b"old").unwrap();
        let mut file = StagedFile::new().unwrap();
        file.file = File::open(&path).unwrap();
        assert!(file.append(b"replacement").is_err());
        file.file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        assert!(file.publish(&path, false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
