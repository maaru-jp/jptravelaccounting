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

  if (settings.openaiKey) {
    try {
      const data = await callOpenAIVision(base64, mimeType, settings.openaiKey);
      if (data) return normalizePayload(data);
    } catch (e) {
      console.warn("OpenAI 辨識失敗，改用備援：", e);
    }
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
    } catch (e) {
      console.warn("Vision 端點失敗：", e);
    }
  }

  await delay(1800 + Math.random() * 1200);
  return mockFromImageHash(base64);
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

function mockFromImageHash(b64) {
  const rough = tryExtractTotalFromDataUrlBase64(b64);
  return {
    storeName: "",
    storeNameZh: "",
    totalJpy: rough || 0,
    taxType: "不確定",
    items: [],
    summaryZh: "未成功辨識發票內容，請手動修正欄位；建議檢查 Vision API / Apps Script 設定。",
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
