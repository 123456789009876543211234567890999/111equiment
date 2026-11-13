/**
 * 設備借用／歸還後台（Google Apps Script）
 *
 * 所有請求都回傳 JSON：{ ok: true/false, message: "...", ... }
 * 前台以 POST 傳送 JSON；也可用 GET 帶相同參數（方便測試）。
 *
 *   驗證碼：  action=captcha                          → 回傳驗證碼編號與圖片（SVG）
 *   登入：    action=login, user=1001, password=****, captchaId=..., captcha=1234
 *                                                     → 回傳 token 與使用者資料
 *   建立帳號：action=register, user=..., name=..., password=****, captchaId=..., captcha=1234
 *                                                     → 在「使用者名單」新增一列，狀態為 NEW_USER_STATUS
 *   登出：    action=logout, token=...
 *   目前身分：action=me, token=...
 *   延長登入：action=ping, token=...                  → 使用者有操作時由前台呼叫
 *   借用：    action=borrow, id=1001, token=...       → C 欄「可借用」改為「借出中」
 *   歸還：    action=return, id=1001, token=...       → C 欄「借出中」改為「可借用」
 *   設備清單：action=list, token=...
 *   借還紀錄：action=log, limit=50, token=...
 *
 * 除了 captcha、login、register 以外，所有動作都必須帶有效的 token（先登入）。
 * 登入後若超過 SESSION_SECONDS 沒有操作，token 自動失效。
 *
 * 工作表 Equipment_List 欄位（設備）：
 *   A 設備編號   B 名稱   C 狀態   D QR Code   E 廠牌
 * 工作表 使用者名單 欄位（使用者）：
 *   A 使用者編號   B 姓名   C 職稱   D 狀態   E 密碼
 *
 * 每次借用／歸還成功時，會在「借還紀錄」分頁新增一列（含操作人）。
 * 該分頁不存在時會自動建立。
 */

var LIST_SHEET_NAME = "Equipment_List";
var LOG_SHEET_NAME = "借還紀錄";

// 使用者資料所在的分頁與起始欄（1 = A 欄），依序為：編號、姓名、職稱、狀態、密碼
var USER_SHEET_NAME = "使用者名單";
var USER_START_COL = 1;
// 狀態欄填入下列任一文字時，該帳號不可登入；空白視為啟用
var DISABLED_STATUSES = ["不啟用", "停用", "待審核"];

// 使用者自行建立帳號時寫入的狀態與職稱。
// 預設「待審核」：管理員到「使用者名單」把該列的狀態清空後，帳號才能登入。
// 若希望建立後立刻可以登入，把 NEW_USER_STATUS 改成 ""（任何人都能自行取得帳號，請斟酌）。
var NEW_USER_STATUS = "待審核";
var NEW_USER_ROLE = "teacher";
var MAX_REGISTER_PER_HOUR = 20;   // 每小時最多可建立幾個帳號，避免被大量灌入

// 沒有操作多久後 token 失效。前台在 5 分鐘無操作時會自動登出（auth.js 的 IDLE_MINUTES），
// 這裡多留 1 分鐘緩衝，避免前台還沒登出、後台先失效。
var SESSION_SECONDS = 360;
var CAPTCHA_SECONDS = 300;     // 驗證碼有效時間：5 分鐘
var CAPTCHA_LENGTH = 4;        // 驗證碼位數
var MAX_LOGIN_FAILS = 5;       // 連續輸入錯誤幾次後鎖定
var LOCK_SECONDS = 600;        // 鎖定時間：10 分鐘

var LOG_HEADERS = ["時間", "設備編號", "名稱", "廠牌", "動作", "更新後狀態", "使用者編號", "使用者"];

function doGet(e) {
  return respond((e && e.parameter) || {});
}

function doPost(e) {
  var params = {};
  try {
    params = JSON.parse(e.postData.contents) || {};
  } catch (err) {
    params = (e && e.parameter) || {};
  }
  return respond(params);
}

function respond(params) {
  var result;
  try {
    result = handle(params);
  } catch (err) {
    result = { ok: false, code: "error", message: "系統錯誤：" + err.message };
  }
  return jsonOutput(result);
}

