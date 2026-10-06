export interface BasemapService {
  id: string;
  name: string;
  type: string;
  preview: "street" | "vector" | "imagery";
  url?: string;
  attribution?: string;
}

export const defaultBasemaps: BasemapService[] = [
  {
    id: "osm",
    name: "OpenStreetMap",
    type: "道路与地名",
    preview: "street",
    attribution: "© OpenStreetMap contributors",
  },
  {
    id: "tdt-vec",
    name: "天地图 · 矢量",
    type: "矢量地图",
    preview: "vector",
    attribution: "© 天地图",
  },
  {
    id: "tdt-img",
    name: "天地图 · 影像",
    type: "卫星影像",
    preview: "imagery",
    attribution: "© 天地图",
  },
];

export function validateXyzUrl(value: string): boolean {
  if (!["{x}", "{y}", "{z}"].every((token) => value.includes(token)))
    return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function isTdtService(service: BasemapService): boolean {
  return service.id === "tdt-vec" || service.id === "tdt-img";
}

export function moveBasemap(
  services: BasemapService[],
  id: string,
  direction: -1 | 1,
): BasemapService[] {
  const index = services.findIndex((service) => service.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= services.length) return services;
  const result = [...services];
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}
