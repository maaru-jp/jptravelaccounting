import { CATEGORIES, PAYMENTS, categoryById, paymentById } from "./config.js";
import { buildDefaultItinerary, regionForDate } from "./itinerary.js";
import { DEFAULT_TRAVELERS } from "./seed.js";
import { recognizeReceipt } from "./receipt-ai.js";
import { pushToSheet, pullFromSheet } from "./sheets.js";

const STORAGE_KEY = "jp-trip-ledger-v2";
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

function el(id) {
  return document.getElementById(id);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function defaultState() {
  const start = "2026-02-24";
  return {
    trip: { name: "2026初次東京小旅遊", start, end: "2026-03-25", budgetJpy: 150000 },
    rateTwdPerJpy: 0.206,
    travelers: DEFAULT_TRAVELERS,
    itinerary: buildDefaultItinerary(start, 30),
    transactions: [],
    settings: { sheetUrl: "", visionUrl: "", openaiKey: "" },
  };
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || defaultState();
  } catch {
    return defaultState();
  }
}

let state = loadState();
if (!state.settings) state.settings = { sheetUrl: "", visionUrl: "", openaiKey: "" };
if (!Array.isArray(state.transactions)) state.transactions = [];

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatJpy(n) {
  return `¥${Number(n || 0).toLocaleString("ja-JP")}`;
}

function formatTwd(n) {
  return `NT$${Number(n || 0).toLocaleString("zh-TW")}`;
}

