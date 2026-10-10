use tauri::{menu::{MenuBuilder, MenuItem, SubmenuBuilder}, Manager};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn install(app: &tauri::App) -> tauri::Result<()> {
    // 自定义 Quit 先请求关闭窗口，使未保存内容继续经过前端确认。
    let quit = MenuItem::with_id(app, "zgis-quit", "退出 zGIS", true, Some("Cmd+Q"))?;
    let application = SubmenuBuilder::new(app, "zGIS")
        .services().separator().hide().hide_others().show_all().separator().item(&quit).build()?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .cut().copy().paste().select_all().build()?;
    let close = MenuItem::with_id(app, "zgis-close", "关闭窗口", true, Some("Cmd+W"))?;
    let window = SubmenuBuilder::new(app, "窗口")
        .minimize().maximize().fullscreen().separator().item(&close).build()?;
    let menu = MenuBuilder::new(app).item(&application).item(&edit).item(&window).build()?;
    app.set_menu(menu)?;
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
