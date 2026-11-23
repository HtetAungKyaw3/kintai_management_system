"use strict";
/*
 * 追加機能: 振替管理 / 交通費（現場請求用・社内向け） / 立替申請 / 現場情報 / キャリアデザインシート
 * と、各画面のExcel出力（勤怠表のExcel出力を含む）。server.js から1回だけ呼ばれる。
 */
const { buildXlsx, tableSheet } = require("./xlsx");

const STATUS = { pending: "承認待ち", approved: "承認済み", rejected: "差し戻し" };
const STATUS_FILL = { pending: "FFF2CC", approved: "E2EFDA", rejected: "F8D7DA" };
const LINES = ["電車", "バス", "新幹線", "タクシー", "自家用車", "その他"];
const CATS = ["消耗品費", "通信費", "会議費", "出張費", "書籍・研修費", "その他"];

const F = {
  date: (key, label) => ({ key, label, type: "date", required: true }),
  text: (key, label, o) => Object.assign({ key, label, type: "text", max: 100 }, o),
  num: (key, label) => ({ key, label, type: "number", required: true }),
  sel: (key, label, options) => ({ key, label, type: "select", options, required: true }),
  bool: (key, label) => ({ key, label, type: "bool" })
};

const KINDS = {
  transfer: {
    label: "振替管理", dateKey: "workDate", money: false,
    fields: [F.date("workDate", "休日出勤日"), F.date("offDate", "振替休日"), F.text("reason", "理由・業務内容", { required: true })]
  },
  transport_site: {
    label: "交通費(現場請求用)", dateKey: "date", money: true,
    fields: [F.date("date", "日付"), { key: "site", label: "現場", type: "site", required: true },
      F.text("from", "出発", { max: 40, required: true }), F.text("to", "到着", { max: 40, required: true }),
      F.sel("line", "交通機関", LINES), F.bool("roundTrip", "往復"), F.num("amount", "金額（円）"), F.text("note", "備考")]
  },
  transport_internal: {
    label: "交通費(社内向け)", dateKey: "date", money: true,
    fields: [F.date("date", "日付"), F.text("purpose", "目的", { required: true }),
      F.text("from", "出発", { max: 40, required: true }), F.text("to", "到着", { max: 40, required: true }),
      F.sel("line", "交通機関", LINES), F.bool("roundTrip", "往復"), F.num("amount", "金額（円）"), F.text("note", "備考")]
  },
  expense: {
    label: "立替申請", dateKey: "date", money: true,
    fields: [F.date("date", "日付"), F.sel("category", "分類", CATS), F.text("item", "内容", { required: true }),
      F.text("shop", "支払先", { max: 60 }), F.num("amount", "金額（円）"), F.text("note", "備考")]
  }
};

const SKILL_LEVELS = ["", "初級", "基礎", "実務可", "得意", "指導可"];

