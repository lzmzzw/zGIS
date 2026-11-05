//! Shared native / Emscripten GDB input validation.
use std::{fs, path::{Path, PathBuf}};

pub(crate) fn source_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|_| "GDB_SOURCE_MISSING: cannot access source")?;
    let info = fs::symlink_metadata(path).map_err(|_| "GDB_SOURCE_MISSING: cannot access source")?;
    if info.file_type().is_symlink() { return Err("GDB_SOURCE_INVALID: symbolic links are not accepted".into()); }
    let name = canonical.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    if !(canonical.is_dir() && name.ends_with(".gdb") || canonical.is_file() && name.ends_with(".gdb.zip")) {
        return Err("GDB_SOURCE_INVALID: select a .gdb directory or .gdb.zip file".into());
    }
    Ok(canonical)
}

pub(crate) fn validate_read(limit: u32, fields: Option<&[String]>, bounds: Option<[f64; 4]>) -> Result<(), String> {
    if !(1..=100_000).contains(&limit) { return Err("GDB_LIMIT_INVALID: read limit must be between 1 and 100000".into()); }
    if let Some(fields) = fields {
        let mut seen = std::collections::HashSet::new();
        if fields.len() > 1024 || fields.iter().any(|f| f.is_empty() || f.len() > 4096 || f.contains('\0') || !seen.insert(f)) {
            return Err("GDB_FIELDS_INVALID: invalid or duplicate field selection".into());
        }
    }
    if let Some([west, south, east, north]) = bounds {
        if ![west, south, east, north].iter().all(|n| n.is_finite()) || west < -180.0 || east > 180.0 || south < -90.0 || north > 90.0 || west >= east || south >= north {
            return Err("GDB_BOUNDS_INVALID: bounds must be west,south,east,north in WGS84 without crossing the date line".into());
        }
    }
    Ok(())
}

