# zGIS 原生 IPC

## 应用信息与项目链接

- `check_app_update`：读取当前运行版本并查询固定公开 GitHub Releases API，返回 `{currentVersion,status,latestVersion?}`。status 为 current、available 或 unpublished；404 表示暂无可用公开发行版，HTTP 错误或无效版本返回错误，不当作已是最新。SemVer 比较包含预发布优先级、忽略构建元数据。请求 10 秒超时、256 KB 上限，不附带令牌，也不下载安装或重启。
- `open_project_link {target}`：target 仅允许 github、license、releases，分别映射项目仓库、GNU GPL 3.0 和项目发布页；Windows 使用 ShellExecuteW 在系统浏览器打开，不接受任意 URL 或 shell。

前端参数使用 camelCase。错误返回中文字符串；数据库密码按用户授权使用 Windows 当前用户 DPAPI 加密持久化，普通配置与恢复文件不含密码。

## 数据源管理

- `load_database_sources` / `save_database_sources {sources}`：PostGIS 安全源配置；MySQL 对应 `load_mysql_sources` / `save_mysql_sources`。源为 `{id,name,host,port,database,user,sslMode}`，不接受 password 或未知字段。
- `load_database_source_password {engine,sourceId}`：返回密码或 null；`save_database_source_password {engine,sourceId,password}` 与 `delete_database_source_password {engine,sourceId}` 保存/删除密码。engine 仅 postgis/mysql，两引擎隔离。固定私有文件 `database-passwords.dat`，DPAPI 加密、原子写入，密码最大 4096 bytes、存储最大 1 MiB；错误不含密码。
- `discover_database_tables {connectionId}` / `discover_mysql_tables {connectionId}`：返回 `{schemas,tables}`，表包含 schema/table、columns、keyColumns、geometryColumns（name/srid/type）。MySQL schemas 为空，表属于连接指定数据库。
- `preview_database_table {connectionId,schema,table,limit}` / `preview_mysql_table {connectionId,table,limit}`：返回 `{columns,rows,truncated}`，limit 为 10 或 20，单次最多 128 列/1 MiB，15 秒超时；非空值以字符串保留精度，复杂/大字段摘要。
- `connect_mysql_database {config}` / `disconnect_mysql_database {connectionId}`：MySQL 独立会话，TLS require/prefer 均验证证书且不降级，disable 明确启用明文。
- `query_mysql_geometry {connectionId,schema,table,geometryColumn,geometryKind?,limit,srid?,bbox?}`：返回 `{features,srid,truncated,writable}`，最多 10000 条，geometry/WKT 工作坐标 4326；未知 geometry SRID=0 需明确确认，其他拒绝。保留 NULL 几何、稳定主键身份、完整属性及提交基线；geometry 基线保存原始存储。二进制属性或单属性超过 64 KiB/总结果超过 16 MiB 拒绝。writable=false 时前端只读。
- `commit_mysql_changes {connectionId,layer,changes,schemaChanges?}` 与 PostGIS `commit_changes` 使用相同变更契约。支持新增/修改/删除记录、几何与属性分离，InnoDB 事务锁行比较完整基线，参数化并拒绝字段转换警告。MySQL 几何写回只支持二维，属性修改保持原 geometry/SRID；WKT 字段保留文本类型。几何写入及字段同步要求 MySQL 8+。
- `schemaChanges` 为 `{kind:'add'|'rename'|'delete',name,newName?}[]`，新增 nullable varchar(255)，重命名保留类型。禁止删除/重命名主键、几何、生成字段及不安全依赖。PostGIS ALTER 与记录写入同一事务；MySQL 使用单次原子 ALTER 后再提交记录，结构已提交而数据失败会返回“提交结果待核对”，前端禁止原批次重试并要求重新加载。

