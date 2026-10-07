# MCP 与 Codex Agent

用户可直接通过应用内 [空间分析工具箱](processing-toolbox.md) 运行 22 项矢量分析，不需要启动 Agent 或 MCP。工具箱和 MCP 共用 Rust 引擎，来源保持不变，输出为独立结果。

## 使用入口

桌面应用启动时自动启用 MCP，固定监听 `http://127.0.0.1:9420/mcp`，仅本机访问。「设置 → MCP」可查看状态、停止或重新启用；手动停止仅影响本次运行，下次启动应用仍自动启用。端口占用或凭据读取失败时保留地图工作区，并在设置页显示原因。

Bearer token 首次启动时生成并保存到当前用户的 Windows 凭据管理器 `zGIS/MCP`，以后启动和启停均复用，不自动轮换。令牌不写入配置、恢复文件或日志。停止服务和退出应用关闭监听；固定令牌继续保留。

Codex 使用固定地址与安装包中的 `mcp-headers.ps1` 认证助手。助手只在客户端取得认证请求头时读取 Windows 凭据管理器，不需要手动设置令牌环境变量。当前用户默认安装路径的配置如下；修改安装目录时同步助手路径。

```toml
[mcp_servers.zgis]
url = "http://127.0.0.1:9420/mcp"
http_headers_helper = 'pwsh -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\PKUWHAI\AppData\Local\zGIS\mcp-headers.ps1"'
enabled = true
```

