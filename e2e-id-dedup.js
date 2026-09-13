/* 复测：本机旧记录中的重复身份串 + 清洗失败现场保护
 * 1. 两条卷共用同一个安全标识 → 首个保留，其余独立新值；切换/编辑/持久化正常
 * 2. 两个片段共用同一个安全标识（同卷 & 跨卷）→ 独立新值
 * 3. 基线/快照中的重复标识按同一分配表对齐 → 核对不误报丢失、快照可恢复
 * 4. 清洗无法挽救（编号重复 / JSON 损坏）→ 现场保护：横幅、原始存储逐字节不变、
 *    编辑不落盘、可下载现场、恢复有效备份后退出保护
 * 5. 正常旧数据：原样加载、无横幅、存储不被无谓改写
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ROOT = "file://" + path.resolve(__dirname, "index.html");
const SK = "film-restore-desk-v2";
const BK = "film-restore-desk-baseline-v2";
const SNK = "film-restore-desk-snapshots-v2";
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
const getRaw = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);
const getState = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SK);
const ID_OK = /^[A-Za-z0-9_-]{6,64}$/;

function seg(id, code, over = {}) {
  return { id, code, duration: 10, shift: "正常", rgb: { r: 0, g: 0, b: 0 }, damage: "完好", conclusion: "", note: "", ...over };
}

(async () => {
  const browser = await chromium.launch();

  /* ====================================== 1-3. 重复身份串的位置化修复 */
  console.log("\n[1] 重复卷标识 + 重复片段标识（同卷/跨卷）+ 跨记录引用");
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(ROOT);
  await page.waitForSelector(".segment-card");

  const SHARED_REEL = "reel-shared-id-1";
  const SHARED_SEG = "seg-shared-id-1";
  const sharedData = {
    version: 2,
    reels: [
      {
        id: SHARED_REEL,
        name: "重复卷一",
        segments: [seg(SHARED_SEG, "D-1"), seg(SHARED_SEG, "D-2", { duration: 20 })]
      },
      {
        id: SHARED_REEL, // 与卷一相同 id
        name: "重复卷二",
        segments: [
          seg(SHARED_SEG, "E-1", { duration: 30 }), // 跨卷第三次出现同一片段 id
          seg("seg-uniq-0002", "E-2")
        ]
      }
    ],
    activeReelId: SHARED_REEL
  };
  await page.evaluate(
    ({ SK, BK, SNK, data }) => {
      localStorage.setItem(SK, JSON.stringify(data));
      localStorage.setItem(BK, JSON.stringify({ at: 1, data: JSON.parse(JSON.stringify(data)) }));
      localStorage.setItem(SNK, JSON.stringify([{ at: 1, data: JSON.parse(JSON.stringify(data)), label: "重复id快照" }]));
    },
    { SK, BK, SNK, data: sharedData }
  );

  await page.reload();
  await page.waitForSelector(".segment-card");

  check("无现场保护横幅（修复成功）", !(await page.locator("#safeBanner").isVisible()));
  const st = await getState(page);
  const reel1 = st.reels[0];
  const reel2 = st.reels[1];
  check("首个卷标识原样保留", reel1.id === SHARED_REEL, reel1.id);
  check("第二条卷获得独立新标识", ID_OK.test(reel2.id) && reel2.id !== SHARED_REEL, reel2.id);
  check("两卷标识互不相同", reel1.id !== reel2.id);
  check("activeReelId 指向保留的首卷", st.activeReelId === reel1.id);

  check("首个片段标识原样保留", reel1.segments[0].id === SHARED_SEG);
  const segIds = st.reels.flatMap((r) => r.segments.map((s) => s.id));
  check("三个重复片段实例得到三个互不相同的标识", new Set(segIds).size === segIds.length, segIds.join(","));
  check("第 2、3 个片段标识均为安全格式且不等于原值", reel1.segments[1].id !== SHARED_SEG && reel2.segments[0].id !== SHARED_SEG);
  check("无关的唯一标识未被改动", reel2.segments[1].id === "seg-uniq-0002");

  // 基线 / 快照按同一分配表对齐
  const aligned = await page.evaluate(
    ({ SK, BK, SNK }) => {
      const s = JSON.parse(localStorage.getItem(SK));
      const b = JSON.parse(localStorage.getItem(BK)).data;
      const snap = JSON.parse(localStorage.getItem(SNK))[0].data;
      const eq = (a, c) =>
        a.reels.length === c.reels.length &&
        a.reels.every((r, i) => r.id === c.reels[i].id && r.segments.every((x, j) => x.id === c.reels[i].segments[j].id));
      return { baseline: eq(s, b), snapshot: eq(s, snap) };
    },
    { SK, BK, SNK }
  );
  check("基线身份串与主数据逐一对应", aligned.baseline);
  check("快照身份串与主数据逐一对应", aligned.snapshot);

  // 修复后核心主流程
  check("默认显示首卷 2 段", (await page.locator(".segment-card").count()) === 2);
  await page.click('.reel-switch:has-text("重复卷二")');
  check("可切换到第二卷（2 段）", (await page.locator(".segment-card").count()) === 2);
  await page.click('.segment-card:has-text("E-1") [data-edit]');
  await page.fill("#durationInput", "88");
  await page.click("#addBtn");
  let now = await getState(page);
  check("第二卷片段编辑可保存", now.reels[1].segments[0].duration === 88);

  await page.click("#tabAudit");
  await page.click("#runAuditBtn");
  await page.waitForTimeout(150);
  const lost = await page.locator('.audit-section:has-text("丢失片段")').textContent();
  check("对齐后核对不误报丢失", lost.includes("全部还在"), lost.slice(0, 100));

  await page.click("#tabBackup");
  await page.click("#restoreSnapshotBtn");
  await page.click("#confirmOkBtn");
  await page.waitForSelector("#confirmModal", { state: "hidden" });
  now = await getState(page);
  check("快照可恢复且身份串一致", now.reels[0].id === SHARED_REEL && now.reels[1].id !== SHARED_REEL);
  const afterReload = await getRaw(page, SK);
  await page.reload();
  await page.waitForSelector(".segment-card");
  check("刷新后存储稳定（不重复修复）", (await getRaw(page, SK)) === afterReload);
  check("刷新后仍无保护横幅", !(await page.locator("#safeBanner").isVisible()));

  await context.close();

  /* ====================================== 4a. 失败保护：编号重复（清洗也救不了） */
  console.log("\n[2] 清洗失败保护：编号重复（id 合法但同卷重号）");
  const ctx2 = await browser.newContext({ acceptDownloads: true });
  const p2 = await ctx2.newPage();
  await p2.goto(ROOT);
  await p2.waitForSelector(".segment-card");
  const dupCode = {
    version: 2,
    reels: [
      {
        id: "reel-valid-0001",
        name: "坏数据卷",
        segments: [seg("seg-valid-0001", "SAME"), seg("seg-valid-0002", "same", { duration: 12 })] // 忽略大小写重号
      }
    ],
    activeReelId: "reel-valid-0001"
  };
  await p2.evaluate(({ SK, data }) => localStorage.setItem(SK, JSON.stringify(data)), { SK, data: dupCode });
  const rawBefore = JSON.stringify(dupCode);
  await p2.reload();
  await p2.waitForSelector(".segment-card");

  check("出现现场保护横幅", await p2.locator("#safeBanner").isVisible());
  const reason = await p2.textContent("#safeBannerReason");
  check("横幅说明原因（编号重复）", reason.includes("重复") || reason.includes("SAME"), reason);
  check("原始存储逐字节保留", (await getRaw(p2, SK)) === rawBefore);

  // 在临时工作台上编辑，不落盘
  await p2.click("#tabDesk");
  await p2.fill("#codeInput", "TEMP-1");
  await p2.fill("#durationInput", "5");
  await p2.click("#addBtn");
  check("临时编辑可执行（样例 3 段 + 新增片段可见）", (await p2.locator(".segment-card").count()) === 4);
  check("编辑没有写入原始存储", (await getRaw(p2, SK)) === rawBefore);
  await p2.reload();
  await p2.waitForSelector(".segment-card");
  check("刷新后仍是保护模式、原始数据还在", (await p2.locator("#safeBanner").isVisible()) && (await getRaw(p2, SK)) === rawBefore);

  // 下载现场
  await p2.click("#tabBackup");
  const [dl] = await Promise.all([p2.waitForEvent("download"), p2.click("#rescueDownloadBtn")]);
  const rescuePath = path.join(OUT, "rescue.json");
  await dl.saveAs(rescuePath);
  const rescue = JSON.parse(fs.readFileSync(rescuePath, "utf8"));
  check("现场文件包含原始主数据", rescue.rawStorage && rescue.rawStorage.main === rawBefore);
  check("现场文件记录失败原因", typeof rescue.reason === "string" && rescue.reason.length > 0);

  // 用有效备份恢复 → 退出保护
  const good = {
    version: 2,
    reels: [{ id: "reel-good-0001", name: "恢复卷", segments: [seg("seg-good-0001", "G-1", { damage: "划痕", conclusion: "重接" })] }],
    activeReelId: "reel-good-0001"
  };
  await p2.setInputFiles("#restoreFile", { name: "good.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(good)) });
  await p2.click("#restoreBtn");
  await p2.waitForSelector("#confirmModal:not(.hidden)");
  const t = await p2.textContent("#confirmTitle");
  check("有效备份进入恢复确认", t.includes("恢复确认"), t);
  await p2.click("#confirmOkBtn");
  await p2.waitForSelector("#confirmModal", { state: "hidden" });
  check("恢复后横幅消失", !(await p2.locator("#safeBanner").isVisible()));
  const restored = await getState(p2);
  check("数据已替换为备份", restored.reels[0].name === "恢复卷");
  await p2.reload();
  await p2.waitForSelector(".segment-card");
  check("刷新后正常加载，不再进入保护", !(await p2.locator("#safeBanner").isVisible()) && (await getState(p2)).reels[0].name === "恢复卷");
  await ctx2.close();

  /* ====================================== 4b. 失败保护：JSON 损坏 */
  console.log("\n[3] 清洗失败保护：JSON 损坏");
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(ROOT);
  await p3.waitForSelector(".segment-card");
  const garbage = "{ oops, not json ";
  await p3.evaluate(({ SK, garbage }) => localStorage.setItem(SK, garbage), { SK, garbage });
  await p3.reload();
  await p3.waitForSelector(".segment-card");
  check("损坏 JSON 进入保护模式", await p3.locator("#safeBanner").isVisible());
  check("损坏字符串原样保留", (await getRaw(p3, SK)) === garbage);
  // 显式放弃并重建
  await p3.click("#tabBackup");
  await p3.click("#rescueWipeBtn");
  await p3.waitForSelector("#confirmModal:not(.hidden)");
  await p3.click("#confirmOkBtn");
  await p3.waitForSelector("#confirmModal", { state: "hidden" });
  check("确认重建后退出保护", !(await p3.locator("#safeBanner").isVisible()));
  const fresh = await getState(p3);
  check("存储被有效样例替换（可正常校验）", Array.isArray(fresh.reels) && fresh.reels.length === 2);
  await p3.reload();
  await p3.waitForSelector(".segment-card");
  check("重建后刷新不再进保护", !(await p3.locator("#safeBanner").isVisible()));
  await ctx3.close();

  /* ====================================== 5. 正常旧数据 */
  console.log("\n[4] 正常旧数据：原样加载，不触发修复/保护");
  const ctx4 = await browser.newContext();
  const p4 = await ctx4.newPage();
  await p4.goto(ROOT);
  await p4.waitForSelector(".segment-card");
  const normal = {
    version: 2,
    reels: [
      { id: "reel-normal-01", name: "正常旧卷", segments: [seg("seg-normal-01", "N-1", { duration: 15 })] }
    ],
    activeReelId: "reel-normal-01"
  };
  await p4.evaluate(({ SK, data }) => localStorage.setItem(SK, JSON.stringify(data)), { SK, data: normal });
  const normalRaw = JSON.stringify(normal);
  await p4.reload();
  await p4.waitForSelector(".segment-card");
  check("无保护横幅", !(await p4.locator("#safeBanner").isVisible()));
  check("存储未被改写", (await getRaw(p4, SK)) === normalRaw);
  check("卷与片段正常显示", (await p4.locator(".segment-card").count()) === 1);
  check("身份串原样", (await getState(p4)).reels[0].segments[0].id === "seg-normal-01");
  await ctx4.close();

  await browser.close();

  console.log(`\n========== 重复身份串与失败保护复测：${passed} 通过，${failures.length} 失败 ==========`);
  if (failures.length) {
    console.log(failures.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
