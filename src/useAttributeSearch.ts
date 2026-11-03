import { useEffect, useMemo, useState } from "react";
import { searchFeatures, searchFeaturesCooperatively } from "./attributeSearch";
import type { GeoFeature } from "./domain/types";

const empty: GeoFeature[] = [];
export function useAttributeSearch(features: GeoFeature[] = empty, query: string) {
  const deferred = features.length > 2000 && Boolean(query);
  const immediate = useMemo(() => deferred ? empty : searchFeatures(features, query), [features, query, deferred]);
  const [result, setResult] = useState<{ input: GeoFeature[]; query: string; features: GeoFeature[] }>();
  useEffect(() => {
    if (!deferred) return;
    const controller = new AbortController();
    void searchFeaturesCooperatively(features, query, controller.signal).then(found => {
      if (found && !controller.signal.aborted) setResult({ input: features, query, features: found });
    });
    return () => controller.abort();
  }, [features, query, deferred]);
  const current = result?.input === features && result.query === query;
  return {
    filtered: deferred ? current ? result.features : empty : immediate,
    searching: deferred && !current,
  };
}
