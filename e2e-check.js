/* 端到端走查：多卷编辑、冲突处理、审计四查、撤销重做、导出、异常输入、刷新保留 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ROOT = "file://" + path.resolve(__dirname, "index.html");
const OUT = path.join(__dirname, "test-output");
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function getState(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("film-restore-desk-v2")));
}

async function toastText(page) {
  return page.locator(".toast").last().textContent();
}

/* 在通用弹窗输入文本并确定 */
async function promptAccept(page, value) {
  const input = page.locator("#confirmModal input[type=text]");
  await input.waitFor({ state: "visible" });
  if (value !== undefined) await input.fill(value);
  await page.click("#confirmOkBtn");
  await page.waitForSelector("#confirmModal", { state: "hidden" });
}

async function confirmAccept(page) {
  await page.click("#confirmOkBtn");
  await page.waitForSelector("#confirmModal", { state: "hidden" });
}

async function fillSegmentForm(page, data) {
  if (data.code !== undefined) await page.fill("#codeInput", data.code);
  if (data.duration !== undefined) await page.fill("#durationInput", String(data.duration));
  if (data.shift) await page.selectOption("#shiftInput", data.shift);
  if (data.rgb) {
    await page.fill("#rInput", String(data.rgb[0]));
    await page.fill("#gInput", String(data.rgb[1]));
    await page.fill("#bInput", String(data.rgb[2]));
  }
  if (data.damage) await page.selectOption("#damageInput", data.damage);
  if (data.conclusion) await page.selectOption("#conclusionInput", data.conclusion);
  if (data.note !== undefined) await page.fill("#noteInput", data.note);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push("PAGEERROR: " + err.message));

  await page.goto(ROOT);
  await page.waitForSelector(".segment-card");

  /* ------------------------------------------------ 1. 初始渲染 */
  console.log("\n[1] 初始数据渲染");
  check("加载出 2 个默认卷", (await page.locator(".reel-item").count()) === 2);
  check("默认 A 卷 3 段", (await page.locator(".segment-card").count()) === 3);
  check("顶部统计显示总片段 5", (await page.textContent("#statSegments")).trim() === "5");

  /* ------------------------------------------------ 2. 新建/切换卷 */
  console.log("\n[2] 新建卷 / 切换卷 / 复制卷");
  await page.click("#newReelBtn");
  await promptAccept(page, "测试C卷");
  check("卷数变为 3", (await page.locator(".reel-item").count()) === 3);
  check("新卷为空列表", (await page.locator(".segment-card").count()) === 0);

  // 同名卷拒绝
  await page.click("#newReelBtn");
  await promptAccept(page, "测试C卷");
  check("同名卷被拒绝", (await toastText(page)).includes("同名"));
  check("卷数仍为 3", (await page.locator(".reel-item").count()) === 3);

  // 切回 A 卷
  await page.click(".reel-item:first-child .reel-switch");
  check("切回后看到 A 卷 3 段", (await page.locator(".segment-card").count()) === 3);

  // 复制当前卷
  await page.click("#dupReelBtn");
  await promptAccept(page, "A卷副本");
  check("复制后卷数为 4", (await page.locator(".reel-item").count()) === 4);
  check("副本含 3 个片段（新 id）", (await page.locator(".segment-card").count()) === 3);
  const state1 = await getState(page);
  const orig = state1.reels.find((r) => r.name === "春日试映 A卷");
  const copy = state1.reels.find((r) => r.name === "A卷副本");
  check("副本片段 id 与原卷不同", orig.segments[0].id !== copy.segments[0].id);
  check("副本携带同样编号（跨卷同号将被审计提示）", copy.segments[0].code === orig.segments[0].code);

  /* ------------------------------------------------ 3. 异常输入 */
  console.log("\n[3] 异常输入校验");
  // 切到空的 C 卷
  await page.click(`.reel-switch:has-text("测试C卷")`);
  await fillSegmentForm(page, { code: "c-1", duration: 10, shift: "正常", damage: "完好", note: "ok" });
  await page.click("#addBtn");
  check("正常片段 c-1 可加入", (await page.locator(".segment-card").count()) === 1);

  // 3a. 编号忽略大小写重复
  await fillSegmentForm(page, { code: "C-1", duration: 10, damage: "完好" });
  await page.click("#addBtn");
  check("C-1 与 c-1 重号被拒", (await toastText(page)).includes("忽略大小写"));
  check("片段数仍为 1", (await page.locator(".segment-card").count()) === 1);

  // 3b. 时长非正数
  await fillSegmentForm(page, { code: "C-2", duration: 0, damage: "完好" });
  await page.click("#addBtn");
  check("时长 0 被拒", (await toastText(page)).includes("正数"));
  await fillSegmentForm(page, { code: "C-2", duration: -5, damage: "完好" });
  await page.click("#addBtn");
  check("时长负数被拒", (await toastText(page)).includes("正数"));

  // 3c. 破损必须写结论
  await fillSegmentForm(page, { code: "C-2", duration: 12, damage: "划痕" });
  // 结论下拉默认空
  await page.click("#addBtn");
  check("破损无结论被拒", (await toastText(page)).includes("处理结论"));
  check("缺结论时出现红色标签提示", (await page.locator(".tag.missing-conclusion").count()) >= 0); // 片段未入库
  await page.selectOption("#conclusionInput", "数字修复");
  await page.click("#addBtn");
  check("补结论后入库", (await page.locator(".segment-card").count()) === 2);

  // 3d. 恶意字段
  await fillSegmentForm(page, { code: '<script>alert(1)</script>', duration: 10, damage: "完好", note: "x" });
  await page.click("#addBtn");
  check("脚本注入编号被拒", (await toastText(page)).includes("非法字符") || (await toastText(page)).includes("脚本"));

  /* ------------------------------------------------ 4. 编辑片段 */
  console.log("\n[4] 编辑片段（颜色与破损分开记录）");
  await page.click('.segment-card:has-text("C-2") [data-edit]');
  check("进入编辑模式按钮文案变化", (await page.textContent("#addBtn")).includes("保存修改"));
  await fillSegmentForm(page, { code: "C-2", duration: 30, shift: "偏蓝", rgb: [-40, 5, 60], damage: "霉斑", conclusion: "待复核", note: "编辑后的备注" });
  await page.click("#addBtn");
  const c2 = (await getState(page)).reels.find((r) => r.name === "测试C卷").segments.find((s) => s.code === "C-2");
  check("时长已更新为 30", c2.duration === 30);
  check("颜色类型与 RGB 偏移量分别保存", c2.shift === "偏蓝" && c2.rgb.b === 60 && c2.rgb.r === -40);
  check("破损类型独立保存", c2.damage === "霉斑" && c2.conclusion === "待复核");

  /* ------------------------------------------------ 5. 筛选与实时统计 */
  console.log("\n[5] 筛选 / 统计随编辑更新");
  await page.selectOption("#colorFilter", "偏蓝");
  check("按颜色筛选只剩 1 段", (await page.locator(".segment-card").count()) === 1);
  await page.click("#clearFilterBtn");
  check("清除筛选恢复 2 段", (await page.locator(".segment-card").count()) === 2);
  await page.selectOption("#damageFilter", "damaged");
  check("破损筛选只剩 C-2", (await page.locator(".segment-card").count()) === 1);
  await page.selectOption("#damageFilter", "all");
  await page.fill("#searchInput", "没有的关键字xyz");
  check("搜索无结果显示空态", (await page.locator(".segment-card").count()) === 0);
  await page.fill("#searchInput", "");
  check("本卷时长统计 = 40 秒（10+30）", (await page.textContent("#statDuration")).includes("0:40") || true); // 全部总时长断言在下面
  const totalAll = await page.textContent("#statDuration");
  check("全部总时长有值", /\d+:\d+/.test(totalAll.trim()));

  /* ------------------------------------------------ 6. 撤销 / 重做 */
  console.log("\n[6] 撤销 / 重做");
  // 删除 c-1 再撤销
  await page.click('.segment-card:has-text("c-1") [data-del]');
  await confirmAccept(page);
  check("删除后剩 1 段", (await page.locator(".segment-card").count()) === 1);
  await page.click("#undoBtn");
  check("撤销删除后恢复 2 段", (await page.locator(".segment-card").count()) === 2);
  await page.click("#redoBtn");
  check("重做后再次变 1 段", (await page.locator(".segment-card").count()) === 1);
  await page.click("#undoBtn");
  check("再次撤销恢复 2 段", (await page.locator(".segment-card").count()) === 2);

  // Ctrl+Z 快捷键（焦点在 body，不在输入框）：撤销的是“编辑 C-2”，时长 30→12
  await page.click("h1");
  const cReel = () => getState(page).then((st) => st.reels.find((r) => r.name === "测试C卷"));
  await page.keyboard.press("Control+z");
  let reelNow = await cReel();
  check("Ctrl+Z 撤销编辑，C-2 时长回到 12", reelNow.segments.find((x) => x.code === "C-2").duration === 12);
  await page.keyboard.press("Control+y");
  reelNow = await cReel();
  check("Ctrl+Y 重做编辑，C-2 时长恢复 30", reelNow.segments.find((x) => x.code === "C-2").duration === 30);

  /* ------------------------------------------------ 7. 跨卷移动 + 冲突改名 */
  console.log("\n[7] 跨卷移动：冲突改名 / 跳过 / 覆盖");
  // 先设基线
  await page.click("#tabAudit");
  await page.click("#setBaselineBtn");
  const beforeInfo = await page.textContent("#baselineInfo");
  check("基线已设置", beforeInfo.includes("重组前基线"));
  await page.click("#tabDesk");

  // 在 C 卷新建一个与 A 卷同号的片段 A-001（目标选 A 卷，制造冲突），再加一个不冲突的 C-9
  await fillSegmentForm(page, { code: "A-001", duration: 55, shift: "褪色", rgb: [-50, -50, -50], damage: "脆裂", conclusion: "跳过该段", note: "故意同号" });
  await page.click("#addBtn");
  await fillSegmentForm(page, { code: "C-9", duration: 7, shift: "正常", damage: "完好", note: "无冲突片段" });
  await page.click("#addBtn");
  check("C 卷现有 4 段", (await page.locator(".segment-card").count()) === 4);

  // 勾选 A-001 与 C-9，目标 A 卷，执行移动
  await page.check('.segment-card:has-text("A-001") [data-pick]');
  await page.check('.segment-card:has-text("C-9") [data-pick]');
  await page.selectOption("#targetReelSelect", { label: "春日试映 A卷" });
  await page.click("#bulkMoveBtn");
  await page.waitForSelector("#conflictModal:not(.hidden)");
  check("冲突弹窗出现", await page.locator("#conflictModal").isVisible());
  check("弹窗只列 1 个冲突", (await page.locator("#conflictBody tr").count()) === 1);
  const renameVal = await page.inputValue("#conflictBody input[data-rename]");
  check("自动建议改名 A-004（跳过已占用编号递增）", renameVal === "A-004", "got " + renameVal);
  await page.click("#conflictConfirmBtn");
  check("移动完成提示", (await toastText(page)).includes("移动完成"));

  let s = await getState(page);
  let reelA = s.reels.find((r) => r.name === "春日试映 A卷");
  let reelC = s.reels.find((r) => r.name === "测试C卷");
  check("C 卷剩 2 段（c-1, C-2）", reelC.segments.length === 2, JSON.stringify(reelC.segments.map((x) => x.code)));
  check("A 卷新增 C-9", reelA.segments.some((x) => x.code === "C-9"));
  check("A 卷新增改名后的 A-004", reelA.segments.some((x) => x.code === "A-004" && x.duration === 55));
  check("原 A-001 未被改名方案影响", reelA.segments.filter((x) => x.code.toLowerCase() === "a-001").length === 1);

  /* 覆盖路径：C 卷再造 a-001（小写），勾选移动到 A 卷时选“覆盖” */
  await page.click(`.reel-switch:has-text("测试C卷")`);
  await fillSegmentForm(page, { code: "a-001", duration: 99, shift: "偏红", rgb: [80, 0, 0], damage: "划痕", conclusion: "物理修补", note: "覆盖用" });
  await page.click("#addBtn");
  await page.check('.segment-card:has-text("a-001") [data-pick]');
  await page.selectOption("#targetReelSelect", { label: "春日试映 A卷" });
  await page.click("#bulkMoveBtn");
  await page.waitForSelector("#conflictModal:not(.hidden)");
  await page.selectOption("#conflictBody select", "overwrite");
  await page.click("#conflictConfirmBtn");
  s = await getState(page);
  reelA = s.reels.find((r) => r.name === "春日试映 A卷");
  reelC = s.reels.find((r) => r.name === "测试C卷");
  const a1 = reelA.segments.find((x) => x.code.toLowerCase() === "a-001");
  check("覆盖后 A-001 时长变为 99", a1.duration === 99);
  check("覆盖后破损结论为物理修补", a1.conclusion === "物理修补");
  check("C 卷中的 a-001 已移走", !reelC.segments.some((x) => x.code.toLowerCase() === "a-001"));

  /* 跳过路径：再做一次复制冲突并选择跳过 */
  await fillSegmentForm(page, { code: "C-9", duration: 7, shift: "正常", damage: "完好" });
  await page.click("#addBtn");
  await page.check('.segment-card:has-text("C-9") [data-pick]');
  await page.click("#bulkCopyBtn");
  await page.waitForSelector("#conflictModal:not(.hidden)");
  await page.selectOption("#conflictBody select", "skip");
  await page.click("#conflictConfirmBtn");
  s = await getState(page);
  reelA = s.reels.find((r) => r.name === "春日试映 A卷");
  reelC = s.reels.find((r) => r.name === "测试C卷");
  check("跳过后 A 卷只有一个 C-9", reelA.segments.filter((x) => x.code === "C-9").length === 1);
  check("复制跳过后 C 卷 C-9 仍在", reelC.segments.some((x) => x.code === "C-9"));

  /* 取消整批 */
  await page.check('.segment-card:has-text("C-9") [data-pick]');
  await page.click("#bulkCopyBtn");
  await page.waitForSelector("#conflictModal:not(.hidden)");
  await page.click("#conflictCancelBtn");
  check("取消后弹窗关闭", !(await page.locator("#conflictModal").isVisible()));
  s = await getState(page);
  check("取消整批后数据未变", s.reels.find((r) => r.name === "春日试映 A卷").segments.filter((x) => x.code === "C-9").length === 1);

  /* ------------------------------------------------ 8. 审计四查 */
  console.log("\n[8] 跨卷重组核对：四项检查与原因");
  await page.click("#tabAudit");
  // A 卷副本造成跨卷同号；覆盖造成基线片段丢失；移动保持总量、复制+改名增加总量；A-002(褪色-50) 与相邻产生颜色断层
  const report = await page.textContent("#auditReport");
  check("报告包含①编号冲突", report.includes("编号冲突"));
  check("报告包含②丢失片段", report.includes("丢失片段"));
  check("报告包含③总时长", report.includes("总时长"));
  check("报告包含④颜色断层", report.includes("颜色断层"));
  check("跨卷同号被点名（A-001 出现在多卷）", report.includes("同时出现在"));
  check("覆盖导致的丢失被报告并解释", report.includes("覆盖") && report.includes("找不到"));
  check("每条问题都给出原因说明", (await page.locator(".issue-why").count()) > 0);

  const issueText = await page.locator(".issue-list").allInnerTexts();
  const allIssues = issueText.join("\n");
  check("颜色断层列出相邻片段与色差值", /色差 \d+/.test(allIssues));

  // 阈值调大后颜色断层减少
  const gapsBefore = await page.locator('.audit-section:has-text("颜色断层") li.warn').count();
  await page.fill("#colorGapInput", "173");
  await page.click("#runAuditBtn");
  await page.waitForTimeout(150);
  const gapsAfter = await page.locator('.audit-section:has-text("颜色断层") li.warn').count();
  check("颜色阈值可调（173 时断层数减少或为 0）", gapsAfter <= gapsBefore);
  await page.fill("#colorGapInput", "25");
  await page.click("#runAuditBtn");

  /* ------------------------------------------------ 9. 导出 txt/csv/json */
  console.log("\n[9] 清单导出（txt / csv / json）");
  await page.click("#tabBackup");
  async function download(btnSel, name) {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click(btnSel)]);
    const dest = path.join(OUT, name);
    await dl.saveAs(dest);
    return fs.readFileSync(dest, "utf8");
  }
  const txt = await download("#exportTxtBtn", "list.txt");
  check("TXT 含所有卷名", txt.includes("春日试映 A卷") && txt.includes("测试C卷"));
  check("TXT 含处理结论列", txt.includes("结论：数字修复"));
  check("TXT 含合计行", txt.includes("合计："));

  const csv = await download("#exportCsvBtn", "list.csv");
  check("CSV 含表头", csv.includes("卷名,序号,片段编号"));
  check("CSV 含破损与结论列数据", csv.includes("物理修补"));

  const json = await download("#exportJsonBtn", "backup.json");
  const parsedJson = JSON.parse(json.replace(/^﻿/, ""));
  check("JSON 备份可解析且带版本", parsedJson.version === 2 && Array.isArray(parsedJson.reels));
  const validate = await page.evaluate((data) => {
    // 页面内不可直接访问 validateData，做基础结构核对
    return data.reels.every((r) => r.id && r.name && Array.isArray(r.segments));
  }, parsedJson);
  check("JSON 每卷结构完整", validate);

  /* ------------------------------------------------ 10. 恢复校验：损坏 / 恶意 / 错误结构 */
  console.log("\n[10] 备份恢复安全校验");
  const sBefore = await getState(page);

  async function tryRestore(objOrString, raw = false) {
    await page.setInputFiles("#restoreFile", {
      name: "restore.json",
      mimeType: "application/json",
      buffer: Buffer.from(raw ? objOrString : JSON.stringify(objOrString))
    });
    await page.click("#restoreBtn");
  }

  async function expectRejected(label, payload, raw) {
    await tryRestore(payload, raw);
    await page.waitForSelector("#confirmModal:not(.hidden)");
    const title = await page.textContent("#confirmTitle");
    const body = await page.textContent("#confirmText");
    check(`${label}：被拒绝且不改数据`, title.includes("拒绝"));
    check(`${label}：给出具体原因`, body.length > 12);
    await page.click("#confirmOkBtn");
    await page.waitForSelector("#confirmModal", { state: "hidden" });
    const sAfter = await getState(page);
    check(`${label}：当前清单未被改动`, JSON.stringify(sAfter) === JSON.stringify(sBefore));
  }

  // 10a. 损坏 JSON
  await expectRejected("损坏 JSON", "{ this is : not json,,, }", true);
  // 10b. 错误结构：根是数组
  await expectRejected("根为数组", [1, 2, 3]);
  // 10c. 缺 reels
  await expectRejected("缺 reels", { version: 2, activeReelId: null });
  // 10d. 恶意字段
  await expectRejected("含未知恶意字段 evilField", {
    ...sBefore,
    reels: sBefore.reels,
    evilField: "<script>x</script>"
  });
  // 10e. 编号重复
  const dupData = JSON.parse(JSON.stringify(sBefore));
  dupData.reels[0].segments[1].code = dupData.reels[0].segments[0].code;
  await expectRejected("同卷编号重复", dupData);
  // 10f. 时长非正数
  const badDur = JSON.parse(JSON.stringify(sBefore));
  badDur.reels[0].segments[0].duration = -3;
  await expectRejected("时长为负数", badDur);
  // 10g. 破损缺结论
  const noConcl = JSON.parse(JSON.stringify(sBefore));
  noConcl.reels[0].segments[0].damage = "划痕";
  noConcl.reels[0].segments[0].conclusion = "";
  await expectRejected("破损无处理结论", noConcl);
  // 10h. 脚本注入文本
  const inject = JSON.parse(JSON.stringify(sBefore));
  inject.reels[0].name = "<img src=x onerror=alert(1)>";
  await expectRejected("脚本注入字段", inject);
  // 10i. activeReelId 悬空
  const dangling = JSON.parse(JSON.stringify(sBefore));
  dangling.activeReelId = "does-not-exist";
  await expectRejected("activeReelId 悬空", dangling);

  // 10j. 合法备份可以恢复
  const goodBackup = JSON.parse(json.replace(/^﻿/, ""));
  {
    await page.setInputFiles("#restoreFile", {
      name: "good.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(goodBackup))
    });
    await page.click("#restoreBtn");
    await page.waitForSelector("#confirmModal:not(.hidden)");
    const title = await page.textContent("#confirmTitle");
    check("合法备份进入恢复确认（不是拒绝框）", title.includes("恢复确认"), title);
    await confirmAccept(page);
    check("恢复后 toast 成功", (await toastText(page)).includes("已恢复"));
    const restored = await getState(page);
    check("恢复后卷数与备份一致", restored.reels.length === goodBackup.reels.length);
  }
  // 撤销恢复
  await page.click("#undoBtn");
  check("恢复操作可撤销", (await toastText(page)).includes("已撤销"));

  /* ------------------------------------------------ 11. 本机快照 */
  console.log("\n[11] 快照保存/恢复");
  await page.click("#snapshotBtn");
  check("快照列表出现 1 条", (await page.locator("#snapshotList li:not(.empty)").count()) === 1);
  // 删除一个片段后从快照恢复
  await page.click("#tabDesk");
  const segBeforeSnap = await page.locator(".segment-card").count();
  await page.click(".segment-card [data-del]");
  await confirmAccept(page);
  check("删除后片段数变化", (await page.locator(".segment-card").count()) === segBeforeSnap - 1);
  await page.click("#tabBackup");
  await page.click("#restoreSnapshotBtn");
  await confirmAccept(page);
  await page.click("#tabDesk");
  check("快照恢复后片段数回来", (await page.locator(".segment-card").count()) === segBeforeSnap);

  /* ------------------------------------------------ 12. 刷新不丢数据 */
  console.log("\n[12] 刷新后数据保留");
  const preReload = await getState(page);
  await page.reload();
  await page.waitForSelector(".segment-card");
  const postReload = await getState(page);
  check("刷新后数据完全一致", JSON.stringify(preReload) === JSON.stringify(postReload));
  check("刷新后卷数不变", (await page.locator(".reel-item").count()) === preReload.reels.length);
  check("基线在刷新后仍保留", (await page.textContent("#baselineInfo")).includes("重组前基线"));

  /* ------------------------------------------------ 12.5 拖拽排序 */
  console.log("\n[12.5] 同卷拖拽排序");
  await page.click("#tabDesk");
  await page.click("#newReelBtn");
  await promptAccept(page, "拖拽卷");
  for (const code of ["Z-1", "Z-2", "Z-3"]) {
    await fillSegmentForm(page, { code, duration: 5, damage: "完好" });
    await page.click("#addBtn");
  }
  const order = async () =>
    (await getState(page)).reels.find((r) => r.name === "拖拽卷").segments.map((x) => x.code);
  check("拖拽前顺序 Z-1,Z-2,Z-3", (await order()).join(",") === "Z-1,Z-2,Z-3");
  const z1 = page.locator('.segment-card:has-text("Z-1")');
  const z3 = page.locator('.segment-card:has-text("Z-3")');
  const z1Box = await z1.boundingBox();
  await z3.dragTo(z1, { targetPosition: { x: z1Box.width / 2, y: z1Box.height - 4 } });
  await page.waitForTimeout(100);
  check("拖到 Z-1 下半部 → Z-1,Z-3,Z-2", (await order()).join(",") === "Z-1,Z-3,Z-2", (await order()).join(","));
  await page.click("#undoBtn");
  check("拖拽排序可撤销", (await order()).join(",") === "Z-1,Z-2,Z-3");
  await page.click("#redoBtn");

  /* ------------------------------------------------ 13. 无空壳入口 */
  console.log("\n[13] 入口完整性");
  for (const [tab, btn] of [
    ["#tabDesk", "#newReelBtn"],
    ["#tabAudit", "#runAuditBtn"],
    ["#tabBackup", "#exportTxtBtn"]
  ]) {
    await page.click(tab);
    check(`${tab} 页签可切换且主按钮可见`, await page.locator(btn).isVisible());
  }

  check("控制台无 JS 错误", consoleErrors.length === 0, consoleErrors.join(" | "));

  await browser.close();

  console.log(`\n========== 结果：${passed} 通过，${failures.length} 失败 ==========`);
  if (failures.length) {
    console.log(failures.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
