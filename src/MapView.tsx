import { useEffect, useRef } from "react";
import Map from "ol/Map";
import MapBrowserEvent from "ol/MapBrowserEvent";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import XYZ from "ol/source/XYZ";
import GeoJSON from "ol/format/GeoJSON";
import { Draw, Modify, Select, Snap, Translate } from "ol/interaction";
import Collection from "ol/Collection";
import LineString from "ol/geom/LineString";
import Polygon from "ol/geom/Polygon";
import Point from "ol/geom/Point";
import MultiPoint from "ol/geom/MultiPoint";
import {
  altKeyOnly,
  click,
  never,
  noModifierKeys,
  primaryAction,
} from "ol/events/condition";
import { unByKey } from "ol/Observable";
import type { EventsKey } from "ol/events";
import type { GeometryFunction } from "ol/interaction/Draw";
import { Fill, Stroke, Circle, Style } from "ol/style";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj";
import { defaults as defaultControls } from "ol/control";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import type { DocumentLayer, GeoFeature } from "./domain/types";
import { validateXyzUrl, type BasemapService } from "./basemaps";
import {
  canFinishDraft,
  geometryVertices,
  preserveInsertedDimensions,
  prepareDrawnGeometry,
  type DrawDraft,
} from "./mapEditing";
export type { DrawDraft } from "./mapEditing";

export type Tool =
  "pan" | "select" | "modify" | "move" | "Point" | "LineString" | "Polygon";
