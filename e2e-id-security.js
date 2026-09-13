/* 安全复测：内部身份串（id）的注入攻击与清洗
 * A. 外部备份中恶意 id（卷/片段/activeReelId）→ 严格拒绝、无图片插入、无事件执行、数据不变
 * B. 本机旧记录中恶意 id（主数据/基线/快照）→ 启动自动清洗，且三处引用同步；
 *    清洗后切换卷、编辑、跨卷搬运、撤销重做、刷新保存全部正常
 * C. 合法自定义身份串 → 备份恢复成功
 */
const { chromium } = require("playwright");
const path = require("path");

const ROOT = "file://" + path.resolve(__dirname, "index.html");
const SK = "film-restore-desk-v2";
const BK = "film-restore-desk-baseline-v2";
const SNK = "film-restore-desk-snapshots-v2";

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

const EVIL_SEG = 'x"><img src=x onerror=window.__pwned=1><i id="';
const EVIL_REEL = 'r"><img src=z onerror=window.__pwned=2 alt="';
const EVIL_ACTIVE = 'a"><img src=y onerror=window.__pwned=3 v="';

function seg(over = {}) {
  return {
    id: "seg0000-" + Math.random().toString(36).slice(2, 8),
    code: "X-" + Math.random().toString(36).slice(2, 8),
    duration: 10,
    shift: "正常",
    rgb: { r: 0, g: 0, b: 0 },
    damage: "完好",
    conclusion: "",
    note: "",
    ...over
  };
}

function buildBackup() {
  const r1 = "reel0000-" + Math.random().toString(36).slice(2, 8);
  const r2 = "reel0001-" + Math.random().toString(36).slice(2, 8);
  return {
    version: 2,
    reels: [
      { id: r1, name: "卷一", segments: [seg(), seg({ code: "X-002" })] },
      { id: r2, name: "卷二", segments: [seg({ code: "Y-001", damage: "划痕", conclusion: "重接" })] }
    ],
    activeReelId: r1
  };
}

async function readPwned(page) {
  return page.evaluate(() => ({ pwned: window.__pwned || 0, imgs: document.querySelectorAll("img").length }));
}
async function getState(page) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SK);
}
const ID_OK = /^[A-Za-z0-9_-]{6,64}$/;
async function allIdsSafe(page) {
  return page.evaluate((k) => {
    const d = JSON.parse(localStorage.getItem(k));
    const ids = [];
    d.reels.forEach((r) => {
      ids.push(r.id, r.activeMarker);
      r.segments.forEach((s) => ids.push(s.id));
    });
    ids.push(d.activeReelId);
    return ids.filter((x) => x !== undefined).every((id) => /^[A-Za-z0-9_-]{6,64}$/.test(id));
  }, SK);
}

