import { importFiles, importCsv } from "../domain";
import Papa from "papaparse";
import type { ImportOptions, InputFile } from "../domain";
import { ParserPacketSender, transferParserLayers, type ParserAck } from "./parserTransfer";
interface ParserRequest {
  files: InputFile[];
  options: ImportOptions;
  perFileOptions?: ImportOptions[];
  preview?: boolean;
  sampleLimited?: boolean;
  byteLimit?: number;
}
let sender: ParserPacketSender | undefined;
let running = false;
function releaseInputs(files: InputFile[]): void {
  for (const file of files) file.bytes = new Uint8Array();
  files.length = 0;
}
self.onmessage = async (
  event: MessageEvent<ParserRequest | ParserAck>,
) => {
  if (event.data && "type" in event.data && event.data.type === "ack") {
    sender?.acknowledge(event.data.sequence);
    return;
  }
  if (running) {
    sender?.cancel(new Error("解析 Worker 不接受并发请求"));
    self.postMessage({ error: "解析 Worker 不接受并发请求" });
    return;
  }
  running = true;
  const request = event.data as ParserRequest;
  try {
    if (request.preview) {
      const { files, options } = request;
      const text = new TextDecoder(options.encoding ?? "utf-8").decode(
        files[0].bytes instanceof Uint8Array ? files[0].bytes : new Uint8Array(files[0].bytes),
      );
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: "greedy",
        dynamicTyping: false,
        preview: 5,
      });
      const fields = parsed.meta.fields ?? [];
      const find = (names: string[]) =>
        fields.find((field) => names.includes(field.toLowerCase()));
      const detected = {
        ...options,
        wktColumn: options.wktColumn || find(["wkt", "geom", "geometry"]),
        xColumn:
          options.xColumn || find(["longitude", "lon", "lng", "x", "经度"]),
        yColumn: options.yColumn || find(["latitude", "lat", "y", "纬度"]),
      };
      const geometryMode =
        options.geometryMode ?? (detected.wktColumn ? "wkt" : "xy");
      const config = { ...detected, geometryMode };
      let validationError: string | undefined;
      let geometryTypes: string[] = [];
      const invalidFields: string[] = [];
      try {
        if (Object.keys(parsed.meta.renamedHeaders ?? {}).length)
          throw new Error("CSV 包含重复列名，请先调整列名");
        const errors = parsed.errors.filter(
          (error) => error.code !== "UndetectableDelimiter",
        );
        if (errors.length)
          throw new Error(errors.map((error) => error.message).join("；"));
        if (
          geometryMode === "xy" &&
          config.xColumn &&
          config.xColumn === config.yColumn
        ) {
          invalidFields.push("xColumn", "yColumn");
          throw new Error("X 和 Y 不能使用同一列");
        }
        if (geometryMode === "xy") {
          for (const key of ["xColumn", "yColumn"] as const) {
            const field = config[key];
            if (
              !field ||
              !fields.includes(field) ||
              parsed.data.some(
                (row) =>
                  row[field]?.trim() && !Number.isFinite(Number(row[field])),
              )
            )
              invalidFields.push(key);
          }
        } else if (!config.wktColumn || !fields.includes(config.wktColumn))
          invalidFields.push("wktColumn");
        if (invalidFields.length)
          throw new Error("请选择有效的几何列，坐标列必须包含数值");
        const sample = importCsv(
          Papa.unparse({
            fields,
            data: parsed.data.map((row) =>
              fields.map((field) => row[field] ?? ""),
            ),
          }),
          config,
        );
        geometryTypes = [
          ...new Set(
            sample.map((feature) => feature.geometry?.type ?? "空几何"),
          ),
        ];
      } catch (error) {
        validationError =
          error instanceof Error ? error.message : String(error);
        if (!invalidFields.length)
          invalidFields.push(
            ...(geometryMode === "wkt"
              ? ["wktColumn"]
              : ["xColumn", "yColumn"]),
          );
      }
      self.postMessage({
        preview: {
          fields,
          rows: parsed.data,
          options: config,
          geometryTypes,
          validationError,
          invalidFields,
          sampleLimited: request.sampleLimited,
        },
      });
      return;
    }
    sender = new ParserPacketSender((packet) => self.postMessage(packet));
    const layers = await importFiles(request.files, request.options, request.perFileOptions, request.byteLimit);
    releaseInputs(request.files);
    await transferParserLayers(layers, (packet) => sender!.send(packet), (packet) => self.postMessage(packet));
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    releaseInputs(request.files);
    sender?.cancel(new Error("解析任务已结束"));
    sender = undefined;
    running = false;
  }
};