interface Props {
  services: BasemapService[];
  disabled?: boolean;
  editable?: boolean;
  theme: "light" | "dark";
  snapping: boolean;
  finishNonce: number;
  cancelNonce?: number;
  undoNodeNonce?: number;
  drawDraft?: DrawDraft | null;
  onDrawDraft?: (draft: DrawDraft | null) => void;
  onGestureState?: (active: boolean) => void;
  featureFitNonce: number;
  onNodeCount: (count: number) => void;
  layers: DocumentLayer[];
  activeId?: string;
  selectedId?: string;
  tool: Tool;
  basemap: string;
  basemapVisible: boolean;
  fitNonce: number;
  onSelect: (id?: string) => void;
  onEdit: (feature: GeoFeature, insert: boolean) => boolean | void;
  onPosition: (xy: number[]) => void;
  onBounds?: (bbox: number[]) => void;
  onContextMenu?: (context: {
    x: number;
    y: number;
    coordinate: number[];
    featureId?: string;
    returnFocus: HTMLElement;
  }) => void;
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
  const selectionRef = useRef<VectorLayer<VectorSource> | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const selectedFeatures = useRef(new Collection<Feature<Geometry>>());
  const gestureRef = useRef(false);
  const pointerDownTime = useRef<number | undefined>(undefined);
  const suppressedSelectionTime = useRef<number | undefined>(undefined);
  const draftRef = useRef<DrawDraft | null>(null);
  const finishDrawingRef = useRef<(() => void) | null>(null);
  const cancelGestureRef = useRef<(() => void) | null>(null);
  const geometryRefs = useRef(
    new WeakMap<Feature<Geometry>, GeoFeature["geometry"]>(),
  );
  const current = useRef(props);
  current.current = props;
  const syncSelection = (id: string | undefined) => {
    if (gestureRef.current) return;
    const layer = vectorRefs.current.get(current.current.activeId ?? "");
    const feature = layer?.getVisible()
      ? layer.getSource()?.getFeatureById(id ?? "")
      : null;
    const collection = selectedFeatures.current;
    if (collection.item(0) !== feature || collection.getLength() > 1) {
      collection.clear();
      if (feature) collection.push(feature);
    }
    const source = selectionRef.current?.getSource();
    if (source && source.getFeatures()[0] !== feature) {
      source.clear();
      if (feature) source.addFeature(feature);
    }
    selectionRef.current?.changed();
  };
  useEffect(() => {
    const base = new TileLayer();
    base.setZIndex(0);
    tileRef.current = base;
    const map = new Map({
      target: element.current!,
      layers: [base],
      controls: defaultControls({ rotate: false, attribution: false }),
      view: new View({ center: fromLonLat([104, 34]), zoom: 4 }),
    });
    mapRef.current = map;
    const selection = new VectorLayer({
      source: new VectorSource(),
      style: (feature) => {
        const active = current.current.layers.find(
          (item) => item.id === current.current.activeId,
        );
        const accent = current.current.theme === "dark" ? "#78a8ff" : "#3e73d8";
        const styles = [
          style(
            active?.color ?? accent,
            true,
            accent,
            active?.strokeWidth ?? 2,
          ),
        ];
        if (current.current.editable && current.current.tool === "modify") {
          const geometry = feature.getGeometry();
          styles.push(
            new Style({
              geometry: geometry
                ? new MultiPoint(
                    geometryVertices(
                      format.writeGeometryObject(geometry as Geometry),
                    ),
                  )
                : undefined,
              image: new Circle({
                radius: 5,
                fill: new Fill({ color: "#ffffff" }),
                stroke: new Stroke({ color: accent, width: 2 }),
              }),
            }),
          );
        }
        return styles;
      },
    });
    selection.setZIndex(1000000);
    map.addLayer(selection);
    selectionRef.current = selection;
    const pointerDown = (event: PointerEvent) => {
      pointerDownTime.current = event.timeStamp;
      suppressedSelectionTime.current = undefined;
      element.current?.focus({ preventScroll: true });
    };
    map.getViewport().addEventListener("pointerdown", pointerDown, true);
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
      if (
        geometry &&
        !current.current.disabled &&
        current.current.tool === "select"
      ) {
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
      map.getViewport().removeEventListener("pointerdown", pointerDown, true);
      map.setTarget(undefined);
      map.dispose();
      mapRef.current = null;
      vectorRefs.current.clear();
      selectionRef.current = null;
      selectedFeatures.current.clear();
    };
  }, []);
  useEffect(() => {
    const base = tileRef.current!;
    const service = props.services.find(
      (item) => item.id === props.basemap && item.enabled !== false,
    );
    base.setSource(
      service?.url && validateXyzUrl(service.url)
        ? new XYZ({
            url: service.url,
            attributions: service.attribution,
            maxZoom: service.maxZoom,
          })
        : null,
    );
  }, [props.basemap, props.services]);
  useEffect(() => {
    const service = props.services.find(
      (item) => item.id === props.basemap && item.enabled !== false,
    );
    tileRef.current?.setVisible(
      props.basemapVisible &&
        Boolean(service?.url && validateXyzUrl(service.url)),
    );
  }, [props.basemapVisible, props.basemap, props.services]);
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
      layer.setStyle(() =>
        style(
          item.color,
          false,
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
        const ids = new Set(item.features.map((feature) => feature.id));
        for (const feature of existing)
          if (!ids.has(String(feature.getId()))) source.removeFeature(feature);
        for (const data of item.features) {
          const feature = source.getFeatureById(data.id);
          if (feature) {
            if (
              !gestureRef.current &&
              geometryRefs.current.get(feature) !== data.geometry
            ) {
              feature.setGeometry(
                data.geometry
                  ? format.readGeometry(data.geometry, {
                      dataProjection: "EPSG:4326",
                      featureProjection: "EPSG:3857",
                    })
                  : undefined,
              );
              geometryRefs.current.set(feature, data.geometry);
            }
            for (const key of feature.getKeys())
              if (
                key !== feature.getGeometryName() &&
                !(key in data.properties)
              )
                feature.unset(key, true);
            feature.setProperties(data.properties, true);
          } else {
            const added = format.readFeatures(
              {
                type: "FeatureCollection",
                features: [
                  {
                    type: "Feature",
                    id: data.id,
                    geometry: data.geometry,
                    properties: data.properties,
                  },
                ],
              },
              { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" },
            )[0];
            geometryRefs.current.set(added, data.geometry);
            source.addFeature(added);
          }
        }
        layer.set("dataRef", item.features);
      }
      layer.changed();
    });
    syncSelection(current.current.selectedId);
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
    if (props.finishNonce) finishDrawingRef.current?.();
  }, [props.finishNonce]);
  useEffect(() => {
    if (!props.cancelNonce) return;
    drawRef.current?.abortDrawing();
    cancelGestureRef.current?.();
  }, [props.cancelNonce]);
  useEffect(() => {
    if (props.undoNodeNonce) drawRef.current?.removeLastPoint();
  }, [props.undoNodeNonce]);
  useEffect(() => {
    const map = mapRef.current!;
    const layer = vectorRefs.current.get(props.activeId ?? "");
    if (!layer || props.disabled) return;
    const keys: EventsKey[] = [];
    const interactions: (Draw | Modify | Select | Snap | Translate)[] = [];
    const snapshots = new globalThis.Map<
      Feature<Geometry>,
      { geometry: Geometry; insertion: number[] }
    >();
    let disposed = false;
    let gestureEvent: MapBrowserEvent | null = null;
    const collection = selectedFeatures.current;
    const select = new Select({
      features: collection,
      condition: (event) =>
        click(event) &&
        !gestureRef.current &&
        !event.originalEvent.altKey &&
        event.originalEvent.timeStamp !== suppressedSelectionTime.current,
      layers: [layer],
      style: null,
      hitTolerance: 12,
      toggleCondition: never,
    });
    interactions.push(select);
    select.setActive(
      props.tool === "select" ||
        props.tool === "modify" ||
        props.tool === "move",
    );
    keys.push(
      select.on("select", () => {
        const id = collection.item(0)?.getId()?.toString();
        syncSelection(id);
        current.current.onSelect(id);
      }),
    );
    const edited = (feature: Feature<Geometry>, insert: boolean) => {
      const raw = format.writeFeatureObject(feature, {
        featureProjection: "EPSG:3857",
        dataProjection: "EPSG:4326",
      });
      if (insert && raw.geometry) {
        const active = current.current.layers.find(
          (item) => item.id === current.current.activeId,
        );
        raw.geometry = prepareDrawnGeometry(
          raw.geometry,
          active?.features.map((feature) => feature.geometry) ?? [],
        );
      }
      return current.current.onEdit(
        {
          id: insert ? crypto.randomUUID() : String(feature.getId()),
          geometry: raw.geometry ?? null,
          properties: raw.properties ?? {},
        },
        insert,
      );
    };
    const beginGesture = (
      features: Collection<Feature<Geometry>>,
      event: MapBrowserEvent,
    ) => {
      gestureEvent = event;
      suppressedSelectionTime.current = pointerDownTime.current;
      gestureRef.current = true;
      for (const feature of features.getArray()) {
        const geometry = feature.getGeometry();
        if (geometry)
          snapshots.set(feature, {
            geometry: geometry.clone(),
            insertion: event.coordinate.slice(),
          });
      }
      current.current.onGestureState?.(true);
    };
    const endGesture = (features: Collection<Feature<Geometry>>) => {
      try {
        for (const feature of features.getArray()) {
          const snapshot = snapshots.get(feature);
          const geometry = feature.getGeometry();
          if (!snapshot || !geometry) continue;
          const before = format.writeGeometryObject(snapshot.geometry);
          const after = format.writeGeometryObject(geometry);
          const repaired = preserveInsertedDimensions(
            before,
            after,
            snapshot.insertion,
          );
          if (JSON.stringify(before) === JSON.stringify(repaired)) continue;
          if (JSON.stringify(after) !== JSON.stringify(repaired))
            feature.setGeometry(format.readGeometry(repaired));
          try {
            if (edited(feature, false) === false)
              feature.setGeometry(snapshot.geometry);
          } catch (error) {
            feature.setGeometry(snapshot.geometry);
            throw error;
          }
        }
      } finally {
        snapshots.clear();
        gestureEvent = null;
        gestureRef.current = false;
        current.current.onGestureState?.(false);
      }
    };
    if (props.editable && props.tool === "modify") {
      const modify = new Modify({
        features: collection,
        pixelTolerance: 12,
        condition: (event) =>
          primaryAction(event) && (noModifierKeys(event) || altKeyOnly(event)),
        insertVertexCondition: noModifierKeys,
        // 使用即时 click，避免 OL 插点后的 singleclick 抑制吞掉下一次 Alt 删除。
        deleteCondition: (event) => altKeyOnly(event) && click(event),
        style: (feature) =>
          new Style({
            image: new Circle({
              radius: feature.get("existing") ? 7 : 5,
              fill: new Fill({ color: "#ffffff" }),
              stroke: new Stroke({
                color: current.current.theme === "dark" ? "#78a8ff" : "#3e73d8",
                width: 3,
              }),
            }),
          }),
      });
      keys.push(
        modify.on("modifystart", (event) =>
          beginGesture(event.features, event.mapBrowserEvent),
        ),
      );
      keys.push(modify.on("modifyend", (event) => endGesture(event.features)));
      interactions.push(modify);
    } else if (props.editable && props.tool === "move") {
      const translate = new Translate({
        layers: [layer],
        hitTolerance: 12,
        condition: (event) => primaryAction(event) && noModifierKeys(event),
      });
      keys.push(
        translate.on("translatestart", (event) => {
          const feature = event.features.item(0);
          syncSelection(feature?.getId()?.toString());
          current.current.onSelect(feature?.getId()?.toString());
          beginGesture(event.features, event.mapBrowserEvent);
        }),
      );
      keys.push(
        translate.on("translateend", (event) => endGesture(event.features)),
      );
      interactions.push(translate);
    } else if (
      props.editable &&
      (props.tool === "Point" ||
        props.tool === "LineString" ||
        props.tool === "Polygon")
    ) {
      const drawType = props.tool;
      let lastDraft = "";
      let finishing = false;
      const publishDraft = (coordinates: number[][]) => {
        if (disposed || finishing || drawType === "Point") return;
        const draft: DrawDraft | null = coordinates.length
          ? {
              type: drawType,
              coordinates: coordinates.map((coordinate) =>
                toLonLat(coordinate),
              ),
            }
          : null;
        draftRef.current = draft;
        const serialized = JSON.stringify(draft);
        if (serialized === lastDraft) return;
        lastDraft = serialized;
        current.current.onNodeCount(coordinates.length);
        current.current.onDrawDraft?.(draft);
      };
      const geometryFunction: GeometryFunction = (coordinates, geometry) => {
        if (drawType === "Point") {
          const point = geometry instanceof Point ? geometry : new Point([]);
          point.setCoordinates(coordinates as number[]);
          return point;
        }
        const nodes =
          drawType === "Polygon"
            ? (coordinates as number[][][])[0]
            : (coordinates as number[][]);
        // finishDrawing 清空 overlay 后会再次调用此函数，此时 nodes 已无 hover 点。
        if (
          !geometry ||
          drawRef.current?.getOverlay().getSource()?.getFeatures().length
        )
          publishDraft(nodes.slice(0, -1));
        if (drawType === "Polygon") {
          const polygon =
            geometry instanceof Polygon ? geometry : new Polygon([]);
          polygon.setCoordinates(nodes.length ? [[...nodes, nodes[0]]] : []);
          return polygon;
        }
        const line =
          geometry instanceof LineString ? geometry : new LineString([]);
        line.setCoordinates(nodes);
        return line;
      };
      const draw = new Draw({
        type: drawType,
        stopClick: true,
        freehandCondition: never,
        geometryFunction,
      });
      drawRef.current = draw;
      const resetNodes = () => {
        if (disposed) return;
        draftRef.current = null;
        lastDraft = "null";
        current.current.onNodeCount(0);
        current.current.onDrawDraft?.(null);
      };
      keys.push(
        draw.on("drawend", (event) => {
          const previous = draftRef.current;
          resetNodes();
          if (edited(event.feature, true) === false && previous) {
            const wasFinishing = finishing;
            finishing = false;
            try {
              draw.appendCoordinates(
                previous.coordinates.map((coordinate) =>
                  fromLonLat(coordinate),
                ),
              );
            } finally {
              finishing = wasFinishing;
            }
          }
        }),
      );
      keys.push(draw.on("drawabort", resetNodes));
      finishDrawingRef.current = () => {
        if (!canFinishDraft(draftRef.current)) return;
        finishing = true;
        try {
          draw.finishDrawing();
        } finally {
          finishing = false;
        }
      };
      interactions.push(draw);
    }
    if (props.editable && props.snapping && props.tool !== "pan")
      interactions.push(new Snap({ source: layer.getSource()! }));
    interactions.forEach((item) => map.addInteraction(item));
    const initialDraft = current.current.drawDraft;
    if (
      drawRef.current &&
      initialDraft?.type === props.tool &&
      initialDraft.coordinates.length
    ) {
      drawRef.current.appendCoordinates(
        initialDraft.coordinates.map((coordinate) => fromLonLat(coordinate)),
      );
    }
    const cancelGesture = () => {
      if (!gestureRef.current) return;
      const originalEvent = gestureEvent;
      for (const [feature, snapshot] of snapshots)
        feature.setGeometry(snapshot.geometry);
      const interaction = interactions.find(
        (item) => item instanceof Modify || item instanceof Translate,
      );
      if (interaction && originalEvent) {
        // 通过公开的事件入口结束拖动，避免停用后遗留 OL 的 down/up 序列。
        const pointerUp = new MapBrowserEvent(
          "pointerup",
          map,
          originalEvent.originalEvent,
          false,
          undefined,
          [],
        );
        pointerUp.coordinate = originalEvent.coordinate;
        pointerUp.pixel = originalEvent.pixel;
        interaction.handleEvent(pointerUp);
      }
      snapshots.clear();
      gestureEvent = null;
      if (gestureRef.current) current.current.onGestureState?.(false);
      gestureRef.current = false;
    };
    cancelGestureRef.current = cancelGesture;
    selectionRef.current?.changed();
    return () => {
      disposed = true;
      unByKey(keys);
      for (const [feature, snapshot] of snapshots)
        feature.setGeometry(snapshot.geometry);
      snapshots.clear();
      if (gestureRef.current) current.current.onGestureState?.(false);
      gestureRef.current = false;
      drawRef.current?.abortDrawing();
      drawRef.current = null;
      finishDrawingRef.current = null;
      cancelGestureRef.current = null;
      interactions.forEach((item) => map.removeInteraction(item));
      interactions.forEach((item) => item.dispose());
    };
  }, [
    props.activeId,
    props.tool,
    props.disabled,
    props.editable,
    props.snapping,
  ]);
  return (
    <div
      className={`map-surface ${props.tool === "pan" ? "pan-mode" : ""} ${props.editable ? "editing-mode" : ""} ${props.tool === "move" ? "move-mode" : ""} ${props.tool === "modify" ? "vertex-mode" : ""}`}
      ref={element}
      aria-label="地理数据地图"
      tabIndex={0}
      onContextMenu={(event) => {
        if ((event.target as Element).closest(".ol-control")) return;
        event.preventDefault();
        event.stopPropagation();
        const map = mapRef.current;
        if (!map) return;
        const pixel = map.getEventPixel(event.nativeEvent);
        const active = vectorRefs.current.get(current.current.activeId ?? "");
        const feature = active?.getVisible()
          ? map.forEachFeatureAtPixel(pixel, (candidate) => candidate, {
              layerFilter: (layer) => layer === active,
              hitTolerance: 5,
            })
          : undefined;
        props.onContextMenu?.({
          x: event.clientX,
          y: event.clientY,
          coordinate: toLonLat(map.getCoordinateFromPixel(pixel)),
          featureId: feature?.getId()?.toString(),
          returnFocus: event.currentTarget,
        });
      }}
      onKeyDown={(event) => {
        if (
          (event.target as Element).closest(
            "input,textarea,select,button,[contenteditable=true]",
          )
        )
          return;
        if (
          props.editable &&
          !props.disabled &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          if (event.key === "Enter" && drawRef.current) {
            event.preventDefault();
            event.stopPropagation();
            finishDrawingRef.current?.();
            return;
          }
          if (
            event.key === "Escape" &&
            (draftRef.current || gestureRef.current)
          ) {
            event.preventDefault();
            event.stopPropagation();
            drawRef.current?.abortDrawing();
            cancelGestureRef.current?.();
            return;
          }
          if (event.key === "Backspace" && drawRef.current) {
            event.preventDefault();
            event.stopPropagation();
            drawRef.current.removeLastPoint();
            return;
          }
        }
        if (
          event.target !== event.currentTarget ||
          !(
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          )
        )
          return;
        event.preventDefault();
        const map = mapRef.current;
        const coordinate = map?.getView().getCenter();
        if (!coordinate) return;
        const rect = event.currentTarget.getBoundingClientRect();
        props.onContextMenu?.({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          coordinate: toLonLat(coordinate),
          returnFocus: event.currentTarget,
          featureId: props.selectedId,
        });
      }}
    />
  );
}