/** 依 action 分派 */
function handle(p) {
  var action = String(p.action || "borrow").toLowerCase();

  if (action === "captcha") return createCaptcha();
  if (action === "login")   return login(p.user, p.password, p.captchaId, p.captcha);
  if (action === "register") return register(p.user, p.name, p.password, p.captchaId, p.captcha);
  if (action === "logout")  return logout(p.token);

  // ---- 以下動作都需要先登入 ----
  // 只有使用者真的有操作時才延長登入時間；總覽頁的自動更新（list、log）不算操作
  var renew = (action === "ping" || action === "me" || action === "borrow" || action === "return");
  var user = getSessionUser(p.token, renew);
  if (!user) return { ok: false, code: "auth", message: "請先登入" };

  if (action === "ping") return { ok: true };
  if (action === "me")   return { ok: true, user: user };
  if (action === "list") return getEquipmentList();
  if (action === "log")  return getLog(parseInt(p.limit, 10) || 50);
  if (action === "borrow" || action === "return") return changeStatus(p.id, action, user);

  return { ok: false, code: "bad_action", message: "未知的動作：" + action };
}

/** 回傳 JSON 格式 */
function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================ 圖形驗證碼 ============================

/** 產生一組驗證碼：答案存在後台快取，只把編號與圖片回傳給前台 */
function createCaptcha() {
  var code = "";
  for (var i = 0; i < CAPTCHA_LENGTH; i++) code += Math.floor(Math.random() * 10);
  var id = Utilities.getUuid().replace(/-/g, "");
  CacheService.getScriptCache().put("cap_" + id, code, CAPTCHA_SECONDS);
  return { ok: true, id: id, svg: drawCaptcha(code) };
}

/** 檢查驗證碼。每組驗證碼只能用一次，不論對錯都會作廢。 */
function checkCaptcha(captchaId, answer) {
  captchaId = String(captchaId == null ? "" : captchaId);
  answer = String(answer == null ? "" : answer).trim();
  if (captchaId === "" || captchaId.length > 64 || answer === "") return false;

  var cache = CacheService.getScriptCache();
  var key = "cap_" + captchaId;
  var code = cache.get(key);
  if (!code) return false;
  cache.remove(key);
  return code === answer;
}

// 數字的筆畫：座標為寬 4、高 6 的格子，每個陣列是一條連續的線
var DIGIT_STROKES = {
  "0": [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]]],
  "1": [[[1, 1.4], [2.4, 0], [2.4, 6]]],
  "2": [[[0, 0], [4, 0], [4, 3], [0, 3], [0, 6], [4, 6]]],
  "3": [[[0, 0], [4, 0], [4, 6], [0, 6]], [[0.8, 3], [4, 3]]],
  "4": [[[0, 0], [0, 3], [4, 3]], [[4, 0], [4, 6]]],
  "5": [[[4, 0], [0, 0], [0, 3], [4, 3], [4, 6], [0, 6]]],
  "6": [[[4, 0], [0, 0], [0, 6], [4, 6], [4, 3], [0, 3]]],
  "7": [[[0, 0], [4, 0], [4, 6]]],
  "8": [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]], [[0, 3], [4, 3]]],
  "9": [[[4, 3], [0, 3], [0, 0], [4, 0], [4, 6], [0, 6]]]
};
var CAPTCHA_COLORS = ["#1b4f9c", "#8a2a2a", "#1f6b3a", "#5b2a86", "#7a4a00", "#333333"];

