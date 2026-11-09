import { Fill, Stroke, Circle, Style, Text } from "ol/style";
import type { StyleFunction } from "ol/style/Style";
import GeometryCollection from "ol/geom/GeometryCollection";
import MultiPoint from "ol/geom/MultiPoint";
import MultiLineString from "ol/geom/MultiLineString";
import MultiPolygon from "ol/geom/MultiPolygon";
import type { DocumentLayer } from "./domain/types";
import { categoryColor, graduatedColor, layerLabelTexts } from "./layerDisplay";

export function geometryDisplayStyle(
  color: string,
  selected = false,
  accent = "#3e73d8",
  width = 2,
  fillColor = color,
  fillOpacity = 36 / 255,
  pointRadius = 5,
  pattern: DocumentLayer["linePattern"] = "solid",
  pointStrokeWidth = 1,
): Style {
  const fillAlpha = Math.round(Math.max(0, Math.min(1, fillOpacity)) * 255)
    .toString(16)
    .padStart(2, "0");
  const fill = selected ? accent : fillColor;
  return new Style({
    stroke: new Stroke({
      color: selected ? accent : color,
      width: selected ? Math.max(2, width) : width,
      lineDash: selected
        ? undefined
        : pattern === "dashed"
          ? [8, 5]
          : pattern === "dotted"
            ? [1, 4]
            : undefined,
    }),
    fill: new Fill({ color: fill + fillAlpha }),
    image: new Circle({
      declutterMode: "none",
      radius: selected ? Math.max(8, pointRadius) : pointRadius,
      fill: new Fill({ color: selected ? accent : fillColor }),
      stroke: new Stroke({
        color: selected ? accent : color,
        width: selected ? Math.max(2, pointStrokeWidth) : pointStrokeWidth,
      }),
    }),
  });
}
/** 属性只从文档读取，不能把业务 geometry 字段复制到 OpenLayers 要素。 */
export function createLayerDisplayStyle(
  layer: DocumentLayer,
): Style | StyleFunction {
  const configuration = layer.categorizedStyle;
  const hasDataColors = Boolean(layer.categorizedStyle || layer.graduatedStyle);
  const colors = new Map(
    hasDataColors
      ? layer.features.map((feature) => [
          feature.id,
          layer.graduatedStyle
            ? graduatedColor(feature.properties, layer.graduatedStyle)
            : configuration
              ? categoryColor(feature.properties, configuration)
              : layer.color,
        ])
      : [],
  );
  const styles = new Map<string, Style>();
  const texts = layerLabelTexts(layer);
  const textStyles = new Map<string, Style>();
  const getStyle = (color: string, line: boolean) => {
    const key = `${color}:${line}`;
    let style = styles.get(key);
    if (!style) {
      style = geometryDisplayStyle(
        line ? color : (layer.strokeColor ?? color),
        false,
        undefined,
        layer.strokeWidth ?? 2,
        hasDataColors ? color : (layer.fillColor ?? color),
        layer.fillOpacity ?? 36 / 255,
        layer.pointRadius ?? 5,
        layer.linePattern,
        layer.strokeWidth ?? 1,
      );
      styles.set(key, style);
    }
    return style;
  };
  // With no separate border, a single OL style also handles mixed collections.
  if (!hasDataColors && !layer.labels && !layer.strokeColor)
    return getStyle(layer.color, false);
  return (feature) => {
    const color = colors.get(String(feature.getId())) ?? layer.color;
    const geometry = feature.getGeometry();
    const type = geometry?.getType();
    let style: Style | Style[];
    if (geometry instanceof GeometryCollection && layer.strokeColor) {
      // Split only the drawing styles; retain the original feature and geometry.
      style = [false, true].map((line) => {
        const key = `${color}:collection:${line}`;
        let cached = styles.get(key);
        if (!cached) {
          cached = getStyle(color, line).clone();
          cached.setGeometry((feature) => {
            const collection = feature.getGeometry();
            if (!(collection instanceof GeometryCollection)) return undefined;
            return new GeometryCollection(
              collection
                .getGeometriesArrayRecursive()
                .filter(
                  (part) =>
                    (part.getType() === "LineString" ||
                      part.getType() === "MultiLineString") === line,
                ),
            );
          });
          styles.set(key, cached);
        }
        return cached;
      });
    } else
      style = getStyle(
        color,
        type === "LineString" || type === "MultiLineString",
      );
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
    return [...(Array.isArray(style) ? style : [style]), textStyle];
  };
}
