# GitHub 构建与发布

zGIS 当前提供 Windows x64 NSIS 安装包。package.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock 中 zgis 条目和 src-tauri/tauri.conf.json 的版本必须一致，`pnpm version:check` 检查一致性；发布标签必须为 `v` 加完整版本。

## 检查与构建

PR、master/main 提交或手动启动「检查与构建」后，Windows runner 使用 Node 22、pnpm 8.10.0、稳定版 Rust 和锁文件安装依赖，执行类型与未使用检查、前端测试、Rust 测试、前端构建和完整 Edge 页面回归，再生成 NSIS 安装包。安装包位于该次运行的 zGIS-windows-x64 artifact，保留 14 天。失败不会进入发布流程。

## 版本发布

1. 同步三处版本，完成源码提交和核验。
2. 将测试过的提交及对应版本标签推送到项目仓库，版本标签触发「发布」。
3. 工作流检查标签版本和完整测试，再以检查过的不可变提交构建。创建 Release 时使用已存在的标签；target_commitish 传默认分支以兼容 GitHub 工作流权限检查，不创建或移动标签。安装包及 SHA256SUMS.txt 上传完成后才公开草稿。

0.2.0 使用 v0.2.0。发布前新增 `docs/releases/<版本>.md`，工作流从对应文件读取发行说明，缺少文件时停止发布。手动执行「发布」须填写已存在的版本标签，不能用分支名代替，也不会自动创建指向未知提交的标签。已公开版本不允许覆盖，应升级版本并使用新标签；失败遗留草稿可按同标签重跑。GitHub 预发布由 SemVer 的预发布部分决定，构建元数据中的连字符不影响发布类型。

仓库为 https://github.com/lzmzzw/zGIS，工作流仅使用 Actions 内置 GITHUB_TOKEN。普通检查只有内容读取权限，发布 job 才有内容写入权限；PR 不获得发布权限。不需要 updater 私钥或额外 GitHub secret。

## 更新与本地验收

关于页查询公开 Releases 的最新正式版本，使用当前运行版本作 SemVer 比较。暂无公开版本、限流或网络失败均如实反馈，发现新版本时提供发布页下载入口。发布流程生成普通安装包与校验文件，不自动替换正在运行的软件，不生成 latest.json 或 updater 签名。

本地打包和安装继续使用 `pwsh -File scripts/build.ps1`、`pwsh -File scripts/install.ps1 -Smoke -Launch`，不以本地通过推断云端 Actions 成功。实际推送、触发工作流及公开发行遵守工作区根 AGENTS.md 的 external_publish 授权要求；工作流文件存在不代表已触发或发布。

`build.ps1` 与 CI 均执行版本校验、类型与未使用代码检查、前后端测试、`cargo clippy --lib --locked -- -D warnings`，打包使用锁文件。默认安装器名称取自 Tauri 配置版本。`-Smoke` 执行安装关键路径验证；`-Smoke -FullSmoke` 在同一个包外 worker 中执行完整原生回归，包含文件、编辑、空间分析、MCP、Agent 生命周期及跨进程恢复，并在完成后还原测试隔离的用户配置。`-Launch` 最后启动还原用户配置后的安装版。