Codex 的 MCP 配置与认证助手支持见 [官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。添加后重启 Codex 的 MCP 连接或重新打开聊天，再查看 `zgis` 工具。

Agent 对 zGIS 内部图层的操作统一使用 zGIS MCP，具体操作以工具清单和 schema 为准。当前图层自动同步为 WGS84 GeoJSON 快照，包括尚未保存的编辑；只传几何、属性和要素 ID，不传数据库连接、主键基线或密码。外部 GeoJSON、SHP、含 WKT 的 CSV 等数据优先交由 zGIS MCP 加载和分析，由调用 Agent 按自身权限规则判断是否可访问；zGIS 不校验外部文件访问授权。

「Codex Agent」侧栏连接本机已安装、已登录的 Codex CLI。沿用 zTerm 的 PTY 交互方式，隐藏侧栏保留会话，停止会话、停止 MCP 或退出应用终止所属进程树。Agent 使用私有工作目录和只读 sandbox，禁用继承的 MCP、apps、plugins，只连接 zGIS；不改写 CLI 登录文件，内嵌会话不检查或执行 CLI 更新，版本维护在应用外进行。用户发送到 Codex 的提示与工具数据受所使用 Codex 服务的数据政策约束。

## 工具

| 工具 | 用途 |
| --- | --- |
| `list_layers` / `describe_layer` | 当前图层、字段、要素数和版本 |
| `read_features` | 当前图层分页要素 |
| `load_vector_file` | 按路径加载外部矢量文件，生成缓存结果 |
| `spatial_query` | bbox 或 intersects/within/contains/touches/disjoint 查询 |
| `spatial_join` | 空间关联，源属性加匹配目标信息 |
| `nearest` | 最近目标及近似米制距离 |
| `topology_check` | 无效几何、精确重复几何、面重叠报告 |
| `buffer` | 近似米制缓冲 |
| `clip` | 面与面裁剪 |
| `dissolve` | 面合并 |
| `intersection` / `difference` / `symmetric_difference` | 面相交、差集、对称差 |
| `centroid` / `point_on_surface` | 逐要素质心和表面代表点 |
| `convex_hull` / `envelope` | 逐要素凸包和轴对齐包络 |
| `multipart_to_singleparts` / `extract_vertices` / `polygon_to_lines` | 拆部件、提取顶点、面边界转线 |
| `simplify` / `geometry_attributes` | 近似米制简化及面积、长度属性 |
| `count_points` / `merge` | 面内点计数和两个图层汇集 |
| `layer_summary` | 几何、字段、范围摘要 |
| `read_result` | 分页读取结果或拓扑问题 |
| `publish_result` | 导入独立未保存结果图层 |

分析的 `source` / `target` 三选一：`{"layerId":"图层ID"}`、`{"resultId":"缓存结果ID"}`、`{"path":"Agent 已判断可访问的文件路径","crs":"EPSG:4326"}`。文件参数另支持 `wktField`、`xField`、`yField`；以工具返回的 schema 为准。示例 tools/call arguments：

```json
{"source":{"layerId":"图层ID"},"bbox":[116,39,117,41]}
```

将返回的 `resultId` 作为 `buffer` 的输入，再发布：

```json
{"source":{"resultId":"查询结果ID"},"distanceMeters":100}
```

```json
{"resultId":"缓冲结果ID","name":"100米缓冲"}
```

发布前检查源图层版本，源已修改则拒绝；同一结果重复发布不会重复创建图层。结果独立于源图层，用户使用现有保存/导出入口处理，不自动写文件或数据库。

当前共 28 个 MCP 工具，其中 22 项为分析。`simplify` 的 `toleranceMeters` 须 >0 且 ≤100000；`dissolve` 可传非空 `groupBy` 字段，按标量类型和值分组。相交的目标属性采用 `target_` 前缀，字段冲突继续加下划线；新字段避免覆盖原属性。输出要素、顶点及字节预算在生成过程中检查，超限不返回部分结果。具体语义见工具箱说明与实际 schema。

## 数据与计算边界

外部读取支持 GeoJSON、UTF-8 CSV（WKT 或 X/Y）、SHP 文件组和仅含一组 SHP 的 ZIP。只支持明确的 EPSG:4326 / EPSG:4490 / EPSG:3857（默认 4326，4490 按近似经纬度转换）；不能可靠识别的 PRJ 需显式指定 CRS，GeoJSON 按传统命名 `crs` 标记识别来源；无标记默认 4326，也可显式指定来源 CRS；显式值与标记冲突时拒绝读取。中文 DBF 按 CPG 编码读取。高精度 GeoJSON 属性与 ID 转为文本保留；超安全精度 DBF 数值拒绝，避免静默损失。

空间关系与面叠加使用经纬度平面，拒绝跨日期线。距离与缓冲使用局部等距圆柱近似，非测地算法；适用纬度 ±75°、经纬跨度不超过 5°，缓冲最大 100 km。Clip 仅支持面。拓扑报告不覆盖完整的缝隙、悬挂线和网络连通规则，也不自动修复。

每个分析输入层与结果最多 1 万要素、100 万顶点；单次分析最多 100 万候选对，结果限 100 MiB。当前快照最多 10 万要素/100 MiB；缓存最多 20 个结果、20 万要素/100 MiB，30 分钟失效；工具响应样本最多 100 条/512 KiB，完整数据分页读取。服务并发最多 2，请求最多 2 MiB。大规模工程级计算应使用专业 GIS 引擎。

PostGIS 表按实际场景选择 zGIS MCP 分析已加载图层快照，或通过 DBX 直接操作数据库。zGIS MCP 不直连数据库，不提供任意 SQL、shell、源文件覆盖或数据库提交工具；审计保存有界调用摘要，不记录访问 token。

## 工具清单展示

「设置 → MCP」直接显示服务状态、操作、地址和令牌；连接配置默认收起，不再展示最近工具调用；后端有界审计能力保留。「工具详情」按图层与数据、空间分析、分析结果分组，显示中文名称、tool 标识和工具总数；展开单个工具后显示完整说明。清单默认收起，首次展开加载；支持错误重试和空清单提示，服务停止时也可查看。

清单通过只读桌面命令 `gis_mcp_tool_catalog` 读取与 MCP `tools/list` 相同的 `definitions()`，不需要启动服务或访问令牌。新增工具即使没有预设中文名称，也会以原标识列入「其他工具」，不会被过滤。此入口仅展示，不执行 tool。
