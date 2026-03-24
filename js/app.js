import { CATEGORIES, PAYMENTS, categoryById, paymentById } from "./config.js";
import { buildDefaultItinerary, regionForDate } from "./itinerary.js";
import { DEFAULT_TRAVELERS } from "./seed.js";
import { recognizeReceipt } from "./receipt-ai.js";
import { pushToSheet, pullFromSheet } from "./sheets.js";

const STORAGE_KEY = "jp-trip-ledger-v1";
const DEMO_PURGED_KEY = "jp-trip-ledger-demo-purged-v1";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function createDefaultState() {
  const start = "2026-02-24";
  const end = "2026-03-25";
  return {
    trip: {
      name: "2026初次東京小旅遊",
      start,
      end,
      budgetJpy: 550000,
    },
    rateTwdPerJpy: 0.206,
    travelers: DEFAULT_TRAVELERS,
    itinerary: buildDefaultItinerary(start, 30),
    transactions: [],
    settings: {
      sheetUrl: "",
      visionUrl: "",
      openaiKey: "",
    },
  };
}

let state = loadState() || createDefaultState();
if (!state.settings) state.settings = { sheetUrl: "", visionUrl: "", openaiKey: "" };
if (!state.itinerary || Object.keys(state.itinerary).length === 0) {
  state.itinerary = buildDefaultItinerary(state.trip.start, 30);
}
purgeLegacyDemoDataOnce();

function purgeLegacyDemoDataOnce() {
  const alreadyPurged = localStorage.getItem(DEMO_PURGED_KEY) === "1";
  if (alreadyPurged) return;
  if (!Array.isArray(state.transactions) || state.transactions.length === 0) {
    localStorage.setItem(DEMO_PURGED_KEY, "1");
    return;
  }
  const filtered = state.transactions.filter((t) => !String(t?.id || "").startsWith("seed-"));
  if (filtered.length !== state.transactions.length) {
    state.transactions = filtered;
    saveState(state);
  }
  localStorage.setItem(DEMO_PURGED_KEY, "1");
}

function jpyToTwd(jpy) {
  return Math.round(jpy * state.rateTwdPerJpy);
}

function formatJpy(n) {
  return `¥${Number(n).toLocaleString("ja-JP")}`;
}

function formatTwd(n) {
  return `NT$${Number(n).toLocaleString("zh-TW")}`;
}

function tripDayIndex() {
  const start = new Date(state.trip.start + "T12:00:00");
  const now = new Date();
  const end = new Date(state.trip.end + "T12:00:00");
  if (now < start) return { current: 0, total: Math.ceil((end - start) / 86400000) + 1 };
  const idx = Math.floor((now - start) / 86400000) + 1;
  const total = Math.ceil((end - start) / 86400000) + 1;
  return { current: Math.min(idx, total), total };
}

function applyRegions() {
  state.transactions.forEach((t) => {
    t.region = regionForDate(state.itinerary, t.date) || t.region || "";
  });
}