function rnd(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * 把驗證碼畫成 SVG 圖片。數字以線條畫出（圖片裡沒有文字），
 * 每個數字的位置、大小、角度、筆畫都隨機偏移，並加上干擾線與雜點。
 */
function drawCaptcha(code) {
  var W = 160, H = 60;
  var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">',
               '<rect width="' + W + '" height="' + H + '" fill="#f1f3f5"/>'];
  var i, j, k;

  // 雜點
  for (i = 0; i < 40; i++) {
    parts.push('<circle cx="' + rnd(0, W).toFixed(1) + '" cy="' + rnd(0, H).toFixed(1) + '" r="' + rnd(0.6, 1.4).toFixed(1) +
               '" fill="' + CAPTCHA_COLORS[Math.floor(rnd(0, CAPTCHA_COLORS.length))] + '" opacity="0.5"/>');
  }

  // 數字
  var slot = W / code.length;
  for (i = 0; i < code.length; i++) {
    var strokes = DIGIT_STROKES[code.charAt(i)];
    var cx = slot * (i + 0.5) + rnd(-4, 4);
    var cy = H / 2 + rnd(-5, 5);
    var scale = rnd(5.2, 6.4);
    var angle = rnd(-12, 12) * Math.PI / 180;
    var cos = Math.cos(angle), sin = Math.sin(angle);
    var d = "";
    for (j = 0; j < strokes.length; j++) {
      for (k = 0; k < strokes[j].length; k++) {
        var x = (strokes[j][k][0] - 2 + rnd(-0.22, 0.22)) * scale;
        var y = (strokes[j][k][1] - 3 + rnd(-0.22, 0.22)) * scale;
        d += (k === 0 ? "M" : "L") + (cx + x * cos - y * sin).toFixed(1) + " " + (cy + x * sin + y * cos).toFixed(1);
      }
    }
    parts.push('<path d="' + d + '" fill="none" stroke="' + CAPTCHA_COLORS[Math.floor(rnd(0, CAPTCHA_COLORS.length))] +
               '" stroke-width="' + rnd(2.6, 3.4).toFixed(1) + '" stroke-linecap="round" stroke-linejoin="round"/>');
  }

  // 干擾線（畫在數字上面）
  for (i = 0; i < 3; i++) {
    parts.push('<path d="M' + rnd(0, W * 0.3).toFixed(1) + ' ' + rnd(0, H).toFixed(1) +
               'Q' + rnd(W * 0.3, W * 0.7).toFixed(1) + ' ' + rnd(-10, H + 10).toFixed(1) +
               ' ' + rnd(W * 0.7, W).toFixed(1) + ' ' + rnd(0, H).toFixed(1) +
               '" fill="none" stroke="' + CAPTCHA_COLORS[Math.floor(rnd(0, CAPTCHA_COLORS.length))] +
               '" stroke-width="' + rnd(0.9, 1.3).toFixed(1) + '" opacity="0.55"/>');
  }

  parts.push('</svg>');
  return parts.join("");
}

// ============================ 登入／登出 ============================

/** 讀取所有使用者（含密碼，僅供後台內部比對，不可直接回傳給前台） */
function getUsers() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USER_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];

  // 用顯示值讀取，避免「0000」這類密碼被當成數字 0
  var rows = sheet.getRange(2, USER_START_COL, sheet.getLastRow() - 1, 5).getDisplayValues();
  var users = [];
  for (var i = 0; i < rows.length; i++) {
    var id = String(rows[i][0]).trim();
    if (id === "") continue;
    var status = String(rows[i][3]).trim();
    users.push({
      id: id,
      name: String(rows[i][1]).trim(),
      role: String(rows[i][2]).trim(),
      status: status,
      disabled: DISABLED_STATUSES.indexOf(status) !== -1,
      password: String(rows[i][4]).trim()
    });
  }
  return users;
}

function findUser(userId) {
  var users = getUsers();
  for (var i = 0; i < users.length; i++) {
    if (users[i].id === userId) return users[i];
  }
  return null;
}

/** 可以回傳給前台的使用者資料（不含密碼） */
function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role };
}

function login(userId, password, captchaId, captcha) {
  userId = String(userId == null ? "" : userId).trim();
  password = String(password == null ? "" : password);
  if (userId === "" || password === "") {
    return { ok: false, code: "bad_request", message: "請輸入帳號與密碼" };
  }
  // 先檢查驗證碼；錯了就不會去比對密碼
  if (!checkCaptcha(captchaId, captcha)) {
    return { ok: false, code: "bad_captcha", message: "驗證碼錯誤或已過期，請重新輸入" };
  }
  if (userId.length > 50 || password.length > 100) {
    return { ok: false, code: "bad_login", message: "帳號或密碼錯誤" };
  }

  var cache = CacheService.getScriptCache();
  var failKey = "fail_" + userId;
  var fails = parseInt(cache.get(failKey), 10) || 0;
  if (fails >= MAX_LOGIN_FAILS) {
    return { ok: false, code: "locked", message: "登入失敗次數過多，請 " + Math.round(LOCK_SECONDS / 60) + " 分鐘後再試" };
  }

  var user = findUser(userId);
  if (!user || user.password === "" || user.password !== password) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    return { ok: false, code: "bad_login", message: "帳號或密碼錯誤" };
  }
  if (user.disabled) {
    return { ok: false, code: "disabled", message: "此帳號目前為「" + user.status + "」，無法登入，請洽管理員" };
  }

  cache.remove(failKey);
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
  cache.put("sess_" + token, user.id, SESSION_SECONDS);
  return { ok: true, message: "登入成功", token: token, user: publicUser(user) };
}

