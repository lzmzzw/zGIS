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
}
export interface DocumentLayer {
  id: string;
  name: string;
  features: GeoFeature[];
  visible: boolean;
  color: string;
  sourceKind: "geojson" | "csv" | "shp" | "postgis";
  sourceId?: string;
  crs: string;
  originalCrs?: string;
  dirty: boolean;
  csvConfig?: ImportOptions;
  db?: {
    connectionId: string;
    schema: string;
    table: string;
    geometryColumn: string;
    geometryKind: "geometry" | "wkt";
    srid: number;
    keyColumns: string[];
    columns: { name: string; type: string; nullable: boolean }[];
  };
  warnings?: string[];
}
export interface InputFile {
  name: string;
  bytes: number[];
  sourceId?: string;
}
