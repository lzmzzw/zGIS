// 与 spatial-wasm 导出保持一致；桌面类型检查无需生成 JS/WASM。
export function analyze(operation: string, parameters: string, source: string, target?: string | null): string;
export function export_shapefile(features: string, stem: string, crs: string): Uint8Array;
export default function init(options: { module_or_path: string | URL | Request }): Promise<unknown>;
