/** Canonical service messages. Placeholders preserve filenames, field names and external details. */
const errors: Record<string, string> = Object.fromEntries(`
ANALYSIS_BUSY: 分析任务正在运行，请稍后重试|ANALYSIS_BUSY: An analysis is already running. Try again later.
ANALYSIS_CANCELLED: 分析已取消|ANALYSIS_CANCELLED: Analysis cancelled
ANALYSIS_DUPLICATE: 任务标识正在使用|ANALYSIS_DUPLICATE: Job ID is already in use
ANALYSIS_TIMEOUT: 分析超过时间预算|ANALYSIS_TIMEOUT: Analysis exceeded its time budget
Agent 会话不存在|Agent session does not exist
Agent 启动已取消|Agent startup cancelled
Agent 启动已取消或 MCP 会话已改变|Agent startup cancelled or MCP session changed
Agent 已退出|Agent has exited
Agent 状态不可用|Agent state unavailable
Agent 输入失败|Agent input failed
Codex CLI 不可用或配置无效，请检查安装与登录状态|Codex CLI unavailable or misconfigured. Check installation and sign-in.
Codex MCP 名称无法安全隔离|Codex MCP names cannot be safely isolated
Codex 配置探测超时|Codex configuration probe timed out
DBF包含超出安全精度的数值，请将该字段转换为文本再加载|DBF contains numbers beyond safe precision. Convert the field to text before loading.
DBF头不完整|Incomplete DBF header
EPSG:3857 不支持超出 ±85.05112878° 的纬度|EPSG:3857 does not support latitudes beyond ±85.05112878°
Feature属性必须为对象或null|Feature properties must be an object or null
Feature缺少geometry|Feature is missing geometry
GeoJSON含重复字段|GeoJSON contains duplicate fields
GeoJSON坐标系标记无效或不支持|Invalid or unsupported GeoJSON CRS
GeoJSON嵌套crs标记与来源坐标系冲突，不支持混合坐标系|Nested GeoJSON CRS conflicts with the source CRS. Mixed coordinate systems are unsupported.
MCP 固定令牌无法保存到 Windows 凭据管理器|Cannot save the MCP token to Windows Credential Manager
MCP 固定令牌格式无效|Invalid MCP token format
MCP 固定令牌格式无效，请检查 Windows 凭据管理器的 zGIS/MCP 条目|Invalid MCP token. Check the zGIS/MCP entry in Windows Credential Manager.
MCP 外部客户端鉴权仅支持 Windows|External MCP client authentication is supported only on Windows
Mysql 连接失败，请检查参数、权限与受信证书|MySQL connection failed. Check parameters, permissions and trusted certificates.
Mysql 连接超时|MySQL connection timed out
PRJ无法严格识别为EPSG:4326/4490/3857，请明确指定已核实的crs或预先转换|PRJ cannot be identified as EPSG:4326/4490/3857. Specify a verified CRS or convert first.
PostGIS geometry_columns 不可读取，请确认扩展和权限|Cannot read PostGIS geometry_columns. Check the extension and permissions.
SHP 包含重复配套文件|SHP contains duplicate companion files
SHP 另存仅允许 ZIP 文件；不会覆盖原 SHP 文件组|Save SHP as ZIP only. The source SHP files will not be overwritten.
SHP 另存必须使用新 ZIP 文件名，不能覆盖已有文件|Use a new ZIP filename to save SHP. Existing files cannot be overwritten.
SHP 文件组超过 100 MB|SHP file set exceeds 100 MB
SHP 配套路径不是文件|SHP companion path is not a file
SHP文件组大小超过100MB|SHP file set exceeds 100 MB
SHP缺少PRJ，请明确提供crs|SHP is missing PRJ. Specify the CRS.
SSL 模式无效|Invalid SSL mode
Schema 数量超过浏览上限|Schema count exceeds the browsing limit
TLS 数据库连接失败，请检查连接参数与受信证书|TLS database connection failed. Check connection parameters and trusted certificates.
ZIP 含无效或越界路径|ZIP contains invalid or out-of-bounds paths
ZIP 含重复成员路径|ZIP contains duplicate member paths
ZIP 图层成员路径无效|Invalid ZIP layer member path
ZIP 文件数量超过 1000|ZIP contains more than 1,000 files
ZIP 来源图层成员不存在|Source layer member does not exist in ZIP
ZIP 解压大小超过 100 MB|Uncompressed ZIP exceeds 100 MB
ZIP 输出解压大小超过 100 MB|Uncompressed ZIP output exceeds 100 MB
ZIP 输出超过 100 MB|ZIP output exceeds 100 MB
ZIP包含重复配套文件|ZIP contains duplicate companion files
ZIP只能包含一组SHP|ZIP must contain exactly one SHP file set
ZIP含越界路径|ZIP contains out-of-bounds paths
[已脱敏]|[redacted]
bbox 必须为数值|bbox values must be numbers
bbox 必须有四个数值|bbox must contain four numbers
bbox 范围无效|Invalid bbox extent
bbox 需要有效 WGS84 [west,south,east,north] 边界|bbox requires valid WGS84 [west,south,east,north] bounds
distanceMeters 必须 > 0 且 <= 100000|distanceMeters must be > 0 and <= 100000
groupBy 必须是非空字符串|groupBy must be a nonempty string
macOS 钥匙串中的 MCP 固定令牌格式无效|Invalid MCP token in macOS Keychain
macOS 钥匙串中缺少本机加密密钥|Local encryption key is missing from macOS Keychain
predicate 必须为字符串|predicate must be a string
spatial_query 的 bbox 与 target 必须二选一|spatial_query requires exactly one of bbox or target
sslMode 必须为 disable、require 或 prefer|sslMode must be disable, require or prefer
toleranceMeters 必须 > 0 且 <= 100000|toleranceMeters must be > 0 and <= 100000
wktField不能与xField/yField同时指定|wktField cannot be specified together with xField/yField
zGIS 启动失败|zGIS failed to start
{error}；还原文件组失败：{detail}|{error}; Failed to restore file set: {detail}
下载更新失败或超时|Update download failed or timed out
下载更新服务暂不可用|Update download service is temporarily unavailable
不支持 GeometryCollection|GeometryCollection is unsupported
不支持 WKT M/ZM|WKT M/ZM is unsupported
不支持WKT几何集合|WKT geometry collections are unsupported
不支持Z/M或特殊几何|Z/M or special geometries are unsupported
不支持的CPG编码|Unsupported CPG encoding
不支持的空间谓词|Unsupported spatial predicate
不支持空WKT|Empty WKT is unsupported
不支持空几何|Empty geometries are unsupported
不支持空面|Empty polygons are unsupported
不支持编辑自定义字段类型|Editing custom field types is unsupported
不支持跨日期变更线或跨度超过 180 度的几何|Geometries crossing the antimeridian or spanning more than 180 degrees are unsupported
不能修改自动生成字段|Generated fields cannot be modified
不能删除或重命名主键、几何列或自动生成字段|Primary keys, geometry columns and generated fields cannot be deleted or renamed
不能导入凭据目录中的文件|Files in credential directories cannot be imported
主键目录超过浏览上限|Primary key catalog exceeds the browsing limit
仅允许安装更新的正式版本|Only newer stable releases can be installed
仅支持 GeoJSON、CSV、SHP 文件组和 ZIP|Only GeoJSON, CSV, SHP file sets and ZIP are supported
仅支持 Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon|Only Point, MultiPoint, LineString, MultiLineString, Polygon and MultiPolygon are supported
仅支持 XY/XYZ 坐标，不支持 M/ZM|Only XY/XYZ coordinates are supported; M/ZM is unsupported
仅支持EPSG:4326/4490/3857|Only EPSG:4326/4490/3857 are supported
仅支持GeoJSON、CSV、SHP及SHP ZIP|Only GeoJSON, CSV, SHP and SHP ZIP are supported
仅支持二维坐标，不允许静默丢弃 Z/M|Only 2D coordinates are supported. Z/M values cannot be silently discarded.
仅支持二维或带高程XYZ坐标，不支持M/ZM|Only 2D or XYZ coordinates with elevation are supported; M/ZM is unsupported
仅支持有限二维或XYZ坐标的基础几何；M/ZM、空几何或 GeometryCollection 不可写入|Only basic geometries with finite 2D or XYZ coordinates can be written; M/ZM, empty geometries and GeometryCollection are unsupported
仅重命名字段允许 newName|newName is allowed only when renaming fields
候选对超过 1000000，请缩小输入范围|Candidate pairs exceed 1,000,000. Reduce the input extent.
写入核验失败|Write verification failed
几何 SRID 未指定，请明确使用 WGS84（EPSG:4326）后加载|Geometry SRID is unspecified. Explicitly use WGS84 (EPSG:4326) before loading.
几何引擎拒绝此数据，分析未完成；请先检查几何有效性|The geometry engine rejected this data. Analysis was not completed. Check geometry validity first.
几何拓扑无效，导入已回滚|Invalid geometry topology. Import rolled back.
几何拓扑无效，提交已回滚|Invalid geometry topology. Commit rolled back.
几何数据读取失败|Failed to read geometry data
几何缺少coordinates|Geometry is missing coordinates
几何解析失败，导入已回滚|Geometry parsing failed. Import rolled back.
几何解析失败，提交已回滚|Geometry parsing failed. Commit rolled back.
几何转换失败|Geometry conversion failed
分析参数必须是对象|Analysis parameters must be an object
分析数据超过大小上限|Analysis data exceeds the size limit
分析结果未通过校验: {error}|Analysis result failed validation: {error}
分析结果超过 100 MB，请缩小范围|Analysis result exceeds 100 MB. Reduce the extent.
分析要素只能包含 type、id、geometry、properties|Analysis features may contain only type, id, geometry and properties
分析要素属性必须是对象或 null|Analysis feature properties must be an object or null
分析要素必须是对象|Analysis features must be objects
分析要素类型必须是 Feature|Analysis feature type must be Feature
分析输入超过 100 MB，请缩小范围|Analysis input exceeds 100 MB. Reduce the extent.
分析运行时不可用|Analysis runtime unavailable
分组字段数值指数超过支持范围|Grouping field numeric exponent exceeds the supported range
单次导入文件总大小不能超过 100 MB|Total imported file size must not exceed 100 MB
单次导入最多 100000 条|At most 100,000 records can be imported at once
单次提交最多 10000 条|At most 10,000 records can be committed at once
单次最多 100 个字段操作|At most 100 field operations per request
单要素坐标超过1000000预算|Feature coordinates exceed the 1,000,000 budget
参数必须为对象|Parameters must be an object
发布版本缺少当前平台安装包或校验文件|Release is missing the installer or checksum file for this platform
发布资源大小无效|Invalid release asset size
发布资源重复|Duplicate release assets
变更缺少有效主键|Change is missing a valid primary key
另存为必须保留原文件扩展名，请通过导出为转换格式|Save as must retain the original extension. Use Export to convert formats.
只允许保存 CSV、GeoJSON 或 JSON；SHP 文件组只读|Only CSV, GeoJSON or JSON can be saved; SHP file sets are read-only
合并结果超过 10000 个要素|Merged result exceeds 10,000 features
同一几何不能混合 XY 与 XYZ 坐标|A geometry cannot mix XY and XYZ coordinates
图层超过 10000 个要素，请先缩小范围|Layer exceeds 10,000 features. Reduce the extent first.
坐标分量必须为有限数值|Coordinate components must be finite numbers
坐标必须为 XY 或 XYZ 数组|Coordinates must be XY or XYZ arrays
坐标必须为数组|Coordinates must be arrays
坐标必须为有效 WGS84 经纬度|Coordinates must be valid WGS84 longitude and latitude
坐标必须是有效 WGS84 经纬度|Coordinates must be valid WGS84 longitude and latitude
坐标超出WGS84范围|Coordinates are outside the WGS84 range
多图层 ZIP 必须指定来源图层成员|Specify the source layer member for a ZIP with multiple layers
多面坐标必须为数组|MultiPolygon coordinates must be an array
字段 {0} 不允许 NULL|Field {0} does not allow NULL
字段 {0} 仍有索引、约束或其他依赖，不能删除|Field {0} still has indexes, constraints or other dependencies and cannot be deleted
字段 {0} 需要合法 JSON|Field {0} requires valid JSON
字段“{0}”超过 64 KiB，未加载；请减少字段体积后重试|Field “{0}” exceeds 64 KiB and was not loaded. Reduce its size and try again.
字段“{0}”为二进制类型，无法无损加载到 GeoJSON；请先转换该字段|Field “{0}” is binary and cannot be loaded losslessly into GeoJSON. Convert it first.
字段不存在|Field does not exist
字段不存在或操作顺序无效|Field does not exist or operation order is invalid
字段依赖检查失败，提交已回滚|Field dependency check failed. Commit rolled back.
字段结构修改失败，请检查权限或依赖；提交已回滚|Field schema modification failed. Check permissions or dependencies. Commit rolled back.
安全存储暂不可用|Secure storage is temporarily unavailable
实际空间候选对超过 1000000，请缩小输入范围；未返回截断结果|Spatial candidate pairs exceed 1,000,000. Reduce the input extent. No truncated result was returned.
密码加密失败|Password encryption failed
密码存储不可读|Cannot read password storage
密码存储写入失败|Failed to write password storage
密码存储无效|Invalid password storage
密码存储暂不可用|Password storage is temporarily unavailable
密码存储目录不可写|Password storage directory is not writable
密码存储目录不可用|Password storage directory unavailable
密码存储解密失败|Password storage decryption failed
密码存储过大|Password storage exceeds the size limit
密码超过长度限制|Password exceeds the length limit
属性字段不属于发现的表|Property field does not belong to the discovered table
属性必须为对象|Properties must be an object
属性数据读取失败|Failed to read property data
属性记录必须为对象|Property records must be objects
工具箱只接受已加载的图层内容，不接受文件或缓存引用|The toolbox accepts loaded layer data only, not file or cache references
底图配置加密或解密失败|Basemap configuration encryption or decryption failed
底图配置安全存储仅支持 Windows|Secure basemap configuration storage is supported only on Windows
底图配置无效|Invalid basemap configuration
底图配置过大|Basemap configuration exceeds the size limit
当前平台不支持安装更新|Installing updates is unsupported on this platform
当前平台尚不支持下载更新|Downloading updates is unsupported on this platform
当前应用版本无效|Invalid application version
当前版本无效|Invalid current version
当前系统不支持打开项目链接|Opening the project link is unsupported on this system
恢复数据保存失败|Failed to save recovery data
恢复数据过大|Recovery data exceeds the size limit
指定坐标系与GeoJSON crs标记冲突|Specified CRS conflicts with the GeoJSON CRS declaration
指定的{0}列不存在|Specified column {0} does not exist
提交结果待核对：请确认目标表是否已创建，不要直接重复导入|Commit outcome needs verification: check whether the target table was created before retrying the import
提交结果待核对：连接在事务完成时异常，请重新读取数据库，不要直接重复提交|Commit outcome needs verification: connection failed when completing the transaction. Reload the database before retrying.
提交行数异常，已回滚|Unexpected affected row count. Rolled back.
数值不能超过 15 位有效数字|Numbers must not exceed 15 significant digits
数值超出 DBF 安全精度范围（绝对值必须小于 10^15）|Number exceeds DBF safe precision (absolute value must be less than 10^15)
数值需要超过 8 位小数，不能无损导出 DBF|Number requires more than 8 decimal places and cannot be exported losslessly to DBF
数据库会话初始化失败|Database session initialization failed
数据库会话初始化超时|Database session initialization timed out
数据库字段名必须非空、无控制字符且不超过 63 字节|Database field names must be nonempty, contain no control characters and be at most 63 bytes
数据库连接失败，请检查连接参数|Database connection failed. Check connection parameters.
数据库连接超时|Database connection timed out
数据源 ID 重复|Duplicate data source ID
数据源包含空字段、过长字段或控制字符|Data source contains empty or oversized fields or control characters
数据源字段已变化或不受支持|Data source fields have changed or are unsupported
数据源数量超过上限（64）|Data source count exceeds the limit (64)
数据源标识无效|Invalid data source ID
数据源端口或 SSL 模式无效|Invalid data source port or SSL mode
数据源配置不可读|Cannot read data source configuration
数据源配置包含空字段、过长字段或控制字符|Data source configuration contains empty or oversized fields or control characters
数据源配置无效|Invalid data source configuration
数据源配置过大|Data source configuration exceeds the size limit
文件不存在或不可访问|File does not exist or is inaccessible
文件句柄失效，请重新打开图层|File handle expired. Reopen the layer.
文件名无效，请输入不含路径或保留字符的名称|Invalid filename. Enter a name without paths or reserved characters.
文件必须小于100MB|File must be smaller than 100 MB
文件过大|File exceeds the size limit
新增字段名已存在|New field name already exists
新文件保存失败（目标可能已存在）：{error}|Failed to save new file (destination may already exist): {error}
新表不支持混合二维与XYZ几何，请分图层导出|New tables cannot mix 2D and XYZ geometries. Export separate layers.
无效 DBF 头部|Invalid DBF header
无效 DBF 字段定义|Invalid DBF field definition
无效 SHP 文件名|Invalid SHP filename
无效 SHP/SHX 头部|Invalid SHP/SHX header
无效 SQL 标识|Invalid SQL identifier
无效DBF头|Invalid DBF header
无效DBF字段长度|Invalid DBF field length
无效Feature|Invalid Feature
无效GeoJSON|Invalid GeoJSON
无效PRJ|Invalid PRJ
无效WKT|Invalid WKT
无效X|Invalid X
无效Y|Invalid Y
无效ZIP|Invalid ZIP
无效几何|Invalid geometry
无效分析任务标识|Invalid analysis job ID
无效坐标|Invalid coordinates
无效坐标数组|Invalid coordinate array
无效数值字段|Invalid numeric field
无效纬度|Invalid latitude
无效经度|Invalid longitude
无法保存更新包|Cannot save update package
无法创建 Agent 私有目录|Cannot create Agent private directory
无法创建 Agent 终端|Cannot create Agent terminal
无法创建更新缓存|Cannot create update cache
无法初始化更新下载|Cannot initialize update download
无法取得 Agent 私有目录|Cannot locate Agent private directory
无法启动更新安装，请重试|Cannot start update installation. Try again.
无法安装 macOS 退出确认保护|Cannot install macOS quit confirmation protection
无法定位安装目录|Cannot locate installation directory
无法定位当前应用|Cannot locate current application
无法定位更新缓存|Cannot locate update cache
无法定位系统 PowerShell|Cannot locate system PowerShell
无法将 MCP 固定令牌保存到 macOS 钥匙串|Cannot save MCP token to macOS Keychain
无法将本机加密密钥保存到 macOS 钥匙串|Cannot save local encryption key to macOS Keychain
无法打开 Agent 输入|Cannot open Agent input
无法打开 Agent 输出|Cannot open Agent output
无法打开更新安装包|Cannot open update installer
无法打开系统浏览器|Cannot open system browser
无法获取瓦片，请检查底图服务|Cannot fetch tiles. Check the basemap service.
无法计算包络|Cannot compute envelope
无法计算表面点|Cannot compute point on surface
无法计算质心|Cannot compute centroid
无法读取 Windows 凭据管理器中的 MCP 固定令牌|Cannot read MCP token from Windows Credential Manager
无法读取 macOS 钥匙串，请检查钥匙串访问权限|Cannot read macOS Keychain. Check Keychain access permissions.
无法读取已下载更新包|Cannot read downloaded update package
无法锁定字段结构，提交已回滚|Cannot lock field schema. Commit rolled back.
暂不支持 Mysql EPSG:{0} 空间加载，请先转换为 EPSG:4326|Loading MySQL EPSG:{0} spatial data is unsupported. Convert to EPSG:4326 first.
暂不支持DBF DateTime字段，请先转换|DBF DateTime fields are unsupported. Convert them first.
暂不支持GeometryCollection|GeometryCollection is unsupported
更新下载地址无效|Invalid update download URL
更新下载超过大小限制|Update download exceeds the size limit
更新任务正在执行|An update task is already running
更新信息超过大小限制|Update information exceeds the size limit
更新包已变化，请重新下载|Update package changed. Download it again.
更新包校验失败，请重新下载|Update package verification failed. Download it again.
更新包缺少 SHA-256 校验信息|Update package is missing SHA-256 checksums
更新包超过大小限制|Update package exceeds the size limit
更新发布信息无效|Invalid update release information
更新发布版本不匹配|Update release version mismatch
更新服务暂不可用，请稍后重试|Update service is temporarily unavailable. Try again later.
更新校验信息无效|Invalid update checksums
更新版本信息无效|Invalid update version information
更新版本无效|Invalid update version
更新状态不可用|Update state unavailable
最多100000要素|At most 100,000 features are allowed
未知单层工具|Unknown single-layer tool
未知参数: {0}|Unknown parameter: {0}
未知变更类型|Unknown change type
未知字段操作|Unknown field operation
未知空间工具|Unknown spatial tool
未能启动 Codex CLI，请安装并登录后重试|Failed to launch Codex CLI. Install it and sign in, then try again.
未能启动 Codex CLI，请检查安装|Failed to launch Codex CLI. Check installation.
本机加密密钥无效|Invalid local encryption key
来源 SHP 已不存在|Source SHP no longer exists
来源指纹缺失，请重新打开图层|Source fingerprint missing. Reopen the layer.
来源文件名无效|Invalid source filename
来源文件没有扩展名|Source file has no extension
来源目录无效|Invalid source directory
查询超时，请缩小数据范围|Query timed out. Reduce the data extent.
检查更新超时|Update check timed out
此工具仅支持 Polygon/MultiPolygon|This tool supports only Polygon/MultiPolygon
每次最多导入 100 个文件|At most 100 files can be imported at once
没有稳定主键，仅支持只读|No stable primary key. Read-only access is supported.
源文件已被外部修改，请另存或重新打开|Source file was modified externally. Save as or reopen it.
源文件已被外部修改，请重新打开后重命名|Source file was modified externally. Reopen it before renaming.
瓦片不是支持的图像格式|Unsupported tile image format
瓦片图像内容无效|Invalid tile image data
瓦片地址仅支持无账号密码的 HTTP(S) 地址|Tile URLs must use HTTP(S) without embedded usernames or passwords
瓦片地址无效|Invalid tile URL
瓦片地址过长|Tile URL exceeds the length limit
瓦片大小超过 2 MB|Tile size exceeds 2 MB
瓦片服务返回错误（HTTP {0}）|Tile service returned an error (HTTP {0})
瓦片缺少图像类型|Tile is missing an image content type
瓦片请求不可用|Tile request unavailable
瓦片重定向无效|Invalid tile redirect
生成 SHP 记录核验失败|Generated SHP record verification failed
目录字段缺失|Catalog field is missing
目录字段转换失败|Catalog field conversion failed
目录过大，请使用权限限制需要浏览的表|Catalog exceeds the size limit. Restrict accessible tables using permissions.
目标为空|Target is empty
目标图层仅支持 Point/MultiPoint|Target layer supports only Point/MultiPoint
目标文件夹中已有同名 SHP 文件组，请选择其他文件夹；不会覆盖已有文件|Destination already contains an SHP file set with this name. Choose another folder; existing files will not be overwritten.
目标是已打开的来源文件，请选择新的 ZIP 文件名|Destination is an open source file. Choose a new ZIP filename.
目标目录中已有同名文件，不能覆盖，请使用其他名称|Destination already contains a file with this name. Use another name; overwriting is not allowed.
空间分析执行失败，请重试|Spatial analysis failed. Try again.
空间数据读取失败|Failed to read spatial data
空间数据超过100 MiB，请减少加载条数|Spatial data exceeds 100 MiB. Load fewer records.
空间计算累计处理顶点超过 10000000；未返回截断结果|Spatial computation exceeded 10,000,000 processed vertices. No truncated result was returned.
简化仅支持线或面几何|Simplification supports only line or polygon geometries
简化结果未通过校验，请降低容差: {error}|Simplified result failed validation. Reduce tolerance: {error}
累计坐标超过2000000预算|Total coordinates exceed the 2,000,000 budget
线至少两点，面环至少四点|Lines require at least two points; polygon rings require at least four
终端尺寸无效|Invalid terminal dimensions
结果超过 100 MiB|Result exceeds 100 MiB
结果超过 100 MiB；未返回截断结果|Result exceeds 100 MiB. No truncated result was returned.
结果超过 100 MiB；重复属性未复制，未返回截断结果|Result exceeds 100 MiB. Duplicate properties were not copied; no truncated result was returned.
结果超过 10000 个要素；未返回截断结果|Result exceeds 10,000 features. No truncated result was returned.
结果顶点总数超过 1000000；未返回截断结果|Result exceeds 1,000,000 vertices. No truncated result was returned.
缺少 DBF，不能清空来源图层|DBF is missing. Source layer cannot be emptied.
缺少 SHP 配套文件|SHP companion files are missing
缺少 SHP/SHX，不能清空来源图层|SHP/SHX is missing. Source layer cannot be emptied.
缺少DBF|DBF is missing
缺少SHP|SHP is missing
缺少features|features is missing
缺少几何类型|Geometry type is missing
获取瓦片超时|Tile fetch timed out
表不存在或没有 SELECT 权限|Table does not exist or SELECT permission is missing
表不存在或没有访问权限|Table does not exist or access permission is missing
表字段超过 128 列，暂不支持空间加载|Table exceeds 128 columns. Spatial loading is unsupported.
表字段超过 128 列，暂不支持记录编辑|Table exceeds 128 columns. Record editing is unsupported.
表字段超过 128 列，暂不支持预览|Table exceeds 128 columns. Preview is unsupported.
表存在自定义触发器，不能安全删除或重命名字段|Table has custom triggers. Fields cannot be safely deleted or renamed.
表或字段名称无效|Invalid table or field name
表目录过大，请限制可访问的表|Table catalog exceeds the size limit. Restrict accessible tables.
表预览超时|Table preview timed out
要素 {0} 为空几何|Feature {0} has empty geometry
要素 {0} 几何无效，请先执行 topology_check|Feature {0} has invalid geometry. Run topology_check first.
要素 {0} 缺少 geometry|Feature {0} is missing geometry
要素 {0} 缺少分组字段 {1}|Feature {0} is missing grouping field {1}
要素 {0}: {error}|Feature {0}: {error}
要素 {0}: {reason}；属于能力限制，未清理任何要素|Feature {0}: {reason}; This is a capability limitation. No features were cleaned.
解压大小超过100MB|Uncompressed size exceeds 100 MB
触发器依赖检查失败，提交已回滚|Trigger dependency check failed. Commit rolled back.
记录基线必须为对象|Record baseline must be an object
记录基线缺少删除字段|Record baseline is missing the deleted field
记录基线缺少重命名字段|Record baseline is missing the renamed field
记录已被其他操作修改或删除，字段和数据提交已回滚|Record was modified or deleted by another operation. Field and data changes rolled back.
记录已被其他操作修改或删除，提交已回滚|Record was modified or deleted by another operation. Commit rolled back.
记录编辑需要可读取的标量主键|Record editing requires a readable scalar primary key
该来源格式不支持重命名|Renaming is unsupported for this source format
请先下载并校验该版本更新|Download and verify this version first
请拖入矢量文件，不支持目录|Drop vector files. Directories are unsupported.
读取 Mysql 表目录失败|Failed to read MySQL table catalog
读取 PostGIS 元数据失败|Failed to read PostGIS metadata
读取 PostGIS 几何字段失败|Failed to read PostGIS geometry fields
读取 Schema 失败|Failed to read schemas
读取主键失败|Failed to read primary keys
读取元数据失败|Failed to read metadata
读取失败，请检查 WKT、SRID 和几何类型|Read failed. Check WKT, SRID and geometry type.
读取时文件发生变化，请重试|File changed while reading. Try again.
读取目录超时|Catalog read timed out
读取目录超时，连接已断开|Catalog read timed out. Connection closed.
读取表目录失败|Failed to read table catalog
读取表预览失败，请检查权限或字段类型|Failed to read table preview. Check permissions or field types.
调整终端失败|Failed to resize terminal
跨日期变更线|Crosses the antimeridian
输入图层没有要素|Input layer has no features
输入过长|Input exceeds the length limit
输出不可用|Output unavailable
输出超过 100 MB|Output exceeds 100 MB
连接已失效|Connection expired
连接忙，请等待当前操作完成后重试|Connection is busy. Wait for the current operation to finish and try again.
连接数量已达上限，请断开不用的连接|Connection limit reached. Disconnect unused connections.
配置不可读|Cannot read configuration
配置加密失败|Configuration encryption failed
配置密文格式无效|Invalid encrypted configuration format
配置目录不可写|Configuration directory is not writable
配置目录不可用|Configuration directory unavailable
配置解密失败或密文已损坏|Configuration decryption failed or encrypted data is corrupted
重命名字段缺少 newName|Field rename is missing newName
重命名目标字段已存在|Target field name already exists
链接目标无效|Invalid link target
需要 GeoJSON FeatureCollection|GeoJSON FeatureCollection is required
需要 target|target is required
需要Feature或FeatureCollection|Feature or FeatureCollection is required
需要明确且有效的 SRID|An explicit valid SRID is required
需要非空 target 或 bbox|A nonempty target or bbox is required
非法坐标|Invalid coordinates
面坐标必须为数组|Polygon coordinates must be an array
面环坐标必须为数组|Polygon ring coordinates must be arrays
面环必须闭合|Polygon rings must be closed
面环至少需要四个坐标且首尾必须相等|Polygon rings require at least four coordinates with matching first and last coordinates
面环面积不能为零|Polygon ring area must not be zero
面缺少外环|Polygon is missing its exterior ring
顶点总数超过 1000000|Total vertices exceed 1,000,000
预算|Budget
预览字段转换失败|Preview field conversion failed
预览条数仅支持 10 或 20|Preview row count must be 10 or 20
预览结果无效|Invalid preview result
预览结果超过 1 MiB，请选择更少的预览行|Preview exceeds 1 MiB. Select fewer preview rows.
首版导入只支持创建新表，不覆盖或追加现有表|Import supports creating new tables only; existing tables cannot be overwritten or appended to
高程 Z 必须为有限数值|Elevation Z must be a finite number
CSV列名为空或重复，无法可靠映射|CSV column names are empty or duplicated and cannot be mapped reliably
CSV缺少xField或wktField|CSV is missing xField or wktField
CSV缺少yField|CSV is missing yField
输出超过 100 MB|Output exceeds 100 MB
`.trim().split('\n').map((line) => {
  const separator = line.indexOf('|');
  return [line.slice(0, separator), line.slice(separator + 1)];
}));

