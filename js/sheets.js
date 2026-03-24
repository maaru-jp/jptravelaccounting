/** 與 Google Apps Script Web App 同步（JSON） */

export async function pushToSheet(webAppUrl, transactions) {
  if (!webAppUrl) throw new Error("請先在設定填入 Apps Script 網址");
  const payload = { action: "push", transactions };
  // text/plain 請求通常可避免 JSON preflight，對 Apps Script 更穩定
  try {
    return await postAndParse(webAppUrl, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    try {
      // 備援為 JSON 送法
      return await postAndParse(
        webAppUrl,
        {
          method: "POST",
          mode: "cors",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        err
      );
    } catch (err2) {
      // 最後備援：用 form POST 直送，避免 fetch CORS 限制（手機 Safari 常用）
      await postViaHiddenForm(webAppUrl, payload);
      const verify = await verifyAfterFormPush(webAppUrl, transactions);
      if (!verify.ok) throw new Error(verify.error || "表單推送後驗證失敗");
      return { ok: true, via: "form-post-fallback", verified: true };
    }
  }
}

export async function pullFromSheet(webAppUrl) {
  if (!webAppUrl) throw new Error("請先在設定填入 Apps Script 網址");
  const url = webAppUrl.includes("?") ? `${webAppUrl}&action=pull` : `${webAppUrl}?action=pull`;
  try {
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
  } catch (fetchErr) {
    // fetch 被擋時，改走 JSONP 備援（需 Apps Script doGet 支援 callback）
    const json = await pullViaJsonp(url);
    if (!json.ok) throw new Error(json.error || fetchErr.message || "拉取失敗");
    return json.transactions || [];
  }
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

function postViaHiddenForm(url, payload) {
  return new Promise((resolve, reject) => {
    try {
      const frameName = `sheetPushFrame_${Date.now()}`;
      const iframe = document.createElement("iframe");
      iframe.name = frameName;
      iframe.style.display = "none";
      document.body.appendChild(iframe);

      const form = document.createElement("form");
      form.method = "POST";
      form.action = url;
      form.target = frameName;
      form.style.display = "none";

      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "payload";
      input.value = JSON.stringify(payload);
      form.appendChild(input);
      document.body.appendChild(form);

      let done = false;
      const cleanup = () => {
        form.remove();
        iframe.remove();
      };
      const finish = (ok) => {
        if (done) return;
        done = true;
        cleanup();
        if (ok) resolve({ ok: true });
        else reject(new Error("表單推送失敗"));
      };

      iframe.addEventListener("load", () => finish(true), { once: true });
      form.submit();
      setTimeout(() => finish(false), 8000);
    } catch (e) {
      reject(e);
    }
  });
}

async function verifyAfterFormPush(webAppUrl, expectedRows) {
  const sampleIds = (expectedRows || []).slice(-3).map((x) => String(x?.id || "")).filter(Boolean);
  for (let i = 0; i < 3; i++) {
    await sleep(900 + i * 700);
    try {
      const rows = await pullFromSheet(webAppUrl);
      if (!sampleIds.length) return { ok: true };
      const idSet = new Set(rows.map((x) => String(x?.id || "")));
      const allHit = sampleIds.every((id) => idSet.has(id));
      if (allHit) return { ok: true };
    } catch (_) {
      // keep retrying
    }
  }
  return { ok: false, error: "推送後未在試算表讀到最新資料" };
}

function pullViaJsonp(url) {
  return new Promise((resolve, reject) => {
    const cbName = `jpLedgerJsonp_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
    const sep = url.includes("?") ? "&" : "?";
    const src = `${url}${sep}callback=${encodeURIComponent(cbName)}`;
    const script = document.createElement("script");
    script.src = src;
    script.async = true;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("JSONP 拉取逾時"));
    }, 10000);

    function cleanup() {
      clearTimeout(timer);
      script.remove();
      try {
        delete window[cbName];
      } catch {
        window[cbName] = undefined;
      }
    }

    window[cbName] = (payload) => {
      cleanup();
      resolve(payload || { ok: false, error: "JSONP 無回應資料" });
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("JSONP 載入失敗"));
    };
    document.body.appendChild(script);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
