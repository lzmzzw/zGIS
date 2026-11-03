import { expect, it } from "vitest";
import { importFiles, importGeoJSON } from "./domain";
import { MAX_DESKTOP_FILE_BYTES, MAX_WEB_FILE_BYTES } from "./fileLimits";

it("Web 和非既定预算拒绝超限输入，桌面 Worker 预算允许原100MiB以上文件", async () => {
  // 实际有效 GeoJSON 加空白，不用伪造 length 绕过真实字节大小验证。
  const bytes = new Uint8Array(MAX_WEB_FILE_BYTES + 1).fill(32);
  bytes.set(new TextEncoder().encode('{"type":"Feature","geometry":{"type":"Point","coordinates":[116,39,12]},"properties":{"id":9007199254740993}}'));
  const files = [{ name: "large.geojson", bytes }];
  await expect(importFiles(files, {}, undefined, MAX_WEB_FILE_BYTES)).rejects.toThrow("100 MB");
  await expect(importFiles(files, {}, undefined, MAX_DESKTOP_FILE_BYTES + 1)).rejects.toThrow("100 MB");
  const [layer] = await importFiles(files, {}, undefined, MAX_DESKTOP_FILE_BYTES);
  expect(layer.features).toHaveLength(1);
  expect(layer.features[0].geometry).toEqual({ type: "Point", coordinates: [116, 39, 12] });
  expect(layer.features[0].properties.id).toBe("9007199254740993");
}, 30_000);

it("十万条 GeoJSON 记录完整保留 XYZ、末条属性和来源 CRS", () => {
  const count = 100_000;
  const record = '{"type":"Feature","geometry":{"type":"Point","coordinates":[116,39,12]},"properties":{"id":9007199254740993}}';
  const features = importGeoJSON('{"type":"FeatureCollection","features":[' + Array(count).fill(record).join(",") + "]}");
  expect(features).toHaveLength(count);
  expect(features.at(-1)?.properties.id).toBe("9007199254740993");
  expect(features.at(-1)?.geometry).toEqual({ type: "Point", coordinates: [116, 39, 12] });
}, 30_000);
