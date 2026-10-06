import { expect } from "@playwright/test";
export async function layerBasemapSmoke(page, restoring = false) {
  if (restoring) {
    await page.getByRole("button", { name: "底图", exact: true }).click();
    await expect(page.getByRole("radio", { name: "恢复底图", exact: true })).toBeChecked();
    await expect(page.getByRole("radio").first()).toHaveAttribute("aria-label", "恢复底图");
    await expect(page.getByRole("checkbox", { name: "显示底图", exact: true })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tree").locator(".tree-row").filter({hasText: "甲孙组"})).toHaveAttribute("aria-level", "5");
    return;
  }
  const tree = page.getByRole("tree", { name: "图层树" });
  const row = name => tree.locator(".tree-row").filter({has:page.locator(".layer-text").filter({hasText: new RegExp(`^${name}$`)})});
  const create = async (name, parent) => {
    if (parent) await row(parent).click({button:"right"});
    else await tree.click({button:"right", position:{x:30,y:300}});
    await page.getByRole("menuitem", {name:"新建分组…"}).click();
    await page.getByLabel("分组名称").fill(name);
    await page.getByRole("button",{name:"创建",exact:true}).click();
  };
  const drag = async (from, to) => {
    const a=await row(from).boundingBox(), b=await row(to).boundingBox();
    await page.mouse.move(a.x+110,a.y+a.height/2); await page.mouse.down();
    await page.mouse.move(b.x+110,b.y+b.height/2,{steps:15}); await page.mouse.up();
  };
  await create("甲组"); await create("甲子组","甲组"); await create("甲孙组","甲子组");
  await create("乙组"); await create("乙子组","乙组");
  await row("乙子组").getByRole("button",{name:"折叠 乙子组"}).click();
  await drag("甲组","乙子组");
  await expect(row("甲孙组")).toHaveAttribute("aria-level","5");
  await expect(row("乙子组")).toHaveAttribute("aria-expanded","true");
  await drag("甲组","甲孙组");
  await expect(row("甲组")).toHaveAttribute("aria-level","3");
  await page.getByRole("button",{name:"编辑顶点",exact:true}).click();
  await page.getByRole("button",{name:"关闭窗口",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"退出 zGIS"})).toBeVisible();
  await page.getByRole("dialog").getByRole("button",{name:"取消",exact:true}).click();
  await page.getByRole("button",{name:"选择",exact:true}).click();
  await page.getByRole("button",{name:"设置",exact:true}).click();
  await page.getByRole("navigation",{name:"设置分类"}).getByRole("button",{name:"地图",exact:true}).click();
  await page.getByLabel("新底图名称").fill("恢复底图");
  await page.getByLabel("XYZ 瓦片地址").fill("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  await page.getByRole("button",{name:"添加底图",exact:true}).click();
  for(let i=0;i<3;i++) await page.getByRole("button",{name:"上移 恢复底图",exact:true}).click();
  await page.getByLabel("底图类型").selectOption({label:"恢复底图"});
  await page.screenshot({path:"output/desktop/basemap-settings.png"});
  await page.getByRole("button",{name:"返回地图",exact:true}).click();
  await page.getByRole("button",{name:"底图",exact:true}).click();
  await expect(page.getByRole("radio").first()).toBeChecked();
  await page.screenshot({path:"output/desktop/nested-basemap.png"});
  await page.keyboard.press("Escape");
}