(async () => {
  const browser = await chromium.launch();

  /* ============================================================ A. 外部备份严格拒绝 */
  console.log("\n[A] 外部备份中的恶意身份串 —— 必须拒绝、不得改变页面结构或触发事件");
  const cases = [
    ["片段 id 含引号+img onerror", (b) => (b.reels[0].segments[0].id = EVIL_SEG)],
    ["卷 id 含引号+img onerror", (b) => (b.reels[0].id = EVIL_REEL)],
    ["activeReelId 含引号+img onerror", (b) => (b.activeReelId = EVIL_ACTIVE)],
    ["片段 id 为 javascript: 协议", (b) => (b.reels[0].segments[1].id = "javascript:alert(1)")],
    ["片段 id 含尖括号无引号", (b) => (b.reels[0].segments[1].id = "abc<img/>")],
    ["卷 id 含空格与事件属性", (b) => (b.reels[1].id = 'x onmouseover="alert(1)"')]
  ];

  for (const [label, mutate] of cases) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__pwned = 0;
    });
    await page.goto(ROOT);
    await page.waitForSelector(".segment-card");
    const cardsBefore = await page.locator(".segment-card").count();
    const stateBefore = await getState(page);

    const backup = buildBackup();
    mutate(backup);
    await page.click("#tabBackup");
    await page.setInputFiles("#restoreFile", {
      name: "evil.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup))
    });
    await page.click("#restoreBtn");
    await page.waitForSelector("#confirmModal:not(.hidden)");
    const title = await page.textContent("#confirmTitle");
    const body = await page.textContent("#confirmText");
    check(`[${label}] 被拒绝（不是恢复确认框）`, title.includes("拒绝"), title);
    check(`[${label}] 原因点名身份串/字段`, /身份串|非法字段|id/.test(body));
    await page.click("#confirmOkBtn");
    await page.waitForSelector("#confirmModal", { state: "hidden" });

    const { pwned, imgs } = await readPwned(page);
    check(`[${label}] onerror 未执行（__pwned=0）`, pwned === 0, "pwned=" + pwned);
    check(`[${label}] 页面没有生成任何 <img>`, imgs === 0, "imgs=" + imgs);
    check(`[${label}] 清单卡片数量不变`, (await page.locator(".segment-card").count()) === cardsBefore);
    const stateAfter = await getState(page);
    check(`[${label}] 当前数据逐字节未变`, JSON.stringify(stateAfter) === JSON.stringify(stateBefore));
    await context.close();
  }

  /* ================================================ B. 本机旧记录恶意 id —— 清洗后全主流程 */
  console.log("\n[B] 本机旧记录恶意身份串 —— 启动清洗，三处引用同步，主流程正常");
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__pwned = 0;
  });
  await page.goto(ROOT);
  await page.waitForSelector(".segment-card");

  // 直接写入“旧版本”本机数据：卷一 id 与首个片段 id 都是攻击串；基线和快照含同样串
  await page.evaluate(
    ({ SK, BK, SNK, EVIL_REEL, EVIL_SEG }) => {
      const evil = {
        version: 2,
        reels: [
          {
            id: EVIL_REEL,
            name: "旧卷一",
            segments: [
              { id: EVIL_SEG, code: "O-1", duration: 11, shift: "正常", rgb: { r: 0, g: 0, b: 0 }, damage: "完好", conclusion: "", note: "恶意片段id" },
              { id: "seg-safe-0001", code: "O-2", duration: 22, shift: "偏红", rgb: { r: 20, g: 0, b: 0 }, damage: "划痕", conclusion: "数字修复", note: "安全片段id" }
            ]
          },
          {
            id: "reel-safe-0002",
            name: "旧卷二",
            segments: [
              { id: "seg-safe-0003", code: "P-1", duration: 33, shift: "正常", rgb: { r: 0, g: 0, b: 0 }, damage: "完好", conclusion: "", note: "" }
            ]
          }
        ],
        activeReelId: EVIL_REEL
      };
      localStorage.setItem(SK, JSON.stringify(evil));
      localStorage.setItem(BK, JSON.stringify({ at: Date.now(), data: JSON.parse(JSON.stringify(evil)) }));
      localStorage.setItem(SNK, JSON.stringify([{ at: Date.now(), data: JSON.parse(JSON.stringify(evil)), label: "恶意快照" }]));
    },
    { SK, BK, SNK, EVIL_REEL, EVIL_SEG }
  );

  await page.reload();
  await page.waitForSelector(".segment-card");

  const { pwned, imgs } = await readPwned(page);
  check("清洗后 onerror 未执行", pwned === 0, "pwned=" + pwned);
  check("清洗后页面无 <img> 注入", imgs === 0, "imgs=" + imgs);
  check("清洗提示 toast 出现", (await page.locator(".toast").last().textContent()).includes("身份串"));

  const cleaned = await getState(page);
  const evilReel = cleaned.reels[0];
  check("卷 id 已换成安全格式", ID_OK.test(evilReel.id) && evilReel.id !== EVIL_REEL, evilReel.id);
  check("片段 id 已换成安全格式", ID_OK.test(evilReel.segments[0].id) && evilReel.segments[0].id !== EVIL_SEG);
  check("activeReelId 已同步指向修复后的卷", cleaned.activeReelId === evilReel.id);
  check("所有身份串均符合安全格式", await allIdsSafe(page));
  check("安全 id 未被无谓改动", evilReel.segments[1].id === "seg-safe-0001" && cleaned.reels[1].id === "reel-safe-0002");
  check("清洗后仍停留在被修复的旧卷一（看到 2 段）", (await page.locator(".segment-card").count()) === 2);

  // 基线 / 快照使用同一映射：切到审计页跑核对，不应把旧片段误报为丢失
  const refConsistent = await page.evaluate(
    ({ SK, BK, SNK }) => {
      const s = JSON.parse(localStorage.getItem(SK));
      const b = JSON.parse(localStorage.getItem(BK));
      const snaps = JSON.parse(localStorage.getItem(SNK));
      const stateReelId = s.reels[0].id;
      const stateSegId = s.reels[0].segments[0].id;
      const baselineMatch = b.data.reels[0].id === stateReelId && b.data.reels[0].segments[0].id === stateSegId;
      const snapMatch =
        snaps[0].data.reels[0].id === stateReelId && snaps[0].data.reels[0].segments[0].id === stateSegId;
      return { baselineMatch, snapMatch };
    },
    { SK, BK, SNK }
  );
  check("基线中的恶意 id 与主数据同步重映射", refConsistent.baselineMatch);
  check("快照中的恶意 id 与主数据同步重映射", refConsistent.snapMatch);

  await page.click("#tabAudit");
  await page.click("#runAuditBtn");
  await page.waitForTimeout(150);
  const lostText = await page.locator('.audit-section:has-text("丢失片段")').textContent();
  check("同映射下审计无误报丢失（② 显示全部还在）", lostText.includes("全部还在"), lostText.slice(0, 80));
  await page.click("#tabDesk");

  // --- 切换卷 ---
  await page.click('.reel-switch:has-text("旧卷二")');
  check("清洗后可切换到卷二（1 段）", (await page.locator(".segment-card").count()) === 1);
  await page.click('.reel-switch:has-text("旧卷一")');
  check("可切回卷一（2 段）", (await page.locator(".segment-card").count()) === 2);

  // --- 编辑片段 ---
  await page.click('.segment-card:has-text("O-1") [data-edit]');
  await page.fill("#durationInput", "77");
  await page.click("#addBtn");
  let st = await getState(page);
  check("清洗后片段编辑可保存", st.reels[0].segments[0].duration === 77);

  // --- 跨卷搬运（含冲突改名路径）：把 O-2 复制到卷二 ---
  await page.check('.segment-card:has-text("O-2") [data-pick]');
  await page.selectOption("#targetReelSelect", { label: "旧卷二" });
  await page.click("#bulkCopyBtn");
  st = await getState(page);
  check("清洗后跨卷复制成功（无冲突直入）", st.reels[1].segments.some((x) => x.code === "O-2"));

  // 再造一个同号冲突，走冲突弹窗的改名路径
  await page.check('.segment-card:has-text("O-2") [data-pick]');
  await page.click("#bulkCopyBtn");
  await page.waitForSelector("#conflictModal:not(.hidden)");
  check("清洗后冲突弹窗仍正常", await page.locator("#conflictModal").isVisible());
  const suggested = await page.inputValue("#conflictBody input[data-rename]");
  check("弹窗中无注入内容（建议名是安全串）", ID_OK ? /^[\w-]+$/.test(suggested) : false, suggested);
  await page.click("#conflictConfirmBtn");
  st = await getState(page);
  check("改名复制成功，新 id 仍是安全格式", st.reels[1].segments.every((x) => ID_OK.test(x.id)));

  // --- 撤销 / 重做 ---
  const segCountRightNow = st.reels[1].segments.length;
  await page.click("#undoBtn");
  st = await getState(page);
  check("撤销跨卷操作生效", st.reels[1].segments.length === segCountRightNow - 1, `now=${st.reels[1].segments.length} expected=${segCountRightNow - 1} reels=${st.reels.map(r=>r.segments.length).join(",")}`);
  await page.click("#redoBtn");
  st = await getState(page);
  check("重做生效", st.reels[1].segments.length === segCountRightNow);
  await page.click("#undoBtn");
  await page.click("#undoBtn");

  // --- 刷新保存 ---
  const beforeReload = await getState(page);
  await page.reload();
  await page.waitForSelector(".segment-card");
  const afterReload = await getState(page);
  check("刷新后数据完全一致", JSON.stringify(beforeReload) === JSON.stringify(afterReload));
  check("刷新后不再重复清洗（所有 id 保持稳定）", await allIdsSafe(page));
  const { pwned: p2, imgs: i2 } = await readPwned(page);
  check("刷新后仍无注入执行", p2 === 0 && i2 === 0);

  await context.close();

  /* ================================================ C. 合法自定义身份串恢复 */
  console.log("\n[C] 合法自定义身份串 —— 备份恢复与主流程");
  const context2 = await browser.newContext({ acceptDownloads: true });
  const page2 = await context2.newPage();
  await page2.goto(ROOT);
  await page2.waitForSelector(".segment-card");

  const good = {
    version: 2,
    reels: [
      {
        id: "reel-custom_001",
        name: "自定义id卷",
        segments: [
          { id: "seg-custom_001", code: "K-1", duration: 12, shift: "偏青", rgb: { r: -10, g: 10, b: 30 }, damage: "霉斑", conclusion: "待复核", note: "合法连字符下划线 id" }
        ]
      }
    ],
    activeReelId: "reel-custom_001"
  };
  await page2.click("#tabBackup");
  await page2.setInputFiles("#restoreFile", {
    name: "good-ids.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(good))
  });
  await page2.click("#restoreBtn");
  await page2.waitForSelector("#confirmModal:not(.hidden)");
  const title2 = await page2.textContent("#confirmTitle");
  check("合法自定义 id 备份进入恢复确认", title2.includes("恢复确认"), title2);
  await page2.click("#confirmOkBtn");
  await page2.waitForSelector("#confirmModal", { state: "hidden" });
  const restored = await getState(page2);
  check("自定义 id 原样保留（不被重生成）", restored.reels[0].id === "reel-custom_001" && restored.reels[0].segments[0].id === "seg-custom_001");
  check("恢复后清单可正常显示", (await page2.locator(".segment-card").count()) === 1);
  check("恢复后可编辑（主流程未受安全策略影响）", (await page2.textContent(".tag.damage")).includes("霉斑"));

  await browser.close();

  console.log(`\n========== 身份串安全复测：${passed} 通过，${failures.length} 失败 ==========`);
  if (failures.length) {
    console.log(failures.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
