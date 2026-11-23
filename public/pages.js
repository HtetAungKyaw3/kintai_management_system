/*
 * 追加機能の画面: 振替管理 / 交通費 / 立替申請 / 現場情報 / キャリアデザインシート
 * メニュー（menu.js）から Pages.show(名前) で開く。保存時にExcelも自動で保存する（メニューのチェックで切り替え）。
 */
(function () {
  "use strict";
  var TC = window.TC;
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function yen(n) { return "¥" + Number(n).toLocaleString("ja-JP"); }
  function p2(n) { return TC.p2(n); }

  var root = $("feature-view");
  var st = { page: null, y: 0, m: 0, all: false, recs: [], sites: [], edit: null, me: null, cfg: null,
    careerUser: null, career: null, users: [], siteEdit: null };

  // ---------- Excel（保存時の自動保存） ----------
  var AUTO_KEY = "tc-auto-xlsx";
  function autoOn() { try { return localStorage.getItem(AUTO_KEY) !== "0"; } catch (e) { return true; } }
  function download(url) {
    var a = document.createElement("a");
    a.href = url; a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
  }
  window.TCExcel = { auto: function (url) { if (autoOn()) download(url); }, download: download };
  var autoBox = $("auto-xlsx");
  if (autoBox) {
    autoBox.checked = autoOn();
    autoBox.addEventListener("change", function () { try { localStorage.setItem(AUTO_KEY, autoBox.checked ? "1" : "0"); } catch (e) { /* 保存できない環境 */ } });
  }

  // ---------- 通信・メッセージ ----------
  function api(method, url, body) {
    var opt = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.error) || "通信に失敗しました。");
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }
  var timer = null;
  function say(msg, keep) {
    var el = $("notice");
    el.textContent = msg; el.hidden = !msg;
    clearTimeout(timer);
    if (msg && !keep) timer = setTimeout(function () { el.hidden = true; el.textContent = ""; }, 4000);
    if (msg) window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function fail(e) {
    if (e && e.status === 401) { window.location.reload(); return; }
    say((e && e.message) || "エラーが発生しました。", true);
  }

  function todayKey() { var n = TC.jstNow(); return TC.dk(n.y, n.m, n.d); }
  function monthKey() { return st.y + "-" + p2(st.m); }
  function shortDate(s) {
    if (!s) return "";
    var y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
    return p2(m) + "/" + p2(d) + "(" + TC.DOW[TC.dowOf(y, m, d)] + ")";
  }
  function isAdmin() { return st.me && st.me.role === "admin"; }

  // ---------- 開く・閉じる ----------
  var TITLES = { transfer: "振替管理", transport_site: "交通費(現場請求用)", transport_internal: "交通費(社内向け)",
    expense: "立替申請", sites: "現場情報", career: "キャリアデザインシート(経歴更新)" };

  function hide() {
    root.hidden = true;
    if ($("login-view").hidden && $("force-view").hidden) $("app-view").hidden = false;
  }
  // ログアウトやセッション切れで、ログイン画面が出たら追加機能の画面も閉じる
  if (window.MutationObserver) {
    var mo = new MutationObserver(function () {
      if (!$("login-view").hidden || !$("force-view").hidden) root.hidden = true;
    });
    mo.observe($("login-view"), { attributes: true, attributeFilter: ["hidden"] });
    mo.observe($("force-view"), { attributes: true, attributeFilter: ["hidden"] });
  }

  function show(page) {
    if (!TITLES[page]) { hide(); return; }
    var n = TC.jstNow();
    if (st.page !== page) { st.y = n.y; st.m = n.m; st.all = false; st.edit = null; st.siteEdit = null; }
    st.page = page;
    $("app-view").hidden = true;
    root.hidden = false;
    root.innerHTML = '<p class="hint">読み込み中…</p>';
    api("GET", "/api/me").then(function (me) {
      if (st.meId !== me.id) { st.meId = me.id; st.careerUser = null; st.users = []; st.page === "career" && (st.career = null); }
      st.me = me;
      return st.cfg ? null : api("GET", "/api/features").then(function (c) { st.cfg = c; });
    }).then(load).then(render).catch(fail);
    window.scrollTo({ top: 0 });
  }
  window.Pages = { show: show, hide: hide };

  function load() {
    if (st.page === "sites") return api("GET", "/api/sites").then(function (d) { st.sites = d.sites; });
    if (st.page === "career") return loadCareer(st.careerUser);
    var def = st.cfg.kinds[st.page], jobs = [];
    var q = "kind=" + st.page + "&month=" + monthKey() + (st.all && isAdmin() ? "&scope=all" : "");
    jobs.push(api("GET", "/api/records?" + q).then(function (d) { st.recs = d.records; }));
    if (def.fields.some(function (f) { return f.type === "site"; })) jobs.push(api("GET", "/api/sites").then(function (d) { st.sites = d.sites; }));
    return Promise.all(jobs);
  }
  function reload() { return load().then(render).catch(fail); }

  // ---------- 描画: 共通部品 ----------
  function head(title, tools) {
    return '<div class="feat-bar"><h2>' + esc(title) + "</h2>" + (tools || "") + "</div>";
  }
  function monthNav() {
    return '<div class="month-nav"><button class="iconbtn" data-act="prev" type="button" aria-label="前の月">‹</button>' +
      "<h2>" + st.y + "年" + st.m + '月</h2><button class="iconbtn" data-act="next" type="button" aria-label="次の月">›</button></div>';
  }
  function autoNote() {
    return '<p class="hint">' + (autoOn() ? "保存すると、Excelファイルも自動で保存されます。" : "Excelの自動保存はオフです。") + "（メニューで切り替えできます）</p>";
  }

  // ---------- 申請系の画面 ----------
  function fieldInput(f, val) {
    var id = "ff-" + f.key, v = val === undefined || val === null ? "" : val, label = '<label for="' + id + '">' + esc(f.label) + (f.required ? " *" : "") + "</label>";
    if (f.type === "date") return '<div class="field">' + label + '<input id="' + id + '" type="date" value="' + esc(v) + '"></div>';
    if (f.type === "number") return '<div class="field">' + label + '<input id="' + id + '" type="number" inputmode="numeric" min="0" max="1000000" step="1" value="' + esc(v) + '"></div>';
    if (f.type === "text") return '<div class="field' + ((f.max || 0) > 60 ? " wide" : "") + '">' + label + '<input id="' + id + '" type="text" maxlength="' + (f.max || 100) + '" value="' + esc(v) + '"></div>';
    if (f.type === "select") {
      return '<div class="field">' + label + '<select id="' + id + '"><option value="">選択してください</option>' +
        f.options.map(function (o) { return '<option value="' + esc(o) + '"' + (o === v ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") + "</select></div>";
    }
    if (f.type === "bool") return '<div class="field check"><label class="chk"><input id="' + id + '" type="checkbox"' + (val ? " checked" : "") + "> " + esc(f.label) + "</label></div>";
    if (f.type === "site") {
      if (!st.sites.length) return '<div class="field wide">' + label + '<p class="hint">現場がまだ登録されていません。管理者が「現場情報」から登録します。</p></div>';
      return '<div class="field">' + label + '<select id="' + id + '"><option value="">選択してください</option>' +
        st.sites.map(function (s) { return '<option value="' + s.id + '"' + (String(s.id) === String(val) ? " selected" : "") + ">" + esc(s.name) + "</option>"; }).join("") + "</select></div>";
    }
    return "";
  }

  function cellText(f, d) {
    var v = d[f.key];
    if (f.type === "date") return esc(shortDate(v));
    if (f.type === "number") return '<span class="num">' + yen(v) + "</span>";
    if (f.type === "bool") return v ? "往復" : "片道";
    return esc(v);
  }

  function renderRecords() {
    var def = st.cfg.kinds[st.page], statusMap = st.cfg.status, e = st.edit;
    var ed = e ? st.recs.filter(function (r) { return r.id === e; })[0] : null;
    var dflt = todayKey();
    var form = def.fields.map(function (f) {
      var val = ed ? ed.data[f.key === "site" ? "siteId" : f.key] : (f.type === "date" && (f.key === "date" || f.key === "workDate") ? dflt : "");
      if (f.type === "bool" && ed) val = ed.data[f.key];
      return fieldInput(f, val);
    }).join("");

    var total = 0;
    st.recs.forEach(function (r) { if (def.money && r.status !== "rejected") total += r.data.amount || 0; });
    var showUser = st.all;
    var ths = (showUser ? "<th>氏名</th>" : "") + def.fields.map(function (f) { return "<th>" + esc(f.label.replace("（円）", "")) + "</th>"; }).join("") + "<th>状態</th><th></th>";
    var rows = st.recs.map(function (r) {
      var mine = r.userId === st.me.id, btns = "";
      if (mine && r.status === "pending") btns += '<button class="btn small" data-act="edit" data-id="' + r.id + '" type="button">修正</button> ';
      if (isAdmin()) {
        if (r.status !== "approved") btns += '<button class="btn small in" data-act="approve" data-id="' + r.id + '" type="button">承認</button> ';
        if (r.status !== "rejected") btns += '<button class="btn small" data-act="reject" data-id="' + r.id + '" type="button">差し戻し</button> ';
      }
      if ((mine && r.status === "pending") || isAdmin()) btns += '<button class="btn small danger" data-act="del" data-id="' + r.id + '" type="button">削除</button>';
      return "<tr>" + (showUser ? "<td>" + esc(r.userName) + "</td>" : "") +
        def.fields.map(function (f) { return "<td>" + cellText(f, r.data) + "</td>"; }).join("") +
        '<td><span class="stat" data-s="' + r.status + '">' + esc(statusMap[r.status]) + '</span></td><td class="ops">' + btns + "</td></tr>";
    }).join("");
    var cols = def.fields.length + 2 + (showUser ? 1 : 0);

    root.innerHTML =
      head(def.label, monthNav() + '<div class="tools">' +
        (isAdmin() ? '<label class="chk"><input type="checkbox" data-act="scope"' + (st.all ? " checked" : "") + "> 全員を表示</label>" : "") +
        '<button class="btn small in" data-act="xlsx" type="button">Excelを保存</button></div>') +
      '<section class="panel feat-form"><h3>' + (ed ? "申請を修正" : "新規登録") + '</h3><div class="fields">' + form + "</div>" +
      '<div class="actions"><button class="btn in" data-act="save" type="button">' + (ed ? "修正を保存" : "保存") + "</button>" +
      (ed ? ' <button class="btn" data-act="cancel" type="button">キャンセル</button>' : "") + "</div>" + autoNote() + "</section>" +
      (def.money ? '<p class="feat-total">合計（差し戻しを除く）<strong>' + yen(total) + "</strong></p>" : "") +
      '<div class="tablewrap"><table class="feat-table"><thead><tr>' + ths + "</tr></thead><tbody>" +
      (rows || '<tr><td colspan="' + cols + '" class="empty">この月の記録はありません。</td></tr>') + "</tbody></table></div>" +
      '<p class="hint flush">申請は「承認待ち」で登録され、管理者が承認または差し戻します。承認待ちの間は修正・削除できます。</p>';
  }

  function collectRecord(def) {
    var body = { kind: st.page };
    def.fields.forEach(function (f) {
      var el = $("ff-" + f.key);
      if (f.type === "site") { body.siteId = el ? Number(el.value) : 0; return; }
      if (!el) return;
      if (f.type === "bool") body[f.key] = el.checked;
      else if (f.type === "number") body[f.key] = el.value === "" ? "" : Number(el.value);
      else body[f.key] = el.value.trim ? el.value.trim() : el.value;
    });
    return body;
  }

  function saveRecord() {
    var def = st.cfg.kinds[st.page], body = collectRecord(def);
    var req = st.edit ? api("PUT", "/api/records/" + st.edit, body) : api("POST", "/api/records", body);
    var dk = body[def.fields[0].key];
    req.then(function () {
      st.edit = null;
      if (dk) { st.y = Number(dk.slice(0, 4)); st.m = Number(dk.slice(5, 7)); }
      say("保存しました。");
      window.TCExcel.auto(xlsxUrl());
      return reload();
    }).catch(fail);
  }
  function xlsxUrl() {
    return "/api/records/export.xlsx?kind=" + st.page + "&month=" + monthKey() + (st.all && isAdmin() ? "&scope=all" : "");
  }

  // ---------- 現場情報 ----------
  function renderSites() {
    var e = st.siteEdit && st.sites.filter(function (s) { return s.id === st.siteEdit; })[0] || { name: "", client: "", address: "", contact: "", note: "" };
    function inp(id, label, key, max, wide) {
      return '<div class="field' + (wide ? " wide" : "") + '"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="text" maxlength="' + max + '" value="' + esc(e[key]) + '"></div>';
    }
    var form = isAdmin()
      ? '<section class="panel feat-form"><h3>' + (st.siteEdit ? "現場を修正" : "現場を追加") + '</h3><div class="fields">' +
        inp("si-name", "現場名 *", "name", 60) + inp("si-client", "取引先", "client", 60) + inp("si-address", "住所", "address", 120, true) +
        inp("si-contact", "連絡先", "contact", 80) + inp("si-note", "備考", "note", 200, true) + "</div>" +
        '<div class="actions"><button class="btn in" data-act="site-save" type="button">' + (st.siteEdit ? "修正を保存" : "追加して保存") + "</button>" +
        (st.siteEdit ? ' <button class="btn" data-act="site-cancel" type="button">キャンセル</button>' : "") + "</div>" + autoNote() + "</section>"
      : '<p class="hint">現場の追加・変更は管理者が行います。</p>';
    var rows = st.sites.map(function (s) {
      return '<tr data-q="' + esc((s.name + s.client + s.address + s.contact + s.note).toLowerCase()) + '"><td>' + esc(s.name) + "</td><td>" + esc(s.client) + "</td><td>" + esc(s.address) + "</td><td>" + esc(s.contact) + "</td><td>" + esc(s.note) + "</td>" +
        (isAdmin() ? '<td class="ops"><button class="btn small" data-act="site-edit" data-id="' + s.id + '" type="button">修正</button> <button class="btn small danger" data-act="site-del" data-id="' + s.id + '" type="button">削除</button></td>' : "") + "</tr>";
    }).join("");
    root.innerHTML = head("現場情報", '<div class="tools"><button class="btn small in" data-act="xlsx" type="button">Excelを保存</button></div>') + form +
      '<div class="field search"><label for="si-q">検索</label><input id="si-q" type="search" placeholder="現場名・取引先・住所など"></div>' +
      '<div class="tablewrap"><table class="feat-table"><thead><tr><th>現場名</th><th>取引先</th><th>住所</th><th>連絡先</th><th>備考</th>' + (isAdmin() ? "<th></th>" : "") +
      "</tr></thead><tbody>" + (rows || '<tr><td colspan="6" class="empty">現場はまだ登録されていません。</td></tr>') + "</tbody></table></div>";
  }
  function saveSite() {
    var body = { name: $("si-name").value, client: $("si-client").value, address: $("si-address").value, contact: $("si-contact").value, note: $("si-note").value };
    var req = st.siteEdit ? api("PUT", "/api/admin/sites/" + st.siteEdit, body) : api("POST", "/api/admin/sites", body);
    req.then(function () {
      st.siteEdit = null; say("保存しました。");
      window.TCExcel.auto("/api/sites/export.xlsx");
      return reload();
    }).catch(fail);
  }

  // ---------- キャリアデザインシート ----------
  function loadCareer(uid) {
    var jobs = [api("GET", "/api/career" + (uid && uid !== st.me.id ? "?user=" + uid : "")).then(function (d) {
      st.careerUser = d.user.id; st.career = d.career || { skills: [], history: [] }; st.careerWho = d.user;
    })];
    if (isAdmin() && !st.users.length) {
      var n = TC.jstNow();
      jobs.push(api("GET", "/api/admin/summary?month=" + n.y + "-" + p2(n.m)).then(function (d) { st.users = d.rows; }));
    }
    return Promise.all(jobs);
  }
  function skillRow(s) {
    s = s || { name: "", level: 3, years: "" };
    var lv = st.cfg.skillLevels;
    return '<div class="row-item sk-row"><div class="field"><label>技能・スキル</label><input class="sk-name" type="text" maxlength="40" value="' + esc(s.name) + '"></div>' +
      '<div class="field"><label>レベル</label><select class="sk-level">' + [1, 2, 3, 4, 5].map(function (i) { return '<option value="' + i + '"' + (i === Number(s.level) ? " selected" : "") + ">" + i + "：" + esc(lv[i]) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label>経験年数</label><input class="sk-years" type="number" min="0" max="60" step="0.5" value="' + esc(s.years) + '"></div>' +
      '<button class="btn small danger rm" data-act="rm-row" type="button" aria-label="この行を削除">×</button></div>';
  }
  function histRow(h) {
    h = h || { from: "", to: "", place: "", work: "" };
    return '<div class="row-item hs-row"><div class="field"><label>開始</label><input class="hs-from" type="month" value="' + esc(h.from) + '"></div>' +
      '<div class="field"><label>終了（空欄＝現在）</label><input class="hs-to" type="month" value="' + esc(h.to) + '"></div>' +
      '<div class="field wide"><label>会社・現場</label><input class="hs-place" type="text" maxlength="60" value="' + esc(h.place) + '"></div>' +
      '<div class="field wide"><label>業務内容</label><input class="hs-work" type="text" maxlength="200" value="' + esc(h.work) + '"></div>' +
      '<button class="btn small danger rm" data-act="rm-row" type="button" aria-label="この行を削除">×</button></div>';
  }
  function renderCareer() {
    var c = st.career, mine = st.careerUser === st.me.id, ro = mine ? "" : " disabled";
    function area(id, label, key, max) {
      return '<div class="field wide"><label for="' + id + '">' + label + '（' + max + "文字まで）</label><textarea id=\"" + id + '" rows="3" maxlength="' + max + '"' + ro + ">" + esc(c[key] || "") + "</textarea></div>";
    }
    var picker = isAdmin() ? '<div class="field wide"><label for="cr-user">表示する社員</label><select id="cr-user">' +
      st.users.map(function (u) { return '<option value="' + u.id + '"' + (u.id === st.careerUser ? " selected" : "") + ">" + esc((u.empNo ? u.empNo + " " : "") + u.name) + "</option>"; }).join("") + "</select></div>" : "";
    root.innerHTML = head("キャリアデザインシート(経歴更新)", '<div class="tools"><button class="btn small in" data-act="xlsx" type="button">Excelを保存</button></div>') +
      '<section class="panel feat-form"><h3>' + esc(st.careerWho.name) + (mine ? "" : "（閲覧のみ）") + "</h3>" +
      '<div class="fields">' + picker +
      '<div class="field"><label for="cr-position">現在の職種・役職</label><input id="cr-position" type="text" maxlength="60" value="' + esc(c.position || "") + '"' + ro + "></div>" +
      '<div class="field"><label for="cr-joined">入社年月</label><input id="cr-joined" type="month" value="' + esc(c.joined || "") + '"' + ro + "></div>" +
      area("cr-summary", "職務内容", "summary", 600) + area("cr-certs", "保有資格", "certs", 300) + area("cr-strengths", "強み", "strengths", 300) + area("cr-goals", "今後のキャリア希望", "goals", 400) + "</div>" +
      '<h3 class="sub">技能・スキル</h3><div id="cr-skills">' + (c.skills || []).map(skillRow).join("") + "</div>" +
      (mine ? '<button class="btn small" data-act="add-skill" type="button">＋ 技能を追加</button>' : "") +
      '<h3 class="sub">職務経歴</h3><div id="cr-hist">' + (c.history || []).map(histRow).join("") + "</div>" +
      (mine ? '<button class="btn small" data-act="add-hist" type="button">＋ 経歴を追加</button>' : "") +
      (mine ? '<div class="actions"><button class="btn in" data-act="career-save" type="button">保存</button></div>' + autoNote() : "") +
      (c.updatedAt ? '<p class="hint">最終更新: ' + esc(c.updatedAt.slice(0, 16)) + "</p>" : "") + "</section>";
    if (!mine) Array.prototype.forEach.call(root.querySelectorAll(".row-item input, .row-item select, .rm"), function (el) { el.disabled = true; });
  }
  function collectCareer() {
    function v(id) { return $(id).value.trim(); }
    var skills = [], history = [];
    Array.prototype.forEach.call(root.querySelectorAll(".sk-row"), function (r) {
      var name = r.querySelector(".sk-name").value.trim();
      if (name) skills.push({ name: name, level: Number(r.querySelector(".sk-level").value), years: Number(r.querySelector(".sk-years").value || 0) });
    });
    Array.prototype.forEach.call(root.querySelectorAll(".hs-row"), function (r) {
      history.push({ from: r.querySelector(".hs-from").value, to: r.querySelector(".hs-to").value, place: r.querySelector(".hs-place").value.trim(), work: r.querySelector(".hs-work").value.trim() });
    });
    return { position: v("cr-position"), joined: $("cr-joined").value, summary: v("cr-summary"), certs: v("cr-certs"), strengths: v("cr-strengths"), goals: v("cr-goals"), skills: skills, history: history };
  }

  function render() {
    if (st.page === "sites") renderSites();
    else if (st.page === "career") renderCareer();
    else renderRecords();
  }

  // ---------- 操作 ----------
  root.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-act]");
    if (!t || t.tagName === "INPUT" && t.type === "checkbox" && t.getAttribute("data-act") !== "scope") return;
    var act = t.getAttribute("data-act"), id = Number(t.getAttribute("data-id"));
    if (act === "scope") return; // changeで処理
    if (act === "prev" || act === "next") {
      st.m += act === "next" ? 1 : -1;
      if (st.m < 1) { st.m = 12; st.y--; } else if (st.m > 12) { st.m = 1; st.y++; }
      st.edit = null; reload();
    } else if (act === "save") saveRecord();
    else if (act === "cancel") { st.edit = null; render(); }
    else if (act === "edit") { st.edit = id; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else if (act === "del") {
      if (window.confirm("この申請を削除しますか？")) api("DELETE", "/api/records/" + id).then(function () { st.edit = null; say("削除しました。"); return reload(); }).catch(fail);
    } else if (act === "approve" || act === "reject") {
      api("PUT", "/api/admin/records/" + id + "/status", { status: act === "approve" ? "approved" : "rejected" }).then(reload).catch(fail);
    } else if (act === "xlsx") {
      if (st.page === "sites") download("/api/sites/export.xlsx");
      else if (st.page === "career") download("/api/career/export.xlsx" + (st.careerUser !== st.me.id ? "?user=" + st.careerUser : ""));
      else download(xlsxUrl());
    } else if (act === "site-save") saveSite();
    else if (act === "site-cancel") { st.siteEdit = null; render(); }
    else if (act === "site-edit") { st.siteEdit = id; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else if (act === "site-del") {
      if (window.confirm("この現場を一覧から削除しますか？（過去の交通費の記録は残ります）")) api("DELETE", "/api/admin/sites/" + id).then(function () { say("削除しました。"); return reload(); }).catch(fail);
    } else if (act === "add-skill") $("cr-skills").insertAdjacentHTML("beforeend", skillRow());
    else if (act === "add-hist") $("cr-hist").insertAdjacentHTML("beforeend", histRow());
    else if (act === "rm-row") t.closest(".row-item").remove();
    else if (act === "career-save") {
      api("PUT", "/api/career", collectCareer()).then(function () {
        say("保存しました。");
        window.TCExcel.auto("/api/career/export.xlsx");
        return reload();
      }).catch(fail);
    }
  });

  root.addEventListener("change", function (ev) {
    var t = ev.target;
    if (t.getAttribute("data-act") === "scope") { st.all = t.checked; st.edit = null; reload(); }
    else if (t.id === "cr-user") { st.careerUser = Number(t.value); reload(); }
  });
  root.addEventListener("input", function (ev) {
    if (ev.target.id !== "si-q") return;
    var q = ev.target.value.trim().toLowerCase();
    Array.prototype.forEach.call(root.querySelectorAll("tbody tr[data-q]"), function (tr) {
      tr.hidden = q !== "" && tr.getAttribute("data-q").indexOf(q) < 0;
    });
  });
})();
