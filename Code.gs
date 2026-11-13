/**
 * 設備借用／歸還後台（Google Apps Script）
 *
 * 所有請求都回傳 JSON：{ ok: true/false, message: "...", ... }
 * 前台以 POST 傳送 JSON；也可用 GET 帶相同參數（方便測試）。
 *
 *   登入：    action=login, user=1001, password=****  → 回傳 token 與使用者資料
 *   登出：    action=logout, token=...
 *   目前身分：action=me, token=...
 *   借用：    action=borrow, id=1001, token=...       → C 欄「可借用」改為「借出中」
 *   歸還：    action=return, id=1001, token=...       → C 欄「借出中」改為「可借用」
 *   設備清單：action=list, token=...
 *   借還紀錄：action=log, limit=50, token=...
 *
 * 除了 login 以外，所有動作都必須帶有效的 token（先登入）。
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
var DISABLED_STATUSES = ["不啟用", "停用"];

var SESSION_SECONDS = 21600;   // 登入有效時間：6 小時（每次操作會自動延長）
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

  if (action === "login")  return login(p.user, p.password);
  if (action === "logout") return logout(p.token);

  // ---- 以下動作都需要先登入 ----
  var user = getSessionUser(p.token);
  if (!user) return { ok: false, code: "auth", message: "請先登入" };

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

function login(userId, password) {
  userId = String(userId == null ? "" : userId).trim();
  password = String(password == null ? "" : password);
  if (userId === "" || password === "") {
    return { ok: false, code: "bad_request", message: "請輸入帳號與密碼" };
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

function logout(token) {
  token = String(token || "");
  if (token !== "") CacheService.getScriptCache().remove("sess_" + token);
  return { ok: true, message: "已登出" };
}

/** 由 token 取得登入中的使用者；token 無效、過期或帳號已停用時回傳 null */
function getSessionUser(token) {
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
  cache.put(key, user.id, SESSION_SECONDS); // 有操作就延長登入時間
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