| command | 参数 | 返回 |
| --- | --- | --- |
| `rename_source_file` | `{sourceId:string,newName:string}` | `{sourceId,name,path}`；只重命名已打开文件，保留扩展名，SHP 同步组件，检测外部修改且拒绝覆盖；失败回滚 |
| `open_files` | 无 | `[{name,bytes:number[],sourceId}]`，取消返回空数组 |
| `save_file` | `{sourceId?:string,suggestedName,content,overwrite}` | `{sourceId,name,path}|null`，取消返回 null |
| `export_shapefile` | `{features:Feature[],suggestedName:string,crs?:string}` | `{sourceId,name,path}\|null`，取消返回 null；只保存新的 ZIP |
| `save_recovery` | `{content:string}`，合法 JSON | 无 |
| `load_recovery` | 无 | `string|null` |
| `connect_database` | `{config:{host,port,database,user,password,sslMode}}` | `connectionId` |
| `discover_layers` | `{connectionId}` | `Layer[]` |
| `query_layer` | `{connectionId,schema,table,geometryColumn,geometryKind,srid?:number,limit,bbox?:number[]}` | `{features,srid,truncated}` |
| `commit_changes` | `{connectionId,layer,changes,schemaChanges?}` | `{committed,reloadRequired:true}` |
| `export_database` | `{connectionId,schema,table,features,newTable:true}` | `{inserted,schema,table}` |

`Layer={schema,table,geometryColumn,geometryKind:'geometry'|'wkt',srid,keyColumns:string[],columns:{name,type,nullable,generated,hasDefault}[]}`。WKT 候选来自文本列，用户必须自行选择实际 WKT 字段及其 SRID。geometry 类型使用数据库发现的 SRID。

查询 feature 为 `{id,geometry,properties,dbKey,baseline}`。geometry 是 EPSG:4326 GeoJSON；properties 是除几何字段以外的列，全部非 NULL 值使用数据库 `::text` 安全表示。baseline 包含全部列（包括原始几何文本），dbKey 保存主键列值；两者原样传回提交。日期、精确数值、大整数均保持字符串。

变更为 `{kind:'insert'|'update'|'delete',dbKey,baseline,geometry,properties,geometryChanged?:boolean}`。geometry 使用 EPSG:4326 GeoJSON 或 null，后端转换到目标 SRID。属性更新应传 `geometryChanged:false` 以保持原几何不变；新增总写几何。提交重新发现字段，在事务中锁行比较 baseline，任何冲突均整体回滚。生成字段不写入，属性只更新与 baseline 不同的字段；json/jsonb 属性接受合法 JSON 文本。几何写入先通过二维检查和 ST_IsValid。没有主键的图层只读；不支持编辑自定义字段类型。提交成功后必须重新查询获取新基线。

`export_database.features` 接受 GeoJSON FeatureCollection 或 Feature 数组。只创建新表，字段为 `id bigint identity`、`properties jsonb`、`geom geometry(Geometry,4326)`；不展开任意属性为数据库列，不覆盖现有表。

TLS `require` 和 `prefer` 均验证系统受信证书并要求加密；prefer 不自动回退明文，明文仅在用户明确选择 disable 时启用。查询限制 100000 条并返回 truncated，有主键时稳定排序；bbox 为 WGS84 `[west,south,east,north]`，geometry 使用源 CRS 包围盒过滤，WKT 文本忽略 bbox，首版无分页。导出最多 100000 条，提交最多 10000 条。无真实数据库验证证据时，不声明连接和事务已实测。

文件单个读写上限 100 MB；打开在阻塞任务线程执行，选择单个 SHP 自动带同目录同名 DBF/SHX/PRJ/CPG。路径只在后端句柄表管理，仅 csv/json/geojson 可保存和覆盖。覆盖前比较 SHA-256 指纹；同目录临时写入、sync、内容核验后调用 Windows ReplaceFileW。恢复数据保存在应用私有目录 recovery.json，首版只存最近一次快照。

`export_shapefile` 将 WGS84 二维工作要素转换并写成 SHP/SHX/DBF/PRJ/CPG ZIP。`crs` 可选 EPSG:4326（省略时默认）、EPSG:4490、EPSG:3857，其他值拒绝；PRJ 与输出坐标一致，3857 拒绝超出有效纬度的输入。4490 采用近似经纬度转换，不含测绘级基准改正。输出前检查单一几何类别、字段命名、类型、长度与数值精度；不静默截断或填充缺失属性。原生对话框选择 ZIP，拒绝已存在目标，临时写入与核验后以不覆盖方式提交单个 ZIP；不提供原 SHP 文件组覆盖接口。返回身份仅表示导出文件，不绑定到编辑图层的覆盖句柄。字段和几何限制见根 README 的“SHP 编辑与另存”。

