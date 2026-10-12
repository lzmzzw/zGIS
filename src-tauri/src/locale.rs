use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub(crate) fn text(chinese: &'static str, english: &'static str) -> &'static str {
    if ENGLISH.load(Ordering::Relaxed) { english } else { chinese }
}

#[tauri::command]
pub fn set_locale(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    match locale.as_str() {
        "zh-CN" => ENGLISH.store(false, Ordering::Relaxed),
        "en" => ENGLISH.store(true, Ordering::Relaxed),
        _ => return Err("Unsupported language".into()),
    }
    #[cfg(target_os = "macos")]
    crate::macos_menu::update_labels(&app).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_language_switches_both_ways() {
        super::ENGLISH.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(super::text("打开", "Open"), "Open");
        super::ENGLISH.store(false, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(super::text("打开", "Open"), "打开");
    }
}
