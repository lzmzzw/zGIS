import { test, expect } from "@playwright/test";
import { analysisTools } from "../src/analysisTools";
import shared from "../src/i18n/shared";

test.beforeEach(async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
});

const file = {
  name: "武汉.geojson",
  mimeType: "application/geo+json",
  buffer: Buffer.from(
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { 城市: "武汉", name: "Original data" },
          geometry: { type: "Point", coordinates: [114, 30] },
        },
      ],
    }),
  ),
};

test("双语切换保留图层、属性、下载草稿和错误，持久化到静态页面重载", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("button", { name: "Import files", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".web-status")).toContainText(
    "files are processed in your browser only",
  );
  await page
    .getByLabel("Choose spatial files", { exact: true })
    .setInputFiles(file);
  const importing = page.getByRole("dialog");
  await expect(importing).toContainText("Files are never uploaded");
  await importing.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await expect(
    page.getByRole("dialog", { name: "导入文件", exact: true }),
  ).toBeVisible();
  await importing.getByRole("button", { name: "导入", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "图层属性", exact: true }),
  ).toContainText("武汉");
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  await expect(
    page.getByLabel("武汉.geojson visibility", { exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("table", { name: "Layer attributes", exact: true }),
  ).toContainText("城市");
  await expect(page.locator(".web-status")).toContainText(
    "Imported 1 layers with 1 features",
  );
  await page
    .getByRole("button", { name: "Download layer", exact: true })
    .click();
  const exporting = page.getByRole("dialog");
  await exporting.getByLabel("Filename", { exact: true }).fill("bad/name");
  await exporting
    .getByRole("button", { name: "Download", exact: true })
    .click();
  await expect(exporting.getByRole("alert")).toContainText(
    "The filename must contain",
  );
  await exporting.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await expect(exporting.getByRole("alert")).toContainText("文件名须为");
  await expect(exporting.getByLabel("文件名", { exact: true })).toHaveValue(
    "bad/name",
  );
  await exporting.getByLabel("语言", { exact: true }).selectOption("en");
  await expect(exporting.getByRole("alert")).toContainText(
    "The filename must contain",
  );
  await exporting.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page.reload();
  await expect(page.getByLabel("语言", { exact: true })).toHaveValue("zh-CN");
  expect(errors).toEqual([]);
});

test("英文工具箱、分析结果与提示可切回中文，文件内容保持原值", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByLabel("选择空间文件", { exact: true }).setInputFiles(file);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "导入", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  await page
    .getByRole("button", { name: "Spatial analysis", exact: true })
    .click();
  const box = page.locator(".processing-toolbox");
  await box.getByLabel("Search analysis tools", { exact: true }).fill("buffer");
  await box.getByRole("button", { name: "Buffer", exact: true }).click();
  await box
    .getByLabel("Result layer name", { exact: true })
    .fill("原始结果名称");
  await box.getByRole("button", { name: "Run analysis", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "原始结果名称", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".web-status")).toContainText("Buffer complete");
  await page.locator(".web-layer").last().locator("summary").filter({ hasText: "Layer notices" }).click();
  await expect(page.locator(".web-layer").last()).toContainText(
    "an independent browser copy",
  );
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await expect(page.locator(".web-status")).toContainText("缓冲区完成");
  await expect(
    box.getByRole("button", { name: "缓冲区", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".web-layer").last()).toContainText(
    "浏览器中的独立副本",
  );
  await expect(page.getByRole("table")).toContainText("武汉");
  await expect(
    page.getByRole("button", { name: "原始结果名称", exact: true }),
  ).toBeVisible();
});

test("英文静态页面与全部工具表单无遗漏的中文界面文字", async ({ page }) => {
  await page.goto("./");
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  await page
    .getByRole("button", { name: "Spatial analysis", exact: true })
    .click();
  const box = page.locator(".processing-toolbox");
  const search = box.getByLabel("Search analysis tools", { exact: true });
  for (const tool of analysisTools) {
    await search.fill(tool.id);
    await box
      .getByRole("button", { name: shared[tool.label], exact: true })
      .click();
    // 语言选项使用语言本名；其余可见产品文字应全部显示英文。
    const text = (await page.locator("body").innerText()).replaceAll(
      "中文",
      "",
    );
    expect(text, `untranslated UI for ${tool.id}`).not.toMatch(
      /[\u3400-\u9fff]/,
    );
    const attrs = await page
      .locator("[aria-label], [title], [placeholder]")
      .evaluateAll((elements) =>
        elements.flatMap((element) =>
          ["aria-label", "title", "placeholder"].map(
            (attr) => element.getAttribute(attr) ?? "",
          ),
        ),
      );
    expect(
      attrs.join("\n"),
      `untranslated accessibility label for ${tool.id}`,
    ).not.toMatch(/[\u3400-\u9fff]/);
  }
});
