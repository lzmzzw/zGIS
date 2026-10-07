import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
import type { BasemapService } from "../src/basemaps";

const NAME = "武汉预览";
const URL = "https://preview.example.com/{z}/{x}/{y}.png";

async function setup(page: Page) {
  await installDesktopMock(page);
  await page.route("**/tile.openstreetmap.org/**", (route) => route.abort());
  await page.route("https://*.example.com/**", (route) => route.abort());
  await page.goto("/");
  await openSettings(page);
}
async function openSettings(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "地图", exact: true })
    .click();
}
async function add(page: Page, name = NAME, url = URL) {
  await page.getByRole("button", { name: "添加底图", exact: true }).click();
  await page.getByLabel("新底图名称", { exact: true }).fill(name);
  await page.getByLabel("XYZ 瓦片地址", { exact: true }).fill(url);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加", exact: true })
    .click();
}
async function service(
  page: Page,
  name = NAME,
): Promise<BasemapService | undefined> {
  return page.evaluate((wanted) => {
    const raw = localStorage.getItem("test.basemaps");
    return raw
      ? (JSON.parse(raw).services as BasemapService[]).find(
          (item) => item.name === wanted,
        )
      : undefined;
  }, name);
}
async function tileCalls(page: Page) {
  return page.evaluate(() =>
    window.__ZG_TEST__.calls.filter(
      (call) => call.command === "fetch_basemap_tile",
    ),
  );
}

test("saving stitches Wuhan tiles into a colored 288×144 PNG and restart uses the cache", async ({
  page,
}) => {
  await setup(page);
  await add(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(async () => (await service(page))?.previewImage)
    .toMatch(/^data:image\/png;base64,/);
  const image = (await service(page))!.previewImage!;
  expect((await tileCalls(page)).map((call) => call.args.url).sort()).toEqual([
    "https://preview.example.com/11/1673/840.png",
    "https://preview.example.com/11/1673/841.png",
    "https://preview.example.com/11/1674/840.png",
    "https://preview.example.com/11/1674/841.png",
  ]);
  const pixels = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      center: [...context.getImageData(144, 72, 1, 1).data],
    };
  }, image);
  expect(pixels).toEqual({
    width: 288,
    height: 144,
    center: [84, 121, 182, 255],
  });
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  const card = page
    .locator(".basemap-card")
    .filter({ has: page.getByRole("radio", { name: NAME, exact: true }) });
  await expect(card.locator("img")).toHaveAttribute("src", image);
  await expect(page.locator(".basemap-card small")).toHaveCount(0);
  await expect(card.locator(".basemap-preview svg")).toHaveCount(0);
  await expect(card.locator("img")).toHaveAttribute("alt", "");
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(card.locator("img")).toHaveAttribute("src", image);
  await expect.poll(async () => (await tileCalls(page)).length).toBe(0);
});

test("failed refresh preserves a cache only when the tile URL remains unchanged", async ({
  page,
}) => {
  await setup(page);
  await add(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const original = (await service(page))!.previewImage;
  await page.evaluate(() => {
    window.__ZG_TEST__.tileError = "tile unavailable";
  });
  await page.getByRole("button", { name: `编辑 ${NAME}`, exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".basemap-preview-warning")).toContainText(
    "预览暂不可用",
  );
  await expect
    .poll(async () => (await service(page))?.previewImage)
    .toBe(original);
  await page.getByRole("button", { name: `编辑 ${NAME}`, exact: true }).click();
  const changed = "https://changed.example.com/{z}/{x}/{y}.png";
  await page.getByLabel("XYZ 瓦片地址", { exact: true }).fill(changed);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await service(page))?.url).toBe(changed);
  expect((await service(page))?.previewImage).toBeUndefined();
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  const card = page
    .locator(".basemap-card")
    .filter({ has: page.getByRole("radio", { name: NAME, exact: true }) });
  await expect(card.locator(".basemap-preview-placeholder")).toBeVisible();
});

test("preview saving disables repeated submission and Escape ignores late tile responses", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.__ZG_TEST__.tileDelay = 1000;
  });
  await add(page, "取消预览");
  const dialog = page.getByRole("dialog", { name: "添加底图", exact: true });
  await expect(
    dialog.getByRole("button", { name: "获取预览…", exact: true }),
  ).toBeDisabled();
  for (const label of [
    "新底图名称",
    "XYZ 瓦片地址",
    "底图来源说明",
    "在地图中显示",
  ])
    await expect(dialog.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeEnabled();
  await dialog
    .locator("form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await tileCalls(page)).toHaveLength(4);
  const saves = await page.evaluate(
    () =>
      window.__ZG_TEST__.calls.filter(
        (call) => call.command === "save_preferences",
      ).length,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("main", { name: "后台设置" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "添加底图", exact: true }),
  ).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.tileCompleted))
    .toBe(4);
  expect(await service(page, "取消预览")).toBeUndefined();
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (call) => call.command === "save_preferences",
        ).length,
    ),
  ).toBe(saves);
});

test("preview timeout saves the service and ignores tiles that arrive after the deadline", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.__ZG_TEST__.tileDelay = 10000;
  });
  const started = Date.now();
  await add(page, "超时预览");
  const dialog = page.getByRole("dialog", { name: "添加底图", exact: true });
  await expect(
    dialog.getByRole("button", { name: "获取预览…", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toHaveCount(0, { timeout: 9500 });
  expect(Date.now() - started).toBeLessThan(10000);
  await expect(page.locator(".basemap-preview-warning")).toContainText(
    "预览暂不可用",
  );
  await expect
    .poll(async () => (await service(page, "超时预览"))?.url)
    .toBe(URL);
  expect((await service(page, "超时预览"))?.previewImage).toBeUndefined();
  expect(await page.evaluate(() => window.__ZG_TEST__.tileCompleted)).toBe(0);
  const saves = await page.evaluate(
    () =>
      window.__ZG_TEST__.calls.filter(
        (call) => call.command === "save_preferences",
      ).length,
  );
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.tileCompleted), {
      timeout: 5000,
    })
    .toBe(4);
  expect((await service(page, "超时预览"))?.previewImage).toBeUndefined();
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (call) => call.command === "save_preferences",
        ).length,
    ),
  ).toBe(saves);
});
