//! Browser GDAL bridge. This static library is linked with GDAL by Emscripten.
//! The native and browser variants compile the same read-only format adapter.
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};
use std::path::Path;

#[path = "../../../src-tauri/src/gdb_contract.rs"]
mod gdb_contract;
#[path = "../../../src-tauri/src/gdb_native.rs"]
mod gdb_native;

const MAX_REQUEST: usize = 1024 * 1024;

fn execute(request: &str) -> String {
    let result = (|| {
        if request.len() > MAX_REQUEST { return Err("GDB_REQUEST_INVALID: request exceeds 1 MiB".to_string()); }
        let value: Value = serde_json::from_str(request).map_err(|_| "GDB_REQUEST_INVALID: invalid input JSON".to_string())?;
        gdb_native::execute(Path::new("/gdal"), &value)
    })();
    match result {
        Ok(value) => json!({"ok":true,"result":value}).to_string(),
        Err(error) => json!({"ok":false,"error":error}).to_string(),
    }
}

/// Input is a valid NUL-terminated UTF-8 string in the Emscripten heap.
/// The caller must free the returned allocation with `zgis_gdb_free`.
///
/// # Safety
/// `request` must refer to a live readable NUL-terminated allocation.
#[no_mangle]
pub unsafe extern "C" fn zgis_gdb_execute(request: *const c_char) -> *mut c_char {
    let result = if request.is_null() {
        json!({"ok":false,"error":"GDB_REQUEST_INVALID: missing input"}).to_string()
    } else {
        match CStr::from_ptr(request).to_str() {
            Ok(input) => execute(input),
            Err(_) => json!({"ok":false,"error":"GDB_REQUEST_INVALID: input must be UTF-8"}).to_string(),
        }
    };
    // serde_json escapes embedded NULs; native error messages cannot contain one.
    CString::new(result).expect("JSON serialization cannot contain a literal NUL").into_raw()
}

/// # Safety
/// `result` must be a live allocation returned by `zgis_gdb_execute`, freed once.
#[no_mangle]
pub unsafe extern "C" fn zgis_gdb_free(result: *mut c_char) {
    if !result.is_null() { drop(CString::from_raw(result)); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exported_protocol_returns_json_errors_and_releases_allocations() {
        let request = CString::new("not-json").unwrap();
        unsafe {
            let response = zgis_gdb_execute(request.as_ptr());
            let value: Value = serde_json::from_str(CStr::from_ptr(response).to_str().unwrap()).unwrap();
            assert_eq!(value["ok"], false);
            assert!(value["error"].as_str().unwrap().contains("GDB_REQUEST_INVALID"));
            zgis_gdb_free(response);
            let response = zgis_gdb_execute(std::ptr::null());
            assert!(CStr::from_ptr(response).to_str().unwrap().contains("missing input"));
            zgis_gdb_free(response);
        }
    }
}