module.exports = function install(ctx) {
  const { db, route, AUTH, ADMIN, sendJson, bad, HttpError, validDate, validMonth, idParam, TC } = ctx;

  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT    NOT NULL,
      date        TEXT    NOT NULL,                 -- 月ごとの絞り込みに使う日付（YYYY-MM-DD）
      data        TEXT    NOT NULL,                 -- 入力内容（JSON）
      status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      reviewer_id INTEGER,
      reviewed_at TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_records_kind_date ON records(kind, date);
    CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id, kind);

    CREATE TABLE IF NOT EXISTS sites (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL UNIQUE,
      client   TEXT NOT NULL DEFAULT '',
      address  TEXT NOT NULL DEFAULT '',
      contact  TEXT NOT NULL DEFAULT '',
      note     TEXT NOT NULL DEFAULT '',
      active   INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS career (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ---------- 共通 ----------
  const str = (v, label, max, required) => {
    const s = v === undefined || v === null ? "" : String(v).trim();
    if (required && !s) throw bad(label + "を入力してください。");
    if (s.length > max) throw bad(label + "は" + max + "文字以内で入力してください。");
    return s;
  };
  const dateOnly = (s) => String(s || "").slice(0, 10);

  function sendXlsx(res, sheets, filename) {
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="timecard.xlsx"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
      "Cache-Control": "no-store"
    });
    res.end(buildXlsx(sheets));
  }

  // ---------- 申請系（振替・交通費・立替） ----------
  function kindOf(k) {
    if (!Object.prototype.hasOwnProperty.call(KINDS, k)) throw bad("種類の指定が正しくありません。");
    return KINDS[k];
  }

  function cleanData(kind, body) {
    const def = KINDS[kind], data = {};
    def.fields.forEach((f) => {
      const v = body[f.key];
      if (f.type === "date") data[f.key] = validDate(v);
      else if (f.type === "text") data[f.key] = str(v, f.label, f.max, f.required);
      else if (f.type === "bool") data[f.key] = !!v;
      else if (f.type === "number") {
        const n = Number(v);
        if (v === "" || v === null || v === undefined || !Number.isInteger(n) || n < 0 || n > 1000000) throw bad(f.label + "は0〜1,000,000の整数で入力してください。");
        data[f.key] = n;
      } else if (f.type === "select") {
        if (!f.options.includes(v)) throw bad(f.label + "を選んでください。");
        data[f.key] = v;
      } else if (f.type === "site") {
        const s = db.prepare("SELECT id, name FROM sites WHERE id = ? AND active = 1").get(Number(body.siteId));
        if (!s) throw bad("現場を選んでください。");
        data.siteId = s.id; data.site = s.name;
      }
    });
    if (kind === "transfer" && data.workDate === data.offDate) throw bad("休日出勤日と振替休日は別の日にしてください。");
    return data;
  }

  function recRow(r) {
    return { id: r.id, userId: r.user_id, userName: r.name, empNo: r.emp_no || "", date: r.date, data: JSON.parse(r.data),
      status: r.status, createdAt: dateOnly(r.created_at) };
  }
  function listRecords(kind, mo, user, all) {
    const where = ["r.kind = ?", "r.date >= ?", "r.date <= ?"];
    const args = [kind, mo.key + "-01", mo.key + "-31"];
    if (!all) { where.push("r.user_id = ?"); args.push(user.id); }
    return db.prepare(`SELECT r.*, u.name, u.emp_no FROM records r JOIN users u ON u.id = r.user_id
      WHERE ${where.join(" AND ")} ORDER BY r.date, r.id`).all(...args).map(recRow);
  }
  function scopeAll(c) {
    if (c.url.searchParams.get("scope") !== "all") return false;
    if (c.user.role !== "admin") throw new HttpError(403, "管理者のみ利用できます。");
    return true;
  }
  function ownedRecord(c, id) {
    const r = db.prepare("SELECT * FROM records WHERE id = ?").get(id);
    if (!r || (r.user_id !== c.user.id && c.user.role !== "admin")) throw new HttpError(404, "記録が見つかりません。");
    return r;
  }

  route("GET", "/api/features", AUTH, async (c) => {
    const kinds = {};
    Object.keys(KINDS).forEach((k) => { kinds[k] = { label: KINDS[k].label, money: KINDS[k].money, fields: KINDS[k].fields }; });
    sendJson(c.res, 200, { kinds, status: STATUS, skillLevels: SKILL_LEVELS });
  });

  route("GET", "/api/records", AUTH, async (c) => {
    const kind = c.url.searchParams.get("kind"); kindOf(kind);
    const mo = validMonth(c.url.searchParams.get("month"));
    sendJson(c.res, 200, { records: listRecords(kind, mo, c.user, scopeAll(c)) });
  });

  route("POST", "/api/records", AUTH, async (c) => {
    const kind = c.body.kind; const def = kindOf(kind);
    const data = cleanData(kind, c.body);
    const r = db.prepare("INSERT INTO records (user_id, kind, date, data) VALUES (?, ?, ?, ?)")
      .run(c.user.id, kind, data[def.dateKey], JSON.stringify(data));
    sendJson(c.res, 201, { id: Number(r.lastInsertRowid) });
  });

  route("PUT", "/api/records/(\\d+)", AUTH, async (c) => {
    const row = ownedRecord(c, idParam(c.params[0]));
    if (row.user_id !== c.user.id) throw new HttpError(403, "他の人の申請は修正できません。");
    if (row.status !== "pending") throw new HttpError(409, "承認済み・差し戻しの申請は修正できません。");
    const def = KINDS[row.kind], data = cleanData(row.kind, c.body);
    db.prepare("UPDATE records SET date = ?, data = ?, updated_at = datetime('now') WHERE id = ?")
      .run(data[def.dateKey], JSON.stringify(data), row.id);
    sendJson(c.res, 200, { ok: true });
  });

  route("DELETE", "/api/records/(\\d+)", AUTH, async (c) => {
    const row = ownedRecord(c, idParam(c.params[0]));
    if (c.user.role !== "admin" && row.status !== "pending") throw new HttpError(409, "承認済み・差し戻しの申請は削除できません。");
    db.prepare("DELETE FROM records WHERE id = ?").run(row.id);
    sendJson(c.res, 200, { ok: true });
  });

  route("PUT", "/api/admin/records/(\\d+)/status", ADMIN, async (c) => {
    const id = idParam(c.params[0]);
    if (!STATUS[c.body.status]) throw bad("状態の指定が正しくありません。");
    const r = db.prepare("UPDATE records SET status = ?, reviewer_id = ?, reviewed_at = datetime('now') WHERE id = ?")
      .run(c.body.status, c.user.id, id);
    if (!r.changes) throw new HttpError(404, "記録が見つかりません。");
    sendJson(c.res, 200, { ok: true });
  });

  function recordsSheet(kind, mo, recs) {
    const def = KINDS[kind];
    const cols = [{ label: "社員番号", width: 11, kind: "center" }, { label: "氏名", width: 14 }];
    const pick = [];
    def.fields.forEach((f) => {
      const w = f.type === "date" ? 13 : f.type === "number" ? 13 : f.type === "bool" ? 8 : f.type === "select" ? 13 : f.type === "site" ? 24 : Math.min(40, Math.max(14, Math.round((f.max || 40) / 2)));
      cols.push({ label: f.type === "number" ? f.label.replace("（円）", "") : f.label, width: w,
        kind: f.type === "number" ? "yen" : f.type === "text" ? "wrap" : "center" });
      pick.push(f);
    });
    cols.push({ label: "状態", width: 12, kind: "center" });
    const amountCol = def.money ? 2 + def.fields.findIndex((f) => f.key === "amount") : -1;
    const statusCol = cols.length - 1;
    const rows = recs.map((r) => {
      const row = [r.empNo, r.userName];
      pick.forEach((f) => {
        const v = r.data[f.key === "site" ? "site" : f.key];
        row.push(f.type === "bool" ? (v ? "往復" : "片道") : v === undefined ? "" : v);
      });
      row.push({ v: STATUS[r.status], fill: STATUS_FILL[r.status] });
      return row;
    });
    return tableSheet({
      name: def.label.replace(/[()（）]/g, ""),
      title: def.label + "　" + mo.y + "年" + mo.m + "月",
      meta: [["出力日", TC.dk(TC.jstNow().y, TC.jstNow().m, TC.jstNow().d)], ["件数", recs.length + "件"]],
      columns: cols, rows,
      sumCol: def.money ? { col: amountCol, label: "合計（差し戻しを除く）", statusCol, yen: true } : null
    });
  }

  route("GET", "/api/records/export.xlsx", AUTH, async (c) => {
    const kind = c.url.searchParams.get("kind"); kindOf(kind);
    const mo = validMonth(c.url.searchParams.get("month"));
    const all = scopeAll(c);
    sendXlsx(c.res, [recordsSheet(kind, mo, listRecords(kind, mo, c.user, all))], KINDS[kind].label.replace(/[()（）]/g, "") + "_" + mo.key + (all ? "_全員" : "") + ".xlsx");
  });

  // ---------- 現場情報 ----------
  const siteRow = (s) => ({ id: s.id, name: s.name, client: s.client, address: s.address, contact: s.contact, note: s.note });
  function cleanSite(b) {
    return { name: str(b.name, "現場名", 60, true), client: str(b.client, "取引先", 60), address: str(b.address, "住所", 120),
      contact: str(b.contact, "連絡先", 80), note: str(b.note, "備考", 200) };
  }
  const listSites = () => db.prepare("SELECT * FROM sites WHERE active = 1 ORDER BY name").all().map(siteRow);

  route("GET", "/api/sites", AUTH, async (c) => sendJson(c.res, 200, { sites: listSites() }));

  route("POST", "/api/admin/sites", ADMIN, async (c) => {
    const s = cleanSite(c.body);
    const old = db.prepare("SELECT * FROM sites WHERE name = ?").get(s.name);
    if (old && old.active) throw new HttpError(409, "その現場名はすでに登録されています。");
    if (old) db.prepare("UPDATE sites SET client=?, address=?, contact=?, note=?, active=1 WHERE id=?").run(s.client, s.address, s.contact, s.note, old.id);
    else db.prepare("INSERT INTO sites (name, client, address, contact, note) VALUES (?, ?, ?, ?, ?)").run(s.name, s.client, s.address, s.contact, s.note);
    sendJson(c.res, 201, { ok: true });
  });

  route("PUT", "/api/admin/sites/(\\d+)", ADMIN, async (c) => {
    const id = idParam(c.params[0]), s = cleanSite(c.body);
    if (db.prepare("SELECT 1 FROM sites WHERE name = ? AND id != ?").get(s.name, id)) throw new HttpError(409, "その現場名はすでに登録されています。");
    const r = db.prepare("UPDATE sites SET name=?, client=?, address=?, contact=?, note=? WHERE id=? AND active=1").run(s.name, s.client, s.address, s.contact, s.note, id);
    if (!r.changes) throw new HttpError(404, "現場が見つかりません。");
    sendJson(c.res, 200, { ok: true });
  });

  // 過去の交通費の記録を残すため、削除は「非表示」にするだけ
  route("DELETE", "/api/admin/sites/(\\d+)", ADMIN, async (c) => {
    db.prepare("UPDATE sites SET active = 0 WHERE id = ?").run(idParam(c.params[0]));
    sendJson(c.res, 200, { ok: true });
  });

  route("GET", "/api/sites/export.xlsx", AUTH, async (c) => {
    const rows = listSites().map((s) => [s.name, s.client, s.address, s.contact, s.note]);
    sendXlsx(c.res, [tableSheet({
      name: "現場情報", title: "現場情報一覧", meta: [["件数", rows.length + "件"]],
      columns: [{ label: "現場名", width: 26, kind: "wrap" }, { label: "取引先", width: 22, kind: "wrap" }, { label: "住所", width: 40, kind: "wrap" },
        { label: "連絡先", width: 24, kind: "wrap" }, { label: "備考", width: 34, kind: "wrap" }],
      rows
    })], "現場情報.xlsx");
  });

  // ---------- キャリアデザインシート ----------
  function cleanCareer(b) {
    const out = {
      position: str(b.position, "現在の職種・役職", 60),
      joined: str(b.joined, "入社年月", 7),
      summary: str(b.summary, "職務内容", 600),
      certs: str(b.certs, "資格", 300),
      strengths: str(b.strengths, "強み", 300),
      goals: str(b.goals, "今後の希望", 400),
      skills: [], history: []
    };
    if (out.joined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(out.joined)) throw bad("入社年月の形式が正しくありません。");
    const sk = Array.isArray(b.skills) ? b.skills : [];
    if (sk.length > 15) throw bad("技能・スキルは15件までです。");
    sk.forEach((x) => {
      if (!x || typeof x !== "object") return;
      const name = str(x.name, "技能名", 40);
      if (!name) return;
      const level = Number(x.level), years = Number(x.years || 0);
      if (!Number.isInteger(level) || level < 1 || level > 5) throw bad("技能のレベルは1〜5で入力してください。");
      if (!(years >= 0 && years <= 60)) throw bad("経験年数は0〜60で入力してください。");
      out.skills.push({ name, level, years: Math.round(years * 10) / 10 });
    });
    const hs = Array.isArray(b.history) ? b.history : [];
    if (hs.length > 10) throw bad("職務経歴は10件までです。");
    hs.forEach((x) => {
      if (!x || typeof x !== "object") return;
      const h = { from: str(x.from, "開始", 7), to: str(x.to, "終了", 7), place: str(x.place, "会社・現場", 60), work: str(x.work, "業務内容", 200) };
      [h.from, h.to].forEach((m) => { if (m && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad("職務経歴の年月の形式が正しくありません。"); });
      if (h.from || h.to || h.place || h.work) out.history.push(h);
    });
    return out;
  }
  function careerOf(userId) {
    const r = db.prepare("SELECT data, updated_at FROM career WHERE user_id = ?").get(userId);
    return r ? Object.assign(JSON.parse(r.data), { updatedAt: r.updated_at }) : null;
  }
  function careerTarget(c) {
    const q = c.url.searchParams.get("user");
    if (!q || Number(q) === c.user.id) return c.user;
    if (c.user.role !== "admin") throw new HttpError(403, "管理者のみ利用できます。");
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(idParam(q));
    if (!u) throw new HttpError(404, "社員が見つかりません。");
    return u;
  }

  route("GET", "/api/career", AUTH, async (c) => {
    const u = careerTarget(c);
    sendJson(c.res, 200, { user: { id: u.id, name: u.name, empNo: u.emp_no || "", email: u.email }, career: careerOf(u.id) });
  });

  route("PUT", "/api/career", AUTH, async (c) => {
    const data = cleanCareer(c.body);
    db.prepare(`INSERT INTO career (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`).run(c.user.id, JSON.stringify(data));
    sendJson(c.res, 200, { ok: true });
  });

  const ym = (s) => (s ? s.slice(0, 4) + "年" + Number(s.slice(5)) + "月" : "");
  route("GET", "/api/career/export.xlsx", AUTH, async (c) => {
    const u = careerTarget(c), k = careerOf(u.id) || { skills: [], history: [] };
    const basic = tableSheet({
      name: "基本情報", title: "キャリアデザインシート", portrait: true,
      meta: [["氏名", u.name], ["社員番号", u.emp_no || ""], ["最終更新", k.updatedAt ? k.updatedAt.slice(0, 10) : "未登録"]],
      columns: [{ label: "項目", width: 22, kind: "center" }, { label: "内容", width: 70, kind: "wrap" }],
      rows: [["現在の職種・役職", k.position || ""], ["入社年月", ym(k.joined)], ["職務内容", k.summary || ""],
        ["保有資格", k.certs || ""], ["強み", k.strengths || ""], ["今後のキャリア希望", k.goals || ""]]
    });
    const hist = tableSheet({
      name: "職務経歴", title: "職務経歴　" + u.name,
      columns: [{ label: "開始", width: 13, kind: "center" }, { label: "終了", width: 13, kind: "center" },
        { label: "会社・現場", width: 28, kind: "wrap" }, { label: "業務内容", width: 60, kind: "wrap" }],
      rows: (k.history || []).map((h) => [ym(h.from), h.to ? ym(h.to) : "現在", h.place, h.work])
    });
    const skills = tableSheet({
      name: "技能・スキル", title: "技能・スキル　" + u.name, portrait: true,
      columns: [{ label: "技能・スキル", width: 30, kind: "wrap" }, { label: "レベル(1-5)", width: 12, kind: "center" },
        { label: "目安", width: 12, kind: "center" }, { label: "経験年数", width: 11, kind: "center" }],
      rows: (k.skills || []).map((s) => [s.name, s.level, SKILL_LEVELS[s.level], s.years])
    });
    sendXlsx(c.res, [basic, hist, skills], "キャリアデザインシート_" + (u.emp_no || u.name) + ".xlsx");
  });

  // ---------- 勤怠表のExcel出力 ----------
  function timecardSheet(user, mo) {
    const rows = ctx.userMonthRows(user, mo); // [メタ行, 見出し行, 日々..., 合計行]
    const days = rows.slice(2, rows.length - 1), total = rows[rows.length - 1];
    const sheet = tableSheet({
      name: mo.y + "年" + mo.m + "月", title: "勤怠表　" + mo.y + "年" + mo.m + "月",
      meta: [["氏名", user.name], ["社員番号", user.emp_no || ""], ["メール", user.email]],
      columns: [{ label: "日付", width: 13, kind: "center" }, { label: "曜", width: 6, kind: "center" }, { label: "区分", width: 14, kind: "center" },
        { label: "出勤", width: 9, kind: "center" }, { label: "退勤", width: 9, kind: "center" }, { label: "休憩", width: 9, kind: "center" },
        { label: "実働", width: 9, kind: "center" }, { label: "残業", width: 9, kind: "center" }, { label: "深夜", width: 9, kind: "center" },
        { label: "備考", width: 32, kind: "wrap" }],
      rows: days,
      rowFill: (r) => (r[1] === "日" || TC.HOL[r[0]] ? "FDE9E9" : r[1] === "土" ? "E3EEFA" : null),
      footer: total
    });
    return sheet;
  }

  route("GET", "/api/export.xlsx", AUTH, async (c) => {
    const mo = validMonth(c.url.searchParams.get("month"));
    sendXlsx(c.res, [timecardSheet(c.user, mo)], "勤怠_" + mo.key + ".xlsx");
  });

  route("GET", "/api/admin/export.xlsx", ADMIN, async (c) => {
    const mo = validMonth(c.url.searchParams.get("month"));
    const uid = c.url.searchParams.get("user");
    if (uid) {
      const u = ctx.targetUser(idParam(uid));
      return sendXlsx(c.res, [timecardSheet(u, mo)], "勤怠_" + (u.emp_no || u.id) + "_" + mo.key + ".xlsx");
    }
    const list = ctx.summaryRows(mo);
    sendXlsx(c.res, [tableSheet({
      name: "勤怠一覧", title: "勤怠一覧　" + mo.y + "年" + mo.m + "月",
      columns: [{ label: "社員番号", width: 11, kind: "center" }, { label: "氏名", width: 16 }, { label: "メール", width: 30 },
        { label: "出勤日数", width: 10, kind: "num" }, { label: "所定日数", width: 10, kind: "num" }, { label: "総実働", width: 10, kind: "center" },
        { label: "残業", width: 10, kind: "center" }, { label: "深夜", width: 10, kind: "center" }, { label: "有給", width: 8, kind: "num" }, { label: "欠勤", width: 8, kind: "num" }],
      rows: list.map((r) => [r.empNo || "", r.name, r.email, r.days, r.sched, TC.fmt(r.work), TC.fmt(r.ot), TC.fmt(r.night), r.paid, r.absent])
    })], "勤怠一覧_" + mo.key + ".xlsx");
  });
};
