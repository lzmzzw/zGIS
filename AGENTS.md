# zGIS 工程约定

个人 Windows 轻量 GIS 编辑器，产品范围与验证入口以 README.md 为准。

- SHP 工作副本可编辑，桌面版只另存新 SHP ZIP，不覆盖原 SHP 文件组；不支持 GDB。字段转换不能静默丢失，特殊几何不能静默降维。
- 文件解析在 Worker 执行；几何工作坐标统一 WGS84，来源 CRS 独立保存。
- zGIS 内部图层的 Agent 操作统一使用 zGIS MCP，具体操作以工具清单和 schema 为准。GeoJSON、SHP、含 WKT 的 CSV 等外部文件优先交由 zGIS MCP 加载和分析；调用 Agent 负责按自身权限规则判断文件是否可访问，zGIS 不校验外部文件访问授权。
- PostGIS 按实际场景选择 zGIS MCP 分析已加载图层快照，或由 DBX 直接操作数据库；不得要求 zGIS MCP 直连数据库。MCP 不暴露任意 shell 或源文件覆盖；分析结果作为独立未保存图层，由用户保存。Agent 只连接本次 zGIS MCP，关闭服务或应用时终止所属进程树。
- PostGIS 写入使用明确提交、参数化与事务；不得用本应用绕过 Codex 的 DBX 工具约束。
- 密码仅在连接期间保留，不写配置、恢复文件、日志或 Git。
- 前端验证：pnpm test、pnpm build；后端验证：cargo test --manifest-path src-tauri/Cargo.toml --lib。
- 打包：pnpm tauri build；Windows 安装及桌面运行必须实际验证。
- 覆盖安装只使用 `pwsh -File scripts/install.ps1 -Smoke`：通过包外当前用户进程执行安装并核验物理路径、release 内容、快捷方式和启动进程。禁止在 Codex MSIX 环境直接运行安装器 `/S` 后以包内 `%LOCALAPPDATA%` 文件核对宣称成功；该路径可能重定向到 Codex LocalCache。完整原生 smoke 只在包外运行。
- 仅提交源码、配置、锁文件与文档；output、target、dist、node_modules 不提交。