function uid() {
  return `tx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/* ---------- DOM ---------- */
const views = {
  home: document.getElementById("view-home"),
  records: document.getElementById("view-records"),
  scan: document.getElementById("view-scan"),
  stats: document.getElementById("view-stats"),
  settings: document.getElementById("view-settings"),
};

function showView(name) {
  Object.entries(views).forEach(([k, el]) => {
    el.classList.toggle("view--active", k === name);
  });
  document.querySelectorAll(".bottom-nav__item").forEach((btn) => {
    btn.classList.toggle("bottom-nav__item--active", btn.dataset.view === name);
  });
  if (name === "stats") requestAnimationFrame(() => renderCharts());
  if (name === "records") renderRecords();
  if (name === "home") renderHome();
  if (name === "settings") loadSettingsForm();
}

document.querySelectorAll(".bottom-nav__item").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

document.getElementById("scan-back").addEventListener("click", () => showView("home"));

/* ---------- Select options ---------- */
function fillCategorySelect(sel) {
  sel.innerHTML = CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
}

function fillPaymentSelect(sel) {
  sel.innerHTML = PAYMENTS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
}

function fillTravelerSelect(sel) {
  sel.innerHTML = state.travelers
    .map((t) => `<option value="${t.id}">${t.emoji} ${t.name}</option>`)
    .join("");
}

[
  ["f-category", fillCategorySelect],
  ["edit-category", fillCategorySelect],
].forEach(([id, fn]) => {
  const el = document.getElementById(id);
  if (el) fn(el);
});
[
  ["f-payment", fillPaymentSelect],
  ["edit-payment", fillPaymentSelect],
].forEach(([id, fn]) => {
  const el = document.getElementById(id);
  if (el) fn(el);
});
["f-traveler", "edit-traveler"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) fillTravelerSelect(el);
});

/* ---------- Render tx card ---------- */
function travelerEmoji(id) {
  const t = state.travelers.find((x) => x.id === id);
  return t ? t.emoji : "👤";
}

function renderTxCard(t, { onEdit } = {}) {
  const cat = categoryById(t.category);
  const pay = paymentById(t.payment);
  const el = document.createElement("article");
  el.className = "tx-card";
  el.innerHTML = `
    <div class="tx-card__avatar">${travelerEmoji(t.travelerId)}</div>
    <div class="tx-card__mid">
      <p class="tx-card__title">${escapeHtml(t.description || t.location || "未命名")}</p>
      <div class="tx-card__tags">
        <span class="tag-cat ${cat.className}">${cat.label}</span>
        <span class="tag-pay">${pay.label}</span>
        <span class="tag-loc">📍 ${escapeHtml(t.location || "—")}</span>
        ${t.region ? `<span class="tag-loc">${escapeHtml(t.region)}</span>` : ""}
      </div>
    </div>
    <div class="tx-card__amt">
      <p class="tx-card__jpy">${formatJpy(t.amountJpy)}</p>
      <p class="tx-card__twd">${formatTwd(jpyToTwd(t.amountJpy))}</p>
    </div>
    <button type="button" class="tx-card__edit" aria-label="編輯">✏️</button>
  `;
  el.querySelector(".tx-card__edit").addEventListener("click", () => onEdit?.(t));
  return el;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------- Home ---------- */
function renderHome() {
  applyRegions();
  document.getElementById("trip-title").textContent = state.trip.name;
  document.getElementById("trip-dates").textContent = `${state.trip.start} — ${state.trip.end}`;

  const tday = todayStr();
  const todaySum = state.transactions.filter((x) => x.date === tday).reduce((s, x) => s + x.amountJpy, 0);
  const totalSum = state.transactions.reduce((s, x) => s + x.amountJpy, 0);

  document.getElementById("dash-today-jpy").textContent = formatJpy(todaySum);
  document.getElementById("dash-today-twd").textContent = `≈ ${formatTwd(jpyToTwd(todaySum))}`;
  document.getElementById("dash-total-jpy").textContent = formatJpy(totalSum);
  document.getElementById("dash-total-twd").textContent = `≈ ${formatTwd(jpyToTwd(totalSum))}`;

  const cashLike = state.transactions
    .filter((x) => x.payment === "cash" || x.payment === "suica")
    .reduce((s, x) => s + x.amountJpy, 0);
  const pct = state.trip.budgetJpy > 0 ? Math.min(100, Math.round((cashLike / state.trip.budgetJpy) * 100)) : 0;
  document.getElementById("dash-budget-pct").textContent = `${pct}%`;
  document.getElementById("dash-budget-bar").style.width = `${pct}%`;

  const { current, total } = tripDayIndex();
  document.getElementById("dash-day-label").textContent = `Day ${current}`;
  document.getElementById("dash-day-total").textContent = `共 ${total} 天`;

  const list = document.getElementById("home-today-list");
  const empty = document.getElementById("home-empty");
  list.innerHTML = "";
  const todayTx = state.transactions.filter((x) => x.date === tday).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  todayTx.forEach((t) => list.appendChild(renderTxCard(t, { onEdit: openEditModal })));
  empty.classList.toggle("empty-hint--show", todayTx.length === 0);
}

/* ---------- Records ---------- */
let recordsTab = "date";

document.querySelectorAll(".tabs__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    recordsTab = btn.dataset.tab;
    document.querySelectorAll(".tabs__btn").forEach((b) => {
      b.classList.toggle("tabs__btn--active", b === btn);
      b.setAttribute("aria-selected", b === btn ? "true" : "false");
    });
    document.getElementById("records-by-date").classList.toggle("records-groups--hidden", recordsTab !== "date");
    document.getElementById("records-by-category").classList.toggle("records-groups--hidden", recordsTab !== "category");
    renderRecords();
  });
});

function renderRecords() {
  applyRegions();
  const total = state.transactions.reduce((s, x) => s + x.amountJpy, 0);
  document.getElementById("records-total-jpy").textContent = formatJpy(total);
  document.getElementById("records-total-twd").textContent = `≈ ${formatTwd(jpyToTwd(total))}`;
  document.getElementById("records-count").textContent = `${state.transactions.length} 筆`;

  const byDate = document.getElementById("records-by-date");
  const byCat = document.getElementById("records-by-category");
  byDate.innerHTML = "";
  byCat.innerHTML = "";

  const dates = [...new Set(state.transactions.map((x) => x.date))].sort((a, b) => b.localeCompare(a));
  dates.forEach((date) => {
    const txs = state.transactions.filter((x) => x.date === date);
    const daySum = txs.reduce((s, x) => s + x.amountJpy, 0);
    const d = new Date(date + "T12:00:00");
    const w = WEEK[d.getDay()];
    const section = document.createElement("section");
    section.className = "record-day";
    section.innerHTML = `
      <div class="record-day__head">
        <span class="record-day__date">${date}（${w}）</span>
        <span class="record-day__total">總計 ${formatJpy(daySum)} ≈ ${formatTwd(jpyToTwd(daySum))}</span>
      </div>
      <div class="record-day__list"></div>
    `;
    const inner = section.querySelector(".record-day__list");
    txs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).forEach((t) => inner.appendChild(renderTxCard(t, { onEdit: openEditModal })));
    byDate.appendChild(section);
  });

  CATEGORIES.forEach((cat) => {
    const txs = state.transactions.filter((x) => x.category === cat.id);
    if (!txs.length) return;
    const section = document.createElement("section");
    section.className = "record-cat";
    section.innerHTML = `<h3 class="record-cat__title">${cat.label} · ${formatJpy(txs.reduce((s, x) => s + x.amountJpy, 0))}</h3><div class="record-day__list"></div>`;
    const inner = section.querySelector(".record-day__list");
    txs.sort((a, b) => b.date.localeCompare(a.date)).forEach((t) => inner.appendChild(renderTxCard(t, { onEdit: openEditModal })));
    byCat.appendChild(section);
  });
}

/* ---------- Scan ---------- */
const scanFile = document.getElementById("scan-file");
const scanPreview = document.getElementById("scan-preview");
const scanPlaceholder = document.getElementById("scan-placeholder");
const scanStatus = document.getElementById("scan-status");
const scanForm = document.getElementById("scan-result-form");
const scanFallbackHint = document.getElementById("scan-fallback-hint");
const fAmount = document.getElementById("f-amount");
const itemsSumHint = document.getElementById("items-sum-hint");
let lastDataUrl = "";
let scanItems = [];

scanFile.addEventListener("change", async () => {
  const f = scanFile.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = async () => {
    lastDataUrl = await shrinkImageDataUrl(reader.result, 1600, 0.82);
    scanPreview.src = lastDataUrl;
    scanPreview.hidden = false;
    scanPlaceholder.hidden = true;
    scanForm.hidden = true;
    scanStatus.hidden = false;
    try {
      const result = await recognizeReceipt(lastDataUrl, {
        openaiKey: state.settings.openaiKey,
        visionUrl: state.settings.visionUrl || state.settings.sheetUrl,
      });
      fillScanForm(result);
    } catch (e) {
      alert("辨識過程發生錯誤：" + (e.message || String(e)));
      fillScanForm({
        storeNameZh: "",
        totalJpy: 0,
        taxType: "",
        items: [],
        summaryZh: "",
      });
    }
    scanStatus.hidden = true;
    scanForm.hidden = false;
  };
  reader.readAsDataURL(f);
});

async function shrinkImageDataUrl(dataUrl, maxSide = 1600, quality = 0.82) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return dataUrl;
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return dataUrl;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale >= 1) return dataUrl;
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, cw, ch);
  return canvas.toDataURL("image/jpeg", quality);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function fillScanForm(result) {
  if (scanFallbackHint) {
    scanFallbackHint.hidden = !result?.isFallback;
  }
  const cleanSummary = sanitizeSummary(result?.summaryZh || "", !!result?.isFallback);
  document.getElementById("f-location").value = result.storeNameZh || result.storeName || "";
  document.getElementById("f-desc").value = cleanSummary;
  document.getElementById("f-amount").value = result.totalJpy || 0;
  const catGuess = guessCategoryFromText((result.summaryZh || "") + (result.storeNameZh || ""));
  document.getElementById("f-category").value = catGuess;
  document.getElementById("f-payment").value = "cash";
  document.getElementById("f-traveler").value = state.travelers[0]?.id || "t1";
  document.getElementById("f-date").value = todayStr();
  updateRegionHint();
  scanItems = (result.items || []).map((it) => ({
    nameJa: String(it.nameJa || ""),
    nameZh: String(it.nameZh || it.nameJa || ""),
    price: Number(it.price) || 0,
    tax: String(it.tax || ""),
  }));
  renderEditableItems();
  scanForm.dataset.taxType = result.taxType || "";
  syncScanItemsDataset();
}

function sanitizeSummary(text, isFallback) {
  let s = String(text || "").trim();
  s = s.replace(/\s*·\s*若已設定 OpenAI 或 Apps Script 將改為真實辨識\s*$/u, "");
  if (isFallback && (!s || /^（示範）/u.test(s))) {
    return "示範辨識結果（可手動修正後儲存）";
  }
  return s;
}

function renderEditableItems() {
  const ul = document.getElementById("f-items");
  ul.innerHTML = "";
  if (!scanItems.length) {
    const li = document.createElement("li");
    li.className = "item-row__empty";
    li.textContent = "尚無品項，可直接儲存或重新掃描";
    ul.appendChild(li);
    updateItemsSumHint();
    return;
  }
  scanItems.forEach((it, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="item-row">
        <input type="text" data-k="nameZh" value="${escapeHtml(it.nameZh)}" placeholder="繁中品名" />
        <input type="text" data-k="nameJa" value="${escapeHtml(it.nameJa)}" placeholder="日文品名" />
        <input type="number" data-k="price" value="${Number(it.price) || 0}" min="0" step="1" />
        <input type="text" data-k="tax" value="${escapeHtml(it.tax)}" placeholder="稅別" />
        <button type="button" class="item-row__delete" data-delete="${idx}" title="刪除品項">🗑️</button>
      </div>
    `;
    ul.appendChild(li);
  });
  updateItemsSumHint();
}

