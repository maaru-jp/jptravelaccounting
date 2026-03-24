/**
 * 收據辨識：優先 OpenAI（若本機有 Key 且環境允許），
 * 其次自訂 vision 網址（Apps Script），否則智慧模擬。
 */
const SYSTEM_PROMPT = `你是日本收據 OCR 助手。請從收據圖片擷取並輸出純 JSON（不要 markdown）：
{
  "storeName": "店名原文",
  "storeNameZh": "店名繁體中文",
  "totalJpy": 數字（含稅總額，整數）,
  "taxType": "內稅|外稅|不確定",
  "items": [ { "nameJa": "日文品名", "nameZh": "繁中翻譯", "priceJpy": 數字, "tax": "課稅|免稅|內含" } ],
  "summaryZh": "整筆消費一句繁中摘要"
}
若看不清，合理推測並在 summaryZh 註明「推測」。`;
const OPENAI_TIMEOUT_MS = 12000;
const VISION_TIMEOUT_MS = 12000;

export async function recognizeReceipt(imageDataUrl, settings) {
  const mimeMatch = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const base64 = mimeMatch ? mimeMatch[2] : imageDataUrl.replace(/^.*,/, "");
  const reasons = [];

  if (settings.openaiKey) {
    try {
      const data = await callOpenAIVision(base64, mimeType, settings.openaiKey);
      if (data) return normalizePayload(data);
    } catch (e) {
      reasons.push(`OpenAI: ${safeErr(e)}`);
      console.warn("OpenAI 辨識失敗，改用備援：", e);
    }
  } else {
    reasons.push("OpenAI: 未設定 API Key");
  }

  if (settings.visionUrl) {
    try {
      const res = await fetchWithTimeout(settings.visionUrl, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "vision", image: base64, mimeType }),
      }, VISION_TIMEOUT_MS);
      const json = await res.json();
      if (json && json.ok && json.data) return normalizePayload(json.data);
      if (json && json.storeNameZh) return normalizePayload(json);
      reasons.push(`Vision: ${json?.error || "回傳格式不符"}`);
    } catch (e) {
      reasons.push(`Vision: ${safeErr(e)}`);
      console.warn("Vision 端點失敗：", e);
    }
  } else {
    reasons.push("Vision: 未設定端點");
  }

  try {
    const local = await recognizeReceiptByLocalOcr(imageDataUrl);
    if (local) return local;
    reasons.push("本地 OCR: 無法擷取文字");
  } catch (e) {
    reasons.push(`本地 OCR: ${safeErr(e)}`);
    console.warn("本地 OCR 失敗：", e);
  }

  await delay(1800 + Math.random() * 1200);
  return mockFromImageHash(base64, reasons);
}

async function callOpenAIVision(base64, mimeType, apiKey) {
  const body = {
    model: "gpt-4o-mini",
    max_tokens: 1200,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "請分析這張日本收據並回傳 JSON。" },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
  };
  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    mode: "cors",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, OPENAI_TIMEOUT_MS);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("無回傳內容");
  return JSON.parse(text);
}

function normalizePayload(raw) {
  const items = (raw.items || []).map((it) => ({
    nameJa: it.nameJa || it.name_ja || "",
    nameZh: it.nameZh || it.name_zh || it.nameJa || "",
    price: Number(it.priceJpy ?? it.price ?? 0),
    tax: it.tax || raw.taxType || "",
  }));
  return {
    storeName: raw.storeName || raw.store || "",
    storeNameZh: raw.storeNameZh || raw.storeName || "",
    totalJpy: Math.round(Number(raw.totalJpy ?? raw.total ?? items.reduce((s, x) => s + x.price, 0))),
    taxType: raw.taxType || "不確定",
    items,
    summaryZh: raw.summaryZh || raw.description || "收據消費",
    isFallback: false,
  };
}

function mockFromImageHash(b64, reasons = []) {
  const rough = tryExtractTotalFromDataUrlBase64(b64);
  const reasonText = reasons.filter(Boolean).slice(0, 2).join("；");
  return {
    storeName: "",
    storeNameZh: "",
    totalJpy: rough || 0,
    taxType: "不確定",
    items: [],
    summaryZh: reasonText
      ? `未成功辨識發票內容（${reasonText}），請手動修正欄位。`
      : "未成功辨識發票內容，請手動修正欄位；建議檢查 Vision API / Apps Script 設定。",
    isFallback: true,
  };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 無 OCR 時只嘗試非常保守的金額推測；失敗就回 0，不亂猜店名/品項
function tryExtractTotalFromDataUrlBase64(base64) {
  try {
    const text = atob(base64.slice(0, 24000));
    const m = text.match(/(?:TOTAL|合計|計|¥|JPY)\s*[:：]?\s*([0-9]{2,7})/i);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function safeErr(e) {
  const s = String(e?.message || e || "unknown");
  return s.slice(0, 120);
}

async function recognizeReceiptByLocalOcr(imageDataUrl) {
  const T = globalThis.Tesseract;
  if (!T || typeof T.recognize !== "function") return null;
  const out = await T.recognize(imageDataUrl, "jpn+eng", {
    logger: () => {},
  });
  const text = String(out?.data?.text || "").replace(/\r/g, "");
  if (!text.trim()) return null;

  const lines = text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const store = pickStoreLine(lines);
  const total = pickTotal(lines);
  const items = pickItems(lines, total);
  return {
    storeName: store,
    storeNameZh: store,
    totalJpy: total,
    taxType: "不確定",
    items,
    summaryZh: store ? `${store} 收據 OCR 擷取（請確認）` : "收據 OCR 擷取（請確認）",
    isFallback: false,
  };
}

function pickStoreLine(lines) {
  const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/;
  const stop = /(領収|レジ|電話|TEL|店No|レシート|合計|小計|税込|税|担当)/i;
  for (const ln of lines.slice(0, 8)) {
    if (!japanese.test(ln)) continue;
    if (stop.test(ln)) continue;
    if (ln.length < 2 || ln.length > 24) continue;
    return ln;
  }
  return "";
}

function pickTotal(lines) {
  const amountRe = /([0-9]{2,7})(?:円|¥)?/;
  const scoreWords = /(合計|お買上計|税込|計|TOTAL|合 計)/i;
  let best = 0;
  for (const ln of lines) {
    const m = ln.replace(/[,，\s]/g, "").match(amountRe);
    if (!m) continue;
    const val = Number(m[1]);
    if (!Number.isFinite(val) || val <= 0) continue;
    const score = (scoreWords.test(ln) ? 1000000 : 0) + val;
    if (score > best) best = score;
  }
  if (!best) return 0;
  return best > 1000000 ? best - 1000000 : best;
}

function pickItems(lines, total) {
  const list = [];
  for (const ln of lines) {
    const s = ln.replace(/[,，]/g, "");
    if (/(合計|小計|税込|税|内税|外税|お預り|釣|レジ|領収|TEL|電話)/i.test(s)) continue;
    const m = s.match(/^(.{1,28}?)([0-9]{2,6})(?:円|¥)?$/);
    if (!m) continue;
    const name = m[1].trim();
    const price = Number(m[2]);
    if (!name || !price) continue;
    if (total && price > total) continue;
    list.push({ nameJa: name, nameZh: name, price, tax: "" });
    if (list.length >= 8) break;
  }
  if (!list.length && total > 0) {
    list.push({ nameJa: "商品", nameZh: "商品", price: total, tax: "" });
  }
  return list;
}
