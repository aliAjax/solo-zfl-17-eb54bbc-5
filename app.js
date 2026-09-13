"use strict";

/* =========================================================================
 * 多卷胶片修复核对台 —— 纯离线应用
 * 数据保存在 localStorage：主数据 / 撤销重做栈（会话内）/ 重组前基线 / 本机快照
 * ========================================================================= */

const STORAGE_KEY = "film-restore-desk-v2";
const BASELINE_KEY = "film-restore-desk-baseline-v2";
const SNAPSHOT_KEY = "film-restore-desk-snapshots-v2";
const LEGACY_KEY = "zfl17-film-strip-desk";
const MAX_HISTORY = 60;
const MAX_SNAPSHOTS = 5;
const DEFAULT_GAP = 25;

const SHIFTS = ["正常", "偏红", "偏青", "偏黄", "偏蓝", "褪色"];
const DAMAGES = ["完好", "划痕", "齿孔破损", "接片松动", "霉斑", "脆裂", "画面缺损"];
const CONCLUSIONS = ["保留原片", "数字修复", "物理修补", "重接", "跳过该段", "待复核"];

const FALLBACK_COLORS = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];

/* ------------------------------------------------------------------ 工具 */

const $ = (sel) => document.querySelector(sel);
void $;

function uid() {
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function normCode(code) {
  return String(code ?? "").trim().toLowerCase();
}

function formatDuration(totalSeconds) {
  const value = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function stampText(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fileStamp() {
  return stampText(Date.now()).replace(/[: ]/g, "-");
}

function rgbDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/* ---------------------------------------------------------- 默认/工厂 */

function makeSegment(partial = {}) {
  return {
    id: partial.id || uid(),
    code: String(partial.code ?? "").trim(),
    duration: Number(partial.duration) || 0,
    shift: partial.shift || "正常",
    rgb: {
      r: Number(partial.rgb?.r) || 0,
      g: Number(partial.rgb?.g) || 0,
      b: Number(partial.rgb?.b) || 0
    },
    damage: partial.damage || "完好",
    conclusion: partial.conclusion || "",
    note: partial.note || ""
  };
}

function makeReel(name, segments = []) {
  return { id: uid(), name, segments };
}

function defaultData() {
  const data = {
    reels: [
      makeReel("春日试映 A卷", [
        makeSegment({ code: "A-001", duration: 18, shift: "正常", damage: "完好", note: "开场街景，节奏平稳。" }),
        makeSegment({ code: "A-002", duration: 9, shift: "偏红", rgb: { r: 38, g: -6, b: -10 }, damage: "划痕", conclusion: "数字修复", note: "人物近景左侧划痕，已安排数字修复。" }),
        makeSegment({ code: "A-003", duration: 14, shift: "褪色", rgb: { r: -18, g: -18, b: -8 }, damage: "接片松动", conclusion: "重接", note: "段尾接片松动，放映前重接压平。" })
      ]),
      makeReel("春日试映 B卷", [
        makeSegment({ code: "B-101", duration: 22, shift: "正常", damage: "完好", note: "转场后第一卷。" }),
        makeSegment({ code: "B-102", duration: 11, shift: "偏青", rgb: { r: -22, g: 10, b: 26 }, damage: "齿孔破损", conclusion: "物理修补", note: "入口端齿孔磨损，物理修补后试映。" })
      ])
    ],
    activeReelId: null
  };
  data.activeReelId = data.reels[0].id;
  return data;
}

/* ------------------------------------------------------------- 数据校验 */

/**
 * 严格校验备份/恢复数据。结构错误、恶意字段、非法内容都会被整体拒绝。
 * 返回 { ok: true, data } 或 { ok: false, errors: [...] }
 */
const MALICIOUS_RE = /<\s*script|javascript:|onerror\s*=|onload\s*=|<\s*iframe/i;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const ALLOWED_ROOT = new Set(["version", "reels", "activeReelId", "exportedAt"]);
const ALLOWED_REEL = new Set(["id", "name", "segments"]);
const ALLOWED_SEG = new Set(["id", "code", "duration", "shift", "rgb", "damage", "conclusion", "note"]);
const ALLOWED_RGB = new Set(["r", "g", "b"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeText(value) {
  if (typeof value !== "string") return false;
  if (CONTROL_RE.test(value)) return false;
  return !MALICIOUS_RE.test(value);
}

function validateData(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: ["根结构错误：必须是 JSON 对象，收到的是 " + (Array.isArray(input) ? "数组" : input === null ? "null" : typeof input)]
    };
  }

  const errors = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_ROOT.has(key) || FORBIDDEN_KEYS.has(key)) {
      errors.push(`根节点存在非法/未知字段：${key}（已拒绝，未写入任何数据）`);
    }
  }

  if (!Array.isArray(input.reels)) {
    errors.push("缺少 reels 数组，或 reels 不是列表结构");
    return { ok: false, errors };
  }
  if (input.reels.length === 0) errors.push("reels 为空：至少需要一个胶片卷");
  if (input.reels.length > 100) errors.push(`胶片卷数量异常：${input.reels.length} > 100`);

  const reelIds = new Set();
  const globalCodes = new Map();
  let activeExists = false;
  if (input.activeReelId != null && typeof input.activeReelId !== "string") {
    errors.push("activeReelId 类型错误");
  }

  input.reels.forEach((rawReel, ri) => {
    const where = `第 ${ri + 1} 卷`;
    if (rawReel === null || typeof rawReel !== "object" || Array.isArray(rawReel)) {
      errors.push(`${where}：结构错误，每卷必须是对象`);
      return;
    }
    for (const key of Object.keys(rawReel)) {
      if (!ALLOWED_REEL.has(key) || FORBIDDEN_KEYS.has(key)) {
        errors.push(`${where}：存在非法字段“${key}”，备份可能被篡改，已拒绝`);
      }
    }

    if (typeof rawReel.id !== "string" || !rawReel.id || rawReel.id.length > 64) {
      errors.push(`${where}：卷 id 缺失或类型错误`);
    } else if (reelIds.has(rawReel.id)) {
      errors.push(`${where}：卷 id 重复（${rawReel.id}）`);
    } else {
      reelIds.add(rawReel.id);
      if (input.activeReelId === rawReel.id) activeExists = true;
    }

    if (typeof rawReel.name !== "string" || !rawReel.name.trim()) {
      errors.push(`${where}：卷名缺失或不是文本`);
    } else if (rawReel.name.length > 60) {
      errors.push(`${where}：卷名超过 60 字`);
    } else if (!isSafeText(rawReel.name)) {
      errors.push(`${where}：卷名含控制字符或疑似脚本内容，已拒绝`);
    }

    if (!Array.isArray(rawReel.segments)) {
      errors.push(`${where}：segments 必须是列表`);
      return;
    }
    if (rawReel.segments.length > 10000) errors.push(`${where}：片段数量异常（${rawReel.segments.length}）`);

    const codeSeen = new Map();
    const segIds = new Set();

    rawReel.segments.forEach((rawSeg, si) => {
      const at = `${where}第 ${si + 1} 段`;
      if (rawSeg === null || typeof rawSeg !== "object" || Array.isArray(rawSeg)) {
        errors.push(`${at}：结构错误，片段必须是对象`);
        return;
      }
      for (const key of Object.keys(rawSeg)) {
        if (!ALLOWED_SEG.has(key) || FORBIDDEN_KEYS.has(key)) {
          errors.push(`${at}：存在非法字段“${key}”，疑似恶意内容，已拒绝整份备份`);
        }
      }

      if (typeof rawSeg.id !== "string" || !rawSeg.id || rawSeg.id.length > 64) {
        errors.push(`${at}：id 缺失或类型错误`);
      } else if (segIds.has(rawSeg.id)) {
        errors.push(`${at}：片段 id 重复（${rawSeg.id}）`);
      } else {
        segIds.add(rawSeg.id);
      }

      if (typeof rawSeg.code !== "string" || !rawSeg.code.trim()) {
        errors.push(`${at}：编号缺失或不是文本`);
      } else if (rawSeg.code.length > 40) {
        errors.push(`${at}：编号超过 40 字符`);
      } else if (!isSafeText(rawSeg.code)) {
        errors.push(`${at}：编号含控制字符或疑似脚本，已拒绝`);
      } else {
        const nc = normCode(rawSeg.code);
        if (codeSeen.has(nc)) {
          errors.push(`${at}：编号“${rawSeg.code}”与本卷第 ${codeSeen.get(nc) + 1} 段重复（忽略大小写后仍重复）`);
        } else {
          codeSeen.set(nc, si);
        }
        if (!globalCodes.has(nc)) globalCodes.set(nc, []);
        globalCodes.get(nc).push(`${where}「${rawReel.name || "?"}」的 ${rawSeg.code}`);
      }

      if (typeof rawSeg.duration !== "number" || !Number.isFinite(rawSeg.duration) || rawSeg.duration <= 0) {
        errors.push(`${at}${rawSeg.code ? `（${rawSeg.code}）` : ""}：时长必须是正数，收到 ${JSON.stringify(rawSeg.duration)}`);
      } else if (rawSeg.duration > 86400) {
        errors.push(`${at}：时长异常（超过 24 小时）`);
      }

      if (!SHIFTS.includes(rawSeg.shift)) errors.push(`${at}：颜色偏移类型非法（${JSON.stringify(rawSeg.shift)}）`);

      if (rawSeg.rgb === null || typeof rawSeg.rgb !== "object" || Array.isArray(rawSeg.rgb)) {
        errors.push(`${at}：rgb 必须是对象`);
      } else {
        for (const key of Object.keys(rawSeg.rgb)) {
          if (!ALLOWED_RGB.has(key) || FORBIDDEN_KEYS.has(key)) errors.push(`${at}：rgb 含非法字段“${key}”`);
        }
        for (const ch of ["r", "g", "b"]) {
          const v = rawSeg.rgb[ch];
          if (typeof v !== "number" || !Number.isFinite(v) || v < -100 || v > 100) {
            errors.push(`${at}：rgb.${ch} 必须是 -100~100 的数字`);
          }
        }
      }

      if (!DAMAGES.includes(rawSeg.damage)) errors.push(`${at}：破损类型非法（${JSON.stringify(rawSeg.damage)}）`);
      if (typeof rawSeg.conclusion !== "string") {
        errors.push(`${at}：处理结论必须是文本`);
      } else if (rawSeg.damage !== "完好" && !CONCLUSIONS.includes(rawSeg.conclusion)) {
        errors.push(`${at}：破损片段（${rawSeg.damage}）必须写明处理结论，当前为 ${JSON.stringify(rawSeg.conclusion) || "空"}`);
      } else if (rawSeg.damage === "完好" && rawSeg.conclusion && !CONCLUSIONS.includes(rawSeg.conclusion)) {
        errors.push(`${at}：处理结论取值非法`);
      }

      if (typeof rawSeg.note !== "string") {
        errors.push(`${at}：备注必须是文本`);
      } else if (rawSeg.note.length > 500) {
        errors.push(`${at}：备注超过 500 字`);
      } else if (!isSafeText(rawSeg.note)) {
        errors.push(`${at}：备注含控制字符或疑似脚本内容，已拒绝`);
      }
    });
  });

  if (input.activeReelId != null && typeof input.activeReelId === "string" && !activeExists) {
    errors.push("activeReelId 指向不存在的卷");
  }

  if (errors.length === 0) {
    // 只取白名单字段，导出包装里的 exportedAt 等不会进入工作数据
    const data = {
      version: 2,
      reels: clone(input.reels),
      activeReelId: input.activeReelId == null ? input.reels[0].id : input.activeReelId
    };
    return { ok: true, data };
  }
  return { ok: false, errors };
}

/* --------------------------------------------------------------- 模型状态 */

let state = null;
let history = []; // 变更前快照
let future = []; // 已撤销、可重做
let baseline = null; // 重组前基线
let snapshots = [];
let opLog = [];
let selectedIds = new Set();
let editingId = null;
let pendingConflict = null;
let dragSnapshot = null;
let filterState = { keyword: "", shift: "all", damage: "all" };

/* ------------------------------------------------------- 持久化 + 迁移 */

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function persistBaseline() {
  if (baseline) localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
  else localStorage.removeItem(BASELINE_KEY);
}
function persistSnapshots() {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots));
}