/** 以 = + - @ ' 開頭的文字寫進試算表可能被當成公式，一律不接受 */
function looksLikeFormula(text) {
  return /^[=+\-@']/.test(text);
}

/** 建立帳號：在「使用者名單」最後新增一列 */
function register(userId, name, password, captchaId, captcha) {
  userId = String(userId == null ? "" : userId).trim();
  name = String(name == null ? "" : name).trim();
  password = String(password == null ? "" : password);
  if (userId === "" || name === "" || password === "") {
    return { ok: false, code: "bad_request", message: "請填寫帳號、姓名與密碼" };
  }
  if (!checkCaptcha(captchaId, captcha)) {
    return { ok: false, code: "bad_captcha", message: "驗證碼錯誤或已過期，請重新輸入" };
  }
  if (!/^[A-Za-z0-9]{4,20}$/.test(userId)) {
    return { ok: false, code: "bad_id", message: "帳號須為 4 到 20 個英文字母或數字" };
  }
  if (name.length > 20 || /[\x00-\x1f<>]/.test(name) || looksLikeFormula(name)) {
    return { ok: false, code: "bad_name", message: "姓名最多 20 個字，不可包含 < >，也不可以 = + - @ ' 開頭" };
  }
  if (password.length < 4 || password.length > 50 || password !== password.trim() ||
      /[\x00-\x1f]/.test(password) || looksLikeFormula(password)) {
    return { ok: false, code: "bad_password", message: "密碼須為 4 到 50 個字元，前後不可有空白，也不可以 = + - @ ' 開頭" };
  }

  var cache = CacheService.getScriptCache();
  var created = parseInt(cache.get("reg_count"), 10) || 0;
  if (created >= MAX_REGISTER_PER_HOUR) {
    return { ok: false, code: "busy", message: "目前建立帳號的人數過多，請稍後再試" };
  }

  // 鎖定後再檢查與寫入，避免兩個人同時用同一個帳號建立
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USER_SHEET_NAME);
    if (!sheet) {
      return { ok: false, code: "error", message: "找不到「" + USER_SHEET_NAME + "」分頁，請洽管理員" };
    }
    var users = getUsers();
    for (var i = 0; i < users.length; i++) {
      if (users[i].id.toLowerCase() === userId.toLowerCase()) {
        return { ok: false, code: "exists", message: "此帳號已被使用，請換一個" };
      }
    }
    var row = Math.max(sheet.getLastRow() + 1, 2);
    var range = sheet.getRange(row, USER_START_COL, 1, 5);
    range.setNumberFormat("@");   // 先設成純文字，「0123」這類帳號或密碼才不會被存成數字
    range.setValues([[userId, name, NEW_USER_ROLE, NEW_USER_STATUS, password]]);
  } finally {
    lock.releaseLock();
  }
  cache.put("reg_count", String(created + 1), 3600);

  var pending = DISABLED_STATUSES.indexOf(NEW_USER_STATUS) !== -1;
  return {
    ok: true,
    pending: pending,
    message: pending ? "帳號已建立，目前狀態為「" + NEW_USER_STATUS + "」。\n請等管理員啟用後再登入。" : "帳號已建立，請登入。"
  };
}

function logout(token) {
  token = String(token || "");
  if (token !== "") CacheService.getScriptCache().remove("sess_" + token);
  return { ok: true, message: "已登出" };
}

/**
 * 由 token 取得登入中的使用者；token 無效、過期或帳號已停用時回傳 null。
 * renew 為 true 時重新計算有效時間。
 */