Object.assign(errors, Object.fromEntries(`
请输入有效值|Enter a valid value
请输入可保真保存的有限数值；高精度数值请使用 JSON 属性编辑|Enter a finite number that can be saved losslessly. Use JSON property editing for high-precision numbers.
请输入 true 或 false|Enter true or false
请输入 JSON 数组|Enter a JSON array
请输入 JSON 对象|Enter a JSON object
预览获取失败|Failed to fetch preview
预览图片过大|Preview image exceeds the size limit
预览生成失败|Failed to generate preview
预览图片无效|Invalid preview image
预览已取消|Preview cancelled
数据库键或基线嵌套过深|Database key or baseline nesting is too deep
数据库键或基线不能包含稀疏数组或额外属性|Database keys or baselines cannot contain sparse arrays or extra properties
数据库键或基线不能包含访问器|Database keys or baselines cannot contain accessors
数据库键或基线必须为普通 JSON|Database keys or baselines must be plain JSON
数据库键或基线不能包含 Symbol|Database keys or baselines cannot contain Symbols
数据库键或基线包含不安全键|Database key or baseline contains an unsafe key
数据库键或基线必须为有限普通 JSON|Database keys or baselines must be finite plain JSON
恢复数据库基线列表无效或超过 100000 条|Recovered database baseline list is invalid or exceeds 100,000 records
数据库记录缺少键或原始基线|Database record is missing its key or original baseline
数据库记录存在重复键，无法核对来源|Database records contain duplicate keys. Source cannot be verified.
数据库来源记录已被修改或删除，恢复工作稿存在冲突，请核对后重新打开|Source database records were modified or deleted. Recovered draft has conflicts. Verify and reopen.
缺少原始数据库基线，无法自动合并恢复工作稿，请重新打开来源|Original database baseline missing. Recovered draft cannot be merged automatically. Reopen the source.
数据库工作稿存在重复要素 ID|Database draft contains duplicate feature IDs
数据库冲突选择不对应当前记录，请重新核对|Database conflict choice does not match the current record. Verify again.
每条数据库冲突都必须明确选择保留本地或原表版本|Choose the local or source table version for every database conflict
恢复数据库{detail}无效|Invalid recovered database {detail}
恢复数据库来源结构无效|Invalid recovered database source structure
恢复数据库引擎无效|Invalid recovered database engine
恢复数据库主键结构无效|Invalid recovered database primary key structure
主键列|Primary key column
恢复数据库主键列重复|Duplicate recovered database primary key columns
恢复数据库字段结构无效|Invalid recovered database field structure
恢复数据库字段定义无效|Invalid recovered database field definition
恢复数据库字段名称重复|Duplicate recovered database field names
恢复数据库几何存储类型无效|Invalid recovered database geometry storage type
恢复数据库 SRID 无效|Invalid recovered database SRID
源配置 ID|Source configuration ID
库/模式|Database/schema
表名|Table name
分组不存在|Group does not exist
分组名称不能为空|Group name cannot be empty
节点标识重复|Duplicate node ID
目标分组不存在|Destination group does not exist
移动节点不存在|Moved node does not exist
不能将节点移动到自身或其后代|A node cannot be moved into itself or its descendants
目标节点不存在|Destination node does not exist
只能移入分组|Nodes can only be moved into groups
根目录只能使用移入操作|Only move-into operations are allowed at the root
恢复要素列表结构无效|Invalid recovered feature list structure
恢复要素结构无效|Invalid recovered feature structure
恢复要素标识无效或重复|Invalid or duplicate recovered feature ID
恢复要素属性结构无效|Invalid recovered feature properties
恢复数据库字段修改列表无效|Invalid recovered database field change list
恢复数据库字段修改无效|Invalid recovered database field change
恢复数据库读取上限无效|Invalid recovered database read limit
恢复数据库读取范围无效|Invalid recovered database read extent
恢复编辑会话结构无效|Invalid recovered editing session structure
恢复编辑会话引用不存在的图层|Recovered editing session references a nonexistent layer
恢复编辑草稿要素标识无效|Invalid recovered editing draft feature ID
恢复编辑草稿引用不存在的要素|Recovered editing draft references a nonexistent feature
恢复绘图草稿结构无效或超出节点限制|Recovered drawing draft is invalid or exceeds the vertex limit
恢复绘图草稿坐标无效，仅支持一致的二维或 XYZ 坐标|Invalid recovered drawing draft coordinates. Consistent 2D or XYZ coordinates are required.
恢复属性草稿结构无效或超出文本限制|Recovered property draft is invalid or exceeds the text limit
恢复属性草稿引用不存在的字段|Recovered property draft references a nonexistent field
恢复要素面板草稿结构无效或超出文本限制|Recovered feature panel draft is invalid or exceeds the text limit
恢复编辑会话不能同时包含多个未完成草稿|Recovered editing session cannot contain multiple unfinished drafts
恢复编辑历史结构无效|Invalid recovered editing history structure
恢复编辑历史要素列表无效|Invalid recovered editing history feature list
恢复编辑历史超出 500000 个要素限制|Recovered editing history exceeds the 500,000 feature limit
恢复编辑历史结构无效或超出 30 步限制|Recovered editing history is invalid or exceeds 30 steps
恢复字段历史结构无效|Invalid recovered field history structure
恢复字段历史与要素历史不一致|Recovered field history does not match feature history
恢复编辑历史基线无效|Invalid recovered editing history baseline
恢复文件必须是图层列表|Recovery file must contain a layer list
恢复图层结构无效|Invalid recovered layer structure
恢复图层显示名无效|Invalid recovered layer display name
恢复图层几何类型无效|Invalid recovered layer geometry type
恢复图层字段结构无效或重复|Invalid or duplicate recovered layer fields
恢复数据库提交状态无效|Invalid recovered database commit state
恢复 CSV 配置无效|Invalid recovered CSV configuration
已恢复数据库工作稿；保存前重新连接来源并核对原始记录。|Database draft recovered. Reconnect to the source and verify original records before saving.
已恢复文件工作副本；保存前检查来源指纹。|File working copy recovered. Check the source fingerprint before saving.
已恢复为工作区图层，保存需选择格式与路径。|Recovered as a workspace layer. Choose a format and path to save.
恢复工作区结构无效|Invalid recovered workspace structure
恢复图层标识无效或重复|Invalid or duplicate recovered layer ID
恢复树节点标识无效或重复|Invalid or duplicate recovered tree node ID
恢复树引用不存在的图层|Recovered tree references a nonexistent layer
恢复树节点结构无效|Invalid recovered tree node structure
恢复树图层引用不完整|Recovered tree layer references are incomplete
不支持 GeometryCollection 或特殊几何|GeometryCollection or special geometries are unsupported
坐标数组不能为空|Coordinate arrays cannot be empty
坐标有 {0} 个分量，仅支持二维或带高程的 XYZ 坐标|Coordinates have {0} components. Only 2D or XYZ coordinates with elevation are supported.
坐标分量必须是有限数值|Coordinate components must be finite numbers
同一几何不能混合二维与 XYZ 坐标|A geometry cannot mix 2D and XYZ coordinates
线至少需要两个顶点|Lines require at least two vertices
面环必须闭合且至少四个坐标|Polygon rings must be closed and contain at least four coordinates
未知坐标系：{0} → {1}|Unknown coordinate system: {0} → {1}
暂不支持 WKT M/ZM；不会把测量值当高程或静默丢弃|WKT M/ZM is unsupported. Measure values will not be treated as elevation or silently discarded.
WKT 解析失败|WKT parsing failed
CSV 第 {0} 行：{error}|CSV row {0}: {error}
CSV 包含重复列名，请先调整列名|CSV contains duplicate column names. Rename them first.
请选择 WKT 列|Select a WKT column
请选择 WKT 列或 X/Y 坐标列|Select a WKT column or X/Y coordinate columns
不存在列 {0}|Column {0} does not exist
X 和 Y 不能使用同一列|X and Y cannot use the same column
X/Y 坐标缺失|X/Y coordinates are missing
属性必须是 JSON 对象|Properties must be a JSON object
GeoJSON 坐标系标记无效或不支持；仅支持 EPSG:4326/4490/3857|Invalid or unsupported GeoJSON CRS. Only EPSG:4326/4490/3857 are supported.
指定坐标系与 GeoJSON crs 标记冲突|Specified CRS conflicts with the GeoJSON CRS declaration
不支持的 GeoJSON 坐标系|Unsupported GeoJSON CRS
无效或不支持的 GeoJSON|Invalid or unsupported GeoJSON
GeoJSON 第 {0} 个要素{1}：{error}|GeoJSON feature {0}{1}: {error}
GeoJSON 第 {0} 个要素{1} · {detail}|GeoJSON feature {0}{1} · {detail}
{detail}：坐标数组为空或结构无效|{detail}: Coordinate array is empty or invalid
{detail}：坐标分量必须是有限数值，不接受字符串或 null|{detail}: Coordinate components must be finite numbers, not strings or null
{detail}：坐标至少需要 X、Y 两个分量|{detail}: Coordinates require at least X and Y components
{detail}：坐标含 {1} 个分量（含 M 或额外分量），仅支持二维或带高程 XYZ；可勾选“按二维副本导入”后重试，原文件不变|{detail}: Coordinates contain {1} components (M or extra components). Only 2D or XYZ with elevation are supported. Select “Import as 2D copy” and retry; the original file is unchanged.
GeoJSON properties 必须是对象或 null|GeoJSON properties must be an object or null
GeoJSON Feature.id 必须是字符串或数值|GeoJSON Feature.id must be a string or number
X/Y CSV 仅支持 Point；线面请导出 WKT|X/Y CSV supports Point only. Export lines and polygons as WKT.
含高程坐标不能无损导出 X/Y CSV，请选择 WKT 或 GeoJSON；或明确导入二维副本|Coordinates with elevation cannot be exported losslessly to X/Y CSV. Choose WKT or GeoJSON, or explicitly import a 2D copy.
{0} 缺少 .prj，不能猜测坐标系|{0} is missing .prj. The CRS cannot be guessed.
{0} 缺少 .dbf|{0} is missing .dbf
SHP 保存回写来源文件组；字段和几何须符合 Shapefile 格式限制|Saving SHP updates the source file set. Fields and geometries must meet Shapefile format constraints.
高精度数值属性以文本保存，导出时保持文本类型|High-precision numeric properties are stored as text and retain text type when exported
已明确选择二维副本；仅载入 X/Y，Z/M 未载入。原文件未修改，保存需另存新文件。|2D copy explicitly selected. Only X/Y were loaded; Z/M were omitted. Original file unchanged. Save to a new file.
ZIP 超过 2000 个文件或 200 MB 解压限制|ZIP exceeds 2,000 files or the 200 MB uncompressed limit
ZIP 包含不安全路径|ZIP contains unsafe paths
不支持文件：{0}|Unsupported file: {0}
未找到可导入图层|No importable layers found
空间分析引擎运行失败|Spatial analysis engine failed
空间分析结果传输失败|Spatial analysis result transfer failed
请选择空间文件|Select spatial files
支持 GeoJSON、CSV 和 Shapefile ZIP；SHP 文件组请打包为 ZIP。|GeoJSON, CSV and Shapefile ZIP are supported. Package SHP file sets as ZIP.
单次导入文件总大小不能超过 100 MB。|Total imported file size must not exceed 100 MB.
导入已取消|Import cancelled
解析 Worker 失败|Parser Worker failed
解析结果传输失败|Parser result transfer failed
请选择有效的几何列，坐标列必须包含数值|Select valid geometry columns. Coordinate columns must contain numbers.
`.trim().split('\n').map((line) => {
  const separator = line.indexOf('|');
  return [line.slice(0, separator), line.slice(separator + 1)];
})));

