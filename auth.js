/**
 * 共用模組：後台網址、登入狀態、API 呼叫
 * login.html、index.html、status.html 都會載入這個檔案。
 */

// ★★★ 請替換成您的 GAS 網頁應用程式網址（全站只需要改這一處）★★★
const API_URL = "https://script.google.com/macros/s/AKfycbw432Celfrlcg_6OJvkn8UmYfKvHcXFpQSeF0AD3U_Qz7yLnpH1RffnQoAQsL1NUbGK/exec";

const SESSION_KEY = "equipment_session";
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
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* 無法儲存時忽略 */ }
}

function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
}

/** 目前頁面的檔名，例如 status.html；首頁（/）視為 index.html */
function currentPage() {
    const name = location.pathname.split("/").pop();
    return PAGES.includes(name) ? name : "index.html";
}

let redirectingToLogin = false;

/** 轉到登入頁（同時有多個請求失敗時只轉一次） */
function goLogin() {
    if (redirectingToLogin) return;
    redirectingToLogin = true;
    location.replace(LOGIN_PAGE + "?next=" + encodeURIComponent(currentPage()));
}

/** 未登入時轉到登入頁並回傳 null；已登入時回傳登入資料 */
function requireLogin() {
    const session = getSession();
    if (!session) goLogin();
    return session;
}

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
