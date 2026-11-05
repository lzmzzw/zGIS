import type { DocumentLayer } from "./domain";
import { isGdbLayer } from "./gdb";

// 格式与持久化来源分开：分析结果、浏览器文件和恢复的数据库副本均无回写目标。
export function layerSource(
  layer: DocumentLayer,
): "workspace" | "file" | "database" | "gdb" {
  if (isGdbLayer(layer)) return "gdb";
  if (layer.db) return "database";
  return layer.sourceId || layer.sourcePath ? "file" : "workspace";
}
