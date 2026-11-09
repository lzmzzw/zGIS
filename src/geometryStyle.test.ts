import { describe, expect, it } from "vitest";
import type { Geometry as GeoJsonGeometry } from "geojson";
import Feature from "ol/Feature";
import GeoJSON from "ol/format/GeoJSON";
import Geometry from "ol/geom/Geometry";
import GeometryCollection from "ol/geom/GeometryCollection";
import CircleStyle from "ol/style/Circle";
import Style from "ol/style/Style";
import { importFiles, makeLayer } from "./domain";
import type { DocumentLayer } from "./domain/types";
import { layerGeometryKinds } from "./geometryStyle";
import { createCategorizedStyle, createGraduatedStyle } from "./layerDisplay";
import { createLayerDisplayStyle } from "./mapDisplayStyle";
import { restoreLayers, snapshotLayers } from "./workspace";

const point: GeoJsonGeometry = { type: "Point", coordinates: [114, 30] };
const line: GeoJsonGeometry = {
  type: "LineString",
  coordinates: [
    [114, 30],
    [115, 31],
  ],
};
const polygon: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [114, 30],
      [115, 30],
      [115, 31],
      [114, 30],
    ],
  ],
};
const format = new GeoJSON();
const make = (
  geometry: GeoJsonGeometry = polygon,
  extra: Partial<DocumentLayer> = {},
) =>
  makeLayer(
    "symbols.geojson",
    [{ id: "a", geometry, properties: { value: 1 } }],
    "geojson",
    {
      color: "#123456",
      ...extra,
    },
  );
const olFeature = (geometry: GeoJsonGeometry, id = "a") => {
  const feature = format.readFeature({
    type: "Feature",
    geometry,
    properties: {},
  }) as Feature<Geometry>;
  feature.setId(id);
  return feature;
};
function stylesFor(
  layer: DocumentLayer,
  feature = olFeature(layer.features[0].geometry!),
): Style[] {
  const render = createLayerDisplayStyle(layer);
  const result = typeof render === "function" ? render(feature, 1) : render;
  if (!result) throw new Error("Expected a rendered geometry style");
  return Array.isArray(result) ? result : [result];
}

