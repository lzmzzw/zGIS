# GitHub 构建与发布

zGIS 的构建流程提供 Windows x64 NSIS 安装包和 macOS ARM64 DMG、`.app.tar.gz`。macOS 面向 macOS 14 或更新系统上的 Apple Silicon，不包含 Intel 或 Universal 构建。package.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock 中 zgis 条目和 src-tauri/tauri.conf.json 的版本必须一致，`pnpm version:check` 检查一致性；发布标签必须为 `v` 加完整版本。

## 检查与构建

PR、master/main 提交或手动启动「检查与构建」后，Windows 和 macOS 分别执行检查。两端使用 Node 22、pnpm 8.10.0、稳定版 Rust 和锁文件，执行版本校验、类型与未使用检查、前端测试、Rust 测试、Clippy 和前端构建。Windows 额外使用 `vite preview` 提供已构建的 `dist`，在固定端口执行完整 Edge 页面回归并生成 NSIS 安装包；macOS 使用 `macos-15` ARM64 runner 和 `aarch64-apple-darwin` target，生成 DMG 和 app 压缩包。检查产物分别保存为 `zGIS-windows-x64` 和 `zGIS-macos-arm64` artifact，保留 14 天。任一平台失败均不能进入发布流程；Windows 页面回归失败时保存截图、trace、错误上下文和 Vite 日志为 14 天 Actions artifact。这些检查不替代原生安装及交互验收。

异步回归验证“请求处理中”“取消”或“迟到响应”时，由桌面模拟层显式保留并释放响应；不要用固定的短延迟充当同步条件。截止时间由可控时钟推进到边界前后验证，真实执行耗时不作为产品超时逻辑的断言依据。

## 版本发布

1. 同步四处版本，完成源码提交和核验。
2. 将测试过的提交及对应版本标签推送到项目仓库，版本标签触发「发布」。
3. 工作流核对标签版本并完成两端检查，再以检查过的不可变提交分别构建。平台构建任务只有内容读取权限，只上传 Actions artifact，不创建 Release。两端都成功后，聚合任务再次核对标签 SHA，校验三个平台产物，生成统一 `SHA256SUMS.txt`，再创建或更新草稿。创建 Release 时使用已存在的标签；target_commitish 传默认分支以兼容 GitHub 工作流权限检查，不创建或移动标签。三个产物及校验文件上传完整后才公开草稿，上传失败时保持草稿。

0.3.9 使用 v0.3.9。发布前新增 `docs/releases/<版本>.md`，工作流从对应文件读取发行说明，缺少文件时停止发布。手动执行「发布」须填写已存在的版本标签，不能用分支名代替，也不会自动创建指向未知提交的标签。已公开版本不允许覆盖，应升级版本并使用新标签；失败遗留草稿可按同标签重跑。GitHub 预发布由 SemVer 的预发布部分决定，构建元数据中的连字符不影响发布类型。

仓库为 https://github.com/lzmzzw/zGIS，工作流仅使用 Actions 内置 GITHUB_TOKEN。普通检查和平台打包只有内容读取权限，聚合发布 job 才有内容写入权限；PR 不获得发布权限。不需要 updater 私钥或额外 GitHub secret。macOS 配置 `signingIdentity: "-"` 执行不依赖 Apple 凭据的 ad-hoc 签名，CI 检查 app 的 ARM64 架构和签名完整性；该签名不等于 Developer ID 签名或 Apple 公证，下载后的首次打开仍受 Gatekeeper 检查。正式签名发行需要另行配置 Apple 身份与公证凭据，当前流程不声称具备该能力。同标签草稿重跑会清理旧草稿资产后上传本次完整产物；已公开发行仍拒绝覆盖。

## 更新与本地验收

关于页查询公开 Releases 的最新正式版本，使用当前运行版本作 SemVer 比较。暂无公开版本、限流或网络失败均如实反馈。发现新版本后可在应用内下载当前平台安装包；后端只接受本仓库对应版本的正式发行资源，并校验统一 SHA256SUMS.txt，安装前再检查缓存。仅允许升级，不允许同版本重装或降级。

Windows 安装前保存工作区与底图配置，编辑状态沿用退出确认；保存失败或取消时不启动安装。包外应用启动独立安装助手，等待应用退出，再使用 NSIS 静默覆盖当前 exe 所在目录并自动重启。发现其他 zGIS 实例时停止更新，安装包也拒绝覆盖运行中的程序，避免静默强杀编辑会话。下载和校验失败保留当前版本。macOS 提供校验后的 DMG 下载与打开，仍由用户手工替换应用；尚无 macOS 实机自动覆盖安装验收。SHA-256 提供下载完整性检查，不是独立发行数字签名；本流程不生成 latest.json 或 Tauri updater 签名，不需要新增私钥。

原生更新测试使用 `pwsh -File scripts/update-smoke.ps1 -ExpectedVersion <新版本>`：须先通过既有安装脚本安装含更新功能且版本较低的测试包，正式新版本公开后在包外启动该旧版本，经关于页下载并覆盖安装，检查物理路径、运行版本及测试工作区恢复。测试结束还原用户配置，证据保存在 output/update-smoke/<任务独立目录>。

Windows 本地打包和安装继续使用 `pwsh -File scripts/build.ps1`、`pwsh -File scripts/install.ps1 -Smoke -Launch`。在 Apple Silicon macOS 上安装 Node 22、pnpm 8.10.0、Rust 和 Xcode Command Line Tools 后，可执行 `pnpm install --frozen-lockfile`、`pnpm version:check`、`pnpm test`、`cargo test --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin --lib --locked`、`cargo clippy --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin --lib --locked -- -D warnings`，再运行 `pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg -- --locked`。DMG 位于 `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg`，app 位于同级 `macos` 目录；`node scripts/release-assets.mjs macos` 可整理 DMG 并保留 app 内容压缩为 tar.gz。Windows 安装脚本不用于 macOS。不以本地通过推断云端 Actions 成功；实际推送、触发工作流及公开发行仍需对应授权，工作流文件存在不代表已触发或发布。

`build.ps1` 与 CI 均执行版本校验、类型与未使用代码检查、前后端测试、`cargo clippy --lib --locked -- -D warnings`，打包使用锁文件。默认安装器名称取自 Tauri 配置版本。`-Smoke` 执行安装关键路径验证；`-Smoke -FullSmoke` 在同一个包外 worker 中执行完整原生回归，包含文件、编辑、空间分析、MCP、Agent 生命周期及跨进程恢复，并在完成后还原测试隔离的用户配置。`-Launch` 最后启动还原用户配置后的安装版。
