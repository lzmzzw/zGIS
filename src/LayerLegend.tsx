import { useMemo } from "react";
import { t, useLocale } from "./i18n";
import type { DocumentLayer } from "./domain/types";
import { layerLegendItems } from "./layerDisplay";
import "./layer-display.css";
import { layerGeometryKinds } from "./geometryStyle";
import { LayerSymbol } from "./LayerSymbol";

export default function LayerLegend({
  layer,
  defaultOpen = false,
}: {
  layer: DocumentLayer;
  defaultOpen?: boolean;
}) {
  useLocale();
  const items = useMemo(
    () => layerLegendItems(layer, false),
    [layer.features, layer.color, layer.categorizedStyle, layer.graduatedStyle],
  );
  const kinds = useMemo(
    () => layerGeometryKinds(layer),
    [layer.features, layer.geometryType],
  );
  return (
    <details
      className="layer-legend layer-legend-inspector"
      open={defaultOpen}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <summary>
        {t("图例")}{" "}
        <span>
          {layer.graduatedStyle?.field ?? layer.categorizedStyle?.field ?? ""}
        </span>
      </summary>
      <ul aria-label={t("图例明细")}>
        {items.map((item) => (
          <li key={item.key}>
            <LayerSymbol layer={layer} kinds={kinds} color={item.color} />
            <span title={item.translate ? t(item.label) : item.label}>
              {item.translate ? t(item.label) : item.label}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
