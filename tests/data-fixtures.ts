import { expect, type Page } from "@playwright/test";

export const CITY_TEST_FILENAME = "城市.geojson";

const cities = [
  { name: "北京", coordinates: [116.4074, 39.9042] },
  { name: "上海", coordinates: [121.4737, 31.2304] },
  { name: "广州", coordinates: [113.2644, 23.1291] },
  { name: "成都", coordinates: [104.0665, 30.5723] },
];

export async function importCityFixture(page: Page) {
  await page.locator("input[type=file]").setInputFiles({
    name: CITY_TEST_FILENAME,
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "FeatureCollection",
        features: cities.map((city, index) => ({
          type: "Feature",
          id: `city-${index + 1}`,
          geometry: { type: "Point", coordinates: city.coordinates },
          properties: { 城市: city.name, 资料: "测试城市坐标" },
        })),
      }),
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(
    page.locator(".layer-text").filter({ hasText: CITY_TEST_FILENAME }),
  ).toBeVisible();
}
