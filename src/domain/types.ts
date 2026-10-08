import type { Geometry } from "geojson";
export interface GeoFeature {
  id: string;
  geometry: Geometry | null;
  properties: Record<string, unknown>;
  sourceFeatureId?: string | number;
  dbKey?: unknown;
  baseline?: unknown;
}
export interface ImportOptions {
  geometryMode?: "wkt" | "xy";
  wktColumn?: string;
  xColumn?: string;
  yColumn?: string;
  crs?: string;
  encoding?: string;
  geoJsonXYCopy?: boolean;
}
export interface SchemaChange {
  kind: "add" | "rename" | "delete";
  name: string;
  newName?: string;
}
export interface DocumentLayer {
  schemaChanges?: SchemaChange[];
  id: string;
  name: string;
  // name 保留来源/保存文件名，displayName 仅用于工作区显示。
  displayName?: string;
  features: GeoFeature[];
  geometryType?: "Point" | "LineString" | "Polygon";
  fieldNames?: string[];
  visible: boolean;
  color: string;
  opacity?: number;
  strokeWidth?: number;
  restored?: boolean;
  restoredFrom?: string;
  sourceKind: "geojson" | "csv" | "shp" | "postgis" | "mysql";
  sourceId?: string;
  crs: string;
  originalCrs?: string;
  dirty: boolean;
  csvConfig?: ImportOptions;
  db?: {
    engine?: "postgis" | "mysql";
    connectionId: string;
    schema: string;
    table: string;
    geometryColumn: string;
    geometryKind: "geometry" | "wkt";
    srid: number;
    keyColumns: string[];
    columns: {
      name: string;
      type: string;
      nullable: boolean;
      generated?: boolean;
      hasDefault?: boolean;
    }[];
  };
  warnings?: string[];
}
export interface InputFile {
  name: string;
  bytes: number[] | Uint8Array;
  sourceId?: string;
}
