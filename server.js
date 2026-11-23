"use strict";
/*
 * 勤怠タイムカード サーバー（Node.js 標準ライブラリ + SQLite のみ。npm install 不要）
 * 起動: node server.js
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDb, hashPassword, verifyPassword, normalizeEmail } = require("./db");
const TC = require("./public/calc.js");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "timecard.db");
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1"; // HTTPSで公開するときは 1
const TRUST_PROXY = process.env.TRUST_PROXY === "1";     // リバースプロキシ配下のとき 1
const SESSION_MS = 7 * 24 * 3600 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDb(DB_FILE);
// 存在しないメールアドレスでも照合の処理時間が変わらないようにするためのダミー
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

// ---------- 共通 ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function sendJson(res, status, data, headers) {
  const body = JSON.stringify(data);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }, headers || {}));
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || "unknown";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 20000) { reject(new HttpError(413, "送信データが大きすぎます。")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!size) return resolve({});
      if (!String(req.headers["content-type"] || "").includes("application/json")) {
        return reject(new HttpError(415, "JSON形式で送信してください。"));
      }
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not object");
        resolve(v);
      } catch (e) { reject(bad("送信内容を読み取れませんでした。")); }
    });
    req.on("error", reject);
  });
}

// ---------- 認証 ----------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function createSession(userId) {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(token), userId, Date.now() + SESSION_MS);
  return token;
}
function sessionCookie(token, maxAgeSec) {
  return "sid=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + maxAgeSec + (COOKIE_SECURE ? "; Secure" : "");
}
function userFromRequest(req) {
  const token = parseCookies(req).sid;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha256(token), Date.now());
  return row || null;
}

const loginFails = new Map(); // ip -> { n, resetAt }
function loginBlocked(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() > e.resetAt) { loginFails.delete(ip); return false; }
  return e.n >= 10;
}
function loginFailed(ip) {
  const e = loginFails.get(ip);
  if (!e || Date.now() > e.resetAt) loginFails.set(ip, { n: 1, resetAt: Date.now() + 10 * 60 * 1000 });
  else e.n++;
}

// ---------- 入力検証・変換 ----------
function validMonth(m) {
  if (typeof m !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad("月の指定が正しくありません。");
  const y = Number(m.slice(0, 4));
  if (y < 2000 || y > 2100) throw bad("月の指定が正しくありません。");
  return { y, m: Number(m.slice(5)), key: m };
}
function validDate(d) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad("日付の指定が正しくありません。");
  const [y, m, dd] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd));
  if (y < 2000 || y > 2100 || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== dd) throw bad("日付の指定が正しくありません。");
  return d;
}
function normTime(v, label) {
  if (v === null || v === undefined || v === "") return null;
  const m = TC.toMin(v);
  if (m == null) throw bad(label + "の時刻が正しくありません。");
  return TC.p2(Math.floor(m / 60)) + ":" + TC.p2(m % 60);
}
function parseDayBody(b) {
  const type = b.type === undefined ? "work" : b.type;
  if (!Object.prototype.hasOwnProperty.call(TC.TYPES, type)) throw bad("区分が正しくありません。");
  let tin = normTime(b.in, "出勤"), tout = normTime(b.out, "退勤");
  let breaks = [];
  if (b.breaks !== undefined && b.breaks !== null) {
    if (!Array.isArray(b.breaks) || b.breaks.length > 20) throw bad("休憩の指定が正しくありません。");
    breaks = b.breaks.map((x) => {
      if (!x || typeof x !== "object") throw bad("休憩の指定が正しくありません。");
      const o = { s: normTime(x.s, "休憩開始") };
      if (!o.s) throw bad("休憩開始の時刻が必要です。");
      const e = normTime(x.e, "休憩終了");
      if (e) o.e = e;
      return o;
    });
  }
  let breakMin = null;
  if (b.breakMin !== null && b.breakMin !== undefined && b.breakMin !== "") {
    breakMin = Number(b.breakMin);
    if (!Number.isInteger(breakMin) || breakMin < 0 || breakMin > 480) throw bad("休憩は0〜480分で入力してください。");
  }
  let note = b.note === undefined || b.note === null ? "" : String(b.note).trim();
  if (note.length > 100) throw bad("備考は100文字以内で入力してください。");
  if (type !== "work") { tin = null; tout = null; breaks = []; breakMin = null; }
  return { type, in: tin, out: tout, breaks, breakMin, note };
}

const rowToRec = (r) => ({
  type: r.type, in: r.time_in, out: r.time_out,
  breaks: JSON.parse(r.breaks || "[]"), breakMin: r.break_min, note: r.note
});
const settingsOf = (u) => ({ start: u.start_time, end: u.end_time, std: u.std_min, brk: u.break_min });
const publicUser = (u) => ({ id: u.id, email: u.email, empNo: u.emp_no, name: u.name, role: u.role,
  mustChangePw: !!u.must_change_pw, settings: settingsOf(u) });

function getDay(userId, date) {
  const r = db.prepare("SELECT * FROM days WHERE user_id = ? AND date = ?").get(userId, date);
  return r ? rowToRec(r) : null;
}
function getMonth(userId, month) {
  const rows = db.prepare("SELECT * FROM days WHERE user_id = ? AND date >= ? AND date <= ?")
    .all(userId, month + "-01", month + "-31");
  const out = {};
  rows.forEach((r) => { out[r.date] = rowToRec(r); });
  return out;
}
function saveDay(userId, date, rec) {
  db.prepare(`
    INSERT INTO days (user_id, date, type, time_in, time_out, break_min, breaks, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, date) DO UPDATE SET
      type = excluded.type, time_in = excluded.time_in, time_out = excluded.time_out,
      break_min = excluded.break_min, breaks = excluded.breaks, note = excluded.note,
      updated_at = datetime('now')`)
    .run(userId, date, rec.type, rec.in, rec.out, rec.breakMin, JSON.stringify(rec.breaks), rec.note);
}
function audit(userId, actorId, date, action, before, after) {
  db.prepare("INSERT INTO audit_log (user_id, actor_id, date, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, actorId, date, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}
const todayKey = () => { const n = TC.jstNow(); return TC.dk(n.y, n.m, n.d); };

// ---------- CSV ----------
const csvCell = (v) => {
  const s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvText = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
function userMonthRows(user, mo) {
  const days = getMonth(user.id, mo.key);
  const st = settingsOf(user);
  const rows = [["氏名", user.name, "メール", user.email, "社員番号", user.emp_no || "", "対象月", mo.y + "年" + mo.m + "月"],
    ["日付", "曜日", "区分", "出勤", "退勤", "休憩", "実働", "残業", "深夜", "備考"]];
  const N = TC.daysIn(mo.y, mo.m);
  for (let d = 1; d <= N; d++) {
    const key = TC.dk(mo.y, mo.m, d), w = TC.dowOf(mo.y, mo.m, d), r = days[key], hol = TC.HOL[key];
    let kind = r ? (TC.TYPES[r.type] || "出勤") : (hol || (w === 0 || w === 6 ? "休み" : ""));
    if (r && r.type === "work" && TC.isOff(mo.y, mo.m, d)) kind = "休日出勤";
    const c = r ? TC.calc(r, st) : null;
    rows.push([key, TC.DOW[w], kind, r && r.in || "", r && r.out || "",
      c && c.ok && c.brk ? TC.fmt(c.brk) : "", c && c.ok ? TC.fmt(c.work) : "",
      c && c.ok && c.ot ? TC.fmt(c.ot) : "", c && c.ok && c.night ? TC.fmt(c.night) : "", r ? r.note : ""]);
  }
  const t = TC.monthStats(days, mo.y, mo.m, st);
  rows.push(["合計", "", "", "", "", "", TC.fmt(t.work), TC.fmt(t.ot), TC.fmt(t.night), "出勤" + t.days + "日"]);
  return rows;
}
const csvUserMonth = (user, mo) => csvText(userMonthRows(user, mo));
function sendCsv(res, text, filename) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="timecard.csv"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
    "Cache-Control": "no-store"
  });
  res.end(text);
}

// ---------- 管理者向けの集計 ----------
function summaryRows(mo) {
  return db.prepare("SELECT * FROM users WHERE active = 1 ORDER BY emp_no IS NULL, emp_no, email").all().map((u) => {
    const t = TC.monthStats(getMonth(u.id, mo.key), mo.y, mo.m, settingsOf(u));
    return { id: u.id, email: u.email, empNo: u.emp_no, name: u.name, role: u.role, days: t.days, sched: t.sched,
      work: t.work, ot: t.ot, night: t.night, paid: t.paid, absent: t.absent };
  });
}

function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < 8 || pw.length > 128) throw bad("パスワードは8文字以上で入力してください。");
}
function idParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw bad("指定が正しくありません。");
  return n;
}
function targetUser(id) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!u) throw new HttpError(404, "社員が見つかりません。");
  return u;
}

// ---------- ルーティング ----------
const routes = [];
const route = (method, pattern, opts, handler) => routes.push({ method, re: new RegExp("^" + pattern + "$"), opts, handler });
const AUTH = { auth: true }, ADMIN = { auth: true, admin: true }, OPEN = {};

route("POST", "/api/login", OPEN, async (c) => {
  const ip = clientIp(c.req);
  if (loginBlocked(ip)) throw new HttpError(429, "ログインの失敗が続いたため、しばらくしてからやり直してください。");
  const email = normalizeEmail(c.body.email), pw = String(c.body.password || "");
  const u = email ? db.prepare("SELECT * FROM users WHERE email = ? AND active = 1").get(email) : null;
  // ユーザーの有無で処理時間が変わらないよう、常にハッシュ照合する
  const ok = verifyPassword(pw, u ? u.pw_hash : DUMMY_HASH) && !!u;
  if (!ok) { loginFailed(ip); throw new HttpError(401, "メールアドレスまたはパスワードが違います。"); }
  loginFails.delete(ip);
  const token = createSession(u.id);
  sendJson(c.res, 200, publicUser(u), { "Set-Cookie": sessionCookie(token, SESSION_MS / 1000) });
});

route("POST", "/api/logout", OPEN, async (c) => {
  const token = parseCookies(c.req).sid;
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  sendJson(c.res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
});

route("GET", "/api/me", AUTH, async (c) => sendJson(c.res, 200, publicUser(c.user)));

route("PUT", "/api/settings", AUTH, async (c) => {
  const b = c.body;
  const start = normTime(b.start, "始業"), end = normTime(b.end, "終業");
  const std = Number(b.std), brk = Number(b.brk);
  if (!start || !end) throw bad("始業・終業時刻を入力してください。");
  if (!Number.isInteger(std) || std < 60 || std > 720) throw bad("所定労働時間は1〜12時間で入力してください。");
  if (!Number.isInteger(brk) || brk < 0 || brk > 240) throw bad("所定休憩は0〜240分で入力してください。");
  db.prepare("UPDATE users SET start_time = ?, end_time = ?, std_min = ?, break_min = ? WHERE id = ?")
    .run(start, end, std, brk, c.user.id);
  sendJson(c.res, 200, { start, end, std, brk });
});

route("POST", "/api/password", AUTH, async (c) => {
  if (!verifyPassword(String(c.body.current || ""), c.user.pw_hash)) throw new HttpError(403, "現在のパスワードが違います。");
  checkPassword(c.body.next);
  if (c.body.next === c.body.current) throw bad("現在と同じパスワードは設定できません。");
  db.prepare("UPDATE users SET pw_hash = ?, must_change_pw = 0 WHERE id = ?").run(hashPassword(c.body.next), c.user.id);
  // 他の端末のログインは終了させる（この端末は続ける）
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(c.user.id, sha256(parseCookies(c.req).sid));
  sendJson(c.res, 200, { ok: true });
});

route("GET", "/api/days", AUTH, async (c) => {
  const mo = validMonth(c.url.searchParams.get("month"));
  sendJson(c.res, 200, { days: getMonth(c.user.id, mo.key) });
});

route("PUT", "/api/days/(\\d{4}-\\d{2}-\\d{2})", AUTH, async (c) => {
  const date = validDate(c.params[0]);
  if (date > todayKey()) throw bad("未来の日付には登録できません。");
  const rec = parseDayBody(c.body);
  const before = getDay(c.user.id, date);
  saveDay(c.user.id, date, rec);
  audit(c.user.id, c.user.id, date, "edit", before, rec);
  sendJson(c.res, 200, rec);
});

route("DELETE", "/api/days/(\\d{4}-\\d{2}-\\d{2})", AUTH, async (c) => {
  const date = validDate(c.params[0]);
  const before = getDay(c.user.id, date);
  if (before) {
    db.prepare("DELETE FROM days WHERE user_id = ? AND date = ?").run(c.user.id, date);
    audit(c.user.id, c.user.id, date, "delete", before, null);
  }
  sendJson(c.res, 200, { ok: true });
});

// 打刻は端末の時計ではなく、サーバーの時刻（日本時間）で記録する
route("POST", "/api/punch", AUTH, async (c) => {
  const act = c.body.act;
  const n = TC.jstNow();
  const date = TC.dk(n.y, n.m, n.d), t = TC.p2(n.hh) + ":" + TC.p2(n.mm);
  const before = getDay(c.user.id, date);
  const rec = before ? JSON.parse(JSON.stringify(before)) : { type: "work", in: null, out: null, breaks: [], breakMin: null, note: "" };
  const st = TC.statusOf(rec);
  const need = { in: "idle", bs: "working", be: "break", out: "working" };
  if (!need[act]) throw bad("打刻の種類が正しくありません。");
  if (st !== need[act]) throw new HttpError(409, "現在の状態ではこの打刻はできません。画面を更新してください。");
  if (act === "in") { rec.type = "work"; rec.in = t; }
  else if (act === "bs") rec.breaks.push({ s: t });
  else if (act === "be") rec.breaks[rec.breaks.length - 1].e = t;
  else rec.out = t;
  saveDay(c.user.id, date, rec);
  audit(c.user.id, c.user.id, date, "punch:" + act, before, rec);
  sendJson(c.res, 200, { date, record: rec });
});

route("GET", "/api/export.csv", AUTH, async (c) => {
  const mo = validMonth(c.url.searchParams.get("month"));
  sendCsv(c.res, csvUserMonth(c.user, mo), "勤怠_" + mo.key + ".csv");
});

// ---- 管理者 ----
// 管理メニューの画面プログラム。公開フォルダには置かず、管理者のセッションにだけ配信する。
// 一般社員のリクエストには 403、未ログインには 401 を返す。
route("GET", "/api/admin/ui.js", ADMIN, async (c) => {
  c.res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
  c.res.end(fs.readFileSync(path.join(__dirname, "admin", "ui.js")));
});

route("GET", "/api/admin/summary", ADMIN, async (c) => {
  const mo = validMonth(c.url.searchParams.get("month"));
  sendJson(c.res, 200, { rows: summaryRows(mo) });
});

route("GET", "/api/admin/users/(\\d+)/days", ADMIN, async (c) => {
  const u = targetUser(idParam(c.params[0]));
  const mo = validMonth(c.url.searchParams.get("month"));
  sendJson(c.res, 200, { user: publicUser(u), days: getMonth(u.id, mo.key) });
});

route("POST", "/api/admin/users", ADMIN, async (c) => {
  const email = normalizeEmail(c.body.email), name = String(c.body.name || "").trim();
  const empNo = String(c.body.empNo || "").trim() || null;
  const role = c.body.role === "admin" ? "admin" : "employee";
  if (!email) throw bad("メールアドレスの形式が正しくありません。");
  if (empNo && !/^[A-Za-z0-9_-]{1,20}$/.test(empNo)) throw bad("社員番号は英数字・ハイフン・アンダースコアで20文字以内にしてください。");
  if (!name || name.length > 40) throw bad("氏名は1〜40文字で入力してください。");
  checkPassword(c.body.password);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "そのメールアドレスはすでに登録されています。");
  if (empNo && db.prepare("SELECT 1 FROM users WHERE emp_no = ?").get(empNo)) throw new HttpError(409, "その社員番号はすでに登録されています。");
  // 仮パスワードで作成し、本人の初回ログイン時に変更してもらう
  db.prepare("INSERT INTO users (email, emp_no, name, pw_hash, role, must_change_pw) VALUES (?, ?, ?, ?, ?, 1)")
    .run(email, empNo, name, hashPassword(c.body.password), role);
  sendJson(c.res, 201, { ok: true });
});

route("POST", "/api/admin/users/(\\d+)/password", ADMIN, async (c) => {
  const u = targetUser(idParam(c.params[0]));
  checkPassword(c.body.password);
  db.prepare("UPDATE users SET pw_hash = ?, must_change_pw = 1 WHERE id = ?").run(hashPassword(c.body.password), u.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  sendJson(c.res, 200, { ok: true });
});

route("PUT", "/api/admin/users/(\\d+)/active", ADMIN, async (c) => {
  const u = targetUser(idParam(c.params[0]));
  if (u.id === c.user.id) throw bad("自分自身は無効にできません。");
  const active = c.body.active ? 1 : 0;
  db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active, u.id);
  if (!active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  sendJson(c.res, 200, { ok: true });
});

route("GET", "/api/admin/export.csv", ADMIN, async (c) => {
  const mo = validMonth(c.url.searchParams.get("month"));
  const uid = c.url.searchParams.get("user");
  if (uid) {
    const u = targetUser(idParam(uid));
    return sendCsv(c.res, csvUserMonth(u, mo), "勤怠_" + (u.emp_no || u.id) + "_" + mo.key + ".csv");
  }
  const rows = [["対象月", mo.y + "年" + mo.m + "月"],
    ["社員番号", "氏名", "メール", "出勤日数", "所定日数", "総実働", "残業", "深夜", "有給", "欠勤"]];
  summaryRows(mo).forEach((r) => rows.push([r.empNo || "", r.name, r.email, r.days, r.sched, TC.fmt(r.work), TC.fmt(r.ot), TC.fmt(r.night), r.paid, r.absent]));
  sendCsv(c.res, csvText(rows), "勤怠一覧_" + mo.key + ".csv");
});

// ---------- 追加機能（振替・交通費・立替・現場情報・キャリアシート・Excel出力） ----------
require("./features")({ db, route, AUTH, ADMIN, sendJson, bad, HttpError, validDate, validMonth, idParam, targetUser, TC, userMonthRows, summaryRows });

// ---------- 静的ファイル ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
function serveStatic(req, res, pathname) {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || !MIME[path.extname(name)]) return false;
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(name)], "Cache-Control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : fs.readFileSync(file));
  return true;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

const server = http.createServer(async (req, res) => {
  Object.keys(SECURITY_HEADERS).forEach((k) => res.setHeader(k, SECURITY_HEADERS[k]));
  try {
    const url = new URL(req.url, "http://localhost");
    const method = req.method;

    if (!url.pathname.startsWith("/api/")) {
      if ((method === "GET" || method === "HEAD") && serveStatic(req, res, url.pathname)) return;
      throw new HttpError(404, "ページが見つかりません。");
    }

    // 別サイトからの書き込みを拒否（CSRF対策。Cookieの SameSite=Lax と併用）
    if (method !== "GET" && method !== "HEAD" && req.headers.origin) {
      let oh = "";
      try { oh = new URL(req.headers.origin).host; } catch (e) { /* 不正なOrigin */ }
      if (oh !== req.headers.host) throw new HttpError(403, "不正なリクエストです。");
    }

    let matched = null, params = null;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (m) { matched = r; params = m.slice(1); break; }
    }
    if (!matched) throw new HttpError(404, "APIが見つかりません。");

    let user = null;
    if (matched.opts.auth) {
      user = userFromRequest(req);
      if (!user) throw new HttpError(401, "ログインが必要です。");
      if (user.must_change_pw && !["/api/me", "/api/logout", "/api/password"].includes(url.pathname)) {
        return sendJson(res, 403, { error: "初回ログインのため、先にパスワードを変更してください。", code: "must_change_password" });
      }
      if (matched.opts.admin && user.role !== "admin") throw new HttpError(403, "管理者のみ利用できます。");
    }
    const body = (method === "POST" || method === "PUT") ? await readBody(req) : {};
    await matched.handler({ req, res, url, params, body, user });
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: "サーバーでエラーが発生しました。" });
  }
});

// 最初の管理者を環境変数から作成（ユーザーが1人もいないときだけ）
(function seedAdmin() {
  const n = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (n > 0) return;
  const email = normalizeEmail(process.env.ADMIN_EMAIL), pw = process.env.ADMIN_PASSWORD;
  if (email && pw && pw.length >= 8) {
    db.prepare("INSERT INTO users (email, name, pw_hash, role) VALUES (?, ?, ?, 'admin')")
      .run(email, process.env.ADMIN_NAME || "管理者", hashPassword(pw));
    console.log("管理者アカウントを作成しました: " + email);
  } else {
    console.log("ユーザーがまだいません。ADMIN_EMAIL と ADMIN_PASSWORD（8文字以上）を設定して起動するか、npm run create-user で管理者を作成してください。");
  }
})();

server.listen(PORT, HOST, () => {
  console.log("勤怠タイムカード: http://" + HOST + ":" + PORT + "  (DB: " + DB_FILE + ")");
});

module.exports = { server, db };
