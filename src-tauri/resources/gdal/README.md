# GDAL 运行时

此目录由 `pnpm gdal:prepare` 从固定源码构建。除本说明外，生成文件不进入 Git。

桌面开发与打包入口会先构建并核验运行时；普通 Rust 单元测试无需安装 GDAL。
