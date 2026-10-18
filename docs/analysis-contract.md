# 分析工具契约

分析工具的兼容基线包括名称、参数、输入几何范围、GUI 顺序和结果类型。前端当前开放 22 项；Rust core 另含 `clean_geometries`，MCP 合计 31 项（23 项分析和 8 项管理/读取入口）。清理工具没有 GUI 入口是当前曝光边界，不是自动补齐目标。

`crates/spatial-core/tool-contract-baseline.json` 固定迁移前的分析工具描述与 MCP 来源参数契约，`src/analysisTools.baseline.json` 固定 GUI 行为。两份文件是兼容性测试夹具，不是运行期配置；不能为通过重构测试而重新生成。新增能力或公开契约变化须单独说明并审阅基线更新。

迁移约束：保持具名 MCP 工具、源文件保护、独立未保存结果、XYZ、取消与预算；算法核心不读取路径和数据库，来源解析仍属于宿主。对所有注册分析工具遍历非法参数的测试只使用内存数据，不触及外部文件或数据库。

验证：`pnpm test`、`cargo test --manifest-path crates/spatial-core/Cargo.toml --locked`。桌面和 Web 的完整检查继续遵守仓库 AGENTS.md。
