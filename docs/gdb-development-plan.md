# GDB 只读支持开发计划

2026-11-05。范围依据：用户要求读取 GDB 图层、允许导出、禁止编辑，随包分发 GDAL；同步实施坐标系、字段几何兼容、规模控制、保存语义及 Windows x64 / macOS ARM64 交付。

## 目标与边界

- 支持 Esri File Geodatabase 的 `.gdb` 目录及包含 `.gdb` 目录的 `.gdb.zip`；不包含企业级地理数据库、MDB、栅格、附件查看、拓扑及关系编辑。
- 先浏览目录，再选择一个矢量图层、字段、要素上限及可选 WGS84 范围；多图层可分别导入。
- GDB 来源图层只读：禁止几何、属性、字段、记录新增删除、撤销重做及源文件重命名/保存；允许显隐、样式、显示名称、查询、选择、测量、分析和导出。
- 导出使用现有 GeoJSON、CSV、SHP ZIP 及已有数据库新表入口，各自保持现有类型、坐标和覆盖保护；不新增 GDB 导出或原库回写。导出不改变 GDB 图层身份和只读状态。
- 分析结果是独立工作区图层，可按现有规则编辑；不修改源 GDB。
- Web 不加载 GDAL，不新增 GDB 入口；MCP 不扩展外部 GDB 读取工具，已导入图层沿用现有快照分析。

## 技术方案

以固定版本 GDAL OpenFileGDB 读取；原生运行时随安装包分发，不依赖 Python、.NET、QGIS 或系统 GDAL。GDAL 动态库、PROJ 数据和必要资源归一化到安装资源 `gdal/`，下载包版本和 SHA-256 纳入锁定清单，二进制不入 Git。

主程序通过自己的 `--gdb-worker <runtimeRoot>` 模式启动独立读取进程。辅助模式在 Tauri 初始化前分流，只接受一个结构化 JSON 请求，仅注册和只读打开必要驱动，不提供任意命令、SQL或写入能力。运行时缺失、架构不符、驱动不可用时明确失败。

父进程使用固定参数启动，限制并发、运行时长和输出，取消、超时、输出超限及应用退出均结束并回收子进程。读取任务不阻塞 UI；取消后不得向工作区追加图层。子进程仅使用随包资源和依赖搜索路径，禁用 PROJ 网络访问。

### IPC 契约

- `gdb_open(requestId, zipped)`：原生选择目录或 ZIP，检查来源、读取图层目录并注册只读来源，返回 `null` 或 catalog。
- `gdb_read(requestId, sourceId, layerName, limit, fields?, bounds?)`：按已注册来源读取，返回完整的有界图层工作副本。
- `gdb_cancel(requestId)`：取消目录或读取任务，幂等；不得取消其他任务。
- catalog：`sourceId, path, fingerprint, layers, warnings`。
- layer：`name, group?, alias?, geometryType, featureCount, sourceCrs, sourceCrsWkt, fields, supported, reason?, warnings`；数量未知为 `null`，不得强制扫描整层计数。
- field：`name, type, nullable, alias?, domain?`；domain 保存可用的非敏感定义或说明，不改变原始编码值。
- read result：`features, sourceCrs, sourceCrsWkt, fields, geometryType, warnings, truncated, loadedCount, readLimit, bounds?, sourceFingerprint, transformation`。feature 使用现有 `{id, geometry, properties, sourceFeatureId}` 格式。
- worker 输入：`{operation: "catalog" | "read", path, layerName?, limit?, fields?, bounds?}`；输出 `{ok: true, result}` 或 `{ok: false, error}`；不混入调试输出。

## 坐标系适配

- 读取每层完整 WKT 和可识别的 authority，工作坐标固定传统 GIS 轴序的 WGS84 经度/纬度。
- 对可可靠转换的地理/投影坐标使用 GDAL/PROJ，覆盖现有三种 CRS 及常见高斯克吕格/UTM 等投影；禁止将未知 CRS 默认为 EPSG:4326。
- 禁用网络格网下载，禁止静默使用 ballpark 转换；缺少所需格网、未知/不支持的 CRS 或非有限结果应报错。保留转换说明，不承诺任意 CRS 或测绘级精度。
- 仅转换 XY；XYZ 的 Z 保留，不进行垂直基准换算。M/ZM、曲线、集合和特殊几何首期拒绝，避免隐式二维化或曲线离散化。
- 范围输入使用 WGS84，校验经纬度及顺序，拒绝跨日期变更线范围；原生过滤后对工作坐标复核范围。

## 字段、几何与身份