/** 所有写操作的唯一入口：先留存变更前快照，再执行，再持久化与刷新 */
function applyChange(message, mutate, opts = {}) {
  const before = clone(state);
  mutate();
  if (!opts.noHistory) {
    history.push(before);
    if (history.length > MAX_HISTORY) history.shift();
    future = [];
  }
  persist();
  if (message) pushLog(message);
  renderAll();
}

function migrateLegacy() {
  const old = localStorage.getItem(LEGACY_KEY);
  if (!old) return null;
  try {
    const parsed = JSON.parse(old);
    if (!parsed || !Array.isArray(parsed.segments)) return null;
    const migrated = {
      version: 2,
      reels: [
        {
          id: uid(),
          name: String(parsed.reelTitle || "旧版数据卷").slice(0, 60),
          segments: parsed.segments
            .filter((s) => s && typeof s.code === "string" && Number(s.duration) > 0)
            .map((s) =>
              makeSegment({
                code: s.code,
                duration: Number(s.duration),
                shift: SHIFTS.includes(s.shift) ? s.shift : "正常",
                damage: DAMAGES.includes(s.damage) && s.damage !== "完好" ? s.damage : "完好",
                conclusion: DAMAGES.includes(s.damage) && s.damage !== "完好" ? "待复核" : "",
                note: typeof s.note === "string" ? s.note.slice(0, 500) : ""
              })
            )
        }
      ],
      activeReelId: null
    };
    migrated.activeReelId = migrated.reels[0].id;
    return migrated;
  } catch {
    return null;
  }
}

function initState() {
  let loaded = null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const result = validateData(JSON.parse(raw));
      if (result.ok) loaded = result.data;
      else toast("本机数据校验失败，已用初始工作台启动，未覆盖损坏数据；请检查或恢复备份。原因：" + result.errors[0], "error", 8000);
    } catch (err) {
      toast("本机数据无法解析（可能已损坏），已用初始工作台启动。" + err.message, "error", 8000);
    }
  } else {
    loaded = migrateLegacy();
    if (loaded) {
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        /* ignore */
      }
    }
  }
  if (!loaded) loaded = defaultData();
  if (!loaded.activeReelId || !loaded.reels.some((r) => r.id === loaded.activeReelId)) {
    loaded.activeReelId = loaded.reels[0]?.id ?? null;
  }
  state = loaded;
  persist();
  try {
    baseline = JSON.parse(localStorage.getItem(BASELINE_KEY) || "null");
  } catch {
    baseline = null;
  }
  try {
    snapshots = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "[]");
    if (!Array.isArray(snapshots)) snapshots = [];
  } catch {
    snapshots = [];
  }
}

/* ------------------------------------------------------------ 撤销重做 */

function undo() {
  if (!history.length) return toast("没有可撤销的操作", "info");
  future.push(clone(state));
  state = history.pop();
  persist();
  pushLog("撤销一步");
  renderAll();
  toast("已撤销", "success");
}

function redo() {
  if (!future.length) return toast("没有可重做的操作", "info");
  history.push(clone(state));
  state = future.pop();
  persist();
  pushLog("重做一步");
  renderAll();
  toast("已重做", "success");
}

function pushLog(text) {
  opLog.unshift({ text, at: Date.now() });
  if (opLog.length > 30) opLog.pop();
}

/* --------------------------------------------------------------- 查询层 */

function activeReel() {
  return state.reels.find((r) => r.id === state.activeReelId) || state.reels[0] || null;
}

function reelDuration(reel) {
  return reel.segments.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
}

function reelHasDamage(s) {
  return s.damage !== "完好";
}

function findReelByCode(reelId, code, ignoreId = null) {
  const target = normCode(code);
  const reel = state.reels.find((r) => r.id === reelId);
  if (!reel) return null;
  return reel.segments.find((s) => s.id !== ignoreId && normCode(s.code) === target) || null;
}

