import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

declare global {
  interface Window {
    __BASEMAP_PREFS_PENDING__: boolean;
    __RELEASE_BASEMAP_PREFS__: () => void;
  }
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "地图", exact: true })
    .click();
}

async function addService(page: Page, name: string, host: string) {
  await page.getByRole("button", { name: "添加底图", exact: true }).click();
  await page.getByLabel("新底图名称", { exact: true }).fill(name);
  await page
    .getByLabel("XYZ 瓦片地址", { exact: true })
    .fill(`https://${host}/{z}/{x}/{y}.png`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加", exact: true })
    .click();
}

async function showBasemaps(page: Page) {
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.getByRole("button", { name: "底图", exact: true }).click();
}

async function hideService(page: Page, name: string) {
  await page.getByRole("button", { name: `编辑 ${name}`, exact: true }).click();
  await page.getByLabel("在地图中显示", { exact: true }).uncheck();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
}

test("custom XYZ services share settings order, selection and restart state", async ({
  page,
}) => {
  await page.goto("/");
  const tiles: string[] = [];
  await page.route("https://custom.example.com/**", async (route) => {
    tiles.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "地图", exact: true })
    .click();
  await page.getByRole("button", { name: "添加底图", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "添加底图", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加", exact: true })
    .click();
  await expect(
    page.getByText("请输入底图名称。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("新底图名称").fill("自定义测试底图");
  await page
    .getByLabel("XYZ 瓦片地址")
    .fill("https://custom.example.com/{z}/{x}/{y}.png");
  await page.getByLabel("底图来源说明").fill("测试服务来源");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加", exact: true })
    .click();
  await page
    .getByRole("button", { name: "上移 自定义测试底图", exact: true })
    .click();
  await expect(page.locator(".basemap-service-list li").first()).toContainText(
    "自定义测试底图",
  );
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(page.getByRole("radio").first()).toHaveAttribute(
    "aria-label",
    "自定义测试底图",
  );
  await page
    .getByRole("radio", { name: "自定义测试底图", exact: true })
    .check();
  await expect(
    page.getByRole("radio", { name: "自定义测试底图", exact: true }),
  ).toBeChecked();
  await expect(page.getByText("测试服务来源", { exact: true })).toBeVisible();
  await expect.poll(() => tiles.length).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "自定义测试底图", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "地图", exact: true })
    .click();
  await page
    .getByRole("button", { name: "删除 自定义测试底图", exact: true })
    .click();
  await expect(page.locator(".basemap-service-list li")).toHaveCount(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".basemap-service-list li").first()).toContainText(
    "自定义测试底图",
  );
});

test("editing cancels cleanly, saves a changed URL and preserves selection after restart", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("https://*.example/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await openSettings(page);
  await addService(page, "原底图", "old-tiles.example");
  await showBasemaps(page);
  await page.getByRole("radio", { name: "原底图", exact: true }).check();
  await expect
    .poll(() => requests.some((url) => url.includes("old-tiles.example")))
    .toBe(true);
  await page.keyboard.press("Escape");
  await openSettings(page);
  const edit = page.getByRole("button", { name: "编辑 原底图", exact: true });
  await edit.click();
  await expect(
    page.getByRole("dialog", { name: "编辑底图", exact: true }),
  ).toBeVisible();
  await page.getByLabel("底图名称", { exact: true }).fill("取消改名");
  await page
    .getByLabel("XYZ 瓦片地址", { exact: true })
    .fill("https://cancelled.example/{z}/{x}/{y}.png");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(edit).toBeFocused();
  await edit.click();
  await expect(page.getByLabel("底图名称", { exact: true })).toHaveValue(
    "原底图",
  );
  await expect(page.getByLabel("XYZ 瓦片地址", { exact: true })).toHaveValue(
    "https://old-tiles.example/{z}/{x}/{y}.png",
  );
  await page.getByLabel("底图名称", { exact: true }).fill("已编辑底图");
  await page
    .getByLabel("XYZ 瓦片地址", { exact: true })
    .fill("https://new-tiles.example/{z}/{x}/{y}.png");
  await page.getByLabel("底图来源说明", { exact: true }).fill("更新的来源");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await showBasemaps(page);
  await expect(
    page.getByRole("radio", { name: "已编辑底图", exact: true }),
  ).toBeChecked();
  await expect(page.getByText("更新的来源", { exact: true })).toBeVisible();
  await expect
    .poll(() => requests.some((url) => url.includes("new-tiles.example")))
    .toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "已编辑底图", exact: true }),
  ).toBeChecked();
  expect(requests.some((url) => url.includes("cancelled.example"))).toBe(false);
});

