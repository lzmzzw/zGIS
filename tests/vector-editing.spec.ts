import { expect, test, type Page } from "@playwright/test";
import type { GeoFeature } from "../src/domain";
import type { WorkspaceEditSession } from "../src/workspace";
import { installDesktopMock } from "./desktop.mock";

type Kind = "Point" | "LineString" | "Polygon";
type Recovery = {
  layers: {
    id: string;
    name: string;
    geometryType: Kind;
    fieldNames: string[];
    features: GeoFeature[];
  }[];
  session?: WorkspaceEditSession;
};
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus || page.isClosed()) return;
  await info.attach("recovery.json", {
    body: (await page.evaluate(() => window.__ZG_TEST__.snapshot)) ?? "null",
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("failure.png") });
});
const readRecovery = (page: Page): Promise<Recovery | null> =>
  page.evaluate(() =>
    window.__ZG_TEST__.snapshot
      ? JSON.parse(window.__ZG_TEST__.snapshot)
      : null,
  );
async function recovery(page: Page, condition: (value: Recovery) => boolean) {
  await expect
    .poll(async () => {
      const value = await readRecovery(page);
      return value !== null && condition(value);
    })
    .toBe(true);
  return (await readRecovery(page))!;
}
async function newLayer(page: Page, kind: Kind) {
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page
    .locator(".header-menus")
    .getByRole("button", { name: "新建", exact: true })
    .click();
  await page.getByLabel("矢量图层名称", { exact: true }).fill(`手绘${kind}`);
  await page.getByLabel("矢量几何类型", { exact: true }).selectOption(kind);
  await page.getByLabel("矢量属性字段", { exact: true }).fill("名称,备注");
  await button(page, "创建并编辑").click();
  await expect(page.getByLabel("矢量编辑提示")).toContainText("编辑中");
  await page
    .locator(".attribute-panel")
    .getByRole("button", { name: "展开属性表", exact: true })
    .click();
  await expect(
    page.getByRole("columnheader", { name: "名称", exact: true }),
  ).toBeVisible();
}

