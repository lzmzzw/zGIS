# zGIS 工程约定

个人 Windows 轻量 GIS 编辑器，产品范围与验证入口以 README.md 为准。

- SHP 工作副本可编辑，桌面版只另存新 SHP ZIP，不覆盖原 SHP 文件组；不支持 GDB。字段转换不能静默丢失，特殊几何不能静默降维。
- 文件解析在 Worker 执行；几何工作坐标统一 WGS84，来源 CRS 独立保存。
- 文件来源只允许通过原生对话框登记的句柄访问；覆盖检查来源变化。
- PostGIS 写入使用明确提交、参数化与事务；不得用本应用绕过 Codex 的 DBX 工具约束。
- 密码仅在连接期间保留，不写配置、恢复文件、日志或 Git。
- 前端验证：pnpm test、pnpm build；后端验证：cargo test --manifest-path src-tauri/Cargo.toml --lib。
- 打包：pnpm tauri build；Windows 安装及桌面运行必须实际验证。
- 仅提交源码、配置、锁文件与文档；output、target、dist、node_modules 不提交。
