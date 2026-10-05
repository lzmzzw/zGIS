# 空间分析 MCP 与 Codex Agent

## 使用入口

桌面 header 的「空间分析 MCP」启用本机服务，默认关闭。服务采用 loopback Streamable HTTP、随机端口和每次启用重新生成的 Bearer token；界面提供外部客户端 TOML 配置，token 使用 `ZGIS_MCP_TOKEN` 环境变量引用。停止服务后旧地址与令牌失效。

当前图层自动同步为 WGS84 GeoJSON 快照，包括尚未保存的编辑；只传几何、属性和要素 ID，不传数据库连接、主键基线或密码。外部文件先在该窗口选择文件或授权目录，仅本次运行有效，可撤销；规范路径与符号链接检查防止越界，`_credentials` 始终排除。

「Codex Agent」侧栏连接本机已安装、已登录的 Codex CLI。沿用 zTerm 的 PTY 交互方式，隐藏侧栏保留会话，停止会话、停止 MCP 或退出应用终止所属进程树。Agent 使用私有工作目录和只读 sandbox，禁用继承的 MCP、apps、plugins，只连接 zGIS；不改写 CLI 登录文件，内嵌会话不检查或执行 CLI 更新，版本维护在应用外进行。用户发送到 Codex 的提示与工具数据受所使用 Codex 服务的数据政策约束。

## 工具

| 工具 | 用途 |
| --- | --- |
| `list_layers` / `describe_layer` | 当前图层、字段、要素数和版本 |
| `read_features` | 当前图层分页要素 |
| `load_vector_file` | 加载已授权外部矢量文件，生成缓存结果 |
| `spatial_query` | bbox 或 intersects/within/contains/touches/disjoint 查询 |
| `spatial_join` | 空间关联，源属性加匹配目标信息 |
| `nearest` | 最近目标及近似米制距离 |
| `topology_check` | 无效几何、精确重复几何、面重叠报告 |
| `buffer` | 近似米制缓冲 |
| `clip` | 面与面裁剪 |
| `dissolve` | 面合并 |
| `layer_summary` | 几何、字段、范围摘要 |
| `read_result` | 分页读取结果或拓扑问题 |
| `publish_result` | 导入独立未保存结果图层 |

分析的 `source` / `target` 三选一：`{"layerId":"图层ID"}`、`{"resultId":"缓存结果ID"}`、`{"path":"已授权文件路径","crs":"EPSG:4326"}`。文件参数另支持 `wktField`、`xField`、`yField`；以工具返回的 schema 为准。示例 tools/call arguments：

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

## 数据与计算边界

外部读取支持 GeoJSON、UTF-8 CSV（WKT 或 X/Y）、SHP 文件组和仅含一组 SHP 的 ZIP。只支持明确的 EPSG:4326 / EPSG:4490 / EPSG:3857（默认 4326，4490 按近似经纬度转换）；不能可靠识别的 PRJ 需显式指定 CRS，GeoJSON 按传统命名 `crs` 标记识别来源；无标记默认 4326，也可显式指定来源 CRS；显式值与标记冲突时拒绝读取。中文 DBF 按 CPG 编码读取。高精度 GeoJSON 属性与 ID 转为文本保留；超安全精度 DBF 数值拒绝，避免静默损失。

空间关系与面叠加使用经纬度平面，拒绝跨日期线。距离与缓冲使用局部等距圆柱近似，非测地算法；适用纬度 ±75°、经纬跨度不超过 5°，缓冲最大 100 km。Clip 仅支持面。拓扑报告不覆盖完整的缝隙、悬挂线和网络连通规则，也不自动修复。

单次分析最多 1 万要素、100 万顶点和 100 万候选对。当前快照最多 10 万要素/100 MB；缓存最多 20 个结果、20 万要素/100 MB，30 分钟失效；工具响应样本最多 100 条/512 KB，完整数据分页读取。服务并发最多 2，请求最多 2 MB。大规模工程级计算应使用专业 GIS 引擎。

MCP 不提供任意 SQL、shell、源文件覆盖或数据库提交工具；审计保存有界调用摘要，不记录访问 token。