function syncScanItemsDataset() {
  scanForm.dataset.itemsJson = JSON.stringify(scanItems);
}

function updateItemsSumHint() {
  const target = Number(fAmount.value) || 0;
  const sum = scanItems.reduce((s, it) => s + (Number(it.price) || 0), 0);
  const diff = target - sum;
  const mark = diff === 0 ? "一致" : diff > 0 ? `少 ¥${diff.toLocaleString("ja-JP")}` : `多 ¥${Math.abs(diff).toLocaleString("ja-JP")}`;
  itemsSumHint.textContent = `品項合計 ${formatJpy(sum)}，與總額差 ${formatJpy(diff)}（${mark}）`;
}

document.getElementById("f-items").addEventListener("input", (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) return;
  const row = input.closest("li");
  if (!row) return;
  const idx = [...row.parentElement.children].indexOf(row);
  if (idx < 0 || idx >= scanItems.length) return;
  const key = input.dataset.k;
  if (!key) return;
  if (key === "price") {
    scanItems[idx].price = Math.max(0, Number(input.value) || 0);
  } else {
    scanItems[idx][key] = input.value;
  }
  syncScanItemsDataset();
  updateItemsSumHint();
});

document.getElementById("f-items").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-delete]");
  if (!btn) return;
  const idx = Number(btn.getAttribute("data-delete"));
  if (Number.isNaN(idx)) return;
  scanItems.splice(idx, 1);
  syncScanItemsDataset();
  renderEditableItems();
});

