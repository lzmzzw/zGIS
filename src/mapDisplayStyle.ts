import { Fill, Stroke, Circle, Style } from "ol/style";
import type { StyleFunction } from "ol/style/Style";
import type { DocumentLayer } from "./domain/types";
import { categoryColor } from "./layerDisplay";

export function geometryDisplayStyle(
  color: string,
  selected = false,
  accent = "#3e73d8",
  width = 2,
): Style {
  return new Style({
    stroke: new Stroke({
      color: selected ? accent : color,
      width: selected ? Math.max(2, width) : width,
    }),
    fill: new Fill({ color: (selected ? accent : color) + "24" }),
    image: new Circle({
      radius: selected ? 8 : 5,
      fill: new Fill({ color: selected ? accent : color }),
      stroke: new Stroke({ color: selected ? accent : color, width: 1 }),
    }),
  });
}
/** 属性只从文档读取，不能把业务 geometry 字段复制到 OpenLayers 要素。 */
export function createLayerDisplayStyle(
  layer: DocumentLayer,
): Style | StyleFunction {
  if (!layer.categorizedStyle)
    return geometryDisplayStyle(
      layer.color,
      false,
      undefined,
      layer.strokeWidth ?? 2,
    );
  const configuration = layer.categorizedStyle;
  const colors = new Map(
    layer.features.map((feature) => [
      feature.id,
      categoryColor(feature.properties, configuration),
    ]),
  );
  const styles = new Map<string, Style>();
  return (feature) => {
    const color = colors.get(String(feature.getId())) ?? layer.color;
    let style = styles.get(color);
    if (!style) {
      style = geometryDisplayStyle(
        color,
        false,
        undefined,
        layer.strokeWidth ?? 2,
      );
      styles.set(color, style);
    }
    return style;
  };
}
