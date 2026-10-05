# zGIS

Windows 轻量地理数据查看与编辑器，使用 Tauri 2、React、OpenLayers 与 Rust。当前版本为 0.1.0，不包含 Python/GDAL 运行时。

## 功能

- GeoJSON、CSV（WKT 或 X/Y）、Shapefile 文件组与 ZIP 导入，多图层显隐、颜色、透明度、线宽和范围定位。
- 地图选取、点线面绘制、顶点修改和捕捉；二维普通和 Multi 几何、面洞；删除、撤销、重做。
- 属性表搜索与每页 100 条显示、属性编辑、JSON 属性编辑、WKT 几何编辑、添加字段。
- GeoJSON 与 CSV 保存/转换；SHP 工作副本可编辑，并另存为新的 SHP ZIP 或其他格式。
- PostGIS 连接、元数据发现、geometry / WKT 文本读取、有主键图层事务编辑、冲突检测和新表导入。
- OpenStreetMap、天地图矢量/影像及注记、无底图模式。
- 自动恢复本地副本、逐图层退出处理、文件外部修改冲突保护。
- 本机 MCP 空间查询、关联、拓扑检查、缓冲、裁剪和面合并；嵌入式 Codex CLI Agent。操作、工具与计算限制见 [空间分析说明](docs/spatial-mcp.md)。

## 运行与安装

交付安装包在 `F:\Workspace\Deliverables\zGIS\zGIS_0.1.0_x64-setup.exe`。当前用户安装默认目录为 `%LOCALAPPDATA%\zGIS`，启动文件为 `zgis.exe`；可从开始菜单启动。卸载使用 Windows 应用管理或安装目录的 `uninstall.exe`。

含 SHP 编辑、空间分析 MCP 和 Agent 的增量安装包为 `F:\Workspace\Deliverables\zGIS\zGIS_0.1.0_mcp-agent_x64-setup.exe`。已对该构建的 release EXE 完成原生测试，未自动替换旧安装版。

依赖 Windows WebView2 Runtime。安装包使用 Tauri NSIS 引导方式，缺少 Runtime 时可能需要联网安装。当前构建未配置代码签名，不是已经签名的商业发布包。

## 操作

界面采用无重复标题的自定义单行 header，空白区域可拖动窗口，双击可最大化或还原，右侧提供窗口控制按钮：文件菜单提供打开、保存、另存、导出与退出，数据菜单提供导入、PostGIS 与城市示例，视图菜单切换图层、属性表和检查器。深浅主题在「设置 → 外观」即时切换并记住选择；底图选择位于图层区底部。「设置 → 地图」配置天地图及注记，tk 不持久化。完整改版约定见 [界面设计约定](docs/interface-design.md)。

打开 GeoJSON 或 CSV；GeoJSON 可按文件 `crs` 标记识别或明确选择来源坐标系，无标记默认 4326；CSV 左侧配置列名、编码与 CRS，右侧显示前 5 行实际数据。预览在 Worker 中执行，导入时校验全部记录，错误留在原窗口；可明确切换 WKT 与 X/Y，支持 EPSG:4326 / EPSG:4490 / EPSG:3857，默认 EPSG:4326。打开单个 SHP 时桌面后端会收集同目录同名配套文件；必须具备 DBF、PRJ，中文编码优先按 CPG 解释。ZIP 内支持多组 SHP。

属性表默认关闭，可从 header 或视图菜单打开并拖动上沿调整高度。单击选择要素，双击表格记录定位。图层单击显示右侧样式与来源详情，双击定位图层。右侧要素字段通过「编辑 → 应用/取消」修改，JSON 与 WKT 在独立窗口中编辑。WKT 坐标始终为 WGS84 经纬度。顶点工具修改选中要素，绘制工具新增要素；地图左上竖排工具栏提供选择、编辑、绘制、删除、撤销重做、完成/取消与捕捉开关，状态栏显示绘制节点数。删除有确认步骤，可撤销。Shapefile 来源支持同样的属性、几何编辑与撤销重做；编辑发生在工作副本中，原文件组保持不变。