document.getElementById("btn-rebalance-items").addEventListener("click", () => {
  if (!scanItems.length) return;
  const target = Math.max(0, Number(fAmount.value) || 0);
  const sumExceptLast = scanItems.slice(0, -1).reduce((s, it) => s + (Number(it.price) || 0), 0);
  scanItems[scanItems.length - 1].price = Math.max(0, target - sumExceptLast);
  syncScanItemsDataset();
  renderEditableItems();
});

document.getElementById("btn-add-item").addEventListener("click", () => {
  scanItems.push({
    nameZh: "新品項",
    nameJa: "",
    price: 0,
    tax: "",
  });
  syncScanItemsDataset();
  renderEditableItems();
});

fAmount.addEventListener("input", updateItemsSumHint);

function guessCategoryFromText(text) {
  const t = text.toLowerCase();
  if (/咖啡|餐|飯|麵|壽司|便利|lawson|7|全家|星巴克|酒/.test(t)) return "dining";
  if (/藥妝|無印|購物|紀念|伊東屋/.test(t)) return "shopping";
  if (/交通|新幹線|巴士|計程|電車|駅|suica/.test(t)) return "transport";
  if (/宿|飯店|温泉|旅館/.test(t)) return "hotel";
  if (/城|入場|樂園|景點|門票/.test(t)) return "sight";
  return "other";
}