Object.assign(errors, Object.fromEntries(`
移除空/无效几何并报告总数及原因预览；生成独立结果，保留有效要素|Remove empty or invalid geometries and report totals and reason previews; create an independent result retaining valid features
空间谓词查询；bbox与target二选一；经纬度平面关系，禁止跨日期变更线|Spatial predicate query using either bbox or target; planar longitude/latitude relationships; antimeridian crossing is unsupported
空间关联，保留源属性并附加匹配目标|Spatial join retaining source properties and attaching matching targets
点对采用 WGS84 椭球测地距离；其他几何采用成对局部等距圆柱近似|Point pairs use WGS84 ellipsoidal geodesic distances; other geometries use pairwise local equirectangular approximations
检查无效几何、重复几何及面重叠，返回有界报告|Check invalid geometries, duplicates and polygon overlaps, returning a bounded report
局部等距圆柱近似米制缓冲，限局部低中纬度数据|Approximate metric buffer using a local equirectangular projection, limited to local low/mid-latitude data
面与面裁剪|Clip polygons with polygons
合并面几何，可按字段类型和值分组|Dissolve polygons, optionally grouped by field type and value
图层几何、属性、范围摘要|Summary of layer geometries, properties and extent
面相交，逐对保留源属性与 target_ 前缀目标属性|Polygon intersection retaining source properties and target properties with the target_ prefix for each pair
面差集，保留源属性|Polygon difference retaining source properties
面对称差，分别保留两侧属性|Polygon symmetric difference retaining properties from each side
每个要素的平面质心，可能位于面外|Planar centroid of each feature, which may lie outside the polygon
每个要素的表面代表点|Point on surface for each feature
每个要素的凸包，退化结果为点或线|Convex hull of each feature; degenerate results become points or lines
每个要素的轴对齐包络，退化结果为点或线|Axis-aligned envelope of each feature; degenerate results become points or lines
多部件转单部件，保留属性并移除旧 ID|Convert multipart to singlepart, retaining properties and removing old IDs
提取顶点，面环不重复末尾闭合点，保留部件/环/节点索引|Extract vertices without duplicate closing polygon vertices; retain part, ring and vertex indexes
面边界转多线，包含洞|Convert polygon boundaries to multilines, including holes
Douglas–Peucker 近似米制简化；无效结果拒绝|Douglas–Peucker simplification using approximate metric distances; invalid results rejected
添加近似平方米面积及米制长度（面包含洞周长），冲突字段加下划线|Add approximate areas in square meters and lengths in meters (polygon lengths include holes); conflicting field names gain underscores
面内点计数，包含边界，多点按每个点计数|Count points within polygons, including boundaries; count each point in multipoints
合并两层要素，保留属性并移除旧 ID|Merge features from two layers, retaining properties and removing old IDs
`.trim().split('\n').map((line) => {
  const separator = line.indexOf('|');
  return [line.slice(0, separator), line.slice(separator + 1)];
})));

