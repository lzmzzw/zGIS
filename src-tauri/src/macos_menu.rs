use tauri::{menu::{MenuBuilder, MenuItem, SubmenuBuilder}, Manager};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn install(app: &tauri::App) -> tauri::Result<()> {
    update_labels(app.handle())?;
    app.on_menu_event(|app, event| {
        if matches!(event.id().as_ref(), "zgis-quit" | "zgis-close") {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
    });
    #[cfg(target_os = "macos")]
    termination::install(app.handle())?;
    Ok(())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn update_labels(app: &tauri::AppHandle) -> tauri::Result<()> {
    use crate::locale::text;
    // 自定义 Quit 先请求关闭窗口，使未保存内容继续经过前端确认。
    let quit = MenuItem::with_id(app, "zgis-quit", crate::locale::text("退出 zGIS", "Quit zGIS"), true, Some("Cmd+Q"))?;
    let application = SubmenuBuilder::new(app, "zGIS")
        .services_with_text(text("服务", "Services")).separator()
        .hide_with_text(text("隐藏 zGIS", "Hide zGIS"))
        .hide_others_with_text(text("隐藏其他应用", "Hide Others"))
        .show_all_with_text(text("显示全部", "Show All")).separator().item(&quit).build()?;
    let edit = SubmenuBuilder::with_id(app, "zgis-edit", crate::locale::text("编辑", "Edit"))
        .cut_with_text(text("剪切", "Cut")).copy_with_text(text("复制", "Copy"))
        .paste_with_text(text("粘贴", "Paste")).select_all_with_text(text("全选", "Select All")).build()?;
    let close = MenuItem::with_id(app, "zgis-close", crate::locale::text("关闭窗口", "Close Window"), true, Some("Cmd+W"))?;
    let window = SubmenuBuilder::with_id(app, "zgis-window", crate::locale::text("窗口", "Window"))
        .minimize_with_text(text("最小化", "Minimize")).maximize_with_text(text("缩放", "Zoom"))
        .fullscreen_with_text(text("进入全屏", "Enter Full Screen")).separator().item(&close).build()?;
    let menu = MenuBuilder::new(app).item(&application).item(&edit).item(&window).build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(target_os = "macos")]
mod termination {
    use objc2::{class, msg_send, runtime::{AnyObject, Imp, Sel}, sel};
    use std::sync::OnceLock;
    use tauri::Manager;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    // NSApplicationTerminateReply 是 NSUInteger；本应用支持的 macOS 均为 64 位。
    // 这里不能直接终止：关闭事件由前端确认，并在恢复副本落盘后 destroy 窗口。
    unsafe extern "C-unwind" fn should_terminate(
        _delegate: &AnyObject,
        _selector: Sel,
        _application: *mut AnyObject,
    ) -> usize {
        if let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) {
            let _ = window.close();
            0 // NSTerminateCancel
        } else {
            1 // NSTerminateNow
        }
    }

    pub(super) fn install(app: &tauri::AppHandle) -> Result<(), std::io::Error> {
        let fail = || std::io::Error::other("无法安装 macOS 退出确认保护");
        APP.set(app.clone()).map_err(|_| fail())?;
        // 保留 Tao 的原 delegate、生命周期及其他回调，只添加缺失的终止询问方法。
        unsafe {
            let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if application.is_null() { return Err(fail()); }
            let delegate: *mut AnyObject = msg_send![application, delegate];
            let delegate = delegate.as_ref().ok_or_else(fail)?;
            let selector = sel!(applicationShouldTerminate:);
            let delegate_class = delegate.class();
            // 依赖升级时若已有框架处理器，不覆盖其语义，也不静默失去退出保护。
            if delegate_class.instance_method(selector).is_some() { return Err(fail()); }
            let implementation = std::mem::transmute::<
                unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
                Imp,
            >(should_terminate);
            let installed = objc2::ffi::class_addMethod(
                (delegate_class as *const objc2::runtime::AnyClass).cast_mut(),
                selector,
                implementation,
                c"Q@:@".as_ptr(),
            );
            if !installed.as_bool() { return Err(fail()); }
            // 刷新 AppKit 的可选 delegate 方法识别，delegate 对象保持不变。
            let _: () = msg_send![application, setDelegate: delegate];
        }
        Ok(())
    }
}
