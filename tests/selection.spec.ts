import { test, expect, type Page } from "@playwright/test";

async function importPolygons(page: Page, count: number) {
  await page.goto("/");
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await page.getByLabel("显示底图", { exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await page.locator("input[type=file]").setInputFiles({
    name: "selection.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "FeatureCollection",
      features: Array.from({ length: count }, (_, index) => {
        const x = 116 + index * .02;
        return {
          type: "Feature",
          properties: { name: `record-${index + 1}` },
          geometry: {
            type: "Polygon",
            coordinates: [[[x, 39], [x + .02, 39], [x + .02, 39.02], [x, 39.02], [x, 39]]],
          },
        };
      }),
    })),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.locator(".layer-text")).toContainText("selection.geojson");
  await page.locator(".attribute-panel").getByRole("button", { name: "展开属性表", exact: true }).click();
}

test("map selection locates its record across pages without filtering the attribute table", async ({ page }) => {
  await importPolygons(page, 232);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.locator("tbody tr").filter({ has: page.getByRole("cell", { name: "record-220", exact: true }) }).dblclick();
  // Fit the chosen geometry through the public table interaction, then navigate
  // away so the map click must locate the record rather than reuse the page.
  await page.waitForTimeout(350);
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await page.getByLabel("搜索属性", { exact: true }).fill("record-1");
  const map = await page.locator(".map-surface").boundingBox();
  await page.mouse.click(map!.x + map!.width / 2, map!.y + 25);
  await page.mouse.click(map!.x + map!.width / 2, map!.y + map!.height / 2);
  await expect(page.getByLabel("搜索属性", { exact: true })).toHaveValue("");
  await expect(page.locator(".pagination")).toContainText("3 / 3");
  await expect(page.locator("tbody tr")).toHaveCount(32);
  const selected = page.locator("tbody tr.selected");
  await expect(selected).toContainText("record-220");
  await expect.poll(() => selected.evaluate(row => {
    const bounds = row.getBoundingClientRect();
    const viewport = row.closest(".table-scroll")!.getBoundingClientRect();
    const container = row.closest(".table-scroll")!;
    const header = container.querySelector("thead")!.getBoundingClientRect().height;
    const center = viewport.top + container.clientTop + (container.clientHeight + header) / 2;
    return Math.abs(bounds.top + bounds.height / 2 - center) < 2;
  })).toBe(true);
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await expect(page.locator("tbody tr").first()).toContainText("record-1");
  await page.getByRole("button", { name: "收起属性表", exact: true }).click();
  const collapsedMap = await page.locator(".map-surface").boundingBox();
  await page.mouse.click(collapsedMap!.x + collapsedMap!.width / 2, collapsedMap!.y + 25);
  await page.mouse.click(collapsedMap!.x + collapsedMap!.width / 2, collapsedMap!.y + collapsedMap!.height / 2);
  await expect(page.locator(".attribute-panel")).toBeVisible();
  await expect(page.locator("tbody tr.selected")).toContainText("record-220");
});

test("selected polygon outlines remain above adjacent shared edges and deselection removes the overlay", async ({ page }) => {
  await importPolygons(page, 2);
  await page.locator("tbody tr").first().dblclick();
  await page.waitForTimeout(350);
  const readOutline = async () => {
    const png = await page.locator(".map-surface").screenshot();
    return page.evaluate(async data => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const points: [number, number][] = [];
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (x < 70 || x >= canvas.width - 70 || y < 50 || y >= canvas.height - 40) continue;
        const i = (y * canvas.width + x) * 4;
        // Accept antialiasing for both supported themes, but exclude translucent fill.
        if ((pixels[i] > 100 && pixels[i] < 135 && pixels[i + 1] > 150 && pixels[i + 1] < 185 && pixels[i + 2] > 235) ||
            (pixels[i] > 45 && pixels[i] < 80 && pixels[i + 1] > 100 && pixels[i + 1] < 130 && pixels[i + 2] > 195 && pixels[i + 2] < 230)) points.push([x, y]);
      }
      if (!points.length) return { count: 0, sharedEdgePixels: 0 };
      const right = Math.max(...points.map(p => p[0]));
      const top = Math.min(...points.map(p => p[1]));
      const bottom = Math.max(...points.map(p => p[1]));
      return {
        count: points.length,
        sharedEdgePixels: points.filter(([x, y]) => x >= right - 3 && y > top + (bottom - top) * .25 && y < top + (bottom - top) * .75).length,
      };
    }, "data:image/png;base64," + png.toString("base64"));
  };
  await expect.poll(async () => (await readOutline()).sharedEdgePixels).toBeGreaterThan(100);
  const map = await page.locator(".map-surface").boundingBox();
  await page.mouse.click(map!.x + map!.width / 2, map!.y + 25);
  await expect(page.locator("tbody tr.selected")).toHaveCount(0);
  await expect.poll(async () => (await readOutline()).count).toBe(0);
});


