import { useMemo } from "react";
import { t, useLocale } from "./i18n";
import type { DocumentLayer } from "./domain/types";
import { layerLegendItems } from "./layerDisplay";
import "./layer-display.css";

export default function LayerLegend({
  layer,
  defaultOpen = false,
}: {
  layer: DocumentLayer;
  defaultOpen?: boolean;
}) {
  useLocale();
  const items = useMemo(
    () => layerLegendItems(layer),
    [layer.features, layer.color, layer.categorizedStyle, layer.graduatedStyle],
  );
  return (
    <details
      className="layer-legend"
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
            <i
              style={{
                backgroundColor: item.color,
                opacity: layer.opacity ?? 1,
              }}
              aria-hidden="true"
            />
            <span title={item.translate ? t(item.label) : item.label}>
              {item.translate ? t(item.label) : item.label}
            </span>
            <small>{item.count.toLocaleString()}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}