文件保存覆盖已打开的 GeoJSON/CSV 前检查指纹；来源发生外部修改时拒绝覆盖，可使用另存或导出。SHP 的保存入口进入导出。导出窗口左配置、右摘要，支持文件名与输出坐标；输出选择 GeoJSON、CSV WKT、CSV X/Y、SHP ZIP（桌面版）或 PostGIS 新表。X/Y 只接受 Point，不支持的几何就地提示并禁用导出；CSV 嵌套属性转为 JSON 文本。

PostGIS 从数据菜单进入左侧数据源列表，连接窗口将端口与 TLS 放在折叠高级设置中，折叠时仍显示 TLS 状态。双击数据表打开加载设置，支持 WKT 来源列、真实 SRID、读取上限及 geometry 的地图范围。无主键只读。文件菜单的提交入口先展示目标与新增、修改、删除数量，再显式提交；失败留在原窗口，本地编辑保留，错误详情可展开。成功后重读基线；事务结束时连接异常或成功后重读失败禁止重复提交，必须重新载入并核对来源。密码只用于本次连接，不保存；天地图 tk 也只在本次运行保留。

### SHP 编辑与另存

桌面版导出 SHP ZIP，内含同名 SHP、SHX、DBF、PRJ、CPG，输出可选 EPSG:4326（默认）、EPSG:4490 或 EPSG:3857，属性编码为 UTF-8。目标 ZIP 必须不存在，已有文件拒绝覆盖。不覆盖原 SHP 文件组，不保留原 DBF schema、编码；三种坐标系以外的原投影保真写回的工作仍应使用专业 GIS 软件。

单个输出图层必须属于同一几何类别：Point、MultiPoint、线（含 MultiLineString）或面（含 MultiPolygon）。面洞和多部件保留；混合类别、空几何及 Z/M 拒绝输出。字段名为 1–10 个 ASCII 字母、数字或下划线，首字符不能为数字，不允许大小写重名。文本最多 254 个 UTF-8 字节，不接受空字符串或首尾空格，避免 DBF 填充及读取去空格造成数据变化；布尔值和安全数值可以输出，数值最多 15 位有效数字和 8 位小数且须保持往返精度。缺失值、NULL、对象、数组及不满足限制的字段明确报错，不静默截断、填零或改名。完全没有属性的图层会增加 ZG_ROW 行号字段，以便生成可互操作的 DBF。

导出成功不会清除工作副本的未保存标记，取消或失败也保留编辑。退出时可以保留恢复副本、另存 GeoJSON 或明确放弃；再次打开导出的 ZIP 可继续编辑。UTF-8 中文跨软件兼容性应以实际目标软件验收为准。

## 当前边界

启动时自动校验并加载恢复副本，所有来源恢复为独立本地 GeoJSON，不保留文件句柄、数据库身份或提交基线；图层标注恢复来源。无效恢复文件报错并保留原文件。退出窗口逐图层选择保存、保留恢复副本、放弃，数据库图层另可明确提交。保存取消或处理失败不退出，前面成功保存或提交的图层保持已完成状态；只有选择保留的图层进入退出快照。

