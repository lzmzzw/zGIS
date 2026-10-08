import { expect, test, type Page } from "@playwright/test";
import { installDesktopMock, openDatabaseManager, addTestSource, loadDatabaseTestLayer } from "./desktop.mock";

async function loadMysql(page: Page, table = "roads") {
  await installDesktopMock(page);
  await page.goto("/");
  await page.evaluate(() => { window.__ZG_TEST__.features[0].dbKey = ["9007199254740993"]; });
  await openDatabaseManager(page, "Mysql");
  await addTestSource(page, "可编辑 MySQL", "Mysql");
  const manager = page.getByRole("region", {name:"Mysql 数据源管理",exact:true});
  await manager.locator(".pg-table").filter({hasText:new RegExp(`^${table}$`)}).click();
  await manager.getByRole("button", {name:"添加到地图",exact:true}).click();
  await page.getByRole("button", {name:"载入",exact:true}).click();
  await page.locator(".attribute-panel").getByRole("button", {name:"展开属性表",exact:true}).click();
  await page.locator(".attribute-panel tbody tr").first().click();
}

async function changeName(page: Page, value: string) {
  await page.getByRole("button", {name:"编辑属性",exact:true}).click();
  await page.locator('.attribute-panel tbody tr.selected td[data-field="name"]').dblclick();
  await page.getByLabel("属性 name", {exact:true}).fill(value);
  await page.getByRole("button", {name:"应用",exact:true}).click();
}

const mysqlCommits = (page: Page) => page.evaluate(() => window.__ZG_TEST__.calls.filter(c => c.command === "commit_mysql_changes"));

test("MySQL attribute-table edits retain precise keys, save directly, and reload the source", async ({page}) => {
  await loadMysql(page);
  const value = "90071992547409931234567890.000001 '修改道路'";
  await changeName(page, value);
  await page.getByRole("button", {name:"保存并退出编辑",exact:true}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".attribute-panel tbody tr")).toContainText(value);
  const calls = await mysqlCommits(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toEqual(expect.objectContaining({connectionId:"connect_mysql_database-1",layer:expect.objectContaining({engine:"mysql",schema:"test",table:"roads",geometryColumn:"geom",srid:4326})}));
  expect(calls[0].args.changes).toEqual([expect.objectContaining({kind:"update",dbKey:["9007199254740993"],baseline:"baseline-1",properties:{name:value}})]);
  const all = await page.evaluate(() => window.__ZG_TEST__.calls);
  expect(all.filter(c => c.command === "query_mysql_geometry")).toHaveLength(2);
  expect(all.some(c => c.command === "commit_changes" || c.command === "save_file")).toBe(false);
});

test("MySQL conflicts preserve the attribute draft and allow an explicit retry", async ({page}) => {
  await loadMysql(page); await changeName(page, "保留的 MySQL 草稿");
  await page.evaluate(() => { window.__ZG_TEST__.commitError = "并发冲突：原记录已变化"; });
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText("并发冲突");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", {name:"保存并退出编辑",exact:true})).toBeEnabled();
  await expect(page.locator(".attribute-panel tbody tr")).toContainText("保留的 MySQL 草稿");
  await page.evaluate(() => { window.__ZG_TEST__.commitError = ""; });
  await page.getByRole("button", {name:"保存并退出编辑",exact:true}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await mysqlCommits(page)).toHaveLength(2);
});

test("MySQL tables without a primary key remain selectable and read only", async ({page}) => {
  await loadMysql(page, "readonly");
  await expect(page.getByRole("button", {name:"编辑属性",exact:true})).toBeDisabled();
  await expect(page.getByRole("button", {name:"编辑",exact:true})).toBeDisabled();
  await expect(page.getByRole("button", {name:"选择",exact:true})).toBeEnabled();
  expect(await mysqlCommits(page)).toHaveLength(0);
});

test("MySQL WKT geometry editing commits through the MySQL source route", async ({page}) => {
  await loadMysql(page);
  await page.getByRole("button", {name:"编辑",exact:true}).click();
  await page.getByLabel("地理数据地图", {exact:true}).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", {name:"WKT 几何…",exact:true}).click();
  await page.getByRole("textbox", {name:"WKT 几何",exact:true}).fill("POINT(117 41)");
  await page.getByRole("button", {name:"应用几何",exact:true}).click();
  await page.getByRole("dialog").getByRole("button", {name:"关闭",exact:true}).first().click();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calls = await mysqlCommits(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].args.changes).toEqual([expect.objectContaining({kind:"update",geometry:{type:"Point",coordinates:[117,41]},dbKey:["9007199254740993"]})]);
  expect(await page.evaluate(() => window.__ZG_TEST__.features[0].geometry)).toEqual({type:"Point",coordinates:[117,41]});
});

