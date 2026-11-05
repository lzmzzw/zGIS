# Web 静态资源版

zGIS Web 与桌面版在同一仓库维护，共享地图、领域模型、文件解析、工具箱和 Rust 空间算法。Web 版用于本地文件图层查看和空间分析，不包含数据库图层、AI、终端或本机 MCP。

## 使用

页面顶部及导入、下载弹窗提供中文 / English 切换，刷新后沿用选择。切换保留当前图层、参数与未完成的表单；文件名、字段和值不翻译。语言维护与验证见[中英双语](i18n.md)。

1. 点击「导入文件」或拖入 GeoJSON、CSV、SHP ZIP；GDB 使用独立的「导入 GDB…」入口选择目录或 ZIP。GDB 首次使用时从当前站点下载并缓存裁剪的 GDAL/WASM，输入文件不上传；坐标、兼容与只读边界见 [GDB 说明](gdb.md)。CSV 可指定 WKT 或 X/Y 列、编码及来源坐标系；SHP 文件组须包含同名 SHP、DBF、PRJ，建议一并包含 SHX、CPG。
2. 在图层列表切换显隐、颜色、透明度和范围定位，在属性表搜索、选择和定位要素。已有非空且非 GDB 来源的图层可进入编辑模式，新增点、线、面，移动要素、修改顶点、捕捉或删除选中要素；属性表只读。保存编辑通过下载生成副本，不回写本地源文件。退出编辑保留内存修改，当前没有桌面式撤销/重做。
3. 打开「空间分析」，选择工具与输入，必要时选择目标图层和参数。结果为独立图层，可继续作为分析输入；摘要和拓扑检查显示报告。
4. 使用「下载图层」输出 GeoJSON、CSV（WKT 或 X/Y）或 SHP ZIP。下载不会覆盖源文件，须确认浏览器下载已保存。

文件通过浏览器 File API 读取，在本地 Worker 中解析和计算，不上传到静态托管服务器。底图使用 OpenStreetMap，瓦片请求会访问外部地图服务；可切换「无底图」。仅请求当前视野所需瓦片，不提供批量下载或离线底图缓存。公开部署须遵守 [OSM 瓦片使用政策](https://operations.osmfoundation.org/policies/tiles/)，保留署名和有效 Referer。

图层与结果保存在当前页面内存中，不自动恢复。刷新、关闭或切换站点会丢失工作区；存在尚未下载的分析结果时，浏览器可显示离开提醒。浏览器下载触发不代表文件已经被用户接受或保存。

## 构建与部署

要求 Node 22.13+、pnpm 8.10.0、Rust stable 与 `wasm32-unknown-unknown` target。GDB 另需 Emscripten 4.0.19、Rust 1.96.0 的 `wasm32-unknown-emscripten` target、CMake 和本机 C/C++ 构建工具；在 Windows MSVC 或 macOS ARM64 环境先构建原生依赖，提供生成 PROJ 数据所需的主机 SQLite 工具。

```powershell
pnpm install --frozen-lockfile
rustup target add wasm32-unknown-unknown
node scripts/install-wasm-bindgen.mjs
rustup toolchain install 1.96.0 --target wasm32-unknown-emscripten
pnpm gdal:prepare
# 激活 Emscripten 4.0.19，并设置 EMSDK（Windows 需使用真实 Python 路径设置 EMSDK_PYTHON）
pnpm gdb:wasm:build
pnpm build:web
```

安装脚本按 `crates/spatial-wasm/Cargo.lock` 的精确 wasm-bindgen 版本安装 CLI；WASM 与原生 Rust 分别使用各自提交的 Cargo.lock。构建输出 `dist-web/`，包含 `index.html`、JS、CSS、解析与分析 Worker、WASM；将目录内容上传到任意 HTTPS 静态托管服务即可，无需服务器计算进程。

资源采用相对 URL，可部署在域名根目录或 `/zgis/` 等子目录。服务须正确提供 `.js` 为 JavaScript、`.wasm` 为 `application/wasm`，不把缺失资源改写成 HTML。更新时成套发布资源，HTML 建议重新验证缓存，带哈希的资源可长期缓存。不要只替换 WASM 或复用旧 HTML 配新脚本。

首版使用单线程 WASM + 独立 Worker，不依赖 SharedArrayBuffer 和 COOP/COEP。分析模块按需加载，取消或超过 120 秒时终止对应 Worker；最多并行两个引擎任务。GDB 运行时作为同源静态资源单独分发，首次使用时下载；完整缓存后可离线复用，缓存被浏览器清理后需要重新下载。其他资源和算法无需 CDN 运行时下载，底图仍需网络。

桌面构建保持 `pnpm build` 和 `pnpm tauri build`；`pnpm build:desktop` 提供安装包构建别名。正式 Windows 构建继续使用 `pwsh -File scripts/build.ps1`。

## 数据与计算边界

工作坐标统一 WGS84，来源 CRS 独立保留；4326、4490、3857 的转换、高程和属性规则沿用 [工具箱说明](processing-toolbox.md) 与 README。WebAssembly 不改变算法的精度：局部近似、大范围、高纬和跨日期线限制仍然适用。

普通格式单批导入文件总大小最多 100 MB；ZIP 最多 2000 成员、200 MB 解压内容。GDB 使用独立的目录、ZIP、字段和结果预算，见 [GDB 容量限制](gdb.md#容量与一致性)。分析每层最多 100000 要素、100 万顶点、候选对和累计工作量、输入与结果字节预算。这些预算是保护上限，不保证任意上限规模都流畅；浏览器可用内存和设备性能仍限制实际规模。

XYZ 可通过 GeoJSON 或 WKT 保存。XY CSV 和 SHP 仅支持二维，拒绝静默丢失高程。SHP 导出沿用共享 Rust 导出器的字段名、类型、长度、NULL 与数值精度检查；不自动截断或改名。CSV 中空字符串与 NULL 不保真，嵌套属性为 JSON 文本；生成几何列时避开现有属性列名。

## 验证与发行

```powershell
pnpm test
cargo test --manifest-path crates/spatial-core/Cargo.toml --locked
pnpm build:web
pnpm test:web
# 真实 GDB 解析验收另须先生成 output/gdb-fixtures 兼容性样本（见 gdb.md）
$env:ZGIS_GDB_REAL='1'
pnpm exec playwright test --config playwright.web.config.ts tests-web/gdb-real.spec.ts --workers=1
node scripts/release-assets.mjs web
```

`test:web` 启动仅提供 `dist-web/` 的静态服务器，在 `/zgis/` 子目录下运行真实 Edge 回归，不使用 Tauri 模拟层。验证涵盖导入、显示交互、属性、25 项 WASM 工具、结果继续分析、下载以及 SHP 往返。自动化地图回归使用测试瓦片，避免向公共 OSM 服务批量发送请求，不代表公共底图服务的可用性验收。

GitHub Release 同时提供桌面安装包与 `zGIS_<版本>_web.zip`，统一记录 SHA-256。Web ZIP 是可部署资源，不是在线站点地址；将其解压到静态托管根目录即可。证据位于任务独立目录 `output/web-0.4.0/`，不提交生成资源和测试截图。