- 不支持 GDB；不静默降维，Z/M、GeometryCollection 和特殊几何拒绝导入或写入。
- 文件单个读写最多 100 MB；ZIP 最多 2000 条、解压数据最多 200 MB。恢复副本也受大小限制。内存放大仍受要素/顶点规模影响，未宣称 100 MB 任意文件均流畅。
- 工作模型统一为 WGS84；SHP 高层读取转到 WGS84，原投影只作为来源信息。CSV、SHP、GeoJSON 支持 4326/4490/3857，默认 4326；GeoJSON 默认输出 RFC 7946 的 4326；也支持含传统 `crs` 标记的 4490/3857 导入导出。无标记文件默认 4326，可在导入窗口明确选择来源坐标系；显式选择与文件标记冲突时拒绝导入。4490（CGCS2000）与 WGS84 采用近似经纬度转换，不含历元、七参数或格网改正，不适用于测绘级基准转换。3857 输出拒绝超出 ±85.05112878° 的纬度，不静默裁切。不承诺任意工程 CRS。
- 超安全范围整数及高精度小数属性转为字符串，GeoJSON 再导出保持文本类型；普通安全数值保留数值类型。JSON 属性编辑采用无损解析后同一规则，不能承诺原始格式完全保真。
- CSV 属性默认文本，不提供完整字段 schema 设计器或 NULL 规则配置；CSV 空字符串与 NULL 不保真。改变输出几何模式会移除已识别的旧几何列，避免留下过时数据。
- 属性表为本地分页和搜索；PostGIS 读取最多 10 万条，geometry 可选当前地图范围，尚无数据库游标分页。界面标记读取上限，不能把当前结果当全表。
- PostGIS 文本 WKT 来源可选 EPSG:4326（默认）、4490、3857，读取转换至工作坐标，几何提交转换回来源坐标。geometry 中 SRID=0 的记录按 4326 解释，已有非零 SRID 保留；不自动批量改写库内 SRID。
- PostGIS 新表采用 `id bigint identity + properties jsonb + geom geometry(Geometry,4326)`，不展开字段，不覆盖已有表；不支持 geography、数据库结构管理或任意 SQL。
- 本地检查几何结构，不执行完整拓扑修复；数据库提交使用 ST_IsValid。数据库连接、TLS、真实约束和并发集成仍需用户提供指定测试环境后验证。
- 退出恢复使用私有目录快照，不存密码。数据库来源恢复为本地 GeoJSON 副本，不能自动提交回原表。
- 公共 OSM 底图没有 SLA，不支持离线预取；本地数据不上传到瓦片服务，但底图请求会暴露视窗范围。

## 开发与验证

使用 Node.js >=22.13、pnpm 8.10、Rust MSVC 与 Visual Studio C++ Build Tools。工程文件位于 `F:\Workspace\Repos\个人项目\zGIS`。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test
pnpm smoke
pwsh -File scripts/build.ps1
```

开发地址为 `http://127.0.0.1:1421`。浏览器仅用于前端验证，原生文件与数据库入口需要桌面运行。`pnpm smoke` 需要先运行 dev，使用已安装 Edge；fixtures 由测试脚本生成，不访问用户数据。

后端单测可执行 `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked`，需先载入 `scripts/msvc-environment.ps1`。打包脚本显式载入 MSVC，防止 Git 的 link.exe 抢占。Cargo.lock 和 pnpm-lock.yaml 都提交，构建、截图与测试数据在 output/target，不提交。

安装版验收执行 `pwsh -File scripts/installed-smoke.ps1`，先正常关闭现有 zGIS 会话。脚本暂存并最终还原原恢复文件，使用独立 WebView2 目录，仅操作生成的测试文件；验证原生打开、保存、导出、取消、外部修改保护，以及真实退出后跨进程恢复和放弃。MCP/Agent 测试还需要 PATH 中有已登录的 Codex CLI，验证鉴权、链式分析、文件授权和 `/mcp` 工具发现，不发起模型推理。可用 `-Executable` 指定新构建的 release EXE。WebView2 本地 CDP 仅测试时通过环境启用，不写入产品配置，常规启动不开调试端口。独立 WebView2 目录本身不隔离 Rust 恢复文件，不直接对用户运行中的实例执行底层 smoke。

接口见 [src-tauri/IPC.md](src-tauri/IPC.md)。最初设计见 [zGIS技术方案](../../../Deliverables/zGIS/zGIS技术方案.md)，实现边界以本 README 为准。数据库的 AI 直接操作仍遵守工作台 DBX 入口，应用数据层不提供旁路工具。
