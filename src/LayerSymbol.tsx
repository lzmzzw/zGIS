import type { DocumentLayer } from "./domain/types";
import type { GeometryKind } from "./geometryStyle";

export function LayerSymbol({
  layer,
  kinds,
  color,
}: {
  layer: DocumentLayer;
  kinds: GeometryKind[];
  color?: string;
}) {
  const themed = Boolean(layer.categorizedStyle || layer.graduatedStyle);
  const primary = color ?? layer.color;
  const fill = themed ? primary : (layer.fillColor ?? primary);
  const border = layer.strokeColor ?? primary;
  const width = layer.strokeWidth ?? 2;
  const dash =
    layer.linePattern === "dashed"
      ? "8 5"
      : layer.linePattern === "dotted"
        ? "1 4"
        : undefined;
  return (
    <svg
      className="layer-symbol-preview"
      viewBox="0 0 32 24"
      aria-hidden="true"
      style={{ opacity: layer.opacity ?? 1 }}
    >
      {kinds.includes("polygon") && (
        <rect
          x="3"
          y="3"
          width="26"
          height="18"
          rx="1"
          fill={fill}
          fillOpacity={layer.fillOpacity ?? 36 / 255}
          stroke={border}
          strokeWidth={Math.min(width, 4)}
          strokeDasharray={dash}
        />
      )}
      {kinds.includes("line") && (
        <path
          d="M3 19 L12 7 L21 16 L29 5"
          fill="none"
          stroke={primary}
          strokeWidth={Math.min(width, 4)}
          strokeDasharray={dash}
        />
      )}
      {kinds.includes("point") && (
        <circle
          cx="16"
          cy="12"
          r={Math.min(8, layer.pointRadius ?? 5)}
          fill={fill}
          stroke={border}
          strokeWidth={Math.min(layer.strokeWidth ?? 1, 4)}
        />
      )}
      {!kinds.length && (
        <circle
          cx="16"
          cy="12"
          r="5"
          fill="none"
          stroke={border}
          strokeWidth="1"
        />
      )}
    </svg>
  );
}