["f-date"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", updateRegionHint);
});

function updateRegionHint() {
  const d = document.getElementById("f-date").value;
  const r = regionForDate(state.itinerary, d);
  document.getElementById("f-region-hint").textContent = r
    ? `依行程表，此日地區為：${r}（儲存時會寫入）`
    : "此日尚未設定行程地區，可於設定中編輯 JSON。";
}

document.getElementById("scan-reset").addEventListener("click", () => {
  scanFile.value = "";
  scanPreview.hidden = true;
  scanPlaceholder.hidden = false;
  scanForm.hidden = true;
  if (scanFallbackHint) scanFallbackHint.hidden = true;
  lastDataUrl = "";
  scanItems = [];
  syncScanItemsDataset();
  renderEditableItems();
});

document.getElementById("scan-result-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const date = document.getElementById("f-date").value;
  const items = JSON.parse(scanForm.dataset.itemsJson || "[]");
  const tx = {
    id: uid(),
    date,
    amountJpy: Number(document.getElementById("f-amount").value) || 0,
    category: document.getElementById("f-category").value,
    payment: document.getElementById("f-payment").value,
    location: document.getElementById("f-location").value,
    region: regionForDate(state.itinerary, date) || "",
    description: document.getElementById("f-desc").value || document.getElementById("f-location").value,
    travelerId: document.getElementById("f-traveler").value,
    items,
    taxType: scanForm.dataset.taxType || "",
    receiptImage: lastDataUrl ? lastDataUrl.slice(0, 120000) : "",
    createdAt: new Date().toISOString(),
  };
  state.transactions.push(tx);
  saveState(state);
  document.getElementById("scan-reset").click();
  showView("home");
  renderHome();
  const sync = await autoSyncPush({ source: "scan" });
  if (!sync.ok) {
    alert(`已加入本機記帳，但試算表自動同步失敗：${sync.error}\n請到「設定」頁按「推送到試算表」查看與重試。`);
  }
});

/* ---------- Modal ---------- */
const modal = document.getElementById("modal-edit");