test("hiding the selected service falls back by display order and hidden services never load tiles", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("https://*.example/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await openSettings(page);
  await addService(page, "当前底图", "active.example");
  await addService(page, "优先候选", "fallback.example");
  await page
    .getByRole("button", { name: "上移 优先候选", exact: true })
    .click();
  await page
    .getByRole("button", { name: "上移 优先候选", exact: true })
    .click();
  await showBasemaps(page);
  await page.getByRole("radio", { name: "当前底图", exact: true }).check();
  await expect
    .poll(() => requests.some((url) => url.includes("active.example")))
    .toBe(true);
  await page.keyboard.press("Escape");
  await openSettings(page);
  await hideService(page, "当前底图");
  await showBasemaps(page);
  await expect(
    page.getByRole("radio", { name: "当前底图", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("radio", { name: "优先候选", exact: true }),
  ).toBeChecked();
  await expect
    .poll(() => requests.some((url) => url.includes("fallback.example")))
    .toBe(true);
  const hiddenRequests = requests.filter((url) =>
    url.includes("active.example"),
  ).length;
  await page.keyboard.press("Escape");
  await page
    .getByLabel("地理数据地图", { exact: true })
    .getByRole("button", { name: "+", exact: true })
    .click();
  await page.waitForTimeout(250);
  expect(requests.filter((url) => url.includes("active.example"))).toHaveLength(
    hiddenRequests,
  );
  await page.reload();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "当前底图", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("radio", { name: "优先候选", exact: true }),
  ).toBeChecked();
});

test("the default OSM service can be edited, removed and undone; all-hidden state survives restart", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("https://osm-mirror.example/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await openSettings(page);
  await expect(page.locator(".basemap-service-list li")).toHaveCount(1);
  await page
    .getByRole("button", { name: "编辑 OpenStreetMap", exact: true })
    .click();
  await page.getByLabel("底图名称", { exact: true }).fill("OSM 镜像");
  await page
    .getByLabel("XYZ 瓦片地址", { exact: true })
    .fill("https://osm-mirror.example/{z}/{x}/{y}.png");
  await page.getByLabel("底图来源说明", { exact: true }).fill("测试镜像来源");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await showBasemaps(page);
  await expect(
    page.getByRole("radio", { name: "OSM 镜像", exact: true }),
  ).toBeChecked();
  await expect(page.getByText("测试镜像来源", { exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await openSettings(page);
  await page
    .getByRole("button", { name: "删除 OSM 镜像", exact: true })
    .click();
  await expect(page.locator(".basemap-service-list li")).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".basemap-service-list li")).toHaveCount(1);
  await hideService(page, "OSM 镜像");
  await showBasemaps(page);
  await expect(page.getByRole("radio")).toHaveCount(0);
  const requestCount = requests.length;
  await page.reload();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.waitForTimeout(150);
  expect(requests).toHaveLength(requestCount);
  await page.keyboard.press("Escape");
  await openSettings(page);
  await expect(page.locator(".basemap-service-list li")).toHaveCount(1);
  await page
    .getByRole("button", { name: "编辑 OSM 镜像", exact: true })
    .click();
  await expect(
    page.getByLabel("在地图中显示", { exact: true }),
  ).not.toBeChecked();
  await expect(page.getByLabel("XYZ 瓦片地址", { exact: true })).toHaveValue(
    "https://osm-mirror.example/{z}/{x}/{y}.png",
  );
  await page.getByLabel("在地图中显示", { exact: true }).check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await showBasemaps(page);
  await expect(
    page.getByRole("radio", { name: "OSM 镜像", exact: true }),
  ).toBeChecked();
});

test("removing every service is valid and restarting does not recreate OSM", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/tile.openstreetmap.org/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await openSettings(page);
  await page
    .getByRole("button", { name: "删除 OpenStreetMap", exact: true })
    .click();
  await expect(page.locator(".basemap-service-list li")).toHaveCount(0);
  await showBasemaps(page);
  await expect(page.getByRole("radio")).toHaveCount(0);
  const requestCount = requests.length;
  await page.reload();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.waitForTimeout(150);
  expect(requests).toHaveLength(requestCount);
  await page.keyboard.press("Escape");
  await openSettings(page);
  await expect(page.locator(".basemap-service-list li")).toHaveCount(0);
  await addService(page, "重新添加", "restored.example");
  await showBasemaps(page);
  await expect(
    page.getByRole("radio", { name: "重新添加", exact: true }),
  ).toBeChecked();
});

for (const state of ["all-hidden", "empty"]) {
  test(`delayed desktop preferences never fetch default tiles before or after loading (${state})`, async ({
    page,
  }) => {
    await installDesktopMock(page);
    const services =
      state === "empty"
        ? []
        : [
            {
              id: "osm",
              name: "OpenStreetMap",
              type: "XYZ",
              preview: "street",
              url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
              enabled: false,
            },
          ];
    await page.addInitScript(
      ({ preferences }) => {
        localStorage.setItem("test.basemaps", preferences);
        window.__BASEMAP_PREFS_PENDING__ = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        window.__RELEASE_BASEMAP_PREFS__ = release;
        const internals = (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (
                command: string,
                args?: Record<string, unknown>,
              ) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__;
        const original = internals.invoke;
        internals.invoke = async (command, args) => {
          if (command === "load_preferences") {
            window.__BASEMAP_PREFS_PENDING__ = true;
            await gate;
            window.__BASEMAP_PREFS_PENDING__ = false;
          }
          return original(command, args);
        };
      },
      {
        preferences: JSON.stringify({
          services,
          selected: "osm",
          visible: true,
        }),
      },
    );
    const requests: string[] = [];
    await page.route("**/tile.openstreetmap.org/**", async (route) => {
      requests.push(route.request().url());
      await route.fulfill({ status: 204 });
    });
    for (const phase of ["initial", "restart"]) {
      if (phase === "initial") await page.goto("/");
      else await page.reload();
      await expect(
        page.getByLabel("地理数据地图", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.__BASEMAP_PREFS_PENDING__))
        .toBe(true);
      await page.waitForTimeout(150);
      expect(requests).toEqual([]);
      await page.evaluate(() => window.__RELEASE_BASEMAP_PREFS__());
      await expect
        .poll(() => page.evaluate(() => window.__BASEMAP_PREFS_PENDING__))
        .toBe(false);
      await openSettings(page);
      await expect(page.locator(".basemap-service-list li")).toHaveCount(
        services.length,
      );
      await showBasemaps(page);
      await expect(page.getByRole("radio")).toHaveCount(0);
      await page.waitForTimeout(150);
      expect(requests).toEqual([]);
    }
  });
}