test("maximized table has natural scroll boundaries and right-side state controls", async ({
  page,
}) => {
  await importPolygons(page, 232);
  const view = page.locator(".table-scroll");
  const controls = page.getByRole("group", { name: "属性表显示控制" });
  const maximize = controls.getByRole("button", {
    name: "最大化属性表",
    exact: true,
  });
  const collapse = controls.getByRole("button", {
    name: "收起属性表",
    exact: true,
  });
  const maxBounds = await maximize.boundingBox(),
    collapseBounds = await collapse.boundingBox();
  expect(collapseBounds!.x + collapseBounds!.width).toBeLessThanOrEqual(maxBounds!.x);
  expect(Math.abs(maxBounds!.y - collapseBounds!.y)).toBeLessThan(1);
  await maximize.click();
  await page.screenshot({path:"output/smoke/table-maximized.png"});
  const restore = controls.getByRole("button", {
    name: "还原属性表",
    exact: true,
  });
  await expect(restore).toHaveAttribute("aria-pressed", "true");
  await expect(restore.locator("svg")).toHaveClass(/lucide-minimize-2/);
  await page.locator("tbody tr").first().click();
  await expect.poll(() => view.evaluate((v) => v.scrollTop)).toBe(0);
  const topGap = () =>
    page
      .locator("tbody tr")
      .first()
      .evaluate((row) => {
        const header = row
          .closest("table")!
          .querySelector("thead")!
          .getBoundingClientRect();
        return Math.abs(row.getBoundingClientRect().top - header.bottom);
      });
  await expect.poll(topGap).toBeLessThan(2);
  await view.evaluate((v) => {
    v.scrollTop = v.scrollHeight;
  });
  await page.locator("tbody tr").last().click();
  await expect
    .poll(() =>
      view.evaluate((v) =>
        Math.abs(v.scrollHeight - v.clientHeight - v.scrollTop),
      ),
    )
    .toBeLessThan(2);
  await expect
    .poll(() =>
      page
        .locator("tbody tr")
        .last()
        .evaluate((row) => {
          const v = row.closest(".table-scroll")!;
          return Math.abs(
            row.getBoundingClientRect().bottom -
              v.getBoundingClientRect().top -
              v.clientTop -
              v.clientHeight,
          );
        }),
    )
    .toBeLessThan(2);
  await view.evaluate((v) => {
    v.scrollTop = 49 * 32;
  });
  await page.locator("tbody tr").nth(49).click();
  const distance = () =>
    page.locator("tbody tr.selected").evaluate((row) => {
      const v = row.closest(".table-scroll")!,
        bounds = v.getBoundingClientRect(),
        r = row.getBoundingClientRect();
      const header = v.querySelector("thead")!.getBoundingClientRect().height;
      return Math.abs(
        r.top +
          r.height / 2 -
          bounds.top -
          v.clientTop -
          (v.clientHeight + header) / 2,
      );
    });
  await expect.poll(distance).toBeLessThan(2);
  const scrollLeft = await view.evaluate((v) => v.scrollLeft);
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect.poll(distance).toBeLessThan(2);
  expect(await view.evaluate((v) => v.scrollLeft)).toBe(scrollLeft);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(view).toBeVisible();
  await expect.poll(() => view.evaluate((v) => v.scrollTop)).toBe(0);
  await expect.poll(topGap).toBeLessThan(2);
  await restore.click();
  await expect(maximize).toHaveAttribute("aria-pressed", "false");
  await expect(maximize.locator("svg")).toHaveClass(/lucide-maximize-2/);
  await expect(page.locator(".map-container")).toBeVisible();
  await collapse.click();
  await expect(
    controls.getByRole("button", { name: "展开属性表", exact: true }),
  ).toBeVisible();
  await expect(controls.getByRole("button")).toHaveCount(1);
});