function jpyToTwd(n) {
  return Math.round(Number(n || 0) * Number(state.rateTwdPerJpy || 0.2));
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function uid() {
  return `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const views = {
  home: el("view-home"),
  records: el("view-records"),
  scan: el("view-scan"),
  stats: el("view-stats"),
  settings: el("view-settings"),
};

function showView(name) {
  Object.entries(views).forEach(([k, node]) => node && node.classList.toggle("view--active", k === name));
  document.querySelectorAll(".bottom-nav__item").forEach((b) => b.classList.toggle("bottom-nav__item--active", b.dataset.view === name));
  if (name === "home") renderHome();
  if (name === "records") renderRecords();
  if (name === "stats") renderCharts();
  if (name === "settings") loadSettingsForm();
}

document.querySelectorAll(".bottom-nav__item").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.view));
});
if (el("scan-back")) el("scan-back").addEventListener("click", () => showView("home"));

function fillSelects() {
  const cat = CATEGORIES.map((x) => `<option value="${x.id}">${x.label}</option>`).join("");
  const pay = PAYMENTS.map((x) => `<option value="${x.id}">${x.label}</option>`).join("");
  const users = state.travelers.map((x) => `<option value="${x.id}">${x.emoji} ${x.name}</option>`).join("");
  ["f-category", "edit-category"].forEach((id) => {
    if (el(id)) el(id).innerHTML = cat;
  });
  ["f-payment", "edit-payment"].forEach((id) => {
    if (el(id)) el(id).innerHTML = pay;
  });
  ["f-traveler", "edit-traveler"].forEach((id) => {
    if (el(id)) el(id).innerHTML = users;
  });
}

function travelerEmoji(id) {
  return state.travelers.find((x) => x.id === id)?.emoji || "👤";
}

function txCard(tx) {
  const c = categoryById(tx.category);
  const p = paymentById(tx.payment);
  return `
    <article class="tx-card" data-id="${esc(tx.id)}">
      <div class="tx-card__avatar">${travelerEmoji(tx.travelerId)}</div>
      <div class="tx-card__mid">
        <p class="tx-card__title">${esc(tx.description || tx.location || "未命名")}</p>
        <div class="tx-card__tags">
          <span class="tag-cat ${c.className}">${esc(c.label)}</span>
          <span class="tag-pay">${esc(p.label)}</span>
          <span class="tag-loc">📍 ${esc(tx.location || "—")}</span>
          ${tx.region ? `<span class="tag-loc">${esc(tx.region)}</span>` : ""}
        </div>
      </div>
      <div class="tx-card__amt">
        <p class="tx-card__jpy">${formatJpy(tx.amountJpy)}</p>
        <p class="tx-card__twd">${formatTwd(jpyToTwd(tx.amountJpy))}</p>
      </div>
      <button type="button" class="tx-card__edit">✏️</button>
    </article>
  `;
}

function bindEditClicks(container) {
  if (!container) return;
  container.querySelectorAll(".tx-card__edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tx = state.transactions.find((x) => x.id === btn.closest(".tx-card")?.dataset.id);
      if (tx) openEditModal(tx);
    });
  });
}

function applyRegions() {
  state.transactions.forEach((t) => {
    t.region = regionForDate(state.itinerary, t.date) || t.region || "";
  });
}

function renderHome() {
  applyRegions();
  if (el("trip-title")) el("trip-title").textContent = state.trip.name;
  if (el("trip-dates")) el("trip-dates").textContent = `${state.trip.start} — ${state.trip.end}`;

  const today = todayStr();
  const todayTx = state.transactions.filter((x) => x.date === today);
  const todaySum = todayTx.reduce((s, x) => s + Number(x.amountJpy || 0), 0);
  const total = state.transactions.reduce((s, x) => s + Number(x.amountJpy || 0), 0);
  const budgetUsed = state.transactions
    .filter((x) => x.payment === "cash" || x.payment === "suica")
    .reduce((s, x) => s + Number(x.amountJpy || 0), 0);
  const pct = state.trip.budgetJpy ? Math.min(100, Math.round((budgetUsed / state.trip.budgetJpy) * 100)) : 0;

  if (el("dash-today-jpy")) el("dash-today-jpy").textContent = formatJpy(todaySum);
  if (el("dash-today-twd")) el("dash-today-twd").textContent = `≈ ${formatTwd(jpyToTwd(todaySum))}`;
  if (el("dash-total-jpy")) el("dash-total-jpy").textContent = formatJpy(total);
  if (el("dash-total-twd")) el("dash-total-twd").textContent = `≈ ${formatTwd(jpyToTwd(total))}`;
  if (el("dash-budget-pct")) el("dash-budget-pct").textContent = `${pct}%`;
  if (el("dash-budget-bar")) el("dash-budget-bar").style.width = `${pct}%`;

  const start = new Date(state.trip.start + "T12:00:00");
  const end = new Date(state.trip.end + "T12:00:00");
  const now = new Date();
  const totalDays = Math.max(1, Math.floor((end - start) / 86400000) + 1);
  const day = Math.max(1, Math.min(totalDays, Math.floor((now - start) / 86400000) + 1));
  if (el("dash-day-label")) el("dash-day-label").textContent = `Day ${day}`;
  if (el("dash-day-total")) el("dash-day-total").textContent = `共 ${totalDays} 天`;

  const list = el("home-today-list");
  if (list) {
    list.innerHTML = todayTx.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(txCard).join("");
    bindEditClicks(list);
  }
  if (el("home-empty")) el("home-empty").classList.toggle("empty-hint--show", todayTx.length === 0);
}

function renderRecords() {
  applyRegions();
  const total = state.transactions.reduce((s, x) => s + Number(x.amountJpy || 0), 0);
  if (el("records-total-jpy")) el("records-total-jpy").textContent = formatJpy(total);
  if (el("records-total-twd")) el("records-total-twd").textContent = `≈ ${formatTwd(jpyToTwd(total))}`;
  if (el("records-count")) el("records-count").textContent = `${state.transactions.length} 筆`;

  const byDate = el("records-by-date");
  const byCategory = el("records-by-category");
  if (!byDate || !byCategory) return;
  byDate.innerHTML = "";
  byCategory.innerHTML = "";

  const dates = [...new Set(state.transactions.map((x) => x.date))].sort((a, b) => b.localeCompare(a));
  dates.forEach((d) => {
    const txs = state.transactions.filter((x) => x.date === d);
    const sum = txs.reduce((s, x) => s + Number(x.amountJpy || 0), 0);
    const dt = new Date(d + "T12:00:00");
    const section = document.createElement("section");
    section.className = "record-day";
    section.innerHTML = `
      <div class="record-day__head">
        <span class="record-day__date">${d}（${WEEK[dt.getDay()]}）</span>
        <span class="record-day__total">總計 ${formatJpy(sum)} ≈ ${formatTwd(jpyToTwd(sum))}</span>
      </div>
      <div class="record-day__list">${txs.map(txCard).join("")}</div>
    `;
    byDate.appendChild(section);
    bindEditClicks(section);
  });

  CATEGORIES.forEach((c) => {
    const txs = state.transactions.filter((x) => x.category === c.id);
    if (!txs.length) return;
    const sec = document.createElement("section");
    sec.className = "record-cat";
    sec.innerHTML = `
      <h3 class="record-cat__title">${c.label} · ${formatJpy(txs.reduce((s, x) => s + Number(x.amountJpy || 0), 0))}</h3>
      <div class="record-day__list">${txs.map(txCard).join("")}</div>
    `;
    byCategory.appendChild(sec);
    bindEditClicks(sec);
  });
}

let scanItems = [];
let lastDataUrl = "";
const scanFallbackHint = el("scan-fallback-hint");

function renderEditableItems() {
  const ul = el("f-items");
  if (!ul) return;
  ul.innerHTML = "";
  if (!scanItems.length) {
    ul.innerHTML = `<li class="item-row__empty">尚無品項，可手動新增</li>`;
    updateItemsHint();
    return;
  }
  scanItems.forEach((it, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="item-row">
        <input type="text" data-k="nameZh" data-i="${idx}" value="${esc(it.nameZh || "")}" placeholder="繁中品名">
        <input type="text" data-k="nameJa" data-i="${idx}" value="${esc(it.nameJa || "")}" placeholder="日文品名">
        <input type="number" data-k="price" data-i="${idx}" value="${Number(it.price || 0)}" min="0" step="1">
        <input type="text" data-k="tax" data-i="${idx}" value="${esc(it.tax || "")}" placeholder="稅別">
        <button type="button" class="item-row__delete" data-del="${idx}">🗑️</button>
      </div>
    `;
    ul.appendChild(li);
  });
  updateItemsHint();
}