function getVisibleSegments(reel) {
  const kw = filterState.keyword.toLowerCase();
  return reel.segments.filter((s) => {
    if (filterState.shift !== "all" && s.shift !== filterState.shift) return false;
    if (filterState.damage === "damaged" && !reelHasDamage(s)) return false;
    if (filterState.damage === "ok" && reelHasDamage(s)) return false;
    if (filterState.damage === "pending" && !(reelHasDamage(s) && !s.conclusion)) return false;
    if (kw) {
      const hay = `${s.code} ${s.note} ${s.conclusion} ${s.damage} ${s.shift}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}

function collectReminders(reel) {
  const list = [];
  reel.segments.forEach((s, i) => {
    if (reelHasDamage(s) && !s.conclusion) {
      list.push({ level: "error", text: `#${i + 1} ${s.code}：破损「${s.damage}」尚未写明处理结论` });
    } else if (reelHasDamage(s) && s.conclusion === "待复核") {
      list.push({ level: "warn", text: `#${i + 1} ${s.code}：结论为「待复核」，放映前需确认` });
    }
    if (s.shift !== "正常") {
      list.push({ level: "info", text: `#${i + 1} ${s.code}：颜色偏移「${s.shift}」，RGB(${s.rgb.r},${s.rgb.g},${s.rgb.b})` });
    }
  });
  const seen = new Map();
  reel.segments.forEach((s, i) => {
    const n = normCode(s.code);
    if (seen.has(n)) list.push({ level: "error", text: `#${i + 1} ${s.code}：与 #${seen.get(n) + 1} 编号重复（忽略大小写）` });
    else seen.set(n, i);
  });
  return list;
}

/* ============================================================ 渲染层 === */