Object.assign(errors, Object.fromEntries(`
字段名称|Field name
字段类型|Field type
几何列|Geometry column
恢复数据库主键列无效|Invalid recovered database primary key column
恢复数据库字段名称无效|Invalid recovered database field name
恢复数据库字段类型无效|Invalid recovered database field type
恢复数据库源配置 ID无效|Invalid recovered database source configuration ID
恢复数据库库/模式无效|Invalid recovered database database/schema
恢复数据库表名无效|Invalid recovered database table name
恢复数据库几何列无效|Invalid recovered database geometry column
MCP启动已被停止或撤销取消|MCP startup was stopped or cancelled
MCP 启动已取消|MCP startup cancelled
MCP 启动失败：本机端口 9420 不可用，请检查其他 zGIS 实例或端口占用|MCP startup failed: local port 9420 is unavailable. Check other zGIS instances or processes using the port.
MCP未启动|MCP is not running
完成|Completed
拒绝或执行失败|Rejected or execution failed
工作区同步失败|Workspace synchronization failed
最多同步100图层|At most 100 layers can be synchronized
同步图层总大小超过100MB|Synchronized layer data exceeds 100 MB
无效图层id|Invalid layer ID
同步图层标识重复或同时删除|Synchronized layer IDs are duplicated or also marked for deletion
无效图层名称|Invalid layer name
无效要素|Invalid feature
最多同步100000要素|At most 100,000 features can be synchronized
工作区超过100图层或100000要素|Workspace exceeds 100 layers or 100,000 features
发布确认参数超过上限|Publication acknowledgement parameters exceed the limit
缺少参数: {0}|Missing parameter: {0}
RESULT_ITEM_TOO_LARGE: offset={0} 的单条记录超过512KiB响应预算；请指定properties字段或includeGeometry=false后重试|RESULT_ITEM_TOO_LARGE: A record at offset={0} exceeds the 512 KiB response budget. Specify properties or includeGeometry=false and retry.
记录序列化失败|Record serialization failed
记录字段超过 64 KiB 或记录超过 1 MiB|Record field exceeds 64 KiB or record exceeds 1 MiB
主键必须完整且不能为 NULL|Primary key must be complete and non-NULL
读取表事务能力失败|Failed to read table transaction capabilities
原始记录基线不完整，请重新读取记录|Original record baseline is incomplete. Reload the record.
只能修改可编辑字段，非空字段不能设为 NULL|Only editable fields can be modified; non-nullable fields cannot be set to NULL
字段“{0}”不是有效 JSON|Field “{0}” is not valid JSON
表字段超过 128 列|Table exceeds 128 columns
字段“{0}”不支持无损编辑|Field “{0}” does not support lossless editing
字段大小标志缺失|Field size flag is missing
字段大小转换失败|Field size conversion failed
字段“{0}”超过读取体积限制|Field “{0}” exceeds the read size limit
字段缺失|Field is missing
字段转换失败|Field conversion failed
记录基线超过16 MiB|Record baseline exceeds 16 MiB
主键和基线必须为对象|Primary key and baseline must be objects
基线必须保留原始字符串或 NULL|Baseline must retain original strings or NULL
基线无效|Invalid baseline
原始基线不完整或过大，请重新读取图层|Original baseline is incomplete or too large. Reload the layer.
几何字段不存在|Geometry field does not exist
只支持 geometry 或 WGS84 文本 WKT 字段|Only geometry or WGS84 text WKT fields are supported
锁定记录失败，请检查权限|Failed to lock record. Check permissions.
记录已被其他操作删除或主键不唯一，提交已回滚|Record was deleted by another operation or primary key is not unique. Commit rolled back.
记录主键不完整或已变化|Record primary key is incomplete or changed
Mysql 仅支持 WGS84 二维坐标，XYZ 或超范围坐标不可写入|MySQL supports WGS84 2D coordinates only; XYZ or out-of-range coordinates cannot be written
原始几何基线缺少 SRID|Original geometry baseline is missing SRID
原始几何基线无效|Invalid original geometry baseline
暂不支持非0/4326坐标系写回|Writing back coordinate systems other than 0/4326 is unsupported
字段“{0}”需要有效 JSON|Field “{0}” requires valid JSON
普通字段只能写入标量值|Regular fields accept scalar values only
属性字段超过64 KiB，提交已回滚|Property field exceeds 64 KiB. Commit rolled back.
几何/WKT字段必须通过几何编辑写回|Geometry/WKT fields must be updated through geometry editing
属性字段不属于来源表|Property field does not belong to the source table
不支持直接编辑几何、二进制或自定义属性字段|Direct editing of geometry, binary or custom property fields is unsupported
不能修改稳定主键字段|Stable primary key fields cannot be modified
字段“{0}”不允许NULL|Field “{0}” does not allow NULL
几何字段不允许NULL|Geometry field does not allow NULL
新增记录缺少必填字段“{0}”|New record is missing required field “{0}”
写入字段表达式无效|Invalid write field expression
单次最多64个字段变更|At most 64 field changes per request
字段名称超过64字符|Field name exceeds 64 characters
新增字段名称已存在|New field name already exists
字段已不存在|Field no longer exists
不能删除/重命名主键、几何/WKT或生成字段|Primary keys, geometry/WKT fields and generated fields cannot be deleted or renamed
新字段名称缺失|New field name is missing
新字段名称已存在或超过64字符|New field name already exists or exceeds 64 characters
未知字段变更类型|Unknown field change type
字段变更后超过128列|Field changes would exceed 128 columns
字段索引/约束依赖检查失败|Field index/constraint dependency check failed
字段参与索引或外键，不能直接删除/重命名|Field is used by an index or foreign key and cannot be deleted or renamed directly
字段表达式/触发器/视图依赖检查失败|Field expression/trigger/view dependency check failed
来源表存在CHECK、触发器、生成表达式或视图依赖，需先处理依赖再修改字段|Source table has CHECK, trigger, generated expression or view dependencies. Resolve dependencies before changing fields.
单次提交最多10000条且不超过16 MiB|A commit may contain at most 10,000 records and 16 MiB
只支持事务型InnoDB图层写回|Only transactional InnoDB layers support writeback
设置锁超时失败|Failed to set lock timeout
开启严格转换失败|Failed to enable strict conversion
Mysql字段同步仅支持MySQL8/9的原子InnoDB ALTER，请先升级|MySQL field synchronization requires atomic InnoDB ALTER on MySQL 8/9. Upgrade first.
字段变更预检事务失败|Field change preflight transaction failed
记录已变化，字段变更尚未执行，请重新读图层|Records changed. Field changes were not applied. Reload the layer.
字段变更预检结束失败|Failed to complete field change preflight
设置字段锁超时失败|Failed to set field lock timeout
字段同步需要LOCK TABLES与ALTER权限，来源表锁定失败|Field synchronization requires LOCK TABLES and ALTER permissions. Failed to lock source table.
表结构核验失败|Table schema verification failed
来源表结构或事务能力已变化，字段同步未执行，请重新读取图层|Source table schema or transaction capabilities changed. Fields were not synchronized. Reload the layer.
记录在字段锁定前已变化，字段同步未执行，请重新读取图层|Records changed before field locking. Fields were not synchronized. Reload the layer.
字段ALTER执行失败或结果待核对，请重新读取来源表；不要重复提交|Field ALTER failed or outcome needs verification. Reload the source table; do not resubmit.
来源表解锁结果待核对，请断开并重新连接|Source table unlock outcome needs verification. Disconnect and reconnect.
开启编辑事务失败|Failed to start editing transaction
来源表事务锁定失败|Source table transaction lock failed
来源表已失效|Source table is no longer valid
来源表结构或事务能力已变化，请重新读取图层|Source table schema or transaction capabilities changed. Reload the layer.
记录已被其他操作修改或删除，整批提交已回滚|Records were modified or deleted by another operation. Entire commit rolled back.
来源表事务能力已变化，提交已回滚|Source table transaction capabilities changed. Commit rolled back.
删除记录失败，整批已回滚|Failed to delete records. Entire batch rolled back.
删除记录数量异常，整批已回滚|Unexpected deleted row count. Entire batch rolled back.
不能修改自动生成的几何/WKT字段|Generated geometry/WKT fields cannot be modified
只支持SRID0/4326写回|Writeback supports only SRID 0/4326
几何解析/拓扑检查失败，整批已回滚|Geometry parsing/topology check failed. Entire batch rolled back.
几何拓扑无效，整批已回滚|Invalid geometry topology. Entire batch rolled back.
字段类型/约束/写入权限检查失败，整批已回滚|Field type/constraint/write permission check failed. Entire batch rolled back.
写入产生转换警告或范围异常，整批已回滚|Write produced conversion warnings or range errors. Entire batch rolled back.
提交结果待核对，请重新读取数据库，不要直接重复提交|Commit outcome needs verification. Reload the database before retrying.
回滚结果待核对，请断开并重新连接|Rollback outcome needs verification. Disconnect and reconnect.
字段结构已提交；数据修改未完成或结果待核对。请重新读取图层，禁止直接重试原变更。{error}|Field schema committed; data changes are incomplete or outcome needs verification. Reload the layer. Do not retry the original changes directly. {error}
图层提交超时，连接已断开；请重新读取核实结果|Layer commit timed out. Connection closed. Reload to verify the outcome.
字段或数据提交结果待核对，连接已断开；请重新读取来源表，禁止直接重试原变更|Field or data commit outcome needs verification. Connection closed. Reload the source table; do not retry the original changes directly.
Mysql 表预览失败，请检查 SELECT 权限|MySQL table preview failed. Check SELECT permission.
预览序列化失败|Preview serialization failed
预览数据超过 1 MiB|Preview data exceeds 1 MiB
表预览超时，连接已断开|Table preview timed out. Connection closed.
加载条数必须为1至10000|Loaded record count must be between 1 and 10,000
空间读取失败，请检查字段数据、Mysql版本与权限|Spatial read failed. Check field data, MySQL version and permissions.
SRID字段缺失|SRID field is missing
SRID转换失败|SRID conversion failed
几何字段缺失|Geometry field is missing
几何字段转换失败|Geometry field conversion failed
单个几何体超过1 MiB，未加载|A geometry exceeds 1 MiB and was not loaded
属性转换失败|Property conversion failed
主键序列化失败|Primary key serialization failed
空间数据序列化失败|Spatial data serialization failed
空间数据超过16 MiB，请减少加载条数|Spatial data exceeds 16 MiB. Load fewer records.
空间加载超时，连接已断开|Spatial loading timed out. Connection closed.
仅支持 EPSG:4326/4490/3857|Only EPSG:4326/4490/3857 are supported
没有可导出的要素|No features to export
输入必须是 GeoJSON Feature|Input must be a GeoJSON Feature
要素属性必须为对象|Feature properties must be an object
字段 {0}：名称必须为 1–10 位 ASCII 字母/数字/下划线，不能数字开头或大小写重名|Field {0}: Name must contain 1–10 ASCII letters/digits/underscores, must not start with a digit, and must be unique ignoring case
字段 {0}：数值不能超过 15 位有效数字，请转换为文本|Field {0}: Numbers must not exceed 15 significant digits. Convert to text.
无效数值|Invalid number
字段 {0}：不支持 null、缺失值、对象/数组、空文本、首尾空格、NUL 或超过 254 UTF-8 字节的文本|Field {0}: null, missing values, objects/arrays, empty text, surrounding spaces, NUL or text exceeding 254 UTF-8 bytes are unsupported
字段 {0}：属性类型不一致|Field {0}: Inconsistent property types
DBF 字段不能超过 255 个|DBF must not exceed 255 fields
DBF 单条属性记录不能超过 4000 字节，请减少字段或文本长度|A DBF record must not exceed 4,000 bytes. Reduce fields or text length.
SHP 不支持混合 Point/MultiPoint/线/面，请分图层导出|SHP cannot mix Point/MultiPoint/line/polygon geometries. Export separate layers.
非点最近距离累计处理顶点超过 10000000，请缩小输入范围|Non-point nearest-distance computation exceeded 10,000,000 processed vertices. Reduce the input extent.
没有可计算坐标|No coordinates available for computation
米制近似仅支持纬度 ±75° 内、经纬跨度不超过 5° 的局部数据|Metric approximation supports only local data within ±75° latitude and longitude/latitude spans of at most 5°
拓扑检查规模超过上限，请缩小输入范围|Topology check exceeds its scale limit. Reduce the input extent.
拓扑问题超过 10000，请缩小输入范围；未返回截断报告|Topology issues exceed 10,000. Reduce the input extent. No truncated report was returned.
不支持几何类型 {0}|Unsupported geometry type {0}
拓扑检查顶点总数超过上限；未返回截断报告|Topology check vertex count exceeds the limit. No truncated report was returned.
`.trim().split('\n').map((line) => {
  const separator = line.indexOf('|');
  return [line.slice(0, separator), line.slice(separator + 1)];
})));

export default errors;