function updateItemsHint() {
  const node = el("items-sum-hint");
  if (!node) return;
  const total = Number(el("f-amount")?.value || 0);
  const sum = scanItems.reduce((s, x) => s + Number(x.price || 0), 0);
  const diff = total - sum;
  node.textContent = `品項合計 ${formatJpy(sum)}，與總額差 ${formatJpy(diff)}`;
}

function syncItemsDataset() {
  const f = el("scan-result-form");
  if (f) f.dataset.itemsJson = JSON.stringify(scanItems);
}

function sanitizeSummary(text, isFallback) {
  let s = String(text || "").trim().replace(/\s*·\s*若已設定 OpenAI 或 Apps Script 將改為真實辨識\s*$/u, "");
  if (isFallback && (!s || /^（示範）/u.test(s))) return "示範辨識結果（可手動修正後儲存）";
  return s;
}

function fillScanForm(result) {
  if (scanFallbackHint) scanFallbackHint.hidden = !result?.isFallback;
  if (el("f-location")) el("f-location").value = result.storeNameZh || result.storeName || "";
  if (el("f-desc")) el("f-desc").value = sanitizeSummary(result.summaryZh || "", !!result.isFallback);
  if (el("f-amount")) el("f-amount").value = Number(result.totalJpy || 0);
  if (el("f-category")) el("f-category").value = guessCategory((result.summaryZh || "") + (result.storeNameZh || ""));
  if (el("f-payment")) el("f-payment").value = "cash";
  if (el("f-traveler")) el("f-traveler").value = state.travelers[0]?.id || "t1";
  if (el("f-date")) el("f-date").value = todayStr();
  updateRegionHint();
  scanItems = (result.items || []).map((x) => ({
    nameJa: x.nameJa || "",
    nameZh: x.nameZh || x.nameJa || "",
    price: Number(x.price || 0),
    tax: x.tax || "",
  }));
  renderEditableItems();
  syncItemsDataset();
  const form = el("scan-result-form");
  if (form) form.dataset.taxType = result.taxType || "";
}

