/**
 * 日本旅遊記帳 · Google 試算表後端
 *
 * 部署步驟（摘要）：
 * 1. 新建 Google 試算表，複製網址中的試算表 ID。
 * 2. 擴充功能 → Apps Script，貼上此檔案。
 * 3. 專案設定 →指令碼屬性：新增 SPREADSHEET_ID = 你的試算表 ID。
 * 4. （選用）OPENAI_API_KEY = sk-... 供收據辨識 action=vision。
 * 5. 部署 → 新增部署作業 → 網頁應用程式，存取權「任何人」，執行身分「我」。
 * 6. 將 Web 應用程式 URL 貼到網頁「設定」。
 *
 * 工作表名稱：Transactions（若不存在會自動建立並寫入標題列）
 */
var PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';
var PROP_OPENAI_KEY = 'OPENAI_API_KEY';
// 若你不想用 Script Properties，可直接在這裡填入試算表 ID（優先使用）
var HARDCODED_SPREADSHEET_ID = '';
var SHEET_NAME = 'Transactions';
var HEADERS = ['id', 'date', 'amountJpy', 'category', 'payment', 'location', 'region', 'description', 'travelerId', 'taxType', 'itemsJson', 'createdAt'];

var VISION_SYSTEM = '你是日本收據 OCR 助手。請從收據圖片擷取並輸出純 JSON（不要 markdown）：' +
  '{"storeName":"店名原文","storeNameZh":"店名繁體中文","totalJpy":數字,"taxType":"內稅|外稅|不確定",' +
  '"items":[{"nameJa":"日文品名","nameZh":"繁中翻譯","priceJpy":數字,"tax":"課稅|免稅|內含"}],' +
  '"summaryZh":"整筆消費一句繁中摘要"}';

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'debug') {
    var id = getSpreadsheetId_();
    var key = PropertiesService.getScriptProperties().getProperty(PROP_OPENAI_KEY);
    return jsonOutMaybeJsonp_({
      ok: true,
      spreadsheetId: id || '',
      sheetName: SHEET_NAME,
      hasOpenAIKey: !!key,
      hint: id ? '已讀到 SPREADSHEET_ID' : '尚未設定 SPREADSHEET_ID（Script Properties 或 HARDCODED_SPREADSHEET_ID）'
    }, e);
  }
  if (action === 'pull') {
    try {
      var txs = pullTransactions_();
      return jsonOutMaybeJsonp_({ ok: true, transactions: txs }, e);
    } catch (err) {
      return jsonOutMaybeJsonp_({ ok: false, error: String(err.message || err) }, e);
    }
  }
  return jsonOutMaybeJsonp_({
    ok: true,
    message: 'JP Trip Ledger API. Use POST action=push|vision, GET ?action=pull, GET ?action=debug'
  }, e);
}

function doPost(e) {
  var body = parseBody_(e);
  if (body.action === 'push') {
    try {
      writeTransactions_(body.transactions || []);
      return jsonOut_({ ok: true });
    } catch (err) {
      return jsonOut_({ ok: false, error: String(err.message || err) });
    }
  }
  if (body.action === 'vision') {
    try {
      var data = callOpenAIVision_(body.image, body.mimeType || 'image/jpeg');
      return jsonOut_({ ok: true, data: data });
    } catch (err) {
      return jsonOut_({ ok: false, error: String(err.message || err) });
    }
  }
  return jsonOut_({ ok: false, error: 'unknown action' });
}

function parseBody_(e) {
  var raw = (e && e.postData && e.postData.contents) || '';
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (x) {
    // 支援 text/plain 或表單包 payload
    var payload = e && e.parameter && e.parameter.payload;
    if (payload) {
      try {
        return JSON.parse(payload);
      } catch (y) {}
    }
    return { action: (e && e.parameter && e.parameter.action) || '' };
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonOutMaybeJsonp_(obj, e) {
  var cb = e && e.parameter && e.parameter.callback;
  if (!cb) return jsonOut_(obj);
  if (!/^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(cb)) {
    return jsonOut_({ ok: false, error: 'invalid callback' });
  }
  return ContentService
    .createTextOutput(cb + '(' + JSON.stringify(obj) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function getSheet_() {
  var id = getSpreadsheetId_();
  if (!id) throw new Error('請在指令碼屬性設定 SPREADSHEET_ID，或填入 HARDCODED_SPREADSHEET_ID');
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
  }
  return sh;
}

function getSpreadsheetId_() {
  if (HARDCODED_SPREADSHEET_ID) return HARDCODED_SPREADSHEET_ID;
  return PropertiesService.getScriptProperties().getProperty(PROP_SPREADSHEET_ID);
}

function pullTransactions_() {
  var sh = getSheet_();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var key = headers[j];
      if (key) obj[key] = row[j];
    }
    rows.push(obj);
  }
  return rows;
}

function writeTransactions_(txs) {
  var sh = getSheet_();
  sh.clearContents();
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  if (!txs.length) return;
  var rows = txs.map(function (t) {
    return HEADERS.map(function (h) {
      var v = t[h];
      if (v === undefined || v === null) return '';
      return String(v);
    });
  });
  sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
}

function callOpenAIVision_(base64, mimeType) {
  var key = PropertiesService.getScriptProperties().getProperty(PROP_OPENAI_KEY);
  if (!key) throw new Error('請在指令碼屬性設定 OPENAI_API_KEY，或使用網頁本機辨識／示範模式');
  var payload = {
    model: 'gpt-4o-mini',
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: VISION_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: '請分析這張日本收據並回傳 JSON。' },
          { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64 } }
        ]
      }
    ]
  };
  var res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error(text || 'OpenAI HTTP ' + code);
  var json = JSON.parse(text);
  var content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('OpenAI 無內容');
  return JSON.parse(content);
}
