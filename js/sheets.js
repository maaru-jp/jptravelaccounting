/** 與 Google Apps Script Web App 同步（JSON） */

export async function pushToSheet(webAppUrl, transactions) {
  if (!webAppUrl) throw new Error("請先在設定填入 Apps Script 網址");
  // text/plain 請求通常可避免 JSON preflight，對 Apps Script 更穩定
  try {
    return await postAndParse(webAppUrl, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "push", transactions }),
    });
  } catch (err) {
    // 備援為 JSON 送法
    return await postAndParse(webAppUrl, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "push", transactions }),
    }, err);
  }
}

export async function pullFromSheet(webAppUrl) {
  if (!webAppUrl) throw new Error("請先在設定填入 Apps Script 網址");
  const url = webAppUrl.includes("?") ? `${webAppUrl}&action=pull` : `${webAppUrl}?action=pull`;
  const res = await fetch(url, { method: "GET", mode: "cors" });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 200) || "拉取失敗");
  }
  if (!json.ok) throw new Error(json.error || "拉取失敗");
  return json.transactions || [];
}

async function postAndParse(url, options, prevErr) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const head = prevErr ? `${prevErr.message || prevErr}；` : "";
    throw new Error(`${head}${text.slice(0, 220) || "推送失敗"}`);
  }
  if (!json.ok) throw new Error(json.error || "推送失敗");
  return json;
}
