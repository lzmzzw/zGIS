import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

const snapshot = JSON.stringify({
  version: 2,
  layers: [
    {
      id: "point",
      name: "points.geojson",
      geometry: {
        type: "MultiPoint",
        coordinates: [
          [116, 40],
          [116.1, 40.1],
        ],
      },
    },
    {
      id: "line",
      name: "lines.geojson",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [116, 40],
            [117, 41],
          ],
        ],
      },
    },
    {
      id: "polygon",
      name: "areas.geojson",
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [116, 40],
              [117, 40],
              [117, 41],
              [116, 40],
            ],
          ],
        ],
      },
    },
  ].map(({ id, name, geometry }) => ({
    id,
    name,
    visible: true,
    color: "#5479b6",
    sourceKind: "geojson",
    features: [{ id: `${id}-f`, geometry, properties: { name } }],
  })),
  tree: [
    {
      kind: "group",
      id: "group",
      name: "项目图层",
      visible: true,
      collapsed: false,
      children: [
        {
          kind: "group",
          id: "subgroup",
          name: "基础资料",
          visible: true,
          collapsed: false,
          children: [
            { kind: "layer", id: "point" },
            { kind: "layer", id: "line" },
            { kind: "layer", id: "polygon" },
          ],
        },
      ],
    },
  ],
});
const row = (page: Page, name: string) =>
  page
    .locator(".tree-row")
    .filter({ has: page.locator(".layer-text").filter({ hasText: name }) });
async function setup(page: Page) {
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(row(page, "areas.geojson")).toBeVisible();
}
async function rename(page: Page, name: string, next: string) {
  await row(page, name).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "设置别名", exact: true })
    .click();
  await page.getByLabel("图层别名", { exact: true }).fill(next);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确定", exact: true })
    .click();
}

test("checkboxes and nested indentation align and geometry symbols open the only style editor", async ({
  page,
}) => {
  await setup(page);
  for (const [name, kind] of [
    ["points.geojson", "point"],
    ["lines.geojson", "line"],
    ["areas.geojson", "polygon"],
  ])
    await expect(row(page, name).locator(`.layer-swatch-${kind}`)).toHaveCount(
      1,
    );
  const boxes = await Promise.all(
    [
      "项目图层",
      "基础资料",
      "points.geojson",
      "lines.geojson",
      "areas.geojson",
    ].map((name) => row(page, name).getByRole("checkbox").boundingBox()),
  );
  expect(boxes[1]!.x - boxes[0]!.x).toBe(20);
  expect(boxes[2]!.x - boxes[1]!.x).toBe(20);
  expect(boxes[2]!.x).toBe(boxes[3]!.x);
  expect(boxes[3]!.x).toBe(boxes[4]!.x);
  await row(page, "lines.geojson").getByRole("checkbox").uncheck();
  await expect(
    row(page, "lines.geojson").getByRole("checkbox"),
  ).not.toBeChecked();
  await row(page, "项目图层").getByRole("checkbox").uncheck();
  await expect(row(page, "points.geojson").getByRole("checkbox")).toBeChecked();
  await row(page, "项目图层").getByRole("checkbox").check();
  await expect(
    row(page, "lines.geojson").getByRole("checkbox"),
  ).not.toBeChecked();
  await row(page, "lines.geojson").getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "points.geojson样式", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "图层样式：points.geojson",
  );
  await page.getByLabel("points.geojson颜色", { exact: true }).fill("#ff8833");
  await page.getByRole("button", { name: "应用样式", exact: true }).click();
  await expect(row(page, "points.geojson").locator(".layer-swatch")).toHaveCSS(
    "background-color",
    "rgb(255, 136, 51)",
  );
  await page.screenshot({ path: "output/smoke/layer-tree-aligned-dark.png" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.setViewportSize({ width: 960, height: 640 });
  await page.screenshot({ path: "output/smoke/layer-tree-aligned-light.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("renaming changes display only, keeps save filenames and survives work-copy recovery", async ({
  page,
}) => {
  await setup(page);
  await rename(page, "points.geojson", "测量点");
  await expect(row(page, "测量点")).toBeVisible();
  await row(page, "测量点").locator(".layer-text").click();
  await expect(page.locator(".document-title")).toContainText("测量点");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name: "另存为", exact: true }).click();
  const save = await page.evaluate(() =>
    window.__ZG_TEST__.calls.filter((c) => c.command === "save_file").at(-1),
  );
  expect(save!.args.suggestedName).toBe("points.geojson");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name: "导出为", exact: true }).click();
  await expect(page.getByLabel("文件名", { exact: true })).toHaveValue(
    "测量点.geojson",
  );
  await expect(page.locator(".export-source-meta, .export-location")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.snapshot))
    .toContain("测量点");
  const raw = JSON.parse(
    (await page.evaluate(() => window.__ZG_TEST__.snapshot))!,
  );
  const saved = raw.layers.find(
    (l: { name: string }) => l.name === "points.geojson",
  );
  expect(saved.displayName).toBe("测量点");
  expect(saved.name).toBe("points.geojson");
  await installDesktopMock(page, JSON.stringify(raw));
  await page.reload();
  await expect(row(page, "测量点")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "测量点样式", exact: true }),
  ).toBeVisible();
});

test("rename validation and Escape preserve the original display and keyboard focus", async ({
  page,
}) => {
  await setup(page);
  const target = row(page, "points.geojson");
  await target.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "设置别名", exact: true })
    .click();
  await expect(page.getByLabel("图层别名", { exact: true })).toHaveValue(
    "points.geojson",
  );
  await page.getByLabel("图层别名", { exact: true }).fill("   ");
  await expect(
    page.getByRole("button", { name: "确定", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("图层别名", { exact: true }).fill("cancelled");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(target).toBeVisible();
  await expect(target).toBeFocused();
});

test("layer panel resizes by pointer and keyboard and remembers its width", async ({
  page,
}) => {
  await setup(page);
  const resizer = page.getByRole("separator", {
    name: "调整图层栏宽度",
    exact: true,
  });
  await expect(resizer).toHaveAttribute("aria-valuenow", "260");
  await resizer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(resizer).toHaveAttribute("aria-valuenow", "280");
  const handle = await resizer.boundingBox();
  await page.mouse.move(handle!.x + 2, handle!.y + 160);
  await page.mouse.down();
  await page.mouse.move(360, handle!.y + 160, { steps: 8 });
  await page.mouse.up();
  await expect(resizer).toHaveAttribute("aria-valuenow", "360");
  expect((await page.locator(".layers-panel").boundingBox())!.width).toBe(360);
  await page.reload();
  await expect(resizer).toHaveAttribute("aria-valuenow", "360");
  await resizer.focus();
  await page.keyboard.press("Home");
  await expect(resizer).toHaveAttribute("aria-valuenow", "200");
  await page.keyboard.press("End");
  await expect(resizer).toHaveAttribute("aria-valuenow", "480");
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(resizer).toHaveAttribute("aria-valuenow", "280");
  await expect(page.locator(".map-column")).toBeVisible();
});
