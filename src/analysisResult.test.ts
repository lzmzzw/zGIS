import { describe, expect, it } from "vitest";
import { analysisLayerNotes, explainAnalysisResult } from "./analysisResult";
import { translate } from "./i18n";

const context = {
  operation: "buffer",
  inputCount: 3,
  selectedOnly: false,
  parameters: { distanceMeters: 12 },
};
describe("analysis result explanations", () => {
  it("translates persisted model notes after switching languages", () => {
    expect(translate("计算模型：局部等距圆柱近似", "en")).toBe(
      "Calculation model: Local equirectangular approximation",
    );
    expect(translate("距离单位：米", "en")).toBe("Distance unit: metres");
  });
  it("preserves approximation and units when converting a result to a layer", () => {
    const explanation = explainAnalysisResult(
      {
        type: "FeatureCollection",
        features: [],
        analysis: {
          distanceModel: "local_equirectangular_approximation",
          units: "meters",
          geodesic: false,
        },
      },
      context,
    );
    expect(explanation.details).toContainEqual({
      label: "输出要素",
      value: "0",
    });
    expect(explanation.details).toContainEqual({
      label: "缓冲距离（米）",
      value: "12",
    });
    expect(analysisLayerNotes(explanation)).toContain(
      "计算模型：局部等距圆柱近似",
    );
    expect(explanation.warnings).toHaveLength(1);
  });
  it("does not invent precision, models or completeness for legacy output", () => {
    const explanation = explainAnalysisResult(
      { type: "FeatureCollection", features: [{}] },
      context,
    );
    expect(explanation.details.some(({ label }) => label === "计算模型")).toBe(
      false,
    );
    expect(explanation.warnings).toEqual([]);
  });
  it("keeps only applicable parameters and excludes source identities", () => {
    const explanation = explainAnalysisResult(
      {},
      {
        ...context,
        operation: "nearest",
        targetCount: 8,
        selectedOnly: true,
        parameters: {
          distanceMeters: 12,
          sourcePath: "private",
          database: "private",
        },
      },
    );
    expect(explanation.details).toContainEqual({
      label: "目标要素",
      value: "8",
    });
    expect(JSON.stringify(explanation)).not.toContain("private");
    expect(
      explanation.details.some(({ label }) => label === "缓冲距离（米）"),
    ).toBe(false);
  });
  it("distinguishes ellipsoidal distances from mixed geometry approximation", () => {
    const exact = explainAnalysisResult(
      {
        analysis: {
          distanceModel: "WGS84_ellipsoidal_geodesic",
          units: "meters",
        },
      },
      context,
    );
    expect(exact.warnings).toEqual([]);
    const mixed = explainAnalysisResult(
      {
        analysis: {
          distanceModel: "point_geodesic_other_pair_local_approximation",
        },
      },
      context,
    );
    expect(mixed.warnings).toHaveLength(1);
  });
  it("retains repair truncation and count without exposing feature data", () => {
    const explanation = explainAnalysisResult(
      {
        analysis: {
          removedCount: 101,
          removedTruncated: true,
          removed: [{ secret: "private" }],
        },
      },
      context,
    );
    expect(analysisLayerNotes(explanation)).toContain("移除要素：101");
    expect(explanation.warnings).toHaveLength(1);
    expect(JSON.stringify(explanation)).not.toContain("private");
  });
  it("reports topology model and limited check scope without claiming full validity", () => {
    const explanation = explainAnalysisResult(
      {
        relationModel: "WGS84 planar",
        checks: ["geometry_validity"],
        issues: [],
        valid: true,
      },
      { ...context, operation: "topology_check" },
    );
    expect(explanation.details).toContainEqual({
      label: "计算模型",
      value: "WGS84 经纬度平面关系",
      translate: true,
    });
    expect(explanation.warnings).toHaveLength(1);
  });
});