function guessCategory(text) {
  const t = String(text || "").toLowerCase();
  if (/咖啡|餐|飯|麵|壽司|lawson|7|便利|星巴克/.test(t)) return "dining";
  if (/藥妝|購物|無印|紀念/.test(t)) return "shopping";
  if (/交通|新幹線|巴士|計程|電車|駅|suica/.test(t)) return "transport";
  if (/宿|飯店|旅館|温泉/.test(t)) return "hotel";
  if (/景點|門票|城|樂園/.test(t)) return "sight";
  return "other";
}

function updateRegionHint() {
  const d = el("f-date")?.value;
  const r = regionForDate(state.itinerary, d);
  if (el("f-region-hint")) el("f-region-hint").textContent = r ? `依行程表，此日地區為：${r}` : "此日尚未設定地區";
}

async function shrinkDataUrl(dataUrl, max = 1600, q = 0.82) {
  if (!String(dataUrl).startsWith("data:image/")) return dataUrl;
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, max / Math.max(w, h));
  if (scale >= 1) return dataUrl;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", q);
}

function setSyncStatus(text, ok = null) {
  const n = el("sheet-sync-status");
  if (!n) return;
  const head = ok === true ? "同步狀態：✅ " : ok === false ? "同步狀態：⚠️ " : "同步狀態：";
  n.textContent = head + text;
}