function openEditModal(t) {
  document.getElementById("edit-id").value = t.id;
  document.getElementById("edit-desc").value = t.description || "";
  document.getElementById("edit-amount").value = t.amountJpy;
  document.getElementById("edit-category").value = t.category;
  document.getElementById("edit-payment").value = t.payment;
  document.getElementById("edit-location").value = t.location || "";
  document.getElementById("edit-date").value = t.date;
  document.getElementById("edit-traveler").value = t.travelerId;
  modal.showModal();
}

document.getElementById("form-edit").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("edit-id").value;
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return;
  t.description = document.getElementById("edit-desc").value;
  t.amountJpy = Number(document.getElementById("edit-amount").value) || 0;
  t.category = document.getElementById("edit-category").value;
  t.payment = document.getElementById("edit-payment").value;
  t.location = document.getElementById("edit-location").value;
  t.date = document.getElementById("edit-date").value;
  t.travelerId = document.getElementById("edit-traveler").value;
  t.region = regionForDate(state.itinerary, t.date) || t.region;
  saveState(state);
  modal.close();
  renderHome();
  renderRecords();
  if (views.stats.classList.contains("view--active")) renderCharts();
  autoSyncPush();
});

document.getElementById("edit-delete").addEventListener("click", () => {
  const id = document.getElementById("edit-id").value;
  state.transactions = state.transactions.filter((x) => x.id !== id);
  saveState(state);
  modal.close();
  renderHome();
  renderRecords();
  if (views.stats.classList.contains("view--active")) renderCharts();
  autoSyncPush();
});

/* ---------- Charts ---------- */
let charts = { daily: null, category: null, payment: null };

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    charts[key] = null;
  }
}

function renderCharts() {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js 尚未載入");
    return;
  }
  applyRegions();
  const byDate = {};
  state.transactions.forEach((t) => {
    byDate[t.date] = (byDate[t.date] || 0) + t.amountJpy;
  });
  const dates = Object.keys(byDate).sort();
  const dailyValues = dates.map((d) => byDate[d]);

  destroyChart("daily");
  charts.daily = new Chart(document.getElementById("chart-daily"), {
    type: "line",
    data: {
      labels: dates,
      datasets: [
        {
          label: "¥",
          data: dailyValues,
          borderColor: "#ff9500",
          backgroundColor: "rgba(255, 149, 0, 0.1)",
          fill: true,
          tension: 0.35,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { beginAtZero: true },
      },
    },
  });

  const catTotals = {};
  CATEGORIES.forEach((c) => {
    catTotals[c.id] = 0;
  });
  state.transactions.forEach((t) => {
    catTotals[t.category] = (catTotals[t.category] || 0) + t.amountJpy;
  });
  const catLabels = CATEGORIES.map((c) => c.label);
  const catData = CATEGORIES.map((c) => catTotals[c.id] || 0);
  const colors = ["#ffcc00", "#ff2d92", "#5ac8fa", "#af52de", "#34c759", "#8e8e93"];

  destroyChart("category");
  charts.category = new Chart(document.getElementById("chart-category"), {
    type: "doughnut",
    data: {
      labels: catLabels,
      datasets: [{ data: catData, backgroundColor: colors }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } } },
    },
  });

  const payTotals = {};
  PAYMENTS.forEach((p) => {
    payTotals[p.id] = 0;
  });
  state.transactions.forEach((t) => {
    payTotals[t.payment] = (payTotals[t.payment] || 0) + t.amountJpy;
  });
  const payLabels = PAYMENTS.map((p) => p.label);
  const payData = PAYMENTS.map((p) => payTotals[p.id] || 0);

  destroyChart("payment");
  charts.payment = new Chart(document.getElementById("chart-payment"), {
    type: "pie",
    data: {
      labels: payLabels,
      datasets: [
        {
          data: payData,
          backgroundColor: ["#34c759", "#007aff", "#ff9500", "#5856d6"],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } } },
    },
  });

  const top10 = [...state.transactions].sort((a, b) => b.amountJpy - a.amountJpy).slice(0, 10);
  const ol = document.getElementById("top10-list");
  ol.innerHTML = top10
    .map(
      (t, i) =>
        `<li><strong>${i + 1}.</strong> ${escapeHtml(t.description || t.location)} — ${formatJpy(t.amountJpy)}（${escapeHtml(
          categoryById(t.category).label
        )}）</li>`
    )
    .join("");
}

let chartResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    ["daily", "category", "payment"].forEach((k) => {
      const c = charts[k];
      if (c && typeof c.resize === "function") c.resize();
    });
  }, 120);
});

/* ---------- Settings ---------- */
function loadSettingsForm() {
  document.getElementById("set-trip-name").value = state.trip.name;
  document.getElementById("set-start").value = state.trip.start;
  document.getElementById("set-end").value = state.trip.end;
  document.getElementById("set-budget").value = state.trip.budgetJpy;
  document.getElementById("set-rate").value = state.rateTwdPerJpy;
  document.getElementById("set-sheet-url").value = state.settings.sheetUrl || "";
  document.getElementById("set-vision-url").value = state.settings.visionUrl || "";
  document.getElementById("set-openai-key").value = state.settings.openaiKey || "";
  document.getElementById("set-itinerary-json").value = JSON.stringify(state.itinerary, null, 2);
}

function setSheetSyncStatus(msg, ok = null) {
  const el = document.getElementById("sheet-sync-status");
  if (!el) return;
  const prefix = ok === true ? "同步狀態：✅ " : ok === false ? "同步狀態：⚠️ " : "同步狀態：";
  el.textContent = `${prefix}${msg}`;
}

document.getElementById("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.trip.name = document.getElementById("set-trip-name").value.trim() || state.trip.name;
  state.trip.start = document.getElementById("set-start").value;
  state.trip.end = document.getElementById("set-end").value;
  state.trip.budgetJpy = Number(document.getElementById("set-budget").value) || 0;
  state.rateTwdPerJpy = Number(document.getElementById("set-rate").value) || 0.2;
  state.settings.sheetUrl = document.getElementById("set-sheet-url").value.trim();
  state.settings.visionUrl = document.getElementById("set-vision-url").value.trim();
  state.settings.openaiKey = document.getElementById("set-openai-key").value.trim();
  saveState(state);
  renderHome();
  alert("設定已儲存");
});

document.getElementById("btn-save-itinerary").addEventListener("click", () => {
  try {
    const parsed = JSON.parse(document.getElementById("set-itinerary-json").value);
    if (typeof parsed !== "object" || parsed === null) throw new Error("需為物件");
    state.itinerary = parsed;
    applyRegions();
    saveState(state);
    alert("行程對照已更新");
  } catch (err) {
    alert("JSON 格式錯誤：" + err.message);
  }
});

document.getElementById("btn-push-sheet").addEventListener("click", async () => {
  const url = document.getElementById("set-sheet-url").value.trim() || state.settings.sheetUrl;
  try {
    const payload = serializeForSheet(state.transactions);
    const pushRes = await pushToSheet(url, payload);
    const verify = await verifySheetWrite(url, payload);
    if (verify.ok) {
      setSheetSyncStatus(`手動推送成功（已驗證 ${verify.count} 筆）`, true);
      alert(`已推送到試算表（已驗證 ${verify.count} 筆）`);
    } else if (pushRes?.unverified) {
      setSheetSyncStatus(`已送出但無法驗證：${verify.error}`, false);
      alert(`已送出推送請求，但尚未驗證寫入成功：${verify.error}`);
    } else {
      setSheetSyncStatus(`推送後驗證失敗：${verify.error}`, false);
      alert(`推送請求成功，但驗證未通過：${verify.error}`);
    }
  } catch (e) {
    setSheetSyncStatus(`手動推送失敗：${e.message}`, false);
    alert("推送失敗：" + e.message);
  }
});