test("editing toolbar separates browsing, geometry, creation, records and saving", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await newLayer(page, "Point");
  await expect(page.locator(".document-state")).toHaveText("仅工作区副本");
  const toolbar = page.getByRole("toolbar", { name: "地图工具", exact: true });
  await expect(toolbar.getByRole("group", { name: "浏览", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("group", { name: "几何编辑", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("group", { name: "新增要素", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("group", { name: "记录操作", exact: true })).toBeVisible();
  await expect(toolbar.locator('[role="separator"]')).toHaveCount(5);
  await expect(toolbar.getByText("保存", { exact: true })).toBeVisible();
  await expect(toolbar.getByText("保存并退出", { exact: true })).toBeVisible();
});

test("move and vertex modes explain how to select an element first", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await newLayer(page, "Point");
  await button(page, "取消绘制").click();
  await button(page, "移动要素").click();
  await expect(page.getByLabel("矢量编辑提示")).toContainText(
    "请先单击要素或属性表记录",
  );
  await expect(page.getByLabel("矢量编辑提示")).toContainText("未选中要素");
  await expect(page.locator(".map-surface")).toHaveClass(/move-mode/);
  await button(page, "编辑顶点").click();
  await expect(page.getByLabel("矢量编辑提示")).toContainText(
    "请先单击要素或属性表记录",
  );
  await expect(page.locator(".map-surface")).toHaveClass(/vertex-mode/);
});

test("selected features expose direct property and geometry editors", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await newLayer(page, "Point");
  await button(page, "取消绘制").click();
  await button(page, "新增点").click();
  const at = await mapPoints(page);
  await page.mouse.click(at(0.5, 0.45).x, at(0.5, 0.45).y);
  await button(page, "选择").click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.locator("tbody tr").click();
  await expect(button(page, "编辑 JSON 属性")).toBeVisible();
  await expect(button(page, "编辑 WKT 几何")).toBeVisible();
});

async function mapPoints(page: Page) {
  const bounds = (await page
    .getByLabel("地理数据地图", { exact: true })
    .boundingBox())!;
  return (x: number, y: number) => ({
    x: bounds.x + bounds.width * x,
    y: bounds.y + bounds.height * y,
  });
}
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}
const positions = (feature: GeoFeature): number[][] => {
  const geometry = feature.geometry!;
  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type === "Polygon") return geometry.coordinates[0];
  throw new Error("Unexpected test geometry");
};

for (const kind of ["Point", "LineString", "Polygon"] as const) {
  test(`${kind}: create continuously, move whole feature, modify vertices, undo and save`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installDesktopMock(page);
    await page.goto("/");
    await newLayer(page, kind);
    const at = await mapPoints(page);
    const first = [at(0.32, 0.36), at(0.52, 0.36), at(0.42, 0.55)];
    const create = async (nodes: { x: number; y: number }[]) => {
      for (const node of nodes) await page.mouse.click(node.x, node.y);
      if (kind !== "Point") await button(page, "完成绘制").click();
    };
    await create(
      first.slice(0, kind === "Point" ? 1 : kind === "LineString" ? 2 : 3),
    );
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await create(
      [at(0.68, 0.6), at(0.82, 0.6), at(0.75, 0.76)].slice(
        0,
        kind === "Point" ? 1 : kind === "LineString" ? 2 : 3,
      ),
    );
    await expect(page.locator("tbody tr")).toHaveCount(2);
    const initial = (
      await recovery(page, (value) => value.layers[0]?.features.length === 2)
    ).layers[0].features[0];
    expect(initial.geometry?.type).toBe(kind);
    expect(initial.properties).toEqual({ 名称: "", 备注: "" });
    for (const other of ["Point", "LineString", "Polygon"].filter(
      (value) => value !== kind,
    ))
      await expect(
        button(
          page,
          other === "Point"
            ? "新增点"
            : other === "LineString"
              ? "新增线"
              : "新增面",
        ),
      ).toBeDisabled();

    await button(page, "选择").click();
    await page.mouse.click(first[0].x, first[0].y);
    await expect(page.locator("tbody tr.selected")).toHaveCount(1);
    await expect(page.locator("tbody tr").first()).toHaveClass(/selected/);
    await button(page, "移动要素").click();
    const shift = { x: 55, y: 36 };
    await drag(page, first[0], {
      x: first[0].x + shift.x,
      y: first[0].y + shift.y,
    });
    const moved = (
      await recovery(
        page,
        (value) =>
          JSON.stringify(value.layers[0]?.features[0].geometry) !==
          JSON.stringify(initial.geometry),
      )
    ).layers[0].features[0];
    const beforeNodes = positions(initial),
      movedNodes = positions(moved);
    expect(movedNodes).toHaveLength(beforeNodes.length);
    const longitudeDelta = movedNodes[0][0] - beforeNodes[0][0];
    expect(longitudeDelta).not.toBe(0);
    for (let index = 0; index < movedNodes.length; index++) {
      expect(movedNodes[index][0] - beforeNodes[index][0]).toBeCloseTo(
        longitudeDelta,
        8,
      );
      expect(movedNodes[index].slice(2)).toEqual(beforeNodes[index].slice(2));
    }
    await page.getByLabel("地理数据地图", { exact: true }).focus();
    await page.keyboard.press("Control+z");
    await recovery(
      page,
      (value) =>
        JSON.stringify(value.layers[0]?.features[0].geometry) ===
        JSON.stringify(initial.geometry),
    );
    await button(page, "重做").click();
    await recovery(
      page,
      (value) =>
        JSON.stringify(value.layers[0]?.features[0].geometry) ===
        JSON.stringify(moved.geometry),
    );

    await button(page, "编辑顶点").click();
    const movedStart = { x: first[0].x + shift.x, y: first[0].y + shift.y };
    await drag(page, movedStart, {
      x: movedStart.x - 28,
      y: movedStart.y - 18,
    });
    const modified = (
      await recovery(
        page,
        (value) =>
          JSON.stringify(value.layers[0]?.features[0].geometry) !==
          JSON.stringify(moved.geometry),
      )
    ).layers[0].features[0];
    expect(positions(modified)[0]).not.toEqual(movedNodes[0]);
    if (kind !== "Point") {
      expect(positions(modified)[1]).toEqual(movedNodes[1]);
      const edge = {
        x: (movedStart.x - 28 + first[1].x + shift.x) / 2,
        y: (movedStart.y - 18 + first[1].y + shift.y) / 2,
      };
      const inserted = { x: edge.x, y: edge.y - 35 };
      await drag(page, edge, inserted);
      await recovery(
        page,
        (value) =>
          positions(value.layers[0].features[0]).length ===
          positions(modified).length + 1,
      );
      await page.keyboard.down("Alt");
      await page.mouse.click(inserted.x, inserted.y);
      await page.keyboard.up("Alt");
      await recovery(
        page,
        (value) =>
          positions(value.layers[0].features[0]).length ===
          positions(modified).length,
      );
    }
    const final = (await readRecovery(page))!.layers[0].features;
    await button(page, "保存编辑").click();
    await expect(page.getByLabel("矢量编辑提示")).toContainText("已保存");
    await expect(button(page, "保存并退出编辑")).toBeEnabled();
    await expect(button(page, "编辑顶点")).toBeVisible();
    const saved = await page.evaluate(() =>
      window.__ZG_TEST__.calls
        .filter((call) => call.command === "save_file")
        .at(-1)!,
    );
    expect(
      JSON.parse(String(saved.args.content)).features.map(
        (feature: GeoFeature) => feature.geometry,
      ),
    ).toEqual(final.map((feature) => feature.geometry));
    await page.screenshot({ path: `output/vector-editing/${kind}.png` });
    await button(page, "保存并退出编辑").click();
    await expect(button(page, "编辑")).toBeVisible();
    await expect(page.getByLabel("矢量编辑提示")).toHaveCount(0);
  });
}

