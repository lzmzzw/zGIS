import { useEffect, useRef } from "react";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import GeoJSON from "ol/format/GeoJSON";
import { Draw, Modify, Select, Snap } from "ol/interaction";
import { click } from "ol/events/condition";
import { Fill, Stroke, Circle, Style } from "ol/style";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj";
import { defaults as defaultControls, ScaleLine } from "ol/control";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import type { DocumentLayer, GeoFeature } from "./domain/types";

export type Tool = "select" | "modify" | "Point" | "LineString" | "Polygon";
interface Props {
  disabled?: boolean;
  editable?: boolean;
  theme: "light" | "dark";
  annotations: boolean;
  snapping: boolean;
  finishNonce: number;
  featureFitNonce: number;
  onNodeCount: (count: number) => void;
  layers: DocumentLayer[];
  activeId?: string;
  selectedId?: string;
  tool: Tool;
  basemap: string;
  tdtKey: string;
  fitNonce: number;
  onSelect: (id?: string) => void;
  onEdit: (feature: GeoFeature, insert: boolean) => void;
  onPosition: (xy: number[]) => void;
  onBounds?: (bbox: number[]) => void;
}
const format = new GeoJSON();
function style(color: string, selected = false, accent = "#3e73d8", width = 2) {
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
export default function MapView(props: Props) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const vectorRefs = useRef(
    new globalThis.Map<string, VectorLayer<VectorSource>>(),
  );
  const tileRef = useRef<TileLayer | null>(null);
  const labelRef = useRef<TileLayer | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    const base = new TileLayer({ source: new OSM() });
    tileRef.current = base;
    const labels = new TileLayer({ visible: false });
    labelRef.current = labels;
    const map = new Map({
      target: element.current!,
      layers: [base, labels],
      controls: defaultControls({ rotate: false }).extend([new ScaleLine()]),
      view: new View({ center: fromLonLat([104, 34]), zoom: 4 }),
    });
    mapRef.current = map;
    map.on("pointermove", (event) =>
      current.current.onPosition(toLonLat(event.coordinate)),
    );
    map.on("dblclick", (event) => {
      const active = vectorRefs.current.get(current.current.activeId ?? "");
      const feature = map.forEachFeatureAtPixel(
        event.pixel,
        (candidate) => candidate,
        { layerFilter: (layer) => layer === active },
      );
      const geometry = feature?.getGeometry();
      if (geometry && current.current.tool === "select") {
        current.current.onSelect(feature?.getId()?.toString());
        map.getView().fit(geometry.getExtent(), {
          padding: [60, 60, 60, 60],
          maxZoom: 16,
          duration: 200,
        });
        event.preventDefault();
        return false;
      }
    });
    map.on("moveend", () => {
      const bbox = transformExtent(
        map.getView().calculateExtent(map.getSize()),
        "EPSG:3857",
        "EPSG:4326",
      );
      current.current.onBounds?.([
        Math.max(-180, bbox[0]),
        Math.max(-85, bbox[1]),
        Math.min(180, bbox[2]),
        Math.min(85, bbox[3]),
      ]);
    });
    const resize = new ResizeObserver(() => map.updateSize());
    resize.observe(element.current!);
    return () => {
      resize.disconnect();
      map.setTarget(undefined);
      map.dispose();
      mapRef.current = null;
      vectorRefs.current.clear();
    };
  }, []);
  useEffect(() => {
    const base = tileRef.current!;
    const labels = labelRef.current!;
    base.setVisible(
      props.basemap === "osm" ||
        (props.basemap.startsWith("tdt") && Boolean(props.tdtKey)),
    );
    labels.setVisible(false);
    if (props.basemap === "osm") base.setSource(new OSM());
    else if (props.basemap.startsWith("tdt") && props.tdtKey) {
      const type = props.basemap === "tdt-img" ? "img" : "vec";
      const annotation = type === "img" ? "cia" : "cva";
      const source = (layer: string) =>
        new XYZ({
          url: `https://t0.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${encodeURIComponent(props.tdtKey)}`,
          maxZoom: 18,
          attributions: "© 天地图",
        });
      base.setSource(source(type));
      labels.setSource(source(annotation));
      labels.setVisible(props.annotations);
    }
  }, [props.basemap, props.tdtKey, props.annotations]);
  useEffect(() => {
    const map = mapRef.current!;
    for (const [id, layer] of vectorRefs.current)
      if (!props.layers.some((item) => item.id === id)) {
        map.removeLayer(layer);
        vectorRefs.current.delete(id);
      }
    props.layers.forEach((item, index) => {
      let layer = vectorRefs.current.get(item.id);
      if (!layer) {
        layer = new VectorLayer({ source: new VectorSource() });
        map.addLayer(layer);
        vectorRefs.current.set(item.id, layer);
      }
      layer.setVisible(item.visible);
      layer.setOpacity(item.opacity ?? 1);
      layer.setZIndex(props.layers.length - index + 10);
      layer.setStyle((feature) =>
        style(
          item.color,
          feature.getId() === props.selectedId && item.id === props.activeId,
          props.theme === "dark" ? "#78a8ff" : "#3e73d8",
          item.strokeWidth ?? 2,
        ),
      );
      const source = layer.getSource()!;
      const existing = source.getFeatures();
      if (
        existing.length !== item.features.length ||
        layer.get("dataRef") !== item.features
      ) {
        source.clear();
        source.addFeatures(
          format.readFeatures(
            {
              type: "FeatureCollection",
              features: item.features.map((f) => ({
                type: "Feature",
                id: f.id,
                geometry: f.geometry,
                properties: f.properties,
              })),
            },
            { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" },
          ),
        );
        layer.set("dataRef", item.features);
      }
      layer.changed();
    });
  }, [props.layers, props.selectedId, props.activeId, props.theme]);
  useEffect(() => {
    const source = vectorRefs.current.get(props.activeId ?? "")?.getSource();
    const extent = source?.getExtent();
    if (source && !source.isEmpty() && extent)
      mapRef
        .current!.getView()
        .fit(extent, { padding: [60, 60, 60, 60], maxZoom: 16, duration: 200 });
  }, [props.fitNonce]);
  useEffect(() => {
    if (!props.featureFitNonce) return;
    const feature = vectorRefs.current
      .get(props.activeId ?? "")
      ?.getSource()
      ?.getFeatureById(props.selectedId ?? "");
    const geometry = feature?.getGeometry();
    if (geometry)
      mapRef.current?.getView().fit(geometry.getExtent(), {
        padding: [60, 60, 60, 60],
        maxZoom: 16,
        duration: 200,
      });
  }, [props.featureFitNonce]);
  useEffect(() => {
    if (props.finishNonce) drawRef.current?.finishDrawing();
  }, [props.finishNonce]);
  useEffect(() => {
    const map = mapRef.current!;
    const layer = vectorRefs.current.get(props.activeId ?? "");
    if (!layer || props.disabled) return;
    const select = new Select({
      condition: click,
      layers: [layer],
      style: style(
        props.theme === "dark" ? "#78a8ff" : "#3e73d8",
        true,
        props.theme === "dark" ? "#78a8ff" : "#3e73d8",
      ),
    });
    map.addInteraction(select);
    select.setActive(props.tool === "select" || props.tool === "modify");
    if (props.selectedId) {
      const f = layer.getSource()!.getFeatureById(props.selectedId);
      if (f) select.getFeatures().push(f);
    }
    select.on("select", (event) =>
      current.current.onSelect(event.selected[0]?.getId()?.toString()),
    );
    const interactions: (Draw | Modify | Snap)[] = [];
    const edited = (feature: Feature<Geometry>, insert: boolean) => {
      const raw = format.writeFeatureObject(feature, {
        featureProjection: "EPSG:3857",
        dataProjection: "EPSG:4326",
      });
      if (insert && raw.geometry && "coordinates" in raw.geometry) {
        const zeroHeight = (coordinates: any[]): any[] =>
          typeof coordinates[0] === "number"
            ? [coordinates[0], coordinates[1], 0]
            : coordinates.map(zeroHeight);
        raw.geometry.coordinates = zeroHeight(
          raw.geometry.coordinates,
        ) as never;
      }
      current.current.onEdit(
        {
          id: insert ? crypto.randomUUID() : String(feature.getId()),
          geometry: raw.geometry ?? null,
          properties: raw.properties ?? {},
        },
        insert,
      );
    };
    if (props.editable && props.tool === "modify") {
      const modify = new Modify({ features: select.getFeatures() });
      modify.on("modifyend", (event) =>
        event.features.forEach((f) => edited(f, false)),
      );
      interactions.push(modify);
    } else if (
      props.editable &&
      props.tool !== "select" &&
      props.tool !== "modify"
    ) {
      const draw = new Draw({ type: props.tool });
      drawRef.current = draw;
      let removeGeometryListener: (() => void) | undefined;
      const resetNodes = () => {
        removeGeometryListener?.();
        removeGeometryListener = undefined;
        current.current.onNodeCount(0);
      };
      draw.on("drawstart", (event) => {
        const geometry = event.feature.getGeometry();
        if (!geometry) return;
        const count = () => {
          const raw = format.writeGeometryObject(geometry);
          const coordinates =
            raw.type === "Point"
              ? [raw.coordinates]
              : raw.type === "LineString"
                ? raw.coordinates.slice(0, -1)
                : raw.type === "Polygon"
                  ? raw.coordinates[0].slice(0, -2)
                  : [];
          current.current.onNodeCount(coordinates.length);
        };
        geometry.on("change", count);
        removeGeometryListener = () => geometry.un("change", count);
        count();
      });
      draw.on("drawend", (event) => {
        resetNodes();
        edited(event.feature, true);
      });
      draw.on("drawabort", resetNodes);
      interactions.push(draw);
    }
    if (props.editable && props.snapping)
      interactions.push(new Snap({ source: layer.getSource()! }));
    interactions.forEach((item) => map.addInteraction(item));
    return () => {
      drawRef.current?.abortDrawing();
      drawRef.current = null;
      map.removeInteraction(select);
      interactions.forEach((item) => map.removeInteraction(item));
    };
  }, [
    props.activeId,
    props.tool,
    props.selectedId,
    props.layers,
    props.disabled,
    props.editable,
    props.snapping,
    props.theme,
  ]);
  return (
    <div className="map-surface" ref={element} aria-label="地理数据地图" />
  );
}
