import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

test("窗口按钮随原生 resize 状态切换最大化与还原图标", async ({ page }) => {
  await installDesktopMock(page);
  await page.addInitScript(() => {
    const internals = (window as any).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    let maximized = false;
    let resizeHandler = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    const transform = internals.transformCallback;
    internals.transformCallback = (callback: (event: unknown) => void) => {
      const id = transform(callback);
      callbacks.set(id, callback);
      return id;
    };
    internals.invoke = async (command: string, args: any = {}) => {
      if (command === "plugin:window|is_maximized") return maximized;
      if (command === "plugin:event|listen" && args.event === "tauri://resize")
        resizeHandler = args.handler;
      if (command === "plugin:window|toggle_maximize") {
        maximized = !maximized;
        callbacks.get(resizeHandler)?.({ event: "tauri://resize", id: 1, payload: {} });
      }
      return invoke(command, args);
    };
  });
  await page.goto("/");
  const maximize = page.getByRole("button", { name: "最大化", exact: true });
  await expect(maximize.locator("svg.lucide-square")).toBeVisible();
  await maximize.click();
  const restore = page.getByRole("button", { name: "还原窗口", exact: true });
  await expect(restore.locator("svg.lucide-copy")).toBeVisible();
  await page.locator(".document-title").dblclick();
  await expect(maximize).toBeVisible();
  await page.screenshot({ path: "output/window-controls/windowed.png" });
  await maximize.click();
  await expect(restore).toBeVisible();
  await page.screenshot({ path: "output/window-controls/maximized.png" });
});