test("drawing keyboard actions remove fixed nodes, complete continuously and cancel", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await newLayer(page, "LineString");
  const at = await mapPoints(page);
  await page.mouse.click(at(0.3, 0.35).x, at(0.3, 0.35).y);
  await page.mouse.click(at(0.5, 0.35).x, at(0.5, 0.35).y);
  await page.mouse.click(at(0.7, 0.5).x, at(0.7, 0.5).y);
  await expect(page.locator(".editing-tools")).toContainText("3 个节点");
  await page.getByLabel("地理数据地图", { exact: true }).focus();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".editing-tools")).toContainText("2 个节点");
  await page.keyboard.press("Enter");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(button(page, "新增线")).toHaveAttribute("aria-pressed", "true");
  const saved = await recovery(
    page,
    (value) =>
      value.layers[0].features.length === 1 && !value.session?.drawDraft,
  );
  expect(positions(saved.layers[0].features[0])).toHaveLength(2);
  await page.mouse.click(at(0.6, 0.6).x, at(0.6, 0.6).y);
  await expect(page.locator(".editing-tools")).toContainText("1 个节点");
  await page.getByLabel("地理数据地图", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".editing-tools")).toContainText("0 个节点");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(button(page, "保存并退出编辑")).toBeEnabled();
});

test("Escape cancels an active move and consecutive drags remain editable", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await newLayer(page, "Point");
  const at = await mapPoints(page);
  const origin = at(0.4, 0.45);
  await page.mouse.click(origin.x, origin.y);
  const initial = (
    await recovery(page, (value) => value.layers[0].features.length === 1)
  ).layers[0].features[0].geometry;
  await button(page, "移动要素").click();
  await page.getByLabel("地理数据地图", { exact: true }).focus();
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 50, origin.y + 25, { steps: 10 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await recovery(
    page,
    (value) =>
      JSON.stringify(value.layers[0].features[0].geometry) ===
      JSON.stringify(initial),
  );
  await drag(page, origin, { x: origin.x + 35, y: origin.y + 25 });
  const firstMove = (
    await recovery(
      page,
      (value) =>
        JSON.stringify(value.layers[0].features[0].geometry) !==
        JSON.stringify(initial),
    )
  ).layers[0].features[0].geometry;
  await drag(
    page,
    { x: origin.x + 35, y: origin.y + 25 },
    { x: origin.x + 65, y: origin.y + 50 },
  );
  await recovery(
    page,
    (value) =>
      JSON.stringify(value.layers[0].features[0].geometry) !==
      JSON.stringify(firstMove),
  );
  await button(page, "撤销").click();
  await recovery(
    page,
    (value) =>
      JSON.stringify(value.layers[0].features[0].geometry) ===
      JSON.stringify(firstMove),
  );
  await button(page, "撤销").click();
  await recovery(
    page,
    (value) =>
      JSON.stringify(value.layers[0].features[0].geometry) ===
      JSON.stringify(initial),
  );
});