- 支持普通点、线、面及对应 Multi，保留洞、多部件、XYZ 和 NULL 几何；非空间表仅列出并说明不支持加入地图。
- 保留字段原名、类型、可空性以及可用别名、域元数据，编码域保留原始值；日期/时间和 GUID 明确转文本；NULL 与空字符串保持区分。
- 64 位整数超过 JS 安全整数范围转文本；要素 OID/FID 以文本保存。二进制及无法可靠映射的字段在目录标明，用户可取消选择；选择后不支持则明确拒绝，不静默删除。
- 属性值、字段数量、嵌套深度、坐标数量和 JSON 字节数受限；不截断字段值、整数或几何。GDAL 警告若涉及数据不完整/身份不保真，不能只作为控制台日志忽略。
- SDC/CDF 压缩等驱动不支持的数据明确失败，不能宣称支持所有 GDB。

## 数据规模和一致性

- 目录不读取全部要素。默认每层读取 10000 条，允许 1–100000；读到上限后额外探测一条，明确标记 `truncated`。用户可按范围/字段缩小读取。
- 单次完整结果最多 100 MiB，单要素最多 100 万坐标位置，累计最多 200 万；XYZ 计一个位置。预算检查随读取推进，超限拒绝整个结果，不交付无标记的部分数据。
- 目录/读任务均有超时及取消；同时最多一个 GDAL 子进程，避免多个大层叠加内存。
- 来源登记仅缓存元数据，不缓存整库。读取前后核对来源指纹；目录指纹有界遍历文件元数据并排除瞬态锁文件，不承诺识别保留时间戳及大小的外部篡改。
- 不持有 GDB 写锁，不创建源目录文件；ZIP 通过只读虚拟文件系统打开，不解压到用户目录。真实样本测试对来源文件内容做读取前后摘要比对。
- 仍沿用地图、工作区恢复、空间分析既有容量限制；驱动支持不等于大库全量渲染支持。

## 来源与恢复语义

- 新增 `sourceKind=gdb` 及专用来源元数据，持久化路径、图层名、来源指纹、字段 schema、原始 CRS、转换说明、实际读取范围/上限及截断状态；临时 sourceId 不持久化。
- 恢复使用已保存只读快照，不自动重读、连接或写回原 GDB；来源缺失仍可看快照和导出，明确是恢复数据。
- 恢复验证不能把 GDB 降级成 GeoJSON/SHP 或允许进入编辑；不恢复 GDB 的编辑会话、字段草稿或历史。
- `Ctrl+S`、保存、另存、重命名源文件等路径对 GDB 明确阻止或引导普通导出；源图层始终不关联导出文件。显示名称与样式修改属于工作区设置。

## 分批提交

1. **计划**：提交本计划，固定范围、数据契约和验收方式。
2. **GDAL 分发与原生读取**：锁定运行时、下载校验和双平台资源；实现 worker、目录、字段/范围限量读取、坐标转换、兼容检查及进程管理；提交通过的原生与运行时检查。
3. **界面与只读语义**：导入面板、来源信息、只读入口和命令保护、快照恢复、导出；提交相关单元及交互验证。
4. **集成交付**：真实 GDB 样本、预算/取消/错误验证、桌面产物检查、跨平台 CI、文档同步；修复并提交。

每批先检查对应改动再提交，根 Agent 负责整合；不推送、不创建发行版、不覆盖安装。遇到平台不可用或样本缺失时记录具体覆盖范围，继续完成独立工作，不伪造实测。

## 验证矩阵

| 方面 | 必测内容 |
| --- | --- |
| 读取 | 多图层目录、分组/名称、选择字段、目录与 ZIP、空图层、未知图层、只读来源未变化 |
| CRS | 4326/4490/3857、至少一种实际投影、经纬轴序、未知 CRS、不可用转换、XYZ 高程保留 |
| 属性 | 中文、NULL/空串、超安全整数、日期/GUID、字段别名/域、被选中不支持字段拒绝 |
| 几何 | 普通与 Multi、面洞、XYZ、空几何；M/ZM/曲线/集合拒绝 |
| 容量 | limit+1 截断提示、字段/范围筛选、字节/坐标预算、取消、超时、并发及子进程回收 |
| 只读 | 工具栏、属性编辑、WKT/JSON、字段/记录增删、快捷键、恢复、保存/另存和源文件重命名均不可绕过 |
| 导出 | 新文件可重读；保持原层只读、身份和范围；不导出未读取的数据；沿用字段及高程保真保护 |
| 平台 | Windows x64 本地原生 worker/打包 smoke；macOS ARM64 CI 运行真实 worker 与产物架构/资源/签名检查 |
| 回归 | pnpm test/build/i18n:check；cargo test/clippy --lib；Web 构建/相关测试；修改共享内核时执行其测试与 Clippy |

GDAL 参考：[OpenFileGDB](https://gdal.org/en/stable/drivers/vector/openfilegdb.html)、[裁剪构建](https://gdal.org/en/stable/development/building_from_source.html)。运行时分发来源、锁定版本和第三方声明由实现提交补齐到长期文档。