test("MySQL uncertain saves retain edits and disable repeat submission", async ({page}) => {
  await loadMysql(page); await changeName(page, "待核实 MySQL 修改");
  await page.evaluate(() => { window.__ZG_TEST__.commitError = "提交结果待核对"; });
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText("提交结果待核对");
  await expect(page.getByRole("button", {name:"保存并退出编辑",exact:true})).toBeDisabled();
  await expect(page.getByRole("button", {name:"保存编辑",exact:true})).toBeDisabled();
  await expect(page.locator(".attribute-panel tbody tr")).toContainText("待核实 MySQL 修改");
  await page.keyboard.press("Control+s");
  expect(await mysqlCommits(page)).toHaveLength(1);
});

async function fieldAction(page: Page, field: string, action: string) {
  await page.locator(".attribute-panel thead th").filter({has:page.locator(`summary:text-is("${field}")`)}).click({button:"right"});
  await page.getByRole("menuitem", {name:action,exact:true}).click();
}
const fieldHeader = (page: Page, field: string) => page.locator(".attribute-panel thead summary").filter({hasText:new RegExp(`^${field}$`)});

test("MySQL partially committed DDL preserves the schema draft and blocks every save route", async ({page}) => {
  await loadMysql(page);
  await page.getByRole("button", {name:"编辑属性",exact:true}).click();
  await fieldAction(page, "name", "添加字段");
  await page.getByLabel("新字段名", {exact:true}).fill("partial_field");
  await page.getByRole("dialog").getByRole("button", {name:"添加字段",exact:true}).click();
  await page.evaluate(() => {
    window.__ZG_TEST__.commitError = "字段结构已提交；数据修改未完成或结果待核对，请重新加载核实，禁止直接重试";
  });
  await page.getByRole("button", {name:"保存属性编辑",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("字段结构已提交");
  await expect(fieldHeader(page, "partial_field")).toHaveCount(1);
  for (const name of ["保存属性编辑", "保存编辑", "保存并退出编辑"])
    await expect(page.getByRole("button", {name,exact:true})).toBeDisabled();
  await page.keyboard.press("Control+s");
  const commits = await mysqlCommits(page);
  expect(commits).toHaveLength(1);
  expect(commits[0].args.schemaChanges).toEqual([{kind:"add",name:"partial_field"}]);
  await expect(fieldHeader(page, "partial_field")).toHaveCount(1);
});

for (const engine of ["PostGIS", "Mysql"] as const) {
  test(`${engine} attribute toolbar inserts and deletes records with the same direct-save interaction`, async ({page}) => {
    if (engine === "Mysql") await loadMysql(page);
    else {
      await installDesktopMock(page); await page.goto("/"); await loadDatabaseTestLayer(page);
      await page.getByRole("button", {name:"载入",exact:true}).click();
      await page.getByRole("button", {name:"展开属性表",exact:true}).click();
      await page.locator(".attribute-panel tbody tr").first().click();
    }
    await page.getByRole("button", {name:"编辑属性",exact:true}).click();
    await page.getByRole("button", {name:"新增记录",exact:true}).click();
    await expect(page.locator(".attribute-panel tbody tr")).toHaveCount(2);
    await page.locator('.attribute-panel tbody tr.selected td[data-field="name"]').dblclick();
    await page.getByLabel("属性 name", {exact:true}).fill("新增的数据库记录");
    await page.getByRole("button", {name:"应用",exact:true}).click();
    await page.getByRole("button", {name:"保存属性编辑",exact:true}).click();
    await expect(page.getByRole("button", {name:"保存属性编辑",exact:true})).toBeDisabled();
    await expect(page.locator(".attribute-panel tbody tr")).toHaveCount(2);
    const command = engine === "Mysql" ? "commit_mysql_changes" : "commit_changes";
    let commits = await page.evaluate(command => window.__ZG_TEST__.calls.filter(c => c.command === command), command);
    expect(commits).toHaveLength(1);
    expect(commits[0].args.changes).toEqual([expect.objectContaining({kind:"insert",geometry:null,properties:{name:"新增的数据库记录"}})]);
    await page.locator(".attribute-panel tbody tr").first().click();
    await page.getByRole("button", {name:"删除记录",exact:true}).click();
    await page.getByRole("dialog", {name:"删除选中要素",exact:true}).getByRole("button", {name:"删除",exact:true}).click();
    await expect(page.locator(".attribute-panel tbody tr")).toHaveCount(1);
    await page.getByRole("button", {name:"保存属性编辑",exact:true}).click();
    await expect(page.getByRole("button", {name:"保存属性编辑",exact:true})).toBeDisabled();
    commits = await page.evaluate(command => window.__ZG_TEST__.calls.filter(c => c.command === command), command);
    expect(commits).toHaveLength(2);
    expect(commits[1].args.changes).toEqual([expect.objectContaining({kind:"delete",baseline:"baseline-1",dbKey:engine === "Mysql" ? ["9007199254740993"] : [1]})]);
    await expect(page.locator(".attribute-panel tbody tr")).toContainText("新增的数据库记录");
    expect(await page.evaluate(() => window.__ZG_TEST__.calls.some(c => c.command === "save_file"))).toBe(false);
  });

  test(`${engine} field CRUD is undoable and saves schema changes through its source route`, async ({page}) => {
    if (engine === "Mysql") await loadMysql(page);
    else {
      await installDesktopMock(page); await page.goto("/"); await loadDatabaseTestLayer(page);
      await page.getByRole("button", {name:"载入",exact:true}).click();
      await page.getByRole("button", {name:"展开属性表",exact:true}).click();
      await page.locator(".attribute-panel tbody tr").first().click();
    }
    await page.getByRole("button", {name:"编辑",exact:true}).click();
    await fieldAction(page, "name", "添加字段");
    await page.getByLabel("新字段名", {exact:true}).fill("extra");
    await page.getByRole("dialog").getByRole("button", {name:"添加字段",exact:true}).click();
    await expect(fieldHeader(page, "extra")).toHaveCount(1);
    await page.getByRole("button", {name:"撤销",exact:true}).click();
    await expect(fieldHeader(page, "extra")).toHaveCount(0);
    await page.getByRole("button", {name:"重做",exact:true}).click();
    await expect(fieldHeader(page, "extra")).toHaveCount(1);
    await fieldAction(page, "name", "重命名字段");
    await page.getByLabel("新字段名", {exact:true}).fill("label");
    await page.getByRole("dialog").getByRole("button", {name:"重命名字段",exact:true}).click();
    await expect(fieldHeader(page, "label")).toHaveCount(1);
    await expect(page.locator('td[data-field="label"]')).toContainText("道路");
    await fieldAction(page, "extra", "删除字段");
    await page.getByRole("dialog").getByRole("button", {name:"删除字段",exact:true}).click();
    await expect(fieldHeader(page, "extra")).toHaveCount(0);
    await page.evaluate(() => { window.__ZG_TEST__.commitError = "字段修改冲突"; });
    await page.getByRole("button", {name:"保存编辑",exact:true}).click();
    await expect(page.getByRole("alert")).toContainText("字段修改冲突");
    await expect(fieldHeader(page, "label")).toHaveCount(1);
    await page.evaluate(() => { window.__ZG_TEST__.commitError = ""; });
    await page.getByRole("button", {name:"保存编辑",exact:true}).click();
    await expect(page.getByRole("button", {name:"保存编辑",exact:true})).toBeDisabled();
    const command = engine === "Mysql" ? "commit_mysql_changes" : "commit_changes";
    const commits = await page.evaluate(command => window.__ZG_TEST__.calls.filter(c => c.command === command), command);
    expect(commits).toHaveLength(2);
    const schemaChanges = [{kind:"add",name:"extra"},{kind:"rename",name:"name",newName:"label"},{kind:"delete",name:"extra"}];
    expect(commits[0].args.schemaChanges).toEqual(schemaChanges);
    expect(commits[1].args.schemaChanges).toEqual(schemaChanges);
    await expect(fieldHeader(page, "label")).toHaveCount(1);
    await expect(fieldHeader(page, "extra")).toHaveCount(0);
    await page.getByRole("button", {name:"保存并退出编辑",exact:true}).click();
    expect(await page.evaluate(command => window.__ZG_TEST__.calls.filter(c => c.command === command).length, command)).toBe(2);
  });
}
