import { expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
export async function layerBasemapSmoke(page, restoring = false) {
  const tile = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    context.fillStyle = "#d8dfbd";
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = "#75b4d0";
    context.fillRect(90, 0, 45, 256);
    return canvas.toDataURL().split(",")[1];
  });
  const requests = [];
  const fixture = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(Buffer.from(tile, "base64"));
  });
  const portFile = "output/desktop/basemap-fixture-port.json";
  const restorePort = restoring
    ? JSON.parse(readFileSync(portFile, "utf8"))
    : 0;
  await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(restorePort, "127.0.0.1", resolve);
  });
  const port = fixture.address().port;
  if (!restoring) writeFileSync(portFile, JSON.stringify(port));
  const template = `http://127.0.0.1:${port}/{z}/{x}/{y}.png`;
  try {
    if (restoring) {
      await page.getByRole("button", { name: "底图", exact: true }).click();
      await expect(
        page.getByRole("radio", { name: "恢复底图", exact: true }),
      ).toBeChecked();
      await expect(page.getByRole("radio").first()).toHaveAttribute(
        "aria-label",
        "恢复底图",
      );
      await expect(
        page.getByRole("checkbox", { name: "显示底图", exact: true }),
      ).toBeChecked();
      await expect(
        page.locator(".basemap-card.selected .basemap-preview img"),
      ).toHaveAttribute("src", /^data:image\/png;base64,/);
      await expect(page.locator(".basemap-card small")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page
        .getByLabel("地理数据地图", { exact: true })
        .getByRole("button", { name: "+", exact: true })
        .click();
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      await expect(
        page
          .getByRole("tree")
          .locator(".tree-row")
          .filter({ hasText: "甲孙组" }),
      ).toHaveAttribute("aria-level", "5");
      return;
    }
    const tree = page.getByRole("tree", { name: "图层树" });
    const row = (name) =>
      tree
        .locator(".tree-row")
        .filter({
          has: page
            .locator(".layer-text")
            .filter({ hasText: new RegExp(`^${name}$`) }),
        });
    const create = async (name, parent) => {
      if (parent) await row(parent).click({ button: "right" });
      else await tree.click({ button: "right", position: { x: 30, y: 300 } });
      await page
        .getByRole("menuitem", { name: parent ? "新建子分组…" : "新建分组…" })
        .click();
      await page.getByLabel("分组名称").fill(name);
      await page.getByRole("button", { name: "创建", exact: true }).click();
    };
    const drag = async (from, to) => {
      const a = await row(from).boundingBox(),
        b = await row(to).boundingBox();
      await page.mouse.move(a.x + 110, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + 110, b.y + b.height / 2, { steps: 15 });
      await page.mouse.up();
    };
    await create("甲组");
    await create("甲子组", "甲组");
    await create("甲孙组", "甲子组");
    await create("乙组");
    await create("乙子组", "乙组");
    await row("乙子组").getByRole("button", { name: "折叠 乙子组" }).click();
    await drag("甲组", "乙子组");
    await expect(row("甲孙组")).toHaveAttribute("aria-level", "5");
    await expect(row("乙子组")).toHaveAttribute("aria-expanded", "true");
    await drag("甲组", "甲孙组");
    await expect(row("甲组")).toHaveAttribute("aria-level", "3");
    await page.getByRole("button", { name: "编辑顶点", exact: true }).click();
    await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "退出 zGIS" })).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page.getByRole("button", { name: "选择", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "地图", exact: true })
      .click();
    await page.getByRole("button", { name: "添加底图", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "添加底图", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("width", "460px");
    await expect(dialog.getByRole("heading")).toHaveCSS("font-size", "15px");
    await expect(page.getByLabel("新底图名称")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("main", { name: "后台设置" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "添加底图", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "添加底图", exact: true }).click();
    await page.getByLabel("新底图名称").fill("恢复底图");
    await page.getByLabel("XYZ 瓦片地址").fill(template);
    await page.screenshot({ path: "output/desktop/basemap-add-dialog.png" });
    await page
      .getByRole("dialog", { name: "添加底图", exact: true })
      .getByRole("button", { name: "添加", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "添加底图", exact: true }),
    ).toHaveCount(0);
    // Wuhan at z=11 is covered by these neighboring XYZ tiles.
    expect(requests).toContain("/11/1674/841.png");
    await expect(
      page.getByRole("status").filter({ hasText: "预览暂不可用" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "上移 恢复底图", exact: true })
      .click();
    await page.screenshot({ path: "output/desktop/basemap-settings.png" });
    await page.getByRole("button", { name: "返回地图", exact: true }).click();
    await page.getByRole("button", { name: "底图", exact: true }).click();
    await page.getByRole("radio", { name: "恢复底图", exact: true }).check();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    await expect(page.getByRole("radio").first()).toBeChecked();
    const preview = page.locator(".basemap-card.selected .basemap-preview img");
    await expect(preview).toHaveAttribute("src", /^data:image\/png;base64,/);
    expect(
      await preview.evaluate((image) => [
        image.naturalWidth,
        image.naturalHeight,
      ]),
    ).toEqual([288, 144]);
    await expect(page.locator(".basemap-card small")).toHaveCount(0);
    await page.screenshot({ path: "output/desktop/nested-basemap.png" });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "地图", exact: true })
      .click();
    await page
      .getByRole("button", { name: "编辑 恢复底图", exact: true })
      .click();
    await page.getByLabel("在地图中显示", { exact: true }).uncheck();
    await page
      .getByRole("dialog", { name: "编辑底图" })
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page.getByRole("button", { name: "返回地图", exact: true }).click();
    await page.getByRole("button", { name: "底图", exact: true }).click();
    await expect(
      page.getByRole("radio", { name: "恢复底图", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("radio", { name: "OpenStreetMap", exact: true }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "地图", exact: true })
      .click();
    await page
      .getByRole("button", { name: "编辑 恢复底图", exact: true })
      .click();
    await page.getByLabel("在地图中显示", { exact: true }).check();
    await page
      .getByLabel("XYZ 瓦片地址")
      .fill(template.replace(`:${port}/`, `:${port}/edited/`));
    await page.screenshot({ path: "output/desktop/basemap-edit-dialog.png" });
    await page
      .getByRole("dialog", { name: "编辑底图" })
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page.getByRole("button", { name: "返回地图", exact: true }).click();
    await page.getByRole("button", { name: "底图", exact: true }).click();
    await page.getByRole("radio", { name: "恢复底图", exact: true }).check();
    await expect
      .poll(() => requests.some((url) => url.includes("/edited/")))
      .toBe(true);
    await page.keyboard.press("Escape");
    console.log(
      "PASS: native XYZ downloads, Wuhan PNG preview/cache, edit visibility, selected fallback and edited URL requests",
    );
  } finally {
    await new Promise((resolve) => fixture.close(resolve));
  }
}
