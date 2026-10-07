import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type McpToolDefinition } from "./bridge";
import { getAnalysisTool } from "./analysisTools";

const labels: Record<string, [string, string]> = {
  list_layers: ["图层与数据", "列举图层"],
  describe_layer: ["图层与数据", "图层详情"],
  read_features: ["图层与数据", "读取要素"],
  load_vector_file: ["图层与数据", "读取外部矢量文件"],
  layer_summary: ["图层与数据", "图层摘要"],
  spatial_query: ["空间分析", "空间查询"],
  spatial_join: ["空间分析", "空间关联"],
  nearest: ["空间分析", "最近目标"],
  topology_check: ["空间分析", "拓扑检查"],
  buffer: ["空间分析", "缓冲分析"],
  clip: ["空间分析", "裁剪"],
  dissolve: ["空间分析", "合并面"],
  read_result: ["分析结果", "读取结果"],
  publish_result: ["分析结果", "发布结果图层"],
};

export default function McpToolCatalog() {
  const [expanded, setExpanded] = useState(false);
  const [tools, setTools] = useState<McpToolDefinition[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function load() {
    setLoading(true);
    setError("");
    try {
      const catalog = await api.mcpTools();
      if (alive.current) setTools(catalog);
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      if (alive.current) setLoading(false);
    }
  }
  const groups = new Map<string, McpToolDefinition[]>();
  for (const tool of tools ?? []) {
    const group = labels[tool.name]?.[0] ?? (getAnalysisTool(tool.name) ? "空间分析" : "其他工具");
    groups.set(group, [...(groups.get(group) ?? []), tool]);
  }
  return (
    <div className="mcp-tools-panel">
      <button
        className="mcp-tools-toggle"
        aria-expanded={expanded}
        aria-controls="mcp-tools-details"
        onClick={() => {
          setExpanded(!expanded);
          if (!expanded && tools === null && !loading) void load();
        }}
      >
        {expanded ? <ChevronDown /> : <ChevronRight />}
        <strong>工具详情</strong>
        {tools !== null && <span>{tools.length} 个工具</span>}
      </button>
      {expanded && (
        <div id="mcp-tools-details" className="mcp-tools-details">
          {loading && <p role="status">正在加载工具清单…</p>}
          {error && (
            <div role="alert" className="mcp-tools-error">
              工具清单加载失败：{error}
              <button onClick={() => void load()} disabled={loading}>
                重试
              </button>
            </div>
          )}
          {!loading && !error && tools?.length === 0 && (
            <p>当前 MCP 未提供工具</p>
          )}
          {!loading &&
            !error &&
            Array.from(groups, ([group, items]) => (
              <section
                key={group}
                aria-label={group}
                className="mcp-tool-group"
              >
                <h3>
                  {group}（{items.length}）
                </h3>
                <div className="mcp-tool-list">
                  {items.map((tool) => (
                    <details key={tool.name} className="mcp-tool-item">
                      <summary>
                        <strong>{labels[tool.name]?.[1] ?? getAnalysisTool(tool.name)?.label ?? tool.name}</strong>
                        <code>{tool.name}</code>
                        <ChevronDown />
                      </summary>
                      <p>{tool.description}</p>
                    </details>
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}