async function verifyWrite(url, expectedRows) {
  try {
    const rows = await pullFromSheet(url);
    if (!expectedRows.length) return { ok: rows.length === 0, count: rows.length };
    const ids = new Set(rows.map((x) => String(x.id || "")));
    const probe = expectedRows.slice(-3).map((x) => String(x.id || ""));
    const missing = probe.filter((id) => id && !ids.has(id));
    return missing.length ? { ok: false, error: "最新資料未出現在試算表" } : { ok: true, count: rows.length };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function serializeRows() {
  return state.transactions.map((t) => ({
    id: t.id,
    date: t.date,
    amountJpy: Number(t.amountJpy || 0),
    category: t.category || "other",
    payment: t.payment || "cash",
    location: t.location || "",
    region: t.region || "",
    description: t.description || "",
    travelerId: t.travelerId || "t1",
    taxType: t.taxType || "",
    itemsJson: JSON.stringify(t.items || []),
    createdAt: t.createdAt || "",
  }));
}

function parseRows(rows) {
  return rows.map((r) => ({
    id: r.id || uid(),
    date: r.date || todayStr(),
    amountJpy: Number(r.amountJpy || 0),
    category: r.category || "other",
    payment: r.payment || "cash",
    location: r.location || "",
    region: r.region || "",
    description: r.description || "",
    travelerId: r.travelerId || "t1",
    taxType: r.taxType || "",
    items: safeItems(r.itemsJson),
    createdAt: r.createdAt || new Date().toISOString(),
  }));
}

function safeItems(s) {
  try {
    const j = typeof s === "string" ? JSON.parse(s) : s;
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

async function autoSyncPush(source = "auto") {
  const url = state.settings.sheetUrl;
  if (!url) return { ok: false, error: "尚未設定 Apps Script 網址" };
  try {
    const payload = serializeRows();
    await pushToSheet(url, payload);
    const verify = await verifyWrite(url, payload);
    if (!verify.ok) throw new Error(verify.error || "驗證失敗");
    setSyncStatus(`${source}同步成功（已驗證 ${verify.count} 筆）`, true);
    return { ok: true };
  } catch (e) {
    setSyncStatus(`${source}同步失敗：${e.message || e}`, false);
    return { ok: false, error: e.message || String(e) };
  }
}

const scanFile = el("scan-file");
if (scanFile) {
  scanFile.addEventListener("change", async () => {
    const f = scanFile.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        lastDataUrl = await shrinkDataUrl(reader.result, 1600, 0.82);
        if (el("scan-preview")) {
          el("scan-preview").src = lastDataUrl;
          el("scan-preview").hidden = false;
        }
        if (el("scan-placeholder")) el("scan-placeholder").hidden = true;
        if (el("scan-result-form")) el("scan-result-form").hidden = true;
        if (el("scan-status")) el("scan-status").hidden = false;
        const result = await recognizeReceipt(lastDataUrl, {
          openaiKey: state.settings.openaiKey,
          visionUrl: state.settings.visionUrl || state.settings.sheetUrl,
        });
        fillScanForm(result);
        if (el("scan-result-form")) el("scan-result-form").hidden = false;
      } catch (e) {
        alert("辨識過程發生錯誤：" + (e.message || String(e)));
      } finally {
        if (el("scan-status")) el("scan-status").hidden = true;
      }
    };
    reader.readAsDataURL(f);
  });
}

if (el("f-items")) {
  el("f-items").addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    const idx = Number(t.dataset.i);
    const key = t.dataset.k;
    if (Number.isNaN(idx) || !key || !scanItems[idx]) return;
    scanItems[idx][key] = key === "price" ? Math.max(0, Number(t.value || 0)) : t.value;
    syncItemsDataset();
    updateItemsHint();
  });
  el("f-items").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-del]");
    if (!btn) return;
    const idx = Number(btn.dataset.del);
    if (Number.isNaN(idx)) return;
    scanItems.splice(idx, 1);
    syncItemsDataset();
    renderEditableItems();
  });
}
if (el("btn-add-item")) {
  el("btn-add-item").addEventListener("click", () => {
    scanItems.push({ nameZh: "新品項", nameJa: "", price: 0, tax: "" });
    syncItemsDataset();
    renderEditableItems();
  });
}
if (el("btn-rebalance-items")) {
  el("btn-rebalance-items").addEventListener("click", () => {
    if (!scanItems.length) return;
    const total = Number(el("f-amount")?.value || 0);
    const rest = scanItems.slice(0, -1).reduce((s, x) => s + Number(x.price || 0), 0);
    scanItems[scanItems.length - 1].price = Math.max(0, total - rest);
    syncItemsDataset();
    renderEditableItems();
  });
}
if (el("f-amount")) el("f-amount").addEventListener("input", updateItemsHint);
if (el("f-date")) el("f-date").addEventListener("change", updateRegionHint);

if (el("scan-reset")) {
  el("scan-reset").addEventListener("click", () => {
    if (scanFile) scanFile.value = "";
    if (el("scan-preview")) el("scan-preview").hidden = true;
    if (el("scan-placeholder")) el("scan-placeholder").hidden = false;
    if (el("scan-result-form")) el("scan-result-form").hidden = true;
    if (scanFallbackHint) scanFallbackHint.hidden = true;
    scanItems = [];
    syncItemsDataset();
  });
}

if (el("scan-result-form")) {
  el("scan-result-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const date = el("f-date")?.value || todayStr();
    const tx = {
      id: uid(),
      date,
      amountJpy: Number(el("f-amount")?.value || 0),
      category: el("f-category")?.value || "other",
      payment: el("f-payment")?.value || "cash",
      location: el("f-location")?.value || "",
      region: regionForDate(state.itinerary, date) || "",
      description: el("f-desc")?.value || el("f-location")?.value || "",
      travelerId: el("f-traveler")?.value || "t1",
      items: scanItems,
      taxType: el("scan-result-form").dataset.taxType || "",
      createdAt: new Date().toISOString(),
    };
    state.transactions.push(tx);
    saveState();
    el("scan-reset")?.click();
    showView("home");
    const r = await autoSyncPush("掃描後");
    if (!r.ok) alert(`已加入本機記帳，但試算表同步失敗：${r.error}`);
  });
}