test("unfinished drawing persists only fixed nodes and resumes after forced restart", async ({
  page,
  context,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await newLayer(page, "LineString");
  const at = await mapPoints(page);
  await page.mouse.click(at(0.35, 0.4).x, at(0.35, 0.4).y);
  await page.mouse.click(at(0.55, 0.4).x, at(0.55, 0.4).y);
  await page.mouse.move(at(0.75, 0.6).x, at(0.75, 0.6).y);
  await expect(button(page, "保存并退出编辑")).toBeDisabled();
  const draft = await recovery(
    page,
    (value) => value.session?.drawDraft?.coordinates.length === 2,
  );
  expect(draft.layers[0].features).toHaveLength(0);
  const raw = await page.evaluate(() => window.__ZG_TEST__.snapshot!);
  // Close without the app's normal exit path to model a killed process.
  await page.close();
  const restarted = await context.newPage();
  await installDesktopMock(restarted, raw);
  await restarted.goto("/");
  await expect(restarted.getByLabel("矢量编辑提示")).toContainText("编辑中");
  await expect(button(restarted, "完成绘制")).toBeEnabled();
  await expect(restarted.locator(".editing-tools")).toContainText("2 个节点");
  await button(restarted, "完成绘制").click();
  const restored = await recovery(
    restarted,
    (value) =>
      value.layers[0].features.length === 1 && !value.session?.drawDraft,
  );
  expect(
    positions(restored.layers[0].features[0]).map((node) => node.slice(0, 2)),
  ).toEqual(
    draft.session!.drawDraft!.coordinates.map((node) => node.slice(0, 2)),
  );
});

for (const kind of ["json", "wkt", "cell"] as const) {
  test(`${kind} draft survives native close and restart with edit session`, async ({
    page,
    context,
  }) => {
    await installDesktopMock(page);
    await page.goto("/");
    await newLayer(page, "Point");
    const at = await mapPoints(page);
    await page.mouse.click(at(0.5, 0.45).x, at(0.5, 0.45).y);
    await button(page, "选择").click();
    await page.locator("tbody tr").click();
    const label =
      kind === "json" ? "JSON 属性" : kind === "wkt" ? "WKT 几何" : "属性 名称";
    const text =
      kind === "json"
        ? '{"名称":"恢复草稿","备注":"未应用"}'
        : kind === "wkt"
          ? "POINT Z (116 40 9)"
          : "未应用的属性";
    if (kind === "cell") {
      await page.locator('td[data-field="名称"]').dblclick();
    } else if (kind === "wkt") {
      await page.getByLabel("地理数据地图", {exact:true}).focus();
      await page.keyboard.press("Shift+F10");
      await page.getByRole("menuitem", {name:"WKT 几何…",exact:true}).click();
    } else {
      await page.getByLabel("地理数据地图", {exact:true}).focus();
      await page.keyboard.press("Shift+F10");
      await page.getByRole("menuitem", {name:"JSON 属性…",exact:true}).click();
    }
    await page.getByRole("textbox", { name: label, exact: true }).fill(text);
    await page.evaluate(() => window.__ZG_TEST__.requestClose());
    await expect(
      page.getByRole("heading", { name: "退出 zGIS", exact: true }),
    ).toBeVisible();
    await button(page, "返回编辑").click();
    await expect(
      page.getByRole("textbox", { name: label, exact: true }),
    ).toHaveValue(text);
    await page.evaluate(() => window.__ZG_TEST__.requestClose());
    await button(page, "退出并保留工作区").click();
    await expect
      .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
      .toBe(true);
    const raw = await page.evaluate(() => window.__ZG_TEST__.snapshot!);
    const snapshot: Recovery = JSON.parse(raw);
    expect(snapshot.layers[0].features[0].properties.名称).toBe("");
    expect(
      kind === "cell"
        ? snapshot.session!.cellDraft!.text
        : snapshot.session!.panelDraft!.text,
    ).toBe(text);
    const restarted = await context.newPage();
    await installDesktopMock(restarted, raw);
    await restarted.goto("/");
    await expect(
      restarted.getByRole("textbox", { name: label, exact: true }),
    ).toHaveValue(text);
    await expect(restarted.getByLabel("矢量编辑提示")).toContainText("编辑中");
    if (kind === "cell") {
      await restarted.getByRole("textbox", {name:label,exact:true}).press("Enter");
    } else {
      await restarted.getByRole("dialog").getByRole("button", {
        name: kind === "json" ? "应用属性" : "应用几何", exact:true,
      }).click();
    }
    const applied = await recovery(restarted, (value) =>
      kind === "wkt"
        ? JSON.stringify(value.layers[0].features[0].geometry) ===
          JSON.stringify({ type: "Point", coordinates: [116, 40, 9] })
        : value.layers[0].features[0].properties.名称 ===
          (kind === "json" ? "恢复草稿" : text),
    );
    expect(applied.session?.layerId).toBe(applied.layers[0].id);
  });
}

test("entering edit mode without changes prompts on close and blocks switching layers", async ({
  page,
}) => {
  const layers = ["first", "second"].map((id) => ({
    id,
    name: `${id}.geojson`,
    visible: true,
    color: "#5479b6",
    sourceKind: "geojson",
    dirty: false,
    features: [
      {
        id,
        geometry: { type: "Point", coordinates: [116, 40] },
        properties: {},
      },
    ],
  }));
  await installDesktopMock(page, JSON.stringify(layers));
  await page.goto("/");
  await expect(page.locator(".operation-status")).toContainText("已恢复 2");
  await button(page, "编辑").click();
  await page.locator(".layer-row").last().click();
  await expect(page.getByRole("alert")).toContainText(
    "先保存并退出当前图层编辑",
  );
  await expect(page.getByLabel("矢量编辑提示")).toContainText("first.geojson");
  await page.evaluate(() => window.__ZG_TEST__.requestClose());
  await expect(
    page.getByRole("heading", { name: "退出 zGIS", exact: true }),
  ).toBeVisible();
  await button(page, "返回编辑").click();
  await button(page, "保存并退出编辑").click();
  await page.locator(".layer-row").last().click();
  await expect(button(page, "编辑")).toBeEnabled();
});

test("empty vector field changes undo, redo and recover with the edit session", async ({
  page,
  context,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await newLayer(page, "Point");
  await button(page, "添加字段").click();
  await page
    .getByRole("textbox", { name: "新字段名", exact: true })
    .fill("分类");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加字段", exact: true })
    .click();
  await expect(
    page.getByRole("columnheader", { name: "分类", exact: true }),
  ).toBeVisible();
  await button(page, "撤销").click();
  await expect(
    page.getByRole("columnheader", { name: "分类", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "名称", exact: true }),
  ).toBeVisible();
  await button(page, "重做").click();
  await expect(
    page.getByRole("columnheader", { name: "分类", exact: true }),
  ).toBeVisible();
  await recovery(page, (value) => value.layers[0].fieldNames.includes("分类"));
  const raw = await page.evaluate(() => window.__ZG_TEST__.snapshot!);
  await page.close();
  const restarted = await context.newPage();
  await installDesktopMock(restarted, raw);
  await restarted.goto("/");
  await expect(restarted.getByLabel("矢量编辑提示")).toContainText("编辑中");
  await button(restarted, "撤销").click();
  const undone = await recovery(
    restarted,
    (value) => !value.layers[0].fieldNames.includes("分类"),
  );
  expect(undone.layers[0].fieldNames).toEqual(["名称", "备注"]);
  expect(undone.layers[0].features).toEqual([]);
});
