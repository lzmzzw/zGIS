# File Geodatabase 只读图层

GDB 入口用于读取 Esri File Geodatabase 中的矢量图层。目录、字段与坐标检查通过后，数据进入 WGS84 工作副本，可查看、选择、设置样式、空间分析和导出。GDB 来源图层始终只读，不能修改几何、属性、字段或记录，也不能保存、另存绑定或重命名原文件。

## 使用

桌面版从「文件 → 打开 GDB…」进入，选择 `.gdb` 文件夹或 `.gdb.zip`。Web 版从「导入 GDB…」进入，选择本地目录或 ZIP；文件在浏览器中读取，不上传。ZIP 必须只包含一个顶层 `.gdb` 目录。

导入面板先列出图层、分组、几何类型、要素数和来源坐标系，再选择字段、读取上限与可选的 WGS84 经纬度范围。数量未知时不强制扫描全层计数。默认读取 10000 条，可设置 1–100000；达到上限后探测额外一条，并在存在更多记录时明确标记截断。查询、属性表、统计、分析和导出只包含实际加载的数据。

导出沿用现有 GeoJSON、CSV、SHP 等入口及其格式限制，生成副本，不将原 GDB 图层关联到输出文件。含高程数据应使用 GeoJSON 或 WKT，SHP 和 X/Y CSV 保持既有二维约束。空间分析结果是独立工作区图层，可按普通工作区图层规则编辑和保存。

## 坐标与数据兼容

- 来源必须有可识别的地理或投影坐标系；保留完整来源 WKT，使用随运行时分发的 GDAL/PROJ 转为传统 GIS 轴序的 WGS84 经度/纬度。未知 CRS 不按 4326 猜测。
- 禁止网络格网下载和隐式 ballpark 降级。所需精确转换不可用时应预先在具有必要参数与格网的工具中转换。
- CGCS2000 及其投影可明确勾选「允许 CGCS2000 与 WGS84 的近似转换」，默认关闭。在 CGCS2000 同基准内反投影后近似视作 WGS84，结果保留该选择和警告；不包含历元、七参数、格网或测绘级基准改正。
- 支持普通点、线、面及其 Multi、洞、XY/XYZ 和 NULL 几何。只转换 XY，Z 原值保留，不换算垂直基准。M/ZM、曲线、集合、特殊几何和不能保真表达的非 NULL 空几何拒绝读取。
- 保留字段原名、类型、可空性及可用别名、域说明，编码域保留原值，不自动替换为描述。日期、时间和 GUID 以文本进入工作副本；NULL 与空字符串分开保存。
- OID/FID 作为文本身份保留，超出 JavaScript 安全范围的整数属性转文本。选中的二进制、列表或其他不支持字段会阻止读取，可在导入前取消这些字段。
- 非空间表只列目录，不加入地图；栅格、附件、关系、拓扑规则和原库回写不在首期范围。OpenFileGDB 不支持的压缩及身份异常等情况明确失败，不能据此推断兼容所有 ArcGIS GDB。

## 容量与一致性

每次读取最多 100 MiB 完整结果、100000 要素、单要素 100 万坐标位置、累计 200 万坐标位置；XYZ 算一个位置。字段数最多 1024（包括 OID），单属性值最多 1 MiB。预算不足时拒绝整个结果，不返回未标记的残缺数据。

目录发现最多 2048 层；目录指纹走访最多 10000 项、深度最多 16。ZIP 最多 10000 成员，桌面解压内容预算 8 GiB，Web 为 200 MiB；Web 本地输入总大小最多 100 MiB。目录计数与指纹不是整库加载，不代表能流畅渲染任意大库。优先使用字段和范围筛选；地图、恢复和空间分析仍受[既有容量限制](large-data.md)约束。

桌面读取前后核对有界文件元数据指纹，瞬态锁文件不进入指纹；这用于检测常见外部变化，不保证识别保留时间戳与大小的篡改。Web 使用浏览器选中文件的内容摘要。恢复保留已加载的只读快照、来源与 schema、原始 CRS、读取范围、上限、截断状态和转换说明，不自动重读或写回原 GDB。原文件缺失时仍可查看与导出恢复快照。