describe("geometry-specific layer styles", () => {
  it.each([
    [
      {
        type: "MultiPoint",
        coordinates: [
          [114, 30],
          [115, 31],
        ],
      },
      ["point"],
    ],
    [
      {
        type: "MultiLineString",
        coordinates: [
          [
            [114, 30],
            [115, 31],
          ],
        ],
      },
      ["line"],
    ],
    [{ type: "MultiPolygon", coordinates: [polygon.coordinates] }, ["polygon"]],
  ] as const)(
    "detects actual imported %s without an editing geometry restriction",
    async (geometry, expected) => {
      const source = JSON.stringify({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry, properties: {} }],
      });
      const [layer] = await importFiles([
        { name: "import.geojson", bytes: new TextEncoder().encode(source) },
      ]);
      expect(layer.geometryType).toBeUndefined();
      expect(layerGeometryKinds(layer)).toEqual(expected);
    },
  );

  it("uses declared geometry only for empty layers and handles null geometry", () => {
    for (const [geometryType, kind] of [
      ["Point", "point"],
      ["LineString", "line"],
      ["Polygon", "polygon"],
    ] as const) {
      expect(
        layerGeometryKinds(makeLayer("empty", [], "geojson", { geometryType })),
      ).toEqual([kind]);
    }
    expect(layerGeometryKinds(makeLayer("empty", [], "geojson"))).toEqual([]);
    expect(
      layerGeometryKinds({ ...make(point), geometryType: "Polygon" }),
    ).toEqual(["point"]);
    expect(
      layerGeometryKinds({
        ...make(),
        features: [{ id: "null", geometry: null, properties: {} }],
      }),
    ).toEqual([]);
  });

  it("detects every family in an existing nested geometry collection", () => {
    const geometry: GeoJsonGeometry = {
      type: "GeometryCollection",
      geometries: [
        point,
        { type: "GeometryCollection", geometries: [line, polygon] },
      ],
    };
    expect(layerGeometryKinds(make(geometry))).toEqual([
      "point",
      "line",
      "polygon",
    ]);
  });

  it.each([
    [0, "00"],
    [1, "ff"],
  ] as const)(
    "renders independent polygon fill and border with fill opacity %s",
    (fillOpacity, alpha) => {
      const layer = make(polygon, {
        fillColor: "#ff6600",
        strokeColor: "#224466",
        fillOpacity,
        strokeWidth: 3,
      });
      const [style] = stylesFor(layer);
      expect(style.getFill()?.getColor()).toBe(`#ff6600${alpha}`);
      expect(style.getStroke()?.getColor()).toBe("#224466");
      expect(style.getStroke()?.getWidth()).toBe(3);
      expect(layer.features[0].geometry).toEqual(polygon);
    },
  );

  it("keeps a zero-width border and the requested point radius", () => {
    const [style] = stylesFor(
      make(point, {
        fillColor: "#ff6600",
        strokeColor: "#224466",
        strokeWidth: 0,
        pointRadius: 14,
      }),
    );
    const symbol = style.getImage() as CircleStyle;
    expect(symbol.getRadius()).toBe(14);
    expect(symbol.getFill()?.getColor()).toBe("#ff6600");
    expect(symbol.getStroke()?.getColor()).toBe("#224466");
    expect(symbol.getStroke()?.getWidth()).toBe(0);
    expect(style.getStroke()?.getWidth()).toBe(0);
  });

  it.each([
    ["solid", null],
    ["dashed", [8, 5]],
    ["dotted", [1, 4]],
  ] as const)("renders %s line patterns", (linePattern, expected) => {
    const [style] = stylesFor(make(line, { linePattern }));
    expect(style.getStroke()?.getLineDash()).toEqual(expected);
  });

  it.each(["categorized", "graduated"] as const)(
    "%s colors replace an old fill but retain the independent border",
    (mode) => {
      const layer = make(polygon, {
        fillColor: "#ff6600",
        strokeColor: "#224466",
        fillOpacity: 1,
      });
      const primary = "#00aa77";
      if (mode === "categorized") {
        layer.categorizedStyle = createCategorizedStyle(layer, "value");
        layer.categorizedStyle.categories[0].color = primary;
      } else {
        layer.graduatedStyle = createGraduatedStyle(layer, "value");
        layer.graduatedStyle.colors[0] = primary;
      }
      const [areaStyle] = stylesFor(layer);
      expect(areaStyle.getFill()?.getColor()).toBe(`${primary}ff`);
      expect(areaStyle.getStroke()?.getColor()).toBe("#224466");
      const [lineStyle] = stylesFor(layer, olFeature(line));
      expect(lineStyle.getStroke()?.getColor()).toBe(primary);
      const [pointStyle] = stylesFor(layer, olFeature(point));
      expect((pointStyle.getImage() as CircleStyle).getFill()?.getColor()).toBe(
        primary,
      );
      expect(
        (pointStyle.getImage() as CircleStyle).getStroke()?.getColor(),
      ).toBe("#224466");
    },
  );

  it("splits nested collection drawing by line and non-line without changing the source geometry", () => {
    const collection: GeoJsonGeometry = {
      type: "GeometryCollection",
      geometries: [
        point,
        { type: "GeometryCollection", geometries: [line, polygon] },
      ],
    };
    const layer = make(collection, {
      fillColor: "#ff6600",
      strokeColor: "#224466",
    });
    const feature = olFeature(collection);
    const original = feature.getGeometry();
    const before = format.writeGeometryObject(original!);
    const rendered = stylesFor(layer, feature);
    expect(rendered).toHaveLength(2);
    const groups = rendered.map((style) => ({
      color: style.getStroke()?.getColor(),
      geometry: style.getGeometryFunction()(feature) as GeometryCollection,
    }));
    expect(groups[0].color).toBe("#224466");
    expect(
      groups[0].geometry.getGeometriesArray().map((g) => g.getType()),
    ).toEqual(["Point", "Polygon"]);
    expect(groups[1].color).toBe(layer.color);
    expect(
      groups[1].geometry.getGeometriesArray().map((g) => g.getType()),
    ).toEqual(["LineString"]);
    expect(feature.getGeometry()).toBe(original);
    expect(format.writeGeometryObject(original!)).toEqual(before);
    expect(layer.features[0].geometry).toEqual(collection);
  });

  it("restores geometry style settings including zero values and line pattern", () => {
    const layer = make(polygon, {
      fillColor: "#ff6600",
      strokeColor: "#224466",
      fillOpacity: 0,
      pointRadius: 16,
      strokeWidth: 0,
      linePattern: "dotted",
      opacity: 0.5,
    });
    const [restored] = restoreLayers(snapshotLayers([layer]));
    expect(restored).toMatchObject({
      fillColor: "#ff6600",
      strokeColor: "#224466",
      fillOpacity: 0,
      pointRadius: 16,
      strokeWidth: 0,
      linePattern: "dotted",
      opacity: 0.5,
    });
    const [style] = stylesFor(
      restored,
      olFeature(polygon, restored.features[0].id),
    );
    expect(style.getFill()?.getColor()).toBe("#ff660000");
    expect(style.getStroke()?.getWidth()).toBe(0);
    expect(style.getStroke()?.getLineDash()).toEqual([1, 4]);
  });

  it.each([
    {
      fillColor: "red",
      strokeColor: "url(x)",
      fillOpacity: -0.1,
      pointRadius: 0,
      strokeWidth: -1,
      linePattern: "double",
    },
    {
      fillColor: 4,
      strokeColor: "#123",
      fillOpacity: 1.1,
      pointRadius: 17,
      strokeWidth: 9,
      linePattern: null,
    },
    {
      fillColor: null,
      strokeColor: [],
      fillOpacity: "0.5",
      pointRadius: "5",
      strokeWidth: "2",
      linePattern: {},
    },
  ])("falls back safely for malformed restored geometry settings", (bad) => {
    const data = JSON.parse(snapshotLayers([make()]));
    Object.assign(data[0], bad);
    const [layer] = restoreLayers(JSON.stringify(data));
    expect(layer.fillColor).toBeUndefined();
    expect(layer.strokeColor).toBeUndefined();
    expect(layer.fillOpacity).toBeUndefined();
    expect(layer.pointRadius).toBeUndefined();
    expect(layer.linePattern).toBeUndefined();
    expect(layer.strokeWidth).toBeUndefined();
    const [style] = stylesFor(layer);
    expect(style.getFill()?.getColor()).toBe(`${layer.color}24`);
    expect((style.getImage() as CircleStyle).getRadius()).toBe(5);
  });
});
