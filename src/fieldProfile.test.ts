import { describe, expect, it } from "vitest";
import type { GeoFeature } from "./domain/types";
import {
  FIELD_PROFILE_LIMITS,
  profileField,
  profileFields,
} from "./fieldProfile";

const feature = (properties: Record<string, unknown>): GeoFeature => ({
  id: "f",
  geometry: null,
  properties,
});
const numeric = (values: number[]) =>
  values.map((value) => feature({ x: value }));
function complete(features: GeoFeature[]) {
  const result = profileField(features, "x");
  if (result.status !== "complete") throw new Error(result.reason);
  return result;
}
describe("field profile", () => {
  it("profiles all loaded records, with separate missing and null counts", () => {
    const source = [
      feature({ x: 2 }),
      feature({ x: 4 }),
      feature({ x: null }),
      feature({}),
    ];
    const before = structuredClone(source);
    const result = complete(source);
    expect(result.totalCount).toBe(4);
    expect([result.validCount, result.nullCount, result.missingCount]).toEqual([
      2, 1, 1,
    ]);
    expect(result.types.number).toBe(2);
    expect(result.numeric).toMatchObject({
      min: 2,
      max: 4,
      mean: 3,
      median: 3,
    });
    expect(
      result.numeric?.histogram.reduce((sum, bin) => sum + bin.count, 0),
    ).toBe(2);
    expect(source).toEqual(before);
  });
  it("does not turn numeric text, booleans, or mixed fields into numeric statistics", () => {
    const result = complete([
      feature({ x: 1 }),
      feature({ x: "1" }),
      feature({ x: true }),
      feature({ x: [] }),
      feature({ x: {} }),
      feature({ x: "" }),
      feature({ x: undefined }),
    ]);
    expect(result.validCount).toBe(7);
    expect(result.numeric).toBeUndefined();
    expect(result.types).toEqual({
      number: 1,
      string: 2,
      boolean: 1,
      array: 1,
      object: 1,
      other: 1,
    });
    expect(result.distinctScalarCount).toBe(4);
    expect(result.commonValues).toContainEqual({
      type: "number",
      value: 1,
      count: 1,
    });
    expect(result.commonValues).toContainEqual({
      type: "string",
      value: "1",
      count: 1,
    });
    expect(
      complete([feature({ x: "9007199254740993" })]).numeric,
    ).toBeUndefined();
  });
  it("rejects unsafe or nonfinite numeric statistics without hiding their records", () => {
    const result = complete(
      numeric([1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]),
    );
    expect(result.validCount).toBe(4);
    expect(result.types.number).toBe(4);
    expect(result.unsafeNumberCount).toBe(3);
    expect(result.numeric).toBeUndefined();
  });
  it("handles empty layers and entirely missing or null fields", () => {
    expect(complete([])).toMatchObject({
      totalCount: 0,
      validCount: 0,
      commonValues: [],
    });
    expect(complete([feature({}), feature({ x: null })])).toMatchObject({
      missingCount: 1,
      nullCount: 1,
    });
    expect(profileFields({ features: [], fieldNames: ["x"] })).toEqual({
      status: "complete",
      fields: ["x"],
    });
    expect(profileFields({ features: [], fieldNames: [] })).toEqual({
      status: "complete",
      fields: [],
    });
  });
  it("keeps histogram totals and boundaries correct for constants and tiny ranges", () => {
    for (const values of [
      [3, 3, 3],
      [0, 1, 2, 10],
      [1, 1 + Number.EPSILON],
      [0, Number.MIN_VALUE],
      [Number.MIN_VALUE, Number.MIN_VALUE],
    ]) {
      const result = complete(numeric(values)).numeric!;
      expect(result.histogram.reduce((sum, bin) => sum + bin.count, 0)).toBe(
        values.length,
      );
      expect(Number.isFinite(result.mean)).toBe(true);
      expect(result.mean).toBeGreaterThanOrEqual(result.min);
      expect(result.mean).toBeLessThanOrEqual(result.max);
      expect(result.median).toBeGreaterThanOrEqual(result.min);
      expect(result.median).toBeLessThanOrEqual(result.max);
      if (result.min !== result.max)
        for (const bin of result.histogram)
          expect(bin.max).toBeGreaterThan(bin.min);
      for (const bin of result.histogram) {
        const last = bin === result.histogram[result.histogram.length - 1];
        expect(bin.count).toBe(
          values.filter(
            (value) =>
              value >= bin.min && (last ? value <= bin.max : value < bin.max),
          ).length,
        );
      }
    }
  });
  it("computes stable approximate means without overflowing safe input values", () => {
    expect(
      complete(numeric([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]))
        .numeric?.mean,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      complete(numeric([-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]))
        .numeric?.mean,
    ).toBe(0);
    expect(complete(numeric([1e15, 1, -1e15])).numeric?.mean).toBeCloseTo(
      1 / 3,
      12,
    );
    expect(complete(numeric([9, 1, 3])).numeric?.median).toBe(3);
  });
  it("returns exact common-value frequencies with a bounded display list", () => {
    const source = Array.from({ length: 20 }, (_, index) =>
      feature({ x: String(index) }),
    );
    source.push(
      feature({ x: "热门" }),
      feature({ x: "热门" }),
      feature({ x: "热门" }),
    );
    const result = complete(source);
    expect(result.distinctScalarCount).toBe(21);
    expect(result.commonValues).toHaveLength(8);
    expect(result.commonValues[0]).toEqual({
      type: "string",
      value: "热门",
      count: 3,
    });
  });
  it("blocks oversized fields and layers rather than returning partial statistics", () => {
    expect(
      profileField(
        Array.from({ length: 10_001 }, () => feature({ x: 1 })),
        "x",
      ).status,
    ).toBe("blocked");
    expect(
      profileField(
        [feature({ x: "x".repeat(FIELD_PROFILE_LIMITS.valueLength + 1) })],
        "x",
      ).status,
    ).toBe("blocked");
    expect(
      profileField(
        Array.from({ length: 1100 }, () => feature({ x: "x".repeat(4096) })),
        "x",
      ).status,
    ).toBe("blocked");
    expect(profileField([feature({ x: 1 })], "").status).toBe("blocked");
    expect(profileField([feature({ x: 1 })], "x".repeat(513)).status).toBe(
      "blocked",
    );
  });
  it("discovers fields without sampling and rejects excessive discovery work", () => {
    expect(
      profileFields({
        fieldNames: ["declared"],
        features: [feature({ x: 1 }), feature({ later: 2, x: 3 })],
      }),
    ).toEqual({ status: "complete", fields: ["declared", "x", "later"] });
    expect(
      profileFields({
        features: [],
        fieldNames: Array.from({ length: 513 }, (_, i) => `f${i}`),
      }).status,
    ).toBe("blocked");
    const wide = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`x${i}`, i]),
    );
    expect(
      profileFields({
        features: Array.from({ length: 10_000 }, () => feature(wide)),
      }).status,
    ).toBe("blocked");
    expect(
      profileFields({
        features: Array.from({ length: 10_001 }, () => feature({})),
      }).status,
    ).toBe("blocked");
  });
  it("treats property names as data and never inspects nested values", () => {
    const properties = JSON.parse('{"__proto__":2,"constructor":3}') as Record<
      string,
      unknown
    >;
    const result = profileField([feature(properties)], "__proto__");
    expect(result.status === "complete" && result.numeric?.mean).toBe(2);
    expect(
      complete([
        feature({
          x: {
            get toJSON() {
              throw new Error("must not serialize");
            },
          },
        }),
      ]).types.object,
    ).toBe(1);
  });
});