## 运行时与构建

桌面随安装包分发固定源码构建的 GDAL、PROJ 和 SQLite 依赖；用户不需要安装 Python、.NET、QGIS 或系统 GDAL。正式运行时只启用 OpenFileGDB 和 GDAL 强制的 MEM 驱动，JSON 输出由共享读取适配器和现有导出模块完成，不启用无关数据格式或网络驱动。源码版本与 SHA-256 在 `config/gdal-runtime.lock.json`，生成的二进制不提交。

原生资源位于 `src-tauri/resources/gdal/{native,data,proj}`，通过 `node scripts/prepare-gdal.mjs` 构建，`node scripts/verify-gdal-runtime.mjs` 核对来源清单、资源摘要和目标架构。`tauri build` 的前置步骤会准备运行时。Windows 使用 MSVC，macOS ARM64 在对应系统构建；工具和资源缺失时构建失败，不回退到系统 GDAL。

Web 的 GDAL/WASM 与原生编译同一份只读适配器。构建时需要 Emscripten、Rust `wasm32-unknown-emscripten` target、CMake 和主机 SQLite 工具；先完成原生依赖构建，再执行 `node scripts/build-gdb-wasm.mjs`。产物进入 `public/gdb-runtime/`，包含由源码摘要区分的不可变版本目录、资源大小与 SHA-256 清单；普通 Web 构建必须包含这些静态资源，但浏览器首屏不请求它们。Vite 不批量复制 public：Web 最终整理仅复制清单引用的版本，桌面前端不携带 Web GDB 运行时。

首次打开 GDB 后才从当前站点相对路径请求运行时，校验摘要后存入按版本隔离的 CacheStorage。全部资源完整缓存后才更新离线清单，更新中断或缓存配额不足时保留上一次完整版本。缓存命中后可重用；离线时可使用已缓存清单和完整资源，首次未下载不能离线使用。浏览器拒绝缓存时本次仍可加载并提示下次可能重新下载。缓存保存运行时，不保存输入的 GDB 文件。取消、失败或损坏缓存不产生图层。部署 `/zgis/` 时保留运行时相对目录结构，并通过 HTTP(S) 服务访问。

## 验证入口

```powershell
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --locked -- -D warnings
node scripts/prepare-gdal.mjs
cargo run --manifest-path src-tauri/Cargo.toml --example gdb-fixtures --locked -- src-tauri/resources/gdal output/gdb-fixtures-new
cargo build --manifest-path src-tauri/Cargo.toml --bin zgis --locked
node scripts/gdb-worker-smoke.mjs src-tauri/target/debug/zgis.exe src-tauri/resources/gdal output/gdb-fixtures-new
node scripts/build-gdb-wasm.mjs --check
```

夹具生成器只在开发 example 中提供写 API，生产读取 worker 不暴露创建、SQL 或更新接口。生成器要求新的输出位置，检查实际驱动列表，读取 smoke 比较源文件内容摘要，并覆盖目录/ZIP、投影、中文字段、长整数、NULL、XYZ、洞、范围、字段、限量及不兼容数据。macOS 使用实际构建的可执行文件路径；浏览器回归按[Web 验证](web.md)执行。


Windows 的真实界面 smoke 使用 `scripts/gdb-desktop-smoke.mjs <测试进程 PID>`，需先通过独立 Tauri 配置构建 `identifier=com.personal.zgis.gdb-smoke`、窗口标题 `zGIS GDB Smoke` 的应用，并设置独立 `WEBVIEW2_USER_DATA_FOLDER` 与 `ZGIS_SMOKE_CDP_PORT`。脚本只操作该隔离标识的测试工作区与 `output/gdb-desktop-smoke/`，覆盖原生 GDB ZIP 选择、只读保护、Ctrl+S 导出及 `--recovery-only` 重启恢复；不用于已有用户安装或真实业务工作区。安装版验收继续遵守[发布说明](release.md)。
