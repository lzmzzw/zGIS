import { describe, expect, it } from "vitest";
import type { Geometry } from "geojson";
import GeoJSON from "ol/format/GeoJSON";
import { fromLonLat } from "ol/proj";
import {
  canFinishDraft,
  geometryVertices,
  preserveInsertedDimensions,
  prepareDrawnGeometry,
} from "./mapEditing";

describe("map editing geometry", () => {
  it("keeps new features XY in existing 2D layers and supplies Z only in empty/3D layers", () => {
    const drawn: Geometry = { type: "Point", coordinates: [100, 30] };
    expect(
      prepareDrawnGeometry(drawn, [
        {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      ]),
    ).toEqual(drawn);
    expect(prepareDrawnGeometry(drawn, [])).toEqual({
      ...drawn,
      coordinates: [100, 30, 0],
    });
    expect(
      prepareDrawnGeometry(drawn, [{ type: "Point", coordinates: [1, 1, 50] }]),
    ).toEqual({ ...drawn, coordinates: [100, 30, 0] });
    const polygon: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    expect(
      prepareDrawnGeometry(polygon, [{ type: "Point", coordinates: [1, 1] }]),
    ).toEqual(polygon);
    expect(
      geometryVertices(prepareDrawnGeometry(polygon, [])).map(
        (coordinate) => coordinate.length,
      ),
    ).toEqual([3, 3, 3]);
    expect(drawn.coordinates).toEqual([100, 30]);
  });

  it("round-trips a translated multipart geometry through OL without flattening holes or Z", () => {
    const format = new GeoJSON();
    const original: Geometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0, 10],
            [2, 0, 20],
            [2, 2, 30],
            [0, 0, 10],
          ],
          [
            [0.5, 0.5, 40],
            [1, 0.5, 50],
            [1, 1, 60],
            [0.5, 0.5, 40],
          ],
        ],
        [
          [
            [5, 5, 70],
            [7, 5, 80],
            [7, 7, 90],
            [5, 5, 70],
          ],
        ],
      ],
    };
    const geometry = format.readGeometry(original, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857",
    });
    geometry.translate(1000, 2000);
    const edited = format.writeGeometryObject(geometry, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857",
    });
    expect(edited.type).toBe("MultiPolygon");
    expect(geometryVertices(edited).map((coordinate) => coordinate[2])).toEqual(
      [10, 20, 30, 40, 50, 60, 70, 80, 90],
    );
    if (edited.type !== "MultiPolygon") throw new Error("geometry changed");
    expect(edited.coordinates).toHaveLength(2);
    expect(edited.coordinates[0]).toHaveLength(2);
    expect(edited.coordinates[0][0][0][0]).not.toBe(0);
  });

  it("repairs OL-inserted height in map projection and preserves it when exporting WGS84", () => {
    const format = new GeoJSON();
    const original: Geometry = {
      type: "LineString",
      coordinates: [
        [100, 30, 10],
        [102, 30, 30],
      ],
    };
    const geometry = format.readGeometry(original, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857",
    });
    const before = format.writeGeometryObject(geometry);
    if (before.type !== "LineString") throw new Error("geometry changed");
    const after = structuredClone(before);
    after.coordinates.splice(1, 0, [...fromLonLat([101, 30]), 0]);
    const repaired = preserveInsertedDimensions(
      before,
      after,
      fromLonLat([101, 30]),
    );
    const exported = format.writeGeometryObject(format.readGeometry(repaired), {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857",
    });
    if (exported.type !== "LineString") throw new Error("geometry changed");
    expect(exported.coordinates[1][0]).toBeCloseTo(101);
    expect(exported.coordinates[1][1]).toBeCloseTo(30);
    expect(exported.coordinates[1][2]).toBeCloseTo(20);
    expect(exported.coordinates[0][2]).toBe(10);
    expect(exported.coordinates[2][2]).toBe(30);
  });

  it("shows all multi-part and hole vertices without duplicate closing handles", () => {
    const geometry: Geometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0, 10],
            [4, 0, 20],
            [4, 4, 30],
            [0, 0, 10],
          ],
          [
            [1, 1, 40],
            [2, 1, 50],
            [2, 2, 60],
            [1, 1, 40],
          ],
        ],
        [
          [
            [10, 10, 70],
            [14, 10, 80],
            [14, 14, 90],
            [10, 10, 70],
          ],
        ],
      ],
    };
    expect(geometryVertices(geometry)).toHaveLength(9);
    expect(geometryVertices(geometry)).toContainEqual([1, 1, 40]);
    expect(geometryVertices(geometry)).toContainEqual([10, 10, 70]);
  });

  it("interpolates Z/M for an inserted vertex from its original insertion point even after dragging", () => {
    const before: Geometry = {
      type: "LineString",
      coordinates: [
        [0, 0, 10, 100],
        [10, 0, 30, 200],
      ],
    };
    const after: Geometry = {
      type: "LineString",
      coordinates: [
        [0, 0, 10, 100],
        [7, 9, 0, 0],
        [10, 0, 30, 200],
      ],
    };
    expect(preserveInsertedDimensions(before, after, [5, 0])).toEqual({
      ...after,
      coordinates: [
        [0, 0, 10, 100],
        [7, 9, 20, 150],
        [10, 0, 30, 200],
      ],
    });
    expect(before.coordinates).toEqual([
      [0, 0, 10, 100],
      [10, 0, 30, 200],
    ]);
  });

  it("preserves MultiPolygon structure and repairs only the edited hole", () => {
    const before: Geometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0, 1],
            [8, 0, 2],
            [8, 8, 3],
            [0, 0, 1],
          ],
          [
            [1, 1, 10],
            [3, 1, 30],
            [3, 3, 40],
            [1, 1, 10],
          ],
        ],
        [
          [
            [10, 10, 50],
            [20, 10, 60],
            [20, 20, 70],
            [10, 10, 50],
          ],
        ],
      ],
    };
    const after = structuredClone(before);
    after.coordinates[0][1].splice(1, 0, [2, 1, 0]);
    const result = preserveInsertedDimensions(before, after);
    expect(result.type).toBe("MultiPolygon");
    if (result.type !== "MultiPolygon") throw new Error("geometry changed");
    expect(result.coordinates[0][1][1]).toEqual([2, 1, 20]);
    expect(result.coordinates[1]).toEqual(before.coordinates[1]);
    expect(result.coordinates[0][0]).toEqual(before.coordinates[0][0]);
  });

  it("does not rewrite moved or removed original vertices or fabricate Z on XY data", () => {
    const before: Geometry = {
      type: "LineString",
      coordinates: [
        [0, 0, 10],
        [5, 0, 20],
        [10, 0, 30],
      ],
    };
    const moved: Geometry = {
      type: "LineString",
      coordinates: [
        [0, 0, 10],
        [5, 8, 20],
        [10, 0, 30],
      ],
    };
    const removed: Geometry = {
      type: "LineString",
      coordinates: [
        [0, 0, 10],
        [10, 0, 30],
      ],
    };
    expect(preserveInsertedDimensions(before, moved)).toEqual(moved);
    expect(preserveInsertedDimensions(before, removed)).toEqual(removed);
    const xyBefore: Geometry = {
      type: "LineString",
      coordinates: [
        [0, 0],
        [10, 0],
      ],
    };
    const xyAfter: Geometry = {
      type: "LineString",
      coordinates: [
        [0, 0],
        [5, 0],
        [10, 0],
      ],
    };
    expect(preserveInsertedDimensions(xyBefore, xyAfter)).toEqual(xyAfter);
  });

  it("requires fixed nodes before keyboard completion", () => {
    expect(canFinishDraft(null)).toBe(false);
    expect(canFinishDraft({ type: "LineString", coordinates: [[0, 0]] })).toBe(
      false,
    );
    expect(
      canFinishDraft({
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe(true);
    expect(
      canFinishDraft({
        type: "Polygon",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe(false);
    expect(
      canFinishDraft({
        type: "Polygon",
        coordinates: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      }),
    ).toBe(true);
  });
});
