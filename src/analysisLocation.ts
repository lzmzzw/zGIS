import type { DocumentLayer, GeoFeature } from "./domain/types";

export interface AnalysisLocation {
  sourceId: string;
  sourceFeatures: GeoFeature[];
  inputIds: string[];
  stale: boolean;
}
export interface AnalysisFocus {
  layerId: string;
  featureIds: string[];
  fit: boolean;
}
export function captureAnalysisLocation(source: DocumentLayer, input: GeoFeature[]): AnalysisLocation {
  return { sourceId: source.id, sourceFeatures: source.features, inputIds: input.map(f => f.id), stale: false };
}
/** Once observed stale, undo cannot make an old report valid again. */
export function refreshAnalysisLocation(snapshot: AnalysisLocation, layers: DocumentLayer[]): boolean {
  const source = layers.find(layer => layer.id === snapshot.sourceId);
  snapshot.stale ||= !source || source.features !== snapshot.sourceFeatures;
  return !snapshot.stale;
}
export function locateAnalysisIssue(snapshot: AnalysisLocation, layers: DocumentLayer[], issue: Record<string, unknown>): AnalysisFocus | undefined {
  if (!refreshAnalysisLocation(snapshot, layers)) return;
  const indices = Array.isArray(issue.featureIndices) ? issue.featureIndices : [issue.featureIndex];
  if (!indices.length || indices.some(i => !Number.isSafeInteger(i) || (i as number) < 0 || (i as number) >= snapshot.inputIds.length)) return;
  const featureIds = [...new Set(indices.map(i => snapshot.inputIds[i as number]))];
  if (featureIds.some(id => snapshot.sourceFeatures.filter(f => f.id === id).length !== 1)) return;
  return { layerId: snapshot.sourceId, featureIds, fit: issue.kind !== "invalid_geometry" };
}
