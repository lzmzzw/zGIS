export interface BasemapService {
  id: string;
  name: string;
  type: string;
  preview: "street" | "vector" | "imagery";
  url?: string;
  attribution?: string;
  enabled?: boolean;
  maxZoom?: number;
  previewImage?: string;
}

export const defaultBasemaps: BasemapService[] = [
  {
    id: "osm",
    name: "OpenStreetMap",
    type: "道路与地名",
    preview: "street",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    enabled: true,
    maxZoom: 19,
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

export function availableBasemaps(
  services: BasemapService[],
): BasemapService[] {
  return services.filter((service) => service.enabled !== false);
}

export function selectBasemap(
  services: BasemapService[],
  selected: string,
): string {
  const available = availableBasemaps(services);
  return available.some((service) => service.id === selected)
    ? selected
    : (available[0]?.id ?? "none");
}

export function loadBasemapPreferences(raw: string): {
  services: BasemapService[];
  selected: string;
  visible: boolean;
} {
  const value = JSON.parse(raw);
  if (!value || !Array.isArray(value.services)) throw new Error("底图配置无效");
  const services: BasemapService[] = [];
  const ids = new Set<string>();
  for (const item of value.services) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      ids.has(item.id)
    )
      throw new Error("底图配置无效");
    ids.add(item.id);
    // 移除旧版预置天地图；用户配置的 XYZ 服务按原顺序保留。
    if ((item.id === "tdt-vec" || item.id === "tdt-img") && !item.url) continue;
    const url =
      item.url ?? (item.id === "osm" ? defaultBasemaps[0].url : undefined);
    if (typeof url !== "string" || !validateXyzUrl(url))
      throw new Error("底图配置无效");
    if (item.enabled !== undefined && typeof item.enabled !== "boolean")
      throw new Error("底图配置无效");
    if (
      item.maxZoom !== undefined &&
      (!Number.isInteger(item.maxZoom) || item.maxZoom < 0 || item.maxZoom > 42)
    )
      throw new Error("底图配置无效");
    services.push({
      id: item.id,
      name: item.name,
      url,
      type: typeof item.type === "string" ? item.type : "XYZ 瓦片服务",
      preview: ["street", "vector", "imagery"].includes(item.preview)
        ? item.preview
        : "street",
      attribution: typeof item.attribution === "string" ? item.attribution : "",
      enabled: item.enabled !== false,
      ...(typeof item.previewImage === "string" &&
      item.previewImage.length <= 128 * 1024 &&
      /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(item.previewImage)
        ? { previewImage: item.previewImage }
        : {}),
      ...(item.maxZoom !== undefined
        ? { maxZoom: item.maxZoom }
        : item.id === "osm" && url === defaultBasemaps[0].url
          ? { maxZoom: 19 }
          : {}),
    });
  }
  return {
    services,
    selected: selectBasemap(services, value.selected),
    visible: value.visible !== false,
  };
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

export function serializeBasemapPreferences(
  services: BasemapService[],
  selected: string,
  visible: boolean,
): string {
  const cached = services.map((service) => ({ ...service }));
  const serialize = () =>
    JSON.stringify({ services: cached, selected, visible, version: 2 });
  let content = serialize();
  // 图片可重新获取；配置容量不足时优先保留服务信息和当前底图的预览。
  const discardOrder = [
    ...cached.filter((service) => service.id !== selected),
    ...cached.filter((service) => service.id === selected),
  ];
  for (const service of discardOrder) {
    if (new TextEncoder().encode(content).byteLength <= 1024 * 1024) break;
    if (!service.previewImage) continue;
    delete service.previewImage;
    content = serialize();
  }
  return content;
}
