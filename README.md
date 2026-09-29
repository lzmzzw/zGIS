# zGIS

Windows 轻量地理数据查看与编辑器，使用 Tauri 2、React、OpenLayers 与 Rust。当前版本为 0.1.0，不包含 Python/GDAL 运行时。

## 功能

- GeoJSON、CSV（WKT 或 X/Y）、Shapefile 文件组与 ZIP 导入，多图层显隐、颜色和范围定位。
- 地图选取、点线面绘制、顶点修改和捕捉；二维普通和 Multi 几何、面洞；删除、撤销、重做。
- 属性表搜索与每页 100 条显示、属性编辑、JSON 属性编辑、WKT 几何编辑、添加字段。
- GeoJSON 与 CSV 保存/转换，SHP 来源只读，可将工作副本导出为其他格式。
- PostGIS 连接、元数据发现、geometry / WKT 文本读取、有主键图层事务编辑、冲突检测和新表导入。
- OpenStreetMap、天地图矢量/影像及注记、无底图模式。
- 未保存副本恢复，关闭前保留提示，文件外部修改冲突保护。

## 运行与安装

交付安装包在 `F:\Workspace\Deliverables\zGIS\zGIS_0.1.0_x64-setup.exe`。当前用户安装默认目录为 `%LOCALAPPDATA%\zGIS`，启动文件为 `zgis.exe`；可从开始菜单启动。卸载使用 Windows 应用管理或安装目录的 `uninstall.exe`。

依赖 Windows WebView2 Runtime。安装包使用 Tauri NSIS 引导方式，缺少 Runtime 时可能需要联网安装。当前构建未配置代码签名，不是已经签名的商业发布包。

## 操作

界面采用单行 header：文件菜单提供打开、保存、另存与导出，数据菜单提供导入、PostGIS 与城市示例，视图菜单切换图层、属性表和检查器。深浅主题在「设置 → 外观」即时切换并记住选择；底图选择位于图层区底部。「设置 → 地图」配置天地图及注记，tk 不持久化。已确认的完整改版约定见 [界面设计约定](docs/interface-design.md)，其中后续批次尚未全部落实。

打开 GeoJSON 或 CSV；CSV 导入确认列名、编码与 CRS，支持 EPSG:4326 / EPSG:3857。打开单个 SHP 时桌面后端会收集同目录同名配套文件；必须具备 DBF、PRJ，中文编码优先按 CPG 解释。ZIP 内支持多组 SHP。

属性表默认关闭，可从 header 或视图菜单打开并拖动上沿调整高度。单击选择要素，双击表格记录定位。图层单击显示右侧样式与来源详情，双击定位图层。右侧要素字段通过「编辑 → 应用/取消」修改，JSON 与 WKT 在独立窗口中编辑。WKT 坐标始终为 WGS84 经纬度。顶点工具修改选中要素，绘制工具新增要素；header 提供完成/取消与捕捉开关，状态栏显示绘制节点数。删除有确认步骤，可撤销。Shapefile 来源显示锁标记，禁止编辑，允许查看、样式与导出。

文件保存覆盖已打开的 GeoJSON/CSV 前检查指纹；来源发生外部修改时拒绝覆盖，可使用导出另存。SHP 的保存入口进入导出。输出选择 GeoJSON、CSV WKT、CSV X/Y 或 PostGIS 新表；X/Y 只接受 Point，CSV 嵌套属性转为 JSON 文本。

PostGIS 连接选择 TLS 校验证书或显式禁用。密码只用于本次连接，不保存；天地图 tk 也只在本次运行保留。WKT 来源必须指定真实 SRID；geometry 来源使用数据库元数据。无主键只读。提交是显式写库操作，整体事务失败保留本地编辑；成功后重读基线。事务结束时连接异常或成功后重读失败，将禁止当前副本再次提交，必须重新载入并核对来源，不自动重试。

## 当前边界

- 不支持 GDB，不输出 SHP；不静默降维，Z/M、GeometryCollection 和特殊几何拒绝导入或写入。
- 文件单个读写最多 100 MB；ZIP 最多 2000 条、解压数据最多 200 MB。恢复副本也受大小限制。内存放大仍受要素/顶点规模影响，未宣称 100 MB 任意文件均流畅。
- 工作模型统一为 WGS84；SHP 高层读取转到 WGS84，原投影只作为来源信息。CSV 支持已验证的 4326/3857，不承诺任意工程 CRS。
- 超安全范围整数及高精度小数属性转为字符串，GeoJSON 再导出保持文本类型；普通安全数值保留数值类型。JSON 属性编辑采用无损解析后同一规则，不能承诺原始格式完全保真。
- CSV 属性默认文本，不提供完整字段 schema 设计器或 NULL 规则配置；CSV 空字符串与 NULL 不保真。改变输出几何模式会移除已识别的旧几何列，避免留下过时数据。
- 属性表为本地分页和搜索；PostGIS 读取最多 10 万条，geometry 可选当前地图范围，尚无数据库游标分页。界面标记读取上限，不能把当前结果当全表。
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

安装版桌面 smoke 使用 WebView2 本地 CDP，仅测试时通过环境启用，不写入产品配置：指定 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9226` 和独立 `WEBVIEW2_USER_DATA_FOLDER` 后启动，再执行 `node scripts/desktop-smoke.mjs <PID>`。测试只操作生成的测试文件，用 Windows UI Automation 验证原生对话框。完成后停止测试实例，不在常规启动时开启调试端口。

接口见 [src-tauri/IPC.md](src-tauri/IPC.md)。最初设计见 [zGIS技术方案](../../../Deliverables/zGIS/zGIS技术方案.md)，实现边界以本 README 为准。数据库的 AI 直接操作仍遵守工作台 DBX 入口，应用数据层不提供旁路工具。