const modal = el("modal-edit");
function openEditModal(tx) {
  if (!modal) return;
  el("edit-id").value = tx.id;
  el("edit-desc").value = tx.description || "";
  el("edit-amount").value = tx.amountJpy || 0;
  el("edit-category").value = tx.category || "other";
  el("edit-payment").value = tx.payment || "cash";
  el("edit-location").value = tx.location || "";
  el("edit-date").value = tx.date || todayStr();
  el("edit-traveler").value = tx.travelerId || "t1";
  modal.showModal();
}

if (el("form-edit")) {
  el("form-edit").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = state.transactions.find((x) => x.id === el("edit-id").value);
    if (!t) return;
    t.description = el("edit-desc").value;
    t.amountJpy = Number(el("edit-amount").value || 0);
    t.category = el("edit-category").value;
    t.payment = el("edit-payment").value;
    t.location = el("edit-location").value;
    t.date = el("edit-date").value;
    t.travelerId = el("edit-traveler").value;
    t.region = regionForDate(state.itinerary, t.date) || "";
    saveState();
    modal.close();
    renderHome();
    renderRecords();
    renderCharts();
    await autoSyncPush("編輯後");
  });
}

if (el("edit-delete")) {
  el("edit-delete").addEventListener("click", async () => {
    const id = el("edit-id").value;
    state.transactions = state.transactions.filter((x) => x.id !== id);
    saveState();
    modal?.close();
    renderHome();
    renderRecords();
    renderCharts();
    await autoSyncPush("刪除後");
  });
}

let charts = { daily: null, category: null, payment: null };
function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    charts[key] = null;
  }
}

