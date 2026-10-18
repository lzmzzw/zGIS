# 分析工具契约

分析工具的兼容基线包括名称、参数、输入几何范围、原有 GUI 相对顺序和结果类型。当前 GUI 与 core 均有 25 项，MCP 合计 33 项（25 项分析和 8 项管理/读取入口）。清理已明确开放 GUI，新增属性条件提取与字段分组统计；统计返回 table 报告，不可发布为地图层。

`crates/spatial-core/tool-contract-baseline.json` 固定迁移前 23 项分析工具描述与 MCP 来源参数契约，`src/analysisTools.baseline.json` 固定原有 22 项 GUI 行为。两份文件是兼容性测试夹具，不是运行期配置，不能为通过重构测试而重新生成。新增能力使用独立的契约断言；已有工具增量参数需在测试中单独比对变化和旧默认行为。

迁移约束：保持具名 MCP 工具、源文件保护、独立未保存结果、XYZ、取消与预算；算法核心不读取路径和数据库，来源解析仍属于宿主。对所有注册分析工具遍历非法参数的测试只使用内存数据，不触及外部文件或数据库。

验证：`pnpm test`、`cargo test --manifest-path crates/spatial-core/Cargo.toml --locked`。桌面和 Web 的完整检查继续遵守仓库 AGENTS.md。

## 注册表与静态目录

`crates/spatial-core/src/registry.rs` 拥有分析操作、参数契约和 GUI 行为描述。`src/analysisTools.ts` 只维护前端展示顺序、分类、可翻译名称及帮助；输入几何范围、目标要求、参数和结果类型由 `src/generated/analysis-catalog.json` 提供。该文件由 Rust example 导出，不手工修改。Web 首屏不必为展示工具箱加载 WASM，也不依赖桌面或 MCP。

修改注册表后执行 `pnpm analysis:generate`，审阅静态目录变化；`pnpm analysis:check` 重新导出并比对，CI 的共享核心检查包含此门禁。两条命令需要 Rust 工具链和本机链接环境，普通前端构建只消费已提交的静态目录。

MCP 宿主负责 `layerId/path/resultId` 引用及其 schema，并在解析来源后将内存要素和纯参数交给 core。桌面输入入口与 WASM 共用 `input::execute`；桌面另安装协作式 checkpoint 并保留共享计算槽位。协议认证、缓存、发布和 ACK 仍属于 MCP 宿主，不因注册表出现新操作而自动授予外部文件写入或数据库访问能力。