const els = {};
function cacheEls() {
  [
    "statReels", "statSegments", "statDuration", "statDamage",
    "tabDesk", "tabAudit", "tabBackup", "undoBtn", "redoBtn",
    "viewDesk", "viewAudit", "viewBackup",
    "reelList", "newReelBtn", "dupReelBtn", "renameReelBtn", "delReelBtn", "reelMeta",
    "segmentForm", "codeInput", "durationInput", "shiftInput", "rInput", "gInput", "bInput",
    "damageInput", "conclusionWrap", "conclusionInput", "noteInput",
    "addBtn", "resetFormBtn", "editingHint", "cancelEditLink",
    "searchInput", "colorFilter", "damageFilter", "clearFilterBtn",
    "targetReelSelect", "bulkMoveBtn", "bulkCopyBtn", "selectAllBtn", "bulkInfo",
    "segmentList", "statsPanel", "warnBadge", "warningList",
    "setBaselineBtn", "runAuditBtn", "baselineInfo", "colorGapInput", "auditSummary", "auditReport",
    "exportTxtBtn", "exportCsvBtn", "exportJsonBtn",
    "restoreFile", "restoreBtn", "downloadBackupBtn",
    "snapshotBtn", "restoreSnapshotBtn", "dangerZoneBtn", "snapshotList", "opLog",
    "conflictModal", "conflictTitle", "conflictIntro", "conflictBody", "conflictConfirmBtn", "conflictCancelBtn",
    "confirmModal", "confirmTitle", "confirmText", "confirmOkBtn", "confirmCancelBtn", "toastHost"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function renderAll() {
  renderReels();
  renderForm();
  renderTargetSelect();
  renderList();
  renderStats();
  renderWarnings();
  renderAudit();
  renderBackupPanel();
  els.undoBtn.disabled = history.length === 0;
  els.redoBtn.disabled = future.length === 0;
}

function switchTab(name) {
  [
    ["desk", els.tabDesk, els.viewDesk],
    ["audit", els.tabAudit, els.viewAudit],
    ["backup", els.tabBackup, els.viewBackup]
  ].forEach(([key, btn, view]) => {
    btn.classList.toggle("active", key === name);
    view.classList.toggle("active", key === name);
  });
  if (name === "audit" && baseline) runAudit({ silent: true });
}

function renderReels() {
  els.reelList.innerHTML = state.reels
    .map((r) => {
      const damaged = r.segments.filter(reelHasDamage).length;
      return `
        <li class="reel-item ${r.id === state.activeReelId ? "active" : ""}">
          <button type="button" class="reel-switch" data-switch-reel="${r.id}">
            <span class="reel-name">${escapeHtml(r.name)}</span>
            <span class="reel-sub">${r.segments.length} 段 · ${formatDuration(reelDuration(r))}${damaged ? ` · 破损 ${damaged}` : ""}</span>
          </button>
        </li>`;
    })
    .join("");

  const reel = activeReel();
  if (reel) {
    els.reelMeta.innerHTML = `
      <div><span>当前卷</span><strong>${escapeHtml(reel.name)}</strong></div>
      <div><span>片段数</span><strong>${reel.segments.length}</strong></div>
      <div><span>本卷总时长</span><strong>${formatDuration(reelDuration(reel))}</strong></div>`;
  }
  els.delReelBtn.disabled = state.reels.length <= 1 || !reel;
  els.dupReelBtn.disabled = !reel;
}

function renderForm() {
  els.conclusionWrap.classList.toggle("hidden", els.damageInput.value === "完好");
  if (editingId) {
    els.addBtn.textContent = "保存修改";
    els.editingHint.classList.remove("hidden");
  } else {
    els.addBtn.textContent = "加入当前卷";
    els.editingHint.classList.add("hidden");
  }
}

function renderList() {
  const reel = activeReel();
  if (!reel) {
    els.segmentList.innerHTML = `<p class="empty">还没有胶片卷，请先新建一卷。</p>`;
    els.bulkInfo.textContent = "已选 0 段";
    return;
  }
  const visible = getVisibleSegments(reel);
  const visibleIds = new Set(visible.map((s) => s.id));
  for (const id of [...selectedIds]) {
    if (!visibleIds.has(id)) selectedIds.delete(id);
  }

  els.segmentList.innerHTML =
    visible
      .map((s) => {
        const realIndex = reel.segments.findIndex((x) => x.id === s.id);
        const color = FALLBACK_COLORS[realIndex % FALLBACK_COLORS.length];
        const damaged = reelHasDamage(s);
        return `
          <article class="segment-card ${editingId === s.id ? "editing" : ""}" draggable="true" data-id="${s.id}">
            <label class="pick" title="勾选后可跨卷移动/复制">
              <input type="checkbox" data-pick="${s.id}" ${selectedIds.has(s.id) ? "checked" : ""} />
            </label>
            <div class="thumb film-placeholder" style="background:linear-gradient(135deg, ${color}, #2a2e31)">${escapeHtml(s.code)}</div>
            <div class="segment-main">
              <div class="segment-title">
                <strong>${realIndex + 1}. ${escapeHtml(s.code)}</strong>
                <span class="dur">${formatDuration(s.duration)}</span>
              </div>
              <div class="tag-row">
                <span class="tag shift">色：${escapeHtml(s.shift)} <em>(${s.rgb.r},${s.rgb.g},${s.rgb.b})</em></span>
                <span class="tag ${damaged ? "damage" : "ok"}">损：${escapeHtml(s.damage)}</span>
                ${
                  s.conclusion
                    ? `<span class="tag conclusion">结论：${escapeHtml(s.conclusion)}</span>`
                    : damaged
                      ? `<span class="tag missing-conclusion">缺处理结论</span>`
                      : ""
                }
              </div>
              <p class="segment-note">${escapeHtml(s.note || "（无备注）")}</p>
            </div>
            <div class="segment-actions">
              <button type="button" title="编辑" data-edit="${s.id}">改</button>
              <button type="button" title="上移" data-up="${s.id}" ${realIndex === 0 ? "disabled" : ""}>↑</button>
              <button type="button" title="下移" data-down="${s.id}" ${realIndex === reel.segments.length - 1 ? "disabled" : ""}>↓</button>
              <button type="button" title="删除" class="danger-text" data-del="${s.id}">×</button>
            </div>
          </article>`;
      })
      .join("") || `<p class="empty">没有符合筛选条件的片段。</p>`;

  els.bulkInfo.textContent = `已选 ${selectedIds.size} 段`;
}

function renderStats() {
  els.statReels.textContent = state.reels.length;
  const allSegs = state.reels.flatMap((r) => r.segments);
  els.statSegments.textContent = allSegs.length;
  els.statDuration.textContent = formatDuration(allSegs.reduce((a, s) => a + s.duration, 0));
  els.statDamage.textContent = allSegs.filter((s) => reelHasDamage(s) && (!s.conclusion || s.conclusion === "待复核")).length;

  const reel = activeReel();
  if (!reel) {
    els.statsPanel.innerHTML = `<p class="empty">无数据</p>`;
    return;
  }
  const count = {};
  reel.segments.forEach((s) => {
    count[s.shift] = (count[s.shift] || 0) + 1;
  });
  const dmgCount = reel.segments.filter(reelHasDamage).length;
  const pending = reel.segments.filter((s) => reelHasDamage(s) && !s.conclusion).length;
  els.statsPanel.innerHTML = `
    <div class="stat-grid">
      <div><span>本卷片段</span><strong>${reel.segments.length}</strong></div>
      <div><span>本卷时长</span><strong>${formatDuration(reelDuration(reel))}</strong></div>
      <div><span>有破损</span><strong>${dmgCount}</strong></div>
      <div><span>缺结论</span><strong class="${pending ? "alarm" : ""}">${pending}</strong></div>
    </div>
    <h3>颜色偏移分布</h3>
    <div class="stat-rows">
      ${SHIFTS.map((name) => `<div class="stat-row"><span>${name}</span><strong>${count[name] || 0}</strong></div>`).join("")}
    </div>`;
}

function renderWarnings() {
  const reel = activeReel();
  const items = reel ? collectReminders(reel) : [];
  const errorCount = items.filter((i) => i.level === "error").length;
  els.warnBadge.textContent = items.length;
  els.warnBadge.className = "badge" + (errorCount ? " alarm" : items.length ? " warn" : "");
  els.warningList.innerHTML =
    items
      .map((i) => `<div class="warning-item ${i.level}"><span class="dot"></span><span>${escapeHtml(i.text)}</span></div>`)
      .join("") || `<p class="empty">本卷暂无颜色偏移或破损提醒。</p>`;
}

function renderTargetSelect() {
  const current = els.targetReelSelect.value;
  els.targetReelSelect.innerHTML = state.reels
    .map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
    .join("");
  if (!state.reels.some((r) => r.id === els.targetReelSelect.value)) {
    els.targetReelSelect.value = state.reels[0]?.id || "";
  }
  if (!current && state.reels[0]) els.targetReelSelect.value = state.reels[0].id;
}

/* ====================================================== 片段增改删 ===== */

function readForm() {
  const clamp = (v) => (Number.isFinite(v) ? Math.max(-100, Math.min(100, v)) : 0);
  return {
    code: els.codeInput.value.trim(),
    duration: Number(els.durationInput.value),
    shift: els.shiftInput.value,
    rgb: {
      r: clamp(parseInt(els.rInput.value, 10)),
      g: clamp(parseInt(els.gInput.value, 10)),
      b: clamp(parseInt(els.bInput.value, 10))
    },
    damage: els.damageInput.value,
    conclusion: els.damageInput.value === "完好" ? "" : els.conclusionInput.value,
    note: els.noteInput.value.trim()
  };
}

function validateSegmentInput(data, ignoreId) {
  const reel = activeReel();
  const errors = [];
  if (!data.code) errors.push("编号不能为空");
  else if (data.code.length > 40) errors.push("编号不能超过 40 个字符");
  else if (MALICIOUS_RE.test(data.code) || CONTROL_RE.test(data.code)) errors.push("编号含非法字符或疑似脚本内容");
  else if (findReelByCode(reel.id, data.code, ignoreId)) errors.push(`编号「${data.code}」在本卷已存在（忽略大小写后仍重复）`);
  if (!Number.isFinite(data.duration) || data.duration <= 0) errors.push("时长必须是正数（秒）");
  if (data.damage !== "完好" && !CONCLUSIONS.includes(data.conclusion)) errors.push("破损片段必须写明处理结论");
  if (MALICIOUS_RE.test(data.note) || CONTROL_RE.test(data.note)) errors.push("备注含非法字符或疑似脚本内容，已拒绝");
  return errors;
}

function resetForm() {
  editingId = null;
  els.segmentForm.reset();
  els.durationInput.value = 12;
  els.rInput.value = 0;
  els.gInput.value = 0;
  els.bInput.value = 0;
  renderForm();
}

function submitSegment(event) {
  event.preventDefault();
  const reel = activeReel();
  if (!reel) return toast("请先新建胶片卷", "error");
  const data = readForm();
  const errors = validateSegmentInput(data, editingId);
  if (errors.length) return toast(errors[0], "error");

  if (editingId) {
    const id = editingId;
    const seg = reel.segments.find((s) => s.id === id);
    if (!seg) {
      resetForm();
      return;
    }
    applyChange(`修改片段「${data.code}」`, () => Object.assign(seg, data));
    resetForm();
    toast("片段已保存", "success");
  } else {
    const seg = makeSegment(data);
    applyChange(`向「${reel.name}」加入片段「${data.code}」`, () => reel.segments.push(seg));
    toast(`已加入 ${data.code}`, "success");
    resetForm();
  }
}

function startEdit(id) {
  const reel = activeReel();
  const seg = reel.segments.find((s) => s.id === id);
  if (!seg) return;
  editingId = id;
  els.codeInput.value = seg.code;
  els.durationInput.value = seg.duration;
  els.shiftInput.value = seg.shift;
  els.rInput.value = seg.rgb.r;
  els.gInput.value = seg.rgb.g;
  els.bInput.value = seg.rgb.b;
  els.damageInput.value = seg.damage;
  els.conclusionInput.value = seg.conclusion;
  els.noteInput.value = seg.note;
  renderForm();
  els.codeInput.focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function deleteSegment(id) {
  const reel = activeReel();
  const seg = reel.segments.find((s) => s.id === id);
  if (!seg) return;
  confirmDialog("删除片段", `确定删除「${reel.name}」中的 ${seg.code} 吗？可在本次会话内撤销。`, () => {
    applyChange(`删除片段「${seg.code}」`, () => {
      reel.segments = reel.segments.filter((s) => s.id !== id);
      selectedIds.delete(id);
      if (editingId === id) editingId = null;
    });
    resetForm();
    toast("已删除（可撤销）", "success");
  });
}

function moveSegment(id, delta) {
  const reel = activeReel();
  const i = reel.segments.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= reel.segments.length) return;
  const code = reel.segments[i].code;
  applyChange(
    delta < 0 ? `片段上移：${code}` : `片段下移：${code}`,
    () => {
      const [item] = reel.segments.splice(i, 1);
      reel.segments.splice(j, 0, item);
    },
    { silent: false }
  );
}

/* ======================================================== 卷：增删复制 */

function uniqueReelName(name) {
  const base = name.trim() || "未命名卷";
  if (!state.reels.some((r) => r.name === base)) return base.slice(0, 60);
  let n = 2;
  while (state.reels.some((r) => r.name === `${base} 副本 ${n}`)) n++;
  return `${base} 副本 ${n}`;
}

function createReel() {
  promptDialog("新建胶片卷", "请输入卷名", "如：春日试映 C卷", (name) => {
    name = name.trim();
    if (!name) return toast("卷名不能为空", "error");
    if (state.reels.some((r) => r.name === name)) return toast("已存在同名胶片卷", "error");
    const reel = makeReel(name.slice(0, 60), []);
    applyChange(`新建胶片卷「${reel.name}」`, () => {
      state.reels.push(reel);
      state.activeReelId = reel.id;
      selectedIds.clear();
    });
    toast("新卷已创建", "success");
  });
}

function duplicateReel() {
  const reel = activeReel();
  if (!reel) return;
  promptDialog("复制胶片卷", "新卷名称", uniqueReelName(reel.name), (name) => {
    name = name.trim();
    if (!name) return toast("卷名不能为空", "error");
    if (state.reels.some((r) => r.name === name)) return toast("已存在同名胶片卷", "error");
    const copy = makeReel(name.slice(0, 60), reel.segments.map((s) => makeSegment({ ...clone(s), id: uid() })));
    applyChange(`复制胶片卷「${reel.name}」→「${copy.name}」（${copy.segments.length} 段）`, () => {
      state.reels.push(copy);
      state.activeReelId = copy.id;
      selectedIds.clear();
    });
    toast("已复制整卷；跨卷同号会在重组核对页提示", "success", 5000);
  });
}

function renameReel() {
  const reel = activeReel();
  if (!reel) return;
  promptDialog("重命名胶片卷", "新的卷名", reel.name, (name) => {
    name = name.trim();
    if (!name) return toast("卷名不能为空", "error");
    if (state.reels.some((r) => r.id !== reel.id && r.name === name)) return toast("已存在同名胶片卷", "error");
    const old = reel.name;
    applyChange(`重命名卷「${old}」→「${name.slice(0, 60)}」`, () => {
      reel.name = name.slice(0, 60);
    });
    toast("已重命名", "success");
  });
}

function removeReel() {
  const reel = activeReel();
  if (!reel || state.reels.length <= 1) return;
  confirmDialog("删除胶片卷", `将删除「${reel.name}」及其 ${reel.segments.length} 个片段，本次会话内可撤销。确定？`, () => {
    applyChange(`删除胶片卷「${reel.name}」`, () => {
      state.reels = state.reels.filter((r) => r.id !== reel.id);
      state.activeReelId = state.reels[0].id;
      selectedIds.clear();
      editingId = null;
      // 基线保持不变：它是重组前快照，保留已删卷才能在核对中报告删除去向
    });
    resetForm();
    toast("卷已删除（可撤销）", "success");
  });
}

function switchReel(id) {
  if (!state.reels.some((r) => r.id === id) || id === state.activeReelId) return;
  state.activeReelId = id;
  selectedIds.clear();
  editingId = null;
  resetForm();
  persist();
  renderAll();
}

/* ============================================== 跨卷移动 / 复制 + 冲突 */

function buildTransfer(kind) {
  const reel = activeReel();
  if (!reel) return;
  const target = state.reels.find((r) => r.id === els.targetReelSelect.value);
  if (!target) return toast("请选择目标卷", "error");
  const ids = [...selectedIds].filter((id) => reel.segments.some((s) => s.id === id));
  if (!ids.length) return toast("请先勾选要" + (kind === "move" ? "移动" : "复制") + "的片段", "error");
  if (kind === "move" && target.id === reel.id) return toast("目标卷与当前卷相同，无需移动", "info");

  const segs = ids
    .map((id) => reel.segments.find((s) => s.id === id))
    .filter(Boolean)
    .sort(
      (a, b) =>
        reel.segments.findIndex((x) => x.id === a.id) - reel.segments.findIndex((x) => x.id === b.id)
    );

  // 冲突：与目标卷已有编号重号，或本批内部互相重号（均忽略大小写）
  const conflicts = [];
  const claimed = new Set(); // 本批中不冲突的已占用编号
  for (const seg of segs) {
    const nc = normCode(seg.code);
    const clashSeg = target.segments.find((t) => normCode(t.code) === nc) || null;
    const clashInBatch = !clashSeg && [...claimed].some((c) => normCode(c) === nc);
    if (clashSeg || clashInBatch) {
      conflicts.push({
        segId: seg.id,
        code: seg.code,
        choice: "rename",
        renameTo: suggestCode(seg.code, target, claimed),
        clashInBatch
      });
    } else {
      claimed.add(seg.code);
    }
  }

  pendingConflict = {
    kind,
    sourceReelId: reel.id,
    targetReelId: target.id,
    segIds: segs.map((s) => s.id),
    conflicts
  };
  if (!conflicts.length) executeTransfer();
  else openConflictModal();
}

function suggestCode(code, targetReel, extraClaimed) {
  const match = String(code).match(/^(.*?)(\d+)$/);
  const stem = match ? match[1] : code + "-";
  let n = match ? parseInt(match[2], 10) + 1 : 1;
  const used = new Set(targetReel.segments.map((s) => normCode(s.code)));
  for (const c of extraClaimed || []) used.add(normCode(c));
  do {
    const num = match ? String(n).padStart(match[2].length, "0") : String(n);
    const candidate = `${stem}${num}`;
    if (!used.has(normCode(candidate))) return candidate;
    n++;
  } while (n < 100000);
  return `${stem}${n}`;
}

function openConflictModal() {
  const { kind, targetReelId, conflicts, segIds } = pendingConflict;
  const target = state.reels.find((r) => r.id === targetReelId);
  els.conflictTitle.textContent = "跨卷编号冲突";
  els.conflictIntro.textContent =
    `把 ${segIds.length} 个片段${kind === "move" ? "移动" : "复制"}到「${target.name}」时，${conflicts.length} 个编号与目标卷（或本批片段）重复（忽略大小写判定）。请逐段选择：`;
  renderConflictRows();
  els.conflictModal.classList.remove("hidden");
}

function renderConflictRows() {
  const target = state.reels.find((r) => r.id === pendingConflict.targetReelId);
  els.conflictBody.innerHTML = pendingConflict.conflicts
    .map((c, idx) => {
      const clash = target.segments.find((t) => normCode(t.code) === normCode(c.code));
      const clashText = c.clashInBatch && !clash
        ? "与本批另一片段同号"
        : clash
          ? `目标卷已有 ${escapeHtml(clash.code)}（${formatDuration(clash.duration)}，${escapeHtml(clash.damage)}）`
          : "与本批另一片段同号";
      return `
      <tr data-row="${idx}">
        <td><strong>${escapeHtml(c.code)}</strong></td>
        <td>${clashText}</td>
        <td>
          <select data-choice="${idx}">
            <option value="rename" ${c.choice === "rename" ? "selected" : ""}>自动改名后加入</option>
            <option value="skip" ${c.choice === "skip" ? "selected" : ""}>跳过该片段</option>
            <option value="overwrite" ${c.choice === "overwrite" ? "selected" : ""}>覆盖目标卷同号片段</option>
          </select>
        </td>
        <td class="rename-cell">
          <input type="text" data-rename="${idx}" value="${escapeHtml(c.renameTo)}" maxlength="40"
            ${c.choice !== "rename" ? "disabled" : ""} />
          <span class="row-err" data-err="${idx}"></span>
        </td>
      </tr>`;
    })
    .join("");
}

function closeConflictModal() {
  els.conflictModal.classList.add("hidden");
  pendingConflict = null;
}

function executeTransfer() {
  const task = pendingConflict;
  const source = state.reels.find((r) => r.id === task.sourceReelId);
  const target = state.reels.find((r) => r.id === task.targetReelId);
  const choiceById = new Map(task.conflicts.map((c) => [c.segId, c]));

  let added = 0;
  let renamed = 0;
  let skipped = 0;
  let overwritten = 0;
  const usedNames = new Set(target.segments.map((s) => normCode(s.code)));
  const plan = []; // {type, orig, newCode?}；所有变更放进 applyChange 内执行
  const removedIds = [];
  const overwriteCodes = new Set(); // 本批已安排覆盖的编号，后来同号者改为改名，避免连环覆盖

  for (const id of task.segIds) {
    const orig = source.segments.find((s) => s.id === id);
    if (!orig) continue;
    const c = choiceById.get(id);

    if (c && c.choice === "skip") {
      skipped++;
      continue;
    }
    if (c && c.choice === "overwrite") {
      const nc = normCode(orig.code);
      if (!overwriteCodes.has(nc) && target.segments.some((t) => normCode(t.code) === nc)) {
        overwriteCodes.add(nc);
        plan.push({ type: "overwrite", orig });
        overwritten++;
        added++;
        continue;
      }
      // 本批内部冲突 / 已安排过覆盖：回退为改名
      const newCode = suggestCode(orig.code, target, new Set([...usedNames, ...overwriteCodes]));
      usedNames.add(normCode(newCode));
      plan.push({ type: "rename", orig, newCode });
      renamed++;
      added++;
      continue;
    }
    if (c) {
      const newCode = (c.renameTo || "").trim();
      if (!newCode || MALICIOUS_RE.test(newCode) || CONTROL_RE.test(newCode) || usedNames.has(normCode(newCode))) {
        skipped++;
        continue;
      }
      usedNames.add(normCode(newCode));
      plan.push({ type: "rename", orig, newCode });
      renamed++;
      added++;
      continue;
    }
    usedNames.add(normCode(orig.code));
    plan.push({ type: "copy", orig });
    added++;
  }

  if (task.kind === "move") {
    // 被跳过的片段留在源卷；其余都加入目标卷后从源卷移除
    for (const id of task.segIds) {
      if (plan.some((p) => p.orig.id === id)) removedIds.push(id);
    }
  }

  const verb = task.kind === "move" ? "移动" : "复制";
  const sourceName = source.name;
  const targetName = target.name;
  applyChange(
    `${verb} ${added} 段：「${sourceName}」→「${targetName}」（改名 ${renamed}，覆盖 ${overwritten}，跳过 ${skipped}）`,
    () => {
      for (const step of plan) {
        if (step.type === "overwrite") {
          const idx = target.segments.findIndex((t) => normCode(t.code) === normCode(step.orig.code));
          target.segments[idx] = makeSegment({ ...clone(step.orig), id: uid() });
        } else if (step.type === "rename") {
          target.segments.push(makeSegment({ ...clone(step.orig), id: uid(), code: step.newCode }));
        } else {
          target.segments.push(makeSegment({ ...clone(step.orig), id: uid() }));
        }
      }
      if (task.kind === "move") {
        source.segments = source.segments.filter((s) => !removedIds.includes(s.id));
        removedIds.forEach((rid) => selectedIds.delete(rid));
      }
    }
  );
  closeConflictModal();
  toast(
    `${verb}完成：加入 ${added} 段（自动改名 ${renamed}、覆盖 ${overwritten}、跳过 ${skipped}）。`,
    skipped ? "warn" : "success",
    6000
  );
  if (baseline) runAudit({ silent: true });
}

/* ===================================================== 重组核对（审计） */

function setBaseline() {
  baseline = { at: Date.now(), data: clone(state) };
  persistBaseline();
  renderAudit();
  runAudit({ silent: true });
  toast("已记录重组前基线，之后移动/复制片段会自动核对", "success");
}

function runAudit(options = {}) {
  if (!baseline) {
    if (!options.silent) toast("请先点击「设为重组前基线」", "info");
    return null;
  }
  const threshold = Math.max(1, Math.min(173, Number(els.colorGapInput.value) || DEFAULT_GAP));
  const before = baseline.data;
  const after = state;

  /* ① 编号冲突：同卷重号（硬错误）+ 跨卷同号（提醒） */
  const codeIssues = [];
  const globalMap = new Map();
  after.reels.forEach((reel) => {
    const seen = new Map();
    reel.segments.forEach((s) => {
      const n = normCode(s.code);
      if (seen.has(n)) {
        codeIssues.push({
          level: "error",
          text: `卷「${reel.name}」内 ${s.code} 与 ${seen.get(n).code} 重号（忽略大小写）`,
          why: "同卷编号必须唯一；通常来自跨卷复制/覆盖时编号未改名。"
        });
      } else {
        seen.set(n, s);
      }
      if (!globalMap.has(n)) globalMap.set(n, []);
      globalMap.get(n).push({ reel, seg: s });
    });
  });
  for (const [, hits] of globalMap) {
    if (hits.length > 1) {
      const names = hits.map((h) => `「${h.reel.name}」的 ${h.seg.code}`).join("、");
      codeIssues.push({
        level: "warn",
        text: `编号 ${hits[0].seg.code} 同时出现在 ${hits.length} 个卷：${names}`,
        why: "跨卷同号允许存在，但放映排片时容易取错片盒，建议改名区分。"
      });
    }
  }

  /* ② 丢失片段：基线里有、当前找不到（按片段 id 追踪，自动改名不会被误报） */
  const nowById = new Map(after.reels.flatMap((r) => r.segments.map((s) => [s.id, { reel: r, seg: s }])));
  const beforeLoc = new Map(before.reels.flatMap((r) => r.segments.map((s) => [s.id, { reelName: r.name, seg: s }])));
  const lost = [];
  for (const [id, loc] of beforeLoc) {
    if (!nowById.has(id)) {
      lost.push({
        level: "error",
        text: `「${loc.reelName}」的 ${loc.seg.code}（${formatDuration(loc.seg.duration)}）在当前数据中找不到`,
        why: "该片段被删除，或在跨卷操作中被同号片段覆盖（覆盖会用新片段替换旧片段，旧片段消失）。"
      });
    }
  }
  let addedCount = 0;
  for (const reel of after.reels) {
    for (const s of reel.segments) if (!beforeLoc.has(s.id)) addedCount++;
  }

  /* ③ 总时长：逐卷变化 + 全局守恒（移动守恒，复制增加） */
  const durIssues = [];
  let beforeTotal = 0;
  let afterTotal = 0;
  before.reels.forEach((bReel) => {
    beforeTotal += reelDuration(bReel);
    const aReel = after.reels.find((r) => r.id === bReel.id);
    const bDur = reelDuration(bReel);
    const aDur = aReel ? reelDuration(aReel) : 0;
    if (!aReel) {
      durIssues.push({
        level: "warn",
        text: `卷「${bReel.name}」已被删除，基线时长 ${formatDuration(bDur)} 不再计入`,
        why: "删除整卷带走了全部时长；如非预期请撤销或从备份恢复。"
      });
    } else if (bDur !== aDur) {
      const diff = aDur - bDur;
      durIssues.push({
        level: "warn",
        text: `卷「${bReel.name}」时长 ${formatDuration(bDur)} → ${formatDuration(aDur)}（${diff > 0 ? "+" : "-"}${formatDuration(Math.abs(diff))}）`,
        why: diff > 0
          ? "有片段复制进本卷，或本卷片段时长被调大。"
          : "有片段移出、删除、被覆盖，或时长被调小。"
      });
    }
  });
  after.reels.forEach((r) => (afterTotal += reelDuration(r)));
  if (beforeTotal !== afterTotal) {
    const diff = afterTotal - beforeTotal;
    durIssues.unshift({
      level: "info",
      text: `全部卷总时长 ${formatDuration(beforeTotal)} → ${formatDuration(afterTotal)}（${diff > 0 ? "+" : "-"}${formatDuration(Math.abs(diff))}）`,
      why:
        diff > 0
          ? "总量增加：发生了跨卷复制（纯移动保持总量不变），或新建片段/调大了时长。"
          : "总量减少：有片段被删除、覆盖或时长调小；纯移动不会改变总量。"
    });
  }

  /* ④ 颜色断层：卷内按放映顺序，相邻片段 RGB 偏移 RMS 超阈值 */
  const gapIssues = [];
  for (const reel of after.reels) {
    for (let i = 1; i < reel.segments.length; i++) {
      const a = reel.segments[i - 1];
      const b = reel.segments[i];
      const d = rgbDistance(a.rgb, b.rgb);
      if (d >= threshold) {
        gapIssues.push({
          level: "warn",
          text: `卷「${reel.name}」#${i} ${a.code}（${a.shift}）→ #${i + 1} ${b.code}（${b.shift}）色差 ${d.toFixed(1)} ≥ 阈值 ${threshold}`,
          why: "跨卷移动后相邻片段颜色状态不连续，试映时画面会明显跳变；可在两段间安排缓冲或先做色彩修复。"
        });
      }
    }
  }

  const report = {
    at: Date.now(),
    threshold,
    errorCount: codeIssues.filter((i) => i.level === "error").length + lost.length,
    warnCount: codeIssues.filter((i) => i.level !== "error").length + durIssues.length + gapIssues.length,
    sections: [
      { key: "code", title: "① 编号冲突", issues: codeIssues, empty: "未发现重号。" },
      {
        key: "lost",
        title: "② 丢失片段",
        issues: lost,
        empty: "基线中的片段全部还在。",
        extra: addedCount ? `另有 ${addedCount} 个新增片段（跨卷复制改名或新建产生，新 id 不在基线中，属正常现象）。` : ""
      },
      {
        key: "duration",
        title: "③ 总时长核对",
        issues: durIssues,
        empty: `各卷时长与基线一致，全局总时长守恒（${formatDuration(afterTotal)}）。`
      },
      { key: "color", title: "④ 颜色断层", issues: gapIssues, empty: `没有相邻片段色差达到阈值 ${threshold}。` }
    ]
  };
  renderAuditReport(report);
  if (!options.silent) {
    toast(report.errorCount ? `核对发现 ${report.errorCount} 个必须处理的问题` : "核对完成，无硬性问题", report.errorCount ? "error" : "success");
  }
  return report;
}

function renderAudit() {
  if (!baseline) {
    els.baselineInfo.textContent = "尚未设置基线：先点「设为重组前基线」记录移动/复制前的状态，之后才能对比丢失片段与时长变化。";
    if (!els.auditReport.dataset.filled) {
      els.auditSummary.innerHTML = "";
      els.auditReport.innerHTML = `<div class="audit-empty">设置基线后，这里会输出四项核对结果及原因说明。</div>`;
    }
    return;
  }
  els.baselineInfo.textContent = `重组前基线：${stampText(baseline.at)} 记录，共 ${baseline.data.reels.length} 卷、${baseline.data.reels.reduce((a, r) => a + r.segments.length, 0)} 段。每次重组后自动核对，也可点「重新核对」。`;
}

function renderAuditReport(report) {
  els.auditReport.dataset.filled = "1";
  const cls = report.errorCount ? "bad" : report.warnCount ? "warn" : "good";
  const text = report.errorCount
    ? `${report.errorCount} 个必须处理的问题、${report.warnCount} 个提醒`
    : report.warnCount
      ? `${report.warnCount} 个提醒，无硬性问题`
      : "全部通过：无重号、无丢失、时长守恒、无颜色断层";
  els.auditSummary.innerHTML = `<div class="audit-banner ${cls}"><strong>核对结论：${escapeHtml(text)}</strong><span>${stampText(report.at)}</span></div>`;
  els.auditReport.innerHTML = report.sections
    .map((sec) => {
      const body = sec.issues.length
        ? sec.issues
            .map(
              (i) => `<li class="${i.level}">
                <div class="issue-text">${escapeHtml(i.text)}</div>
                <div class="issue-why">原因：${escapeHtml(i.why)}</div>
              </li>`
            )
            .join("")
        : `<li class="ok">${escapeHtml(sec.empty)}</li>`;
      const extra = sec.extra ? `<div class="audit-extra">${escapeHtml(sec.extra)}</div>` : "";
      return `<section class="audit-section"><h3>${sec.title}</h3><ul class="issue-list">${body}</ul>${extra}</section>`;
    })
    .join("");
  renderAudit();
}

/* ============================================================ 导出层 === */

function downloadText(filename, content, mime, bom = false) {
  const blob = new Blob([bom ? "﻿" + content : content], { type: `${mime};charset=utf-8` });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function exportTxt() {
  const lines = ["多卷胶片修复核对清单", `导出时间：${stampText(Date.now())}`, "=".repeat(42), ""];
  state.reels.forEach((reel, ri) => {
    lines.push(`【胶片卷 ${ri + 1}】${reel.name}`);
    lines.push(`片段 ${reel.segments.length} 段 · 总时长 ${formatDuration(reelDuration(reel))}`);
    reel.segments.forEach((s, i) => {
      lines.push(
        `${String(i + 1).padStart(2, "0")}. ${s.code}｜${formatDuration(s.duration)}｜颜色：${s.shift}(RGB ${s.rgb.r},${s.rgb.g},${s.rgb.b})｜破损：${s.damage}｜结论：${s.conclusion || "—"}｜备注：${s.note || "无"}`
      );
    });
    lines.push("");
  });
  const all = state.reels.flatMap((r) => r.segments);
  lines.push("=".repeat(42));
  lines.push(`合计：${state.reels.length} 卷 / ${all.length} 段 / 总时长 ${formatDuration(all.reduce((a, s) => a + s.duration, 0))}`);
  downloadText(`胶片核对清单-${fileStamp()}.txt`, lines.join("\n"), "text/plain");
  toast("文本清单已导出", "success");
}

function exportCsv() {
  const rows = [["卷名", "序号", "片段编号", "时长(秒)", "时长(时分秒)", "颜色偏移", "R", "G", "B", "破损情况", "处理结论", "备注"]];
  state.reels.forEach((reel) => {
    reel.segments.forEach((s, i) => {
      rows.push([
        reel.name, i + 1, s.code, s.duration, formatDuration(s.duration), s.shift,
        s.rgb.r, s.rgb.g, s.rgb.b, s.damage, s.conclusion || "", s.note || ""
      ]);
    });
  });
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  downloadText(`胶片核对清单-${fileStamp()}.csv`, csv, "text/csv", true);
  toast("CSV 清单已导出", "success");
}

function exportJsonBackup() {
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    reels: clone(state.reels),
    activeReelId: state.activeReelId
  };
  // 导出前再校验：绝不把非法结构写进备份文件
  const check = validateData({ version: 2, reels: payload.reels, activeReelId: payload.activeReelId });
  if (!check.ok) {
    toast("当前数据未通过校验，已阻止导出：" + check.errors[0], "error", 6000);
    return;
  }
  downloadText(`胶片备份-${fileStamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
  toast("完整 JSON 备份已导出", "success");
}

/* ------------------------------------------------------- 恢复 / 快照 */

function restoreFromFile(file) {
  if (!file) return toast("请先选择备份文件", "info");
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (err) {
      showRestoreErrors([`文件不是合法 JSON（${err.message}），可能已损坏；当前数据未做任何改动。`]);
      return;
    }
    // 整份原始对象直接进校验器：未知字段（如 evilField、__proto__）一律拒绝；
    // 导出包装里的 exportedAt 在白名单内，校验通过后只保留 reels / activeReelId。
    const result = validateData(parsed);
    if (!result.ok) return showRestoreErrors(result.errors);
    confirmDialog(
      "恢复确认",
      `备份校验通过：${result.data.reels.length} 卷、${result.data.reels.reduce((a, r) => a + r.segments.length, 0)} 段。恢复会覆盖当前全部数据（当前状态可撤销），确定？`,
      () => {
        applyChange("从备份文件恢复数据", () => {
          state = result.data;
          selectedIds.clear();
          editingId = null;
        });
        resetForm();
        toast("备份已恢复", "success");
      }
    );
  };
  reader.onerror = () => showRestoreErrors(["读取文件失败，文件可能已损坏。"]);
  reader.readAsText(file);
}

function showRestoreErrors(errors) {
  const max = errors.slice(0, 8).map((e) => `• ${e}`).join("\n");
  const more = errors.length > 8 ? `\n…另有 ${errors.length - 8} 条` : "";
  confirmDialog(
    "备份已被拒绝，未写入清单",
    `校验发现 ${errors.length} 个问题：\n${max}${more}\n\n当前数据保持不变。`,
    null,
    { okText: "我知道了", cancelHidden: true }
  );
}

function saveSnapshot() {
  const snap = {
    at: Date.now(),
    data: clone(state),
    label: `${state.reels.length}卷/${state.reels.reduce((a, r) => a + r.segments.length, 0)}段`
  };
  snapshots.unshift(snap);
  snapshots = snapshots.slice(0, MAX_SNAPSHOTS);
  persistSnapshots();
  renderBackupPanel();
  toast("快照已保存到本机浏览器", "success");
}

function restoreSnapshot(index = 0) {
  const snap = snapshots[index];
  if (!snap) return toast("没有可恢复的快照", "info");
  const result = validateData(clone(snap.data));
  if (!result.ok) return showRestoreErrors(["快照数据校验失败：" + result.errors[0]]);
  confirmDialog("恢复本机快照", `将恢复到 ${stampText(snap.at)} 的状态（当前状态可撤销），确定？`, () => {
    applyChange(`恢复本机快照（${stampText(snap.at)}）`, () => {
      state = result.data;
      selectedIds.clear();
      editingId = null;
    });
    resetForm();
    toast("快照已恢复", "success");
  });
}

function wipeAll() {
  confirmDialog(
    "清空全部数据",
    "将删除本机所有卷、片段、基线与快照，且无法找回。强烈建议先导出 JSON 备份。确定清空？",
    () => {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(BASELINE_KEY);
      localStorage.removeItem(SNAPSHOT_KEY);
      history = [];
      future = [];
      baseline = null;
      snapshots = [];
      state = defaultData();
      selectedIds.clear();
      editingId = null;
      resetForm();
      pushLog("清空全部数据并重建工作台");
      renderAll();
      toast("已清空，工作台恢复初始示例", "success");
    }
  );
}

function renderBackupPanel() {
  els.snapshotList.innerHTML = snapshots.length
    ? snapshots
        .map(
          (s, i) => `<li>
            <span>${stampText(s.at)} · ${escapeHtml(s.label || "")}</span>
            <button type="button" data-snap="${i}">恢复</button>
          </li>`
        )
        .join("")
    : `<li class="empty">暂无快照</li>`;
  els.opLog.innerHTML = opLog.length
    ? opLog
        .slice(0, 12)
        .map((l) => `<li><time>${stampText(l.at)}</time><span>${escapeHtml(l.text)}</span></li>`)
        .join("")
    : `<li class="empty">暂无操作记录</li>`;
}

/* ========================================================== 弹窗与提示 */

function toast(message, type = "info", timeout = 3500) {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toastHost.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 300);
  }, timeout);
}

function closeConfirm() {
  els.confirmModal.classList.add("hidden");
  els.confirmOkBtn.onclick = null;
  els.confirmCancelBtn.onclick = null;
}

function confirmDialog(title, text, onOk, opts = {}) {
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.confirmOkBtn.textContent = opts.okText || "确定";
  els.confirmCancelBtn.classList.toggle("hidden", !!opts.cancelHidden);
  els.confirmCancelBtn.textContent = "取消";
  els.confirmModal.classList.remove("hidden");
  els.confirmOkBtn.onclick = () => {
    closeConfirm();
    if (typeof onOk === "function") onOk();
  };
  els.confirmCancelBtn.onclick = closeConfirm;
}

function promptDialog(title, label, defaultValue, onOk) {
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = "";
  const lab = document.createElement("label");
  lab.className = "prompt-label";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.value = defaultValue || "";
  input.maxLength = 60;
  lab.appendChild(span);
  lab.appendChild(input);
  els.confirmText.appendChild(lab);
  els.confirmOkBtn.textContent = "确定";
  els.confirmCancelBtn.classList.remove("hidden");
  els.confirmModal.classList.remove("hidden");
  setTimeout(() => input.focus(), 30);

  const cleanup = () => {
    closeConfirm();
    input.onkeydown = null;
  };
  els.confirmOkBtn.onclick = () => {
    const value = input.value;
    cleanup();
    onOk(value);
  };
  els.confirmCancelBtn.onclick = cleanup;
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      els.confirmOkBtn.click();
    }
  };
}

/* ============================================================ 事件绑定 */

function bindEvents() {
  els.tabDesk.addEventListener("click", () => switchTab("desk"));
  els.tabAudit.addEventListener("click", () => switchTab("audit"));
  els.tabBackup.addEventListener("click", () => switchTab("backup"));

  els.undoBtn.addEventListener("click", undo);
  els.redoBtn.addEventListener("click", redo);
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (!typing && key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (!typing && key === "y") {
      e.preventDefault();
      redo();
    }
  });

  els.newReelBtn.addEventListener("click", createReel);
  els.dupReelBtn.addEventListener("click", duplicateReel);
  els.renameReelBtn.addEventListener("click", renameReel);
  els.delReelBtn.addEventListener("click", removeReel);
  els.reelList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-switch-reel]");
    if (btn) switchReel(btn.dataset.switchReel);
  });

  els.segmentForm.addEventListener("submit", submitSegment);
  els.resetFormBtn.addEventListener("click", resetForm);
  els.cancelEditLink.addEventListener("click", (e) => {
    e.preventDefault();
    resetForm();
  });
  els.damageInput.addEventListener("change", renderForm);

  els.searchInput.addEventListener("input", () => {
    filterState.keyword = els.searchInput.value;
    renderList();
  });
  els.colorFilter.addEventListener("change", () => {
    filterState.shift = els.colorFilter.value;
    renderList();
  });
  els.damageFilter.addEventListener("change", () => {
    filterState.damage = els.damageFilter.value;
    renderList();
  });
  els.clearFilterBtn.addEventListener("click", () => {
    filterState = { keyword: "", shift: "all", damage: "all" };
    els.searchInput.value = "";
    els.colorFilter.value = "all";
    els.damageFilter.value = "all";
    renderList();
  });

  els.segmentList.addEventListener("click", (e) => {
    const card = e.target.closest(".segment-card");
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest("[data-edit]")) startEdit(id);
    else if (e.target.closest("[data-up]")) moveSegment(id, -1);
    else if (e.target.closest("[data-down]")) moveSegment(id, 1);
    else if (e.target.closest("[data-del]")) deleteSegment(id);
  });
  els.segmentList.addEventListener("change", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (!pick) return;
    if (pick.checked) selectedIds.add(pick.dataset.pick);
    else selectedIds.delete(pick.dataset.pick);
    renderList();
  });
  els.selectAllBtn.addEventListener("click", () => {
    const reel = activeReel();
    if (!reel) return;
    const visible = getVisibleSegments(reel);
    const allOn = visible.length > 0 && visible.every((s) => selectedIds.has(s.id));
    if (allOn) visible.forEach((s) => selectedIds.delete(s.id));
    else visible.forEach((s) => selectedIds.add(s.id));
    renderList();
  });
  els.bulkMoveBtn.addEventListener("click", () => buildTransfer("move"));
  els.bulkCopyBtn.addEventListener("click", () => buildTransfer("copy"));

  // 拖拽：dragstart 留存变更前快照；dragover 只移动 DOM 节点（不重建列表）；drop 时按 DOM 顺序一次性重排 state
  els.segmentList.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".segment-card");
    if (!card) return;
    dragSnapshot = clone(state);
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.id);
  });
  els.segmentList.addEventListener("dragover", (e) => {
    const card = e.target.closest(".segment-card");
    if (!card || !dragSnapshot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const draggingNode = document.querySelector(".segment-card.dragging");
    if (!draggingNode || card === draggingNode) return;
    const rect = card.getBoundingClientRect();
    const after = e.clientY - rect.top > rect.height / 2;
    if (after) {
      if (card.nextElementSibling !== draggingNode) card.after(draggingNode);
    } else {
      if (card.previousElementSibling !== draggingNode) card.before(draggingNode);
    }
  });
  els.segmentList.addEventListener("dragend", () => {
    document.querySelectorAll(".segment-card.dragging").forEach((n) => n.classList.remove("dragging"));
    // 拖到列表外松手 = 取消：直接恢复快照
    if (dragSnapshot) {
      state = dragSnapshot;
      persist();
      renderAll();
      dragSnapshot = null;
    }
  });
  els.segmentList.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragSnapshot) return;
    const reel = activeReel();
    const domIds = [...els.segmentList.querySelectorAll(".segment-card")].map((n) => n.dataset.id);
    const byId = new Map(reel.segments.map((s) => [s.id, s]));
    // 筛选状态下只在可见子序列内重排，被隐藏的片段保持原位
    const visibleSet = new Set(domIds);
    let vi = 0;
    reel.segments = reel.segments.map((s) => (visibleSet.has(s.id) ? byId.get(domIds[vi++]) : s));
    if (JSON.stringify(dragSnapshot) !== JSON.stringify(state)) {
      history.push(dragSnapshot);
      if (history.length > MAX_HISTORY) history.shift();
      future = [];
      pushLog(`调整「${reel.name}」内片段顺序`);
    }
    dragSnapshot = null;
    persist();
    renderAll();
  });

  els.setBaselineBtn.addEventListener("click", setBaseline);
  els.runAuditBtn.addEventListener("click", () => runAudit());

  els.exportTxtBtn.addEventListener("click", exportTxt);
  els.exportCsvBtn.addEventListener("click", exportCsv);
  els.exportJsonBtn.addEventListener("click", exportJsonBackup);
  els.downloadBackupBtn.addEventListener("click", exportJsonBackup);
  els.restoreBtn.addEventListener("click", () => restoreFromFile(els.restoreFile.files[0]));
  els.snapshotBtn.addEventListener("click", saveSnapshot);
  els.restoreSnapshotBtn.addEventListener("click", () => restoreSnapshot(0));
  els.dangerZoneBtn.addEventListener("click", wipeAll);
  els.snapshotList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-snap]");
    if (btn) restoreSnapshot(Number(btn.dataset.snap));
  });

  els.conflictCancelBtn.addEventListener("click", closeConflictModal);
  els.conflictConfirmBtn.addEventListener("click", executeTransfer);
  els.conflictModal.addEventListener("click", (e) => {
    if (e.target === els.conflictModal) closeConflictModal();
  });
  els.conflictBody.addEventListener("input", (e) => {
    if (!pendingConflict) return;
    const idx = Number(e.target.dataset.rename);
    if (Number.isInteger(idx) && pendingConflict.conflicts[idx]) {
      pendingConflict.conflicts[idx].renameTo = e.target.value;
    }
  });
  els.conflictBody.addEventListener("change", (e) => {
    if (!pendingConflict) return;
    const idx = Number(e.target.dataset.choice);
    if (!Number.isInteger(idx) || !pendingConflict.conflicts[idx]) return;
    pendingConflict.conflicts[idx].choice = e.target.value;
    if (e.target.value === "rename") {
      const target = state.reels.find((r) => r.id === pendingConflict.targetReelId);
      const c = pendingConflict.conflicts[idx];
      const claimed = new Set(pendingConflict.conflicts.filter((x) => x !== c).map((x) => x.code));
      c.renameTo = c.renameTo || suggestCode(c.code, target, claimed);
    }
    renderConflictRows();
  });
}

/* ------------------------------------------------------------- 启动 */

cacheEls();
initState();
bindEvents();
pushLog("打开核对台");
renderAll();