function renderCharts() {
  if (typeof Chart === "undefined" || !el("chart-daily")) return;
  const byDate = {};
  state.transactions.forEach((t) => {
    byDate[t.date] = (byDate[t.date] || 0) + Number(t.amountJpy || 0);
  });
  const dates = Object.keys(byDate).sort();
  destroyChart("daily");
  charts.daily = new Chart(el("chart-daily"), {
    type: "line",
    data: { labels: dates, datasets: [{ data: dates.map((d) => byDate[d]), borderColor: "#ff9500", fill: true, backgroundColor: "rgba(255,149,0,.14)", tension: 0.3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });

  const catData = CATEGORIES.map((c) =>
    state.transactions.filter((t) => t.category === c.id).reduce((s, x) => s + Number(x.amountJpy || 0), 0)
  );
  destroyChart("category");
  charts.category = new Chart(el("chart-category"), {
    type: "doughnut",
    data: { labels: CATEGORIES.map((c) => c.label), datasets: [{ data: catData, backgroundColor: ["#ffcc00", "#ff2d92", "#5ac8fa", "#af52de", "#34c759", "#8e8e93"] }] },
    options: { responsive: true, maintainAspectRatio: false },
  });

  const payData = PAYMENTS.map((p) =>
    state.transactions.filter((t) => t.payment === p.id).reduce((s, x) => s + Number(x.amountJpy || 0), 0)
  );
  destroyChart("payment");
  charts.payment = new Chart(el("chart-payment"), {
    type: "pie",
    data: { labels: PAYMENTS.map((p) => p.label), datasets: [{ data: payData, backgroundColor: ["#34c759", "#007aff", "#ff9500", "#5856d6"] }] },
    options: { responsive: true, maintainAspectRatio: false },
  });

  if (el("top10-list")) {
    const top = [...state.transactions].sort((a, b) => Number(b.amountJpy || 0) - Number(a.amountJpy || 0)).slice(0, 10);
    el("top10-list").innerHTML = top
      .map((t, i) => `<li><strong>${i + 1}.</strong> ${esc(t.description || t.location)} — ${formatJpy(t.amountJpy)}</li>`)
      .join("");
  }
}

function loadSettingsForm() {
  if (el("set-trip-name")) el("set-trip-name").value = state.trip.name || "";
  if (el("set-start")) el("set-start").value = state.trip.start || "";
  if (el("set-end")) el("set-end").value = state.trip.end || "";
  if (el("set-budget")) el("set-budget").value = state.trip.budgetJpy || 0;
  if (el("set-rate")) el("set-rate").value = state.rateTwdPerJpy || 0.206;
  if (el("set-sheet-url")) el("set-sheet-url").value = state.settings.sheetUrl || "";
  if (el("set-vision-url")) el("set-vision-url").value = state.settings.visionUrl || "";
  if (el("set-openai-key")) el("set-openai-key").value = state.settings.openaiKey || "";
  if (el("set-itinerary-json")) el("set-itinerary-json").value = JSON.stringify(state.itinerary, null, 2);
}

if (el("settings-form")) {
  el("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    state.trip.name = el("set-trip-name").value.trim() || state.trip.name;
    state.trip.start = el("set-start").value || state.trip.start;
    state.trip.end = el("set-end").value || state.trip.end;
    state.trip.budgetJpy = Number(el("set-budget").value || 0);
    state.rateTwdPerJpy = Number(el("set-rate").value || 0.206);
    state.settings.sheetUrl = el("set-sheet-url").value.trim();
    state.settings.visionUrl = el("set-vision-url").value.trim();
    state.settings.openaiKey = el("set-openai-key").value.trim();
    saveState();
    renderHome();
    alert("設定已儲存");
  });
}

if (el("btn-save-itinerary")) {
  el("btn-save-itinerary").addEventListener("click", () => {
    try {
      const obj = JSON.parse(el("set-itinerary-json").value);
      state.itinerary = obj;
      saveState();
      alert("行程對照已更新");
    } catch (e) {
      alert("JSON 格式錯誤：" + (e.message || e));
    }
  });
}

if (el("btn-push-sheet")) {
  el("btn-push-sheet").addEventListener("click", async () => {
    const url = el("set-sheet-url").value.trim() || state.settings.sheetUrl;
    try {
      const rows = serializeRows();
      await pushToSheet(url, rows);
      const v = await verifyWrite(url, rows);
      if (!v.ok) throw new Error(v.error || "驗證失敗");
      setSyncStatus(`手動推送成功（已驗證 ${v.count} 筆）`, true);
      alert(`已推送（已驗證 ${v.count} 筆）`);
    } catch (e) {
      setSyncStatus(`手動推送失敗：${e.message || e}`, false);
      alert("推送失敗：" + (e.message || e));
    }
  });
}

if (el("btn-pull-sheet")) {
  el("btn-pull-sheet").addEventListener("click", async () => {
    const url = el("set-sheet-url").value.trim() || state.settings.sheetUrl;
    try {
      const rows = await pullFromSheet(url);
      state.transactions = parseRows(rows);
      saveState();
      renderHome();
      renderRecords();
      renderCharts();
      setSyncStatus(`手動拉取成功（${rows.length} 筆）`, true);
      alert(`已拉取 ${rows.length} 筆`);
    } catch (e) {
      setSyncStatus(`手動拉取失敗：${e.message || e}`, false);
      alert("拉取失敗：" + (e.message || e));
    }
  });
}

document.querySelectorAll(".tabs__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs__btn").forEach((b) => {
      b.classList.toggle("tabs__btn--active", b === btn);
      b.setAttribute("aria-selected", b === btn ? "true" : "false");
    });
    const tab = btn.dataset.tab;
    el("records-by-date")?.classList.toggle("records-groups--hidden", tab !== "date");
    el("records-by-category")?.classList.toggle("records-groups--hidden", tab !== "category");
  });
});

window.addEventListener("resize", () => {
  Object.values(charts).forEach((c) => c?.resize?.());
});

fillSelects();
loadSettingsForm();
renderHome();