function getSessionUser(token, renew) {
  token = String(token || "");
  if (token === "" || token.length > 100) return null;

  var cache = CacheService.getScriptCache();
  var key = "sess_" + token;
  var userId = cache.get(key);
  if (!userId) return null;

  var user = findUser(userId);
  if (!user || user.disabled) {
    cache.remove(key);
    return null;
  }
  if (renew) cache.put(key, user.id, SESSION_SECONDS);
  return publicUser(user);
}

// ============================ 借用／歸還 ============================

function changeStatus(equipmentId, action, user) {
  equipmentId = String(equipmentId == null ? "" : equipmentId).trim();
  if (equipmentId === "") {
    return { ok: false, code: "bad_request", message: "請提供設備編號" };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LIST_SHEET_NAME);
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() !== equipmentId) continue;

    var currentStatus = String(data[i][2]).trim();
    var eqName = data[i][1];
    var eqBrand = data[i][4];
    var statusCell = sheet.getRange(i + 1, 3); // C 欄

    // 借用：可借用 → 借出中
    if (action === "borrow") {
      if (currentStatus !== "可借用") {
        return { ok: false, code: "bad_status", message: "借用失敗！該設備目前狀態為：" + currentStatus };
      }
      statusCell.setValue("借出中");
      appendLog(ss, equipmentId, eqName, eqBrand, "借用", "借出中", user);
      return { ok: true, message: "借用成功！\n" + eqBrand + " " + eqName + "\n借用人：" + user.name + "\n狀態已更新為：借出中" };
    }

    // 歸還：借出中 → 可借用
    if (currentStatus !== "借出中") {
      return { ok: false, code: "bad_status", message: "歸還失敗！該設備目前狀態為：" + currentStatus + "（未在借出狀態）" };
    }
    statusCell.setValue("可借用");
    appendLog(ss, equipmentId, eqName, eqBrand, "歸還", "可借用", user);
    return { ok: true, message: "歸還成功！\n" + eqBrand + " " + eqName + "\n歸還人：" + user.name + "\n狀態已更新為：可借用" };
  }
  return { ok: false, code: "not_found", message: "找不到設備編號：" + equipmentId };
}

// ============================ 查詢 ============================

/** 取得所有設備與狀態 */
function getEquipmentList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LIST_SHEET_NAME);
  var data = sheet.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === "") continue;
    items.push({
      id: String(data[i][0]).trim(),
      name: String(data[i][1] || ""),
      status: String(data[i][2] || "").trim(),
      brand: String(data[i][4] || "")
    });
  }
  return { ok: true, updatedAt: formatTime(new Date()), items: items };
}

/** 取得最近 N 筆借還紀錄（新到舊） */
function getLog(limit) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!logSheet || logSheet.getLastRow() < 2) return { ok: true, records: [] };

  var lastRow = logSheet.getLastRow();
  var count = Math.min(Math.max(limit, 1), 500, lastRow - 1);
  var startRow = lastRow - count + 1;
  var data = logSheet.getRange(startRow, 1, count, LOG_HEADERS.length).getValues();

  var records = [];
  for (var i = data.length - 1; i >= 0; i--) {
    records.push({
      time: data[i][0] instanceof Date ? formatTime(data[i][0]) : String(data[i][0]),
      id: String(data[i][1]),
      name: String(data[i][2]),
      brand: String(data[i][3]),
      action: String(data[i][4]),
      status: String(data[i][5]),
      userId: String(data[i][6]),
      userName: String(data[i][7])
    });
  }
  return { ok: true, records: records };
}

/** 在「借還紀錄」分頁新增一列。分頁不存在時自動建立並寫入標題列。 */
function appendLog(ss, equipmentId, eqName, eqBrand, actionText, newStatus, user) {
  var logSheet = ss.getSheetByName(LOG_SHEET_NAME);

  if (!logSheet) {
    logSheet = ss.insertSheet(LOG_SHEET_NAME);
    logSheet.setFrozenRows(1);
    logSheet.setColumnWidth(1, 160);
  }
  // 標題列（舊的紀錄分頁只有 6 欄時，會補上「使用者編號」「使用者」兩欄）
  logSheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight("bold");

  logSheet.appendRow([new Date(), String(equipmentId), eqName, eqBrand, actionText, newStatus, user.id, user.name]);
  logSheet.getRange(logSheet.getLastRow(), 1).setNumberFormat("yyyy/MM/dd HH:mm:ss");
}

function formatTime(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm:ss");
}
