/**
 * 共用模組：後台網址、登入狀態、閒置自動登出、驗證碼、API 呼叫
 * login.html、register.html、index.html、status.html 都會載入這個檔案。
 */

// ★★★ 請替換成您的 GAS 網頁應用程式網址（全站只需要改這一處）★★★
const API_URL = "https://script.google.com/macros/s/AKfycbw432Celfrlcg_6OJvkn8UmYfKvHcXFpQSeF0AD3U_Qz7yLnpH1RffnQoAQsL1NUbGK/exec";

// 沒有操作幾分鐘後自動登出（後台 Code.gs 的 SESSION_SECONDS 需略大於這個值）
const IDLE_MINUTES = 5;

const SESSION_KEY = "equipment_session";
const ACTIVE_KEY = "equipment_last_active";   // 最後一次操作的時間，分頁之間共用
const LOGIN_PAGE = "login.html";
const PAGES = ["index.html", "status.html"];   // 登入後允許前往的頁面

/** 取得目前登入資料 { token, user: { id, name, role } }，未登入時回傳 null */
function getSession() {
    try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY));
        return s && s.token && s.user ? s : null;
    } catch (e) {
        return null;
    }
}

function setSession(session) {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        localStorage.setItem(ACTIVE_KEY, String(Date.now()));   // 登入本身算一次操作
    } catch (e) { /* 無法儲存時忽略 */ }
}

function clearSession() {
    try {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(ACTIVE_KEY);
    } catch (e) { /* 忽略 */ }
}

/** 目前頁面的檔名，例如 status.html；首頁（/）視為 index.html */
function currentPage() {
    const name = location.pathname.split("/").pop();
    return PAGES.includes(name) ? name : "index.html";
}

let redirectingToLogin = false;

/** 轉到登入頁（同時有多個請求失敗時只轉一次）。reason 為 "idle" 時登入頁會顯示閒置登出的說明 */
function goLogin(reason) {
    if (redirectingToLogin) return;
    redirectingToLogin = true;
    location.replace(LOGIN_PAGE + "?next=" + encodeURIComponent(currentPage()) + (reason ? "&reason=" + reason : ""));
}

/** 未登入或已閒置過久時轉到登入頁並回傳 null；已登入時回傳登入資料並開始監看閒置時間 */
function requireLogin() {
    const session = getSession();
    if (!session) { goLogin(); return null; }
    if (isIdleExpired()) { idleLogout(); return null; }
    startIdleWatch();
    return session;
}

// ============================ 閒置自動登出 ============================

const IDLE_LIMIT_MS = IDLE_MINUTES * 60 * 1000;
const RENEW_EVERY_MS = 30 * 1000;   // 有操作時，最多每 30 秒通知後台一次以延長登入
let lastRenewAt = 0;

function lastActiveAt() {
    try { return parseInt(localStorage.getItem(ACTIVE_KEY), 10) || 0; } catch (e) { return 0; }
}

function isIdleExpired() {
    const last = lastActiveAt();
    return last > 0 && Date.now() - last >= IDLE_LIMIT_MS;
}

/** 記錄「使用者剛剛有操作」。點擊、按鍵、觸控、掃描成功都會呼叫。 */
function markActive() {
    const now = Date.now();
    if (!getSession() || redirectingToLogin) return;
    if (isIdleExpired()) { idleLogout(); return; }   // 已經超時才回來操作：不延長，直接登出
    if (now - lastActiveAt() >= 1000) {   // 連續操作時最多每秒寫入一次
        try { localStorage.setItem(ACTIVE_KEY, String(now)); } catch (e) { /* 忽略 */ }
    }
    if (now - lastRenewAt >= RENEW_EVERY_MS) {
        lastRenewAt = now;
        api({ action: "ping" }).catch(() => { /* 連線失敗時下次操作再試 */ });
    }
}

/** 通知後台讓 token 失效（不等待結果） */
function sendLogout(token) {
    try {
        fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "logout", token: token }), keepalive: true }).catch(() => {});
    } catch (e) { /* 忽略 */ }
}

function idleLogout() {
    const session = getSession();
    if (session) sendLogout(session.token);
    clearSession();
    goLogin("idle");
}

function checkIdle() {
    if (redirectingToLogin) return;
    if (!getSession()) { goLogin(); return; }        // 已在其他分頁登出
    if (isIdleExpired()) idleLogout();
}

let idleWatchStarted = false;

function startIdleWatch() {
    if (idleWatchStarted) return;
    idleWatchStarted = true;
    markActive();   // 開啟頁面算一次操作
    ["pointerdown", "keydown", "touchstart"].forEach(type =>
        document.addEventListener(type, markActive, { capture: true, passive: true }));
    setInterval(checkIdle, 5000);
    // 手機從背景切回來時立刻檢查，不必等計時器
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkIdle(); });
}

// ============================ 後台呼叫 ============================

/**
 * 呼叫後台。params 例如 { action: "borrow", id: "1001" }。
 * 會自動帶上登入 token；後台回覆「請先登入」時清除登入資料並轉到登入頁。
 */
async function api(params, withToken = true) {
    const body = Object.assign({}, params);
    if (withToken) {
        const session = getSession();
        if (!session) { goLogin(); throw new Error("尚未登入"); }
        body.token = session.token;
    }
    // 不指定 Content-Type（瀏覽器會用 text/plain），可避免 Apps Script 不支援的 CORS 預檢請求
    const res = await fetch(API_URL, { method: "POST", body: JSON.stringify(body) });
    const data = await res.json();
    if (withToken && data && data.code === "auth") {
        clearSession();
        goLogin();
        throw new Error(data.message || "請先登入");
    }
    return data;
}

/**
 * 驗證碼元件，登入頁與建立帳號頁共用。
 * 向後台要一張驗證碼圖片並顯示；答案只存在後台，前台只拿到編號與圖片。
 * 回傳 { id, reload() }：id 是目前這張驗證碼的編號，reload() 換一張新的。
 */
function createCaptchaBox(img, input, refreshBtn, showError) {
    const box = { id: "", reload: reload };

    async function reload() {
        refreshBtn.disabled = true;
        box.id = "";
        input.value = "";
        img.removeAttribute("src");
        try {
            const data = await api({ action: "captcha" }, false);
            if (!data.ok || !data.id || !data.svg) throw new Error(data.message || "無法取得驗證碼");
            box.id = data.id;
            // 以圖片方式顯示，SVG 內容不會被當成網頁的一部分執行
            img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data.svg);
        } catch (err) {
            console.error(err);
            showError("無法取得驗證碼，請按「換一張」再試。");
        }
        refreshBtn.disabled = false;
    }

    refreshBtn.addEventListener("click", () => { showError(""); reload(); });
    return box;
}

async function logout() {
    try { await api({ action: "logout" }); } catch (e) { /* 連線失敗也照樣在本機登出 */ }
    clearSession();
    location.replace(LOGIN_PAGE);
}

/** 在指定元素顯示「姓名（職稱） 登出」 */
function renderUserBar(el, session) {
    el.textContent = "";
    const who = document.createElement("span");
    who.textContent = "👤 " + session.user.name + (session.user.role ? "（" + session.user.role + "）" : "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "logout-btn";
    btn.textContent = "登出";
    btn.addEventListener("click", () => { btn.disabled = true; logout(); });
    el.append(who, btn);
}