document.getElementById("btn-pull-sheet").addEventListener("click", async () => {
  const url = document.getElementById("set-sheet-url").value.trim() || state.settings.sheetUrl;
  try {
    const rows = await pullFromSheet(url);
    const merged = deserializeFromSheet(rows);
    if (merged.length) {
      state.transactions = merged;
      saveState(state);
      renderHome();
      renderRecords();
      if (views.stats.classList.contains("view--active")) renderCharts();
      setSheetSyncStatus(`手動拉取成功（${merged.length} 筆）`, true);
      alert(`已從試算表合併 ${merged.length} 筆`);
    } else {
      setSheetSyncStatus("手動拉取成功（0 筆）", true);
      alert("試算表無資料列");
    }
  } catch (e) {
    setSheetSyncStatus(`手動拉取失敗：${e.message}`, false);
    alert("拉取失敗：" + e.message);
  }
});

function serializeForSheet(txs) {
  return txs.map((t) => ({
    id: t.id,
    date: t.date,
    amountJpy: t.amountJpy,
    category: t.category,
    payment: t.payment,
    location: t.location,
    region: t.region || regionForDate(state.itinerary, t.date) || "",
    description: t.description,
    travelerId: t.travelerId,
    taxType: t.taxType || "",
    itemsJson: JSON.stringify(t.items || []),
    createdAt: t.createdAt || "",
  }));
}

function deserializeFromSheet(rows) {
  return rows.map((r) => ({
    id: r.id || uid(),
    date: r.date,
    amountJpy: Number(r.amountJpy) || 0,
    category: r.category || "other",
    payment: r.payment || "cash",
    location: r.location || "",
    region: r.region || "",
    description: r.description || "",
    travelerId: r.travelerId || "t1",
    taxType: r.taxType || "",
    items: safeParseItems(r.itemsJson),
    createdAt: r.createdAt || new Date().toISOString(),
  }));
}

function safeParseItems(s) {
  try {
    const j = typeof s === "string" ? JSON.parse(s) : s;
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

async function autoSyncPush({ source = "auto" } = {}) {
  const url = state.settings.sheetUrl;
  if (!url) {
    setSheetSyncStatus("尚未設定 Apps Script 網址", false);
    return { ok: false, error: "尚未設定 Apps Script 網址" };
  }
  try {
    const payload = serializeForSheet(state.transactions);
    const pushRes = await pushToSheet(url, payload);
    const verify = await verifySheetWrite(url, payload);
    const from = source === "scan" ? "掃描後" : "自動";
    if (verify.ok) {
      setSheetSyncStatus(`${from}同步成功（已驗證 ${verify.count} 筆）`, true);
      return { ok: true };
    }
    const reason = verify.error || "驗證失敗";
    if (pushRes?.unverified) {
      setSheetSyncStatus(`${from}已送出但無法驗證：${reason}`, false);
      return { ok: false, error: reason };
    }
    setSheetSyncStatus(`${from}同步失敗：${reason}`, false);
    return { ok: false, error: reason };
  } catch (e) {
    const msg = e?.message || String(e);
    setSheetSyncStatus(`自動同步失敗：${msg}`, false);
    return { ok: false, error: msg };
  }
}

async function verifySheetWrite(url, expectedRows) {
  const expected = Array.isArray(expectedRows) ? expectedRows : [];
  try {
    const pulled = await pullFromSheet(url);
    if (expected.length === 0) {
      return { ok: pulled.length === 0, count: pulled.length, error: pulled.length ? "試算表仍有舊資料" : "" };
    }
    if (!pulled.length) return { ok: false, count: 0, error: "試算表回傳 0 筆" };
    const pulledIds = new Set(pulled.map((x) => String(x.id || "")));
    const sample = expected.slice(-Math.min(3, expected.length)).map((x) => String(x.id || ""));
    const missed = sample.filter((id) => id && !pulledIds.has(id));
    if (missed.length) {
      return { ok: false, count: pulled.length, error: "最新資料未出現在試算表" };
    }
    return { ok: true, count: pulled.length };
  } catch (e) {
    return { ok: false, count: 0, error: e?.message || String(e) };
  }
}

/* ---------- Init ---------- */
applyRegions();
loadSettingsForm();
renderHome();
