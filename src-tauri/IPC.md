# zGIS 原生 IPC

前端参数使用 camelCase。错误返回中文字符串；凭据只存活在当前进程内。

| command | 参数 | 返回 |
| --- | --- | --- |
| `open_files` | 无 | `[{name,bytes:number[],sourceId}]`，取消返回空数组 |
| `save_file` | `{sourceId?:string,suggestedName,content,overwrite}` | `{sourceId,name,path}|null`，取消返回 null |
| `export_shapefile` | `{features:Feature[],suggestedName:string,crs?:string}` | `{sourceId,name,path}\|null`，取消返回 null；只保存新的 ZIP |
| `save_recovery` | `{content:string}`，合法 JSON | 无 |
| `load_recovery` | 无 | `string|null` |
| `connect_database` | `{config:{host,port,database,user,password,sslMode}}` | `connectionId` |
| `discover_layers` | `{connectionId}` | `Layer[]` |
| `query_layer` | `{connectionId,schema,table,geometryColumn,geometryKind,srid?:number,limit,bbox?:number[]}` | `{features,srid,truncated}` |
| `commit_changes` | `{connectionId,layer,changes}` | `{committed,reloadRequired:true}` |
| `export_database` | `{connectionId,schema,table,features,newTable:true}` | `{inserted,schema,table}` |

`Layer={schema,table,geometryColumn,geometryKind:'geometry'|'wkt',srid,keyColumns:string[],columns:{name,type,nullable,generated,hasDefault}[]}`。WKT 候选来自文本列，用户必须自行选择实际 WKT 字段及其 SRID。geometry 类型使用数据库发现的 SRID。

查询 feature 为 `{id,geometry,properties,dbKey,baseline}`。geometry 是 EPSG:4326 GeoJSON；properties 是除几何字段以外的列，全部非 NULL 值使用数据库 `::text` 安全表示。baseline 包含全部列（包括原始几何文本），dbKey 保存主键列值；两者原样传回提交。日期、精确数值、大整数均保持字符串。

变更为 `{kind:'insert'|'update'|'delete',dbKey,baseline,geometry,properties,geometryChanged?:boolean}`。geometry 使用 EPSG:4326 GeoJSON 或 null，后端转换到目标 SRID。属性更新应传 `geometryChanged:false` 以保持原几何不变；新增总写几何。提交重新发现字段，在事务中锁行比较 baseline，任何冲突均整体回滚。生成字段不写入，属性只更新与 baseline 不同的字段；json/jsonb 属性接受合法 JSON 文本。几何写入先通过二维检查和 ST_IsValid。没有主键的图层只读；不支持编辑自定义字段类型。提交成功后必须重新查询获取新基线。

`export_database.features` 接受 GeoJSON FeatureCollection 或 Feature 数组。只创建新表，字段为 `id bigint identity`、`properties jsonb`、`geom geometry(Geometry,4326)`；不展开任意属性为数据库列，不覆盖现有表。

TLS `require` 和 `prefer` 均验证系统受信证书并要求加密；prefer 不自动回退明文，明文仅在用户明确选择 disable 时启用。查询限制 100000 条并返回 truncated，有主键时稳定排序；bbox 为 WGS84 `[west,south,east,north]`，geometry 使用源 CRS 包围盒过滤，WKT 文本忽略 bbox，首版无分页。导出最多 100000 条，提交最多 10000 条。无真实数据库验证证据时，不声明连接和事务已实测。

文件单个读写上限 100 MB；打开在阻塞任务线程执行，选择单个 SHP 自动带同目录同名 DBF/SHX/PRJ/CPG。路径只在后端句柄表管理，仅 csv/json/geojson 可保存和覆盖。覆盖前比较 SHA-256 指纹；同目录临时写入、sync、内容核验后调用 Windows ReplaceFileW。恢复数据保存在应用私有目录 recovery.json，首版只存最近一次快照。

`export_shapefile` 将 WGS84 二维工作要素转换并写成 SHP/SHX/DBF/PRJ/CPG ZIP。`crs` 可选 EPSG:4326（省略时默认）、EPSG:4490、EPSG:3857，其他值拒绝；PRJ 与输出坐标一致，3857 拒绝超出有效纬度的输入。4490 采用近似经纬度转换，不含测绘级基准改正。输出前检查单一几何类别、字段命名、类型、长度与数值精度；不静默截断或填充缺失属性。原生对话框选择 ZIP，拒绝已存在目标，临时写入与核验后以不覆盖方式提交单个 ZIP；不提供原 SHP 文件组覆盖接口。返回身份仅表示导出文件，不绑定到编辑图层的覆盖句柄。字段和几何限制见根 README 的“SHP 编辑与另存”。

## 空间分析与 Agent

- `gis_mcp_status` / `gis_mcp_set_enabled {enabled}`：返回 `{enabled,endpoint?,token?,authorizedPaths}`；token 仅供本次服务，不持久化。
- `gis_workspace_sync {layers,activeLayerId}`：layers 为 `{id,name,features}`，只接受标准 GeoJSON Feature 快照。
- `gis_results_drain`：消费待导入的 `{id,name,features}` 结果；前端暂存队列避免退出或繁忙期间丢失。
- `gis_authorize_files` / `gis_authorize_directory`：原生对话框授权只读路径；`gis_revoke_access` 撤销并使缓存失效。
- `gis_mcp_audit`：有界工具审计摘要。
- `agent_open` / `agent_current`：`{sessionId,running}`；current 无会话时 null。
- `agent_read {sessionId}`：`{data,sequence}`；`agent_write {sessionId,data}`、`agent_resize {sessionId,cols,rows}`、`agent_close {sessionId}`。
- 事件 `zgis-agent-output {sessionId,data,sequence}` 与 `zgis-agent-exit {sessionId,running}`；先订阅后回放，按序号去重。启动与关闭按代次串行校验，取消中的启动不能发布会话。

MCP 工具及计算边界见 [空间分析说明](../docs/spatial-mcp.md)。这些接口不提供任意文件写入、数据库提交或 shell 调用。

### 默认与来源坐标系

`query_layer.srid` 省略时默认 4326。文本 WKT 按所选 4326/4490/3857 解析后转换到 WGS84；几何提交转换回来源。geometry 列声明 SRID=0 时，仅对实际 SRID=0 的记录在查询表达式中赋予 4326，保留已有非零 SRID；地图范围过滤在 4326 中比较。读取不会持久化重标记，后续几何修改以有效来源 SRID（缺失时 4326）写回。

外部 GeoJSON 支持命名 `crs` 的 EPSG 标记；无标记默认 4326，显式来源与标记冲突或未知标记拒绝。内部同步和数据库传入的工作 GeoJSON 仍为 4326。
