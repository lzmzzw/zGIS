import { Fill, Stroke, Circle, Style, Text } from "ol/style";
import type { StyleFunction } from "ol/style/Style";
import MultiPoint from "ol/geom/MultiPoint";
import MultiLineString from "ol/geom/MultiLineString";
import MultiPolygon from "ol/geom/MultiPolygon";
import type { DocumentLayer } from "./domain/types";
import { categoryColor, layerLabelTexts } from "./layerDisplay";

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
      declutterMode: "none",
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
  if (!layer.categorizedStyle && !layer.labels)
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
      configuration
        ? categoryColor(feature.properties, configuration)
        : layer.color,
    ]),
  );
  const styles = new Map<string, Style>();
  const texts = layerLabelTexts(layer);
  const textStyles = new Map<string, Style>();
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
    const text = texts.get(String(feature.getId()));
    if (!text || !layer.labels) return style;
    let textStyle = textStyles.get(text);
    if (!textStyle) {
      textStyle = new Style({
        // 多部件只标注首个部件，避免单条要素绕过文字数量预算。
        geometry: (feature) => {
          const geometry = feature.getGeometry();
          if (geometry instanceof MultiPoint)
            return geometry.getPoint(0) ?? undefined;
          if (geometry instanceof MultiLineString)
            return geometry.getLineString(0) ?? undefined;
          if (geometry instanceof MultiPolygon)
            return geometry.getPolygon(0) ?? undefined;
          return geometry;
        },
        text: new Text({
          text,
          font: `${layer.labels.fontSize}px sans-serif`,
          fill: new Fill({ color: layer.labels.color }),
          stroke:
            layer.labels.haloWidth > 0
              ? new Stroke({
                  color: layer.labels.haloColor,
                  width: layer.labels.haloWidth,
                })
              : undefined,
          offsetY: -12,
          overflow: false,
          padding: [2, 2, 2, 2],
          declutterMode: "declutter",
        }),
      });
      textStyles.set(text, textStyle);
    }
    return [style, textStyle];
  };
}
