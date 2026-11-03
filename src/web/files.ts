import {
  exportCsv,
  exportGeoJSON,
  type GeoFeature,
  type InputFile,
} from "../domain";
import { MAX_WEB_FILE_BYTES } from "../fileLimits";

export const MAX_IMPORT_BYTES = MAX_WEB_FILE_BYTES;
export async function readBrowserFiles(files: File[]): Promise<InputFile[]> {
  if (!files.length) throw new Error("请选择空间文件");
  if (files.some((file) => !/\.(geojson|json|csv|zip)$/i.test(file.name)))
    throw new Error(
      "支持 GeoJSON、CSV 和 Shapefile ZIP；SHP 文件组请打包为 ZIP。",
    );
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BYTES)
    throw new Error("单次导入文件总大小不能超过 100 MB。");
  const inputs: InputFile[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // File 的元数据可能过时；在实际读取后再次检查，避免越界字节进入 Worker。
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > file.size || totalBytes > MAX_IMPORT_BYTES)
      throw new Error("单次导入文件总大小不能超过 100 MB。");
    inputs.push({
      name: file.name,
      bytes,
    });
  }
  return inputs;
}

export function downloadFile(
  name: string,
  content: string | Uint8Array,
  mime: string,
): void {
  const bytes = typeof content === "string" ? content : new Uint8Array(content);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, "_");
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function textExport(
  features: GeoFeature[],
  mode: "geojson" | "wkt" | "xy",
  crs: string,
): string {
  if (mode === "geojson") return exportGeoJSON(features, crs);
  // 输出几何列不能覆盖同名业务属性。
  const fields = new Set(
    features.flatMap((feature) => Object.keys(feature.properties)),
  );
  const unique = (name: string) => {
    let candidate = name;
    for (let index = 2; fields.has(candidate); index++)
      candidate = `${name}_${index}`;
    fields.add(candidate);
    return candidate;
  };
  return exportCsv(
    features,
    mode === "wkt"
      ? { mode, crs, wktColumn: unique("wkt") }
      : {
          mode,
          crs,
          xColumn: unique("longitude"),
          yColumn: unique("latitude"),
        },
  );
}