## 空间分析与 Agent

- `gis_mcp_status` / `gis_mcp_set_enabled {enabled}`：返回 `{enabled,endpoint?,token?,startupError?,headersHelper?}`；应用启动自动启用，地址固定为 `http://127.0.0.1:9420/mcp`。token 首次生成后保存到当前用户 Windows 凭据管理器并复用，停止和重启不轮换；不写配置或日志。headersHelper 为安装目录中的认证助手命令；startupError 展示启动失败原因。
- `gis_workspace_sync {layers,activeLayerId}`：layers 为 `{id,name,features}`，只接受标准 GeoJSON Feature 快照。
- `gis_results_drain`：消费待导入的 `{id,name,features}` 结果；前端暂存队列避免退出或繁忙期间丢失。
- `gis_mcp_audit`：有界工具审计摘要。
- `agent_open` / `agent_current`：`{sessionId,running}`；current 无会话时 null。
- `agent_read {sessionId}`：`{data,sequence}`；`agent_write {sessionId,data}`、`agent_resize {sessionId,cols,rows}`、`agent_close {sessionId}`。
- 事件 `zgis-agent-output {sessionId,data,sequence}` 与 `zgis-agent-exit {sessionId,running}`；先订阅后回放，按序号去重。启动与关闭按代次串行校验，取消中的启动不能发布会话。

MCP 工具及计算边界见 [空间分析说明](../docs/spatial-mcp.md)。zGIS 内部图层的 Agent 操作统一使用 zGIS MCP，具体操作以工具清单和 schema 为准。外部文件是否可访问由调用 Agent 按自身权限规则判断，zGIS 不校验外部文件访问授权；这些接口不提供任意文件写入、数据库提交或 shell 调用。PostGIS 按场景使用 zGIS 已加载图层快照或 DBX 直接操作，zGIS MCP 不提供数据库直连。

### 默认与来源坐标系

`query_layer.srid` 省略时默认 4326。文本 WKT 按所选 4326/4490/3857 解析后转换到 WGS84；几何提交转换回来源。geometry 列声明 SRID=0 时，仅对实际 SRID=0 的记录在查询表达式中赋予 4326，保留已有非零 SRID；地图范围过滤在 4326 中比较。读取不会持久化重标记，后续几何修改以有效来源 SRID（缺失时 4326）写回。

外部 GeoJSON 支持命名 `crs` 的 EPSG 标记；无标记默认 4326，显式来源与标记冲突或未知标记拒绝。内部同步和数据库传入的工作 GeoJSON 仍为 4326。

### 底图配置

- `save_preferences {content}`：保存 JSON 字符串，Windows 使用当前用户 DPAPI 加密，最大 1 MB。
- `load_preferences`：返回解密后的 JSON 字符串或 null；读取失败不覆盖旧配置。
- 当前配置为 `{version:2, services, selected, visible}`。服务包含 `id/name/type/preview/url/attribution/enabled`，可选 `previewImage` 为不超过 128 KB 的 PNG data URL，`enabled` 缺省为 true；可选 `maxZoom` 为 0–42 的整数，预置 OpenStreetMap 为 19。`url` 为包含 `{z}`、`{x}`、`{y}` 的 HTTP(S) 地址。
- 前端兼容旧配置：补齐 OSM 地址，移除无自定义地址的旧天地图预置，保留自定义服务和顺序；不再保存全局注记或 tk。空服务列表合法，隐藏服务不参与当前选择；没有可显示服务时 `selected` 为 `none`。服务内容校验失败时保留旧文件并显示错误。

- `fetch_basemap_tile {url:string}`：只读下载单张 HTTP(S) 瓦片并返回图片 data URL，仅供设置保存时合成武汉预览，不暴露为 MCP 工具。拒绝 URL 用户名/密码，最多 3 次重定向、8 秒请求超时、2 MB 响应上限；校验图片类型，错误不含服务地址或密钥。前端并行合成 288×144 PNG，整个预览最多等待 8 秒。保存配置超过 1 MB 时仅裁减可重新获取的预览缓存，优先保留当前底图预览，不删除服务信息。取消后忽略晚到结果；失败保留同地址旧预览，地址变化时移除旧缓存，均允许保存服务。
