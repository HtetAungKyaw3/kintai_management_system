(function () {
  "use strict";

  var TC = window.TC;
  var DOW = TC.DOW, TYPES = TC.TYPES, HOL = TC.HOL;
  var p2 = TC.p2, dk = TC.dk, dowOf = TC.dowOf, daysIn = TC.daysIn, fmt = TC.fmt, toMin = TC.toMin;

  var S = {
    me: null,
    days: {},          // 読み込み済みの自分の記録 { "YYYY-MM-DD": 記録 }
    view: null,        // 表示中の月 { y, m }
    editing: null,
    delArmed: false,
    todayKey: null
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clone(o) { return o ? JSON.parse(JSON.stringify(o)) : o; }
  function monthKey(v) { return v.y + "-" + p2(v.m); }

  // ---- API ----
  function api(method, url, body) {
    var opt = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.error) || "通信に失敗しました。");
          err.status = r.status;
          err.code = data && data.code;
          throw err;
        }
        return data;
      });
    });
  }
  function fail(e) {
    if (e && e.code === "must_change_password" && S.me) { showForce(); return; }
    if (e && e.status === 401 && S.me) {
      S.me = null;
      showLogin("ログインの有効期限が切れました。もう一度ログインしてください。");
      return;
    }
    notice((e && e.message) || "エラーが発生しました。");
  }

  function notice(msg) {
    var el = $("notice");
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  // ---- 画面の切り替え ----
  function showLogin(msg) {
    teardownAdmin();
    $("login-view").hidden = false;
    $("force-view").hidden = true;
    $("app-view").hidden = true;
    $("acct").hidden = true;
    notice(msg || "");
    $("l-pw").value = "";
    $("l-emp").focus();
  }
  function showForce() {
    $("login-view").hidden = true;
    $("app-view").hidden = true;
    $("force-view").hidden = false;
    $("acct").hidden = false;
    renderWho();
    notice("");
    $("f-cur").value = ""; $("f-new").value = ""; $("f-new2").value = "";
    $("f-cur").focus();
  }
  function showApp() {
    if (S.me.mustChangePw) { showForce(); return; }
    $("login-view").hidden = true;
    $("force-view").hidden = true;
    $("app-view").hidden = false;
    $("acct").hidden = false;
    notice("");
    var n = TC.jstNow();
    S.view = { y: n.y, m: n.m };
    S.days = {};
    S.editing = null;
    fillSettings();
    renderAll();
    loadMonth(S.view).then(renderAll);
    mountAdmin();
  }

  function loadMonth(v) {
    var key = monthKey(v);
    return api("GET", "/api/days?month=" + key).then(function (data) {
      Object.keys(S.days).forEach(function (k) { if (k.indexOf(key) === 0) delete S.days[k]; });
      Object.keys(data.days).forEach(function (k) { S.days[k] = data.days[k]; });
    }).catch(fail);
  }

  // ---- 打刻 ----
  function todayRec() {
    var n = TC.jstNow();
    return S.days[dk(n.y, n.m, n.d)] || null;
  }
  function punch(act) {
    notice("");
    api("POST", "/api/punch", { act: act }).then(function (res) {
      S.days[res.date] = res.record;
      renderAll();
    }).catch(function (e) {
      fail(e);
      if (e.status === 409) { var n = TC.jstNow(); loadMonth({ y: n.y, m: n.m }).then(renderAll); }
    });
  }

  function renderPunch() {
    var r = todayRec();
    var st = TC.statusOf(r);
    var labels = { idle: "未出勤", working: "勤務中", break: "休憩中", done: "退勤済み" };
    var pill = $("status");
    pill.textContent = labels[st];
    pill.setAttribute("data-s", st);

    $("btns").innerHTML =
      '<button class="btn in" data-act="in" type="button"' + (st === "idle" ? "" : " disabled") + ">出勤</button>" +
      '<button class="btn out" data-act="out" type="button"' + (st === "working" ? "" : " disabled") + ">退勤</button>" +
      '<button class="btn" data-act="bs" type="button"' + (st === "working" ? "" : " disabled") + ">休憩開始</button>" +
      '<button class="btn" data-act="be" type="button"' + (st === "break" ? "" : " disabled") + ">休憩終了</button>";

    var stamp = '<div class="stamp empty">未打刻</div>';
    var brText = "—";
    if (r && r.in) {
      var n = TC.jstNow();
      var ev, tm;
      var bs = r.breaks || [];
      var last = bs.length ? bs[bs.length - 1] : null;
      if (st === "done") { ev = "退勤"; tm = r.out; }
      else if (st === "break") { ev = "休憩入"; tm = last.s; }
      else if (last && last.e) { ev = "休憩明"; tm = last.e; }
      else { ev = "出勤"; tm = r.in; }
      stamp = '<div class="stamp"><span class="s1">' + n.m + "." + n.d + '</span><span class="s2">' + esc(tm) + '</span><span class="s3">' + ev + "</span></div>";
      if (bs.length) {
        brText = bs.map(function (b) { return esc(b.s) + "–" + (b.e ? esc(b.e) : "…"); }).join(" / ");
      }
    }
    $("today-log").innerHTML = stamp +
      '<dl class="log"><dt>出勤</dt><dd>' + (r && r.in ? esc(r.in) : "—") + "</dd>" +
      "<dt>休憩</dt><dd>" + brText + "</dd>" +
      "<dt>退勤</dt><dd>" + (r && r.out ? esc(r.out) : "—") + "</dd></dl>";
  }

  // ---- 月次表 ----
  function totalsHtml(t) {
    function tot(label, val, unit) {
      return '<div class="total"><div class="label">' + label + '</div><div class="v">' + val + "<small>" + unit + "</small></div></div>";
    }
    return tot("出勤日数", t.days + " / " + t.sched, "日") +
      tot("総実働", fmt(t.work), "時間") +
      tot("残業", fmt(t.ot), "時間") +
      tot("深夜", fmt(t.night), "時間") +
      tot("有給・欠勤", t.paid + " / " + t.absent, "日");
  }

  // 1か月分の行（自分用・管理者の詳細表で共通）
  function rowsHtml(v, days, st, opts) {
    opts = opts || {};
    var N = daysIn(v.y, v.m);
    var now = TC.jstNow(), todayKey = dk(now.y, now.m, now.d);
    var startM = toMin(st.start), endM = toMin(st.end);
    var html = "";
    for (var d = 1; d <= N; d++) {
      var key = dk(v.y, v.m, d);
      var w = dowOf(v.y, v.m, d);
      var hol = HOL[key];
      var off = w === 0 || w === 6 || !!hol;
      var r = days[key];
      var cls = [];
      if (hol || w === 0) cls.push("sun"); else if (w === 6) cls.push("sat");
      if (key === todayKey) cls.push("today");
      if (opts.selectable && key === S.editing) cls.push("sel");

      var kind = "", inT = "", outT = "", brkT = "", workT = "", otT = "", nightT = "", note = "", tags = "";
      if (!r) {
        if (hol) kind = '<span class="dim">' + esc(hol) + "</span>";
        else if (off) kind = '<span class="dim">休み</span>';
      } else {
        kind = TYPES[r.type] || "出勤";
        if (r.type === "work" && off) kind = "休日出勤";
        if (hol && r.type !== "work") kind += ' <span class="dim">' + esc(hol) + "</span>";
        if (r.type === "work") {
          inT = esc(r.in || "");
          if (r.out) outT = esc(r.out);
          else if (r.in && key === todayKey) outT = '<span class="dim">勤務中</span>';
          var c = TC.calc(r, st);
          if (c.ok) {
            brkT = c.brk ? fmt(c.brk) : "";
            workT = fmt(c.work);
            otT = c.ot ? fmt(c.ot) : "";
            nightT = c.night ? fmt(c.night) : "";
            if (!off) {
              if (startM != null && c.inM > startM) tags += '<span class="tag">遅刻</span>';
              if (endM != null && !c.overnight && c.outM < endM) tags += '<span class="tag">早退</span>';
            }
          } else if (r.in && !r.out && key < todayKey) {
            tags += '<span class="tag">退勤の打刻なし</span>';
          }
        }
        note = esc(r.note || "");
      }
      html += '<tr class="' + cls.join(" ") + '"' + (opts.selectable ? ' data-key="' + key + '" tabindex="0"' : "") + ">" +
        '<td class="d num">' + d + "</td>" +
        '<td class="w">' + DOW[w] + "</td>" +
        "<td>" + kind + "</td>" +
        '<td class="num">' + inT + "</td>" +
        '<td class="num">' + outT + "</td>" +
        '<td class="num">' + brkT + "</td>" +
        '<td class="num">' + workT + "</td>" +
        '<td class="num">' + otT + "</td>" +
        '<td class="num">' + nightT + "</td>" +
        '<td class="note">' + note + tags + "</td></tr>";
    }
    return html;
  }

  function renderMonth() {
    var v = S.view;
    $("month-title").textContent = v.y + "年" + v.m + "月";
    $("totals").innerHTML = totalsHtml(TC.monthStats(S.days, v.y, v.m, S.me.settings));
    $("rows").innerHTML = rowsHtml(v, S.days, S.me.settings, { selectable: true });
  }

  function renderWho() {
    $("who").textContent = S.me.name + "　" + S.me.email + (S.me.role === "admin" ? "（管理者）" : "");
  }
  function renderAll() {
    if (!S.me) return;
    renderWho();
    renderPunch();
    renderMonth();
  }

  // ---- 編集パネル ----
  function renderEditor() {
    var el = $("editor");
    var key = S.editing;
    if (!key) { el.hidden = true; el.innerHTML = ""; return; }
    var r = S.days[key] || { type: "work", breaks: [], note: "" };
    var parts = key.split("-").map(Number);
    var title = parts[0] + "年" + parts[1] + "月" + parts[2] + "日（" + DOW[dowOf(parts[0], parts[1], parts[2])] + "）";
    var opts = Object.keys(TYPES).map(function (k) {
      return '<option value="' + k + '"' + (r.type === k ? " selected" : "") + ">" + TYPES[k] + "</option>";
    }).join("");
    var brkVal = (r.breakMin === null || r.breakMin === undefined) ? "" : r.breakMin;
    el.innerHTML =
      "<h3>" + title + "の勤怠</h3>" +
      '<div class="fields">' +
      '<div class="field"><label for="ed-type">区分</label><select id="ed-type">' + opts + "</select></div>" +
      '<div class="field"><label for="ed-in">出勤</label><input id="ed-in" type="time" value="' + esc(r.in || "") + '"></div>' +
      '<div class="field"><label for="ed-out">退勤</label><input id="ed-out" type="time" value="' + esc(r.out || "") + '"></div>' +
      '<div class="field"><label for="ed-brk">休憩（分）</label><input id="ed-brk" type="number" min="0" max="480" step="5" value="' + esc(brkVal) + '" placeholder="自動"></div>' +
      '<div class="field wide"><label for="ed-note">備考</label><input id="ed-note" type="text" maxlength="100" value="' + esc(r.note || "") + '" placeholder="例 客先訪問のため直行"></div>' +
      "</div>" +
      '<p class="hint">休憩を空欄にすると、打刻した休憩、なければ所定休憩から自動で計算します。</p>' +
      '<div class="actions">' +
      '<button class="btn small in" id="ed-save" type="button">保存</button>' +
      '<button class="btn small" id="ed-close" type="button">閉じる</button>' +
      (S.days[key] ? '<button class="btn small' + (S.delArmed ? " danger-armed" : "") + '" id="ed-del" type="button">' + (S.delArmed ? "もう一度押すと消去" : "記録を消去") + "</button>" : "") +
      "</div>";
    el.hidden = false;
  }
  function openEditor(key) {
    S.editing = key;
    S.delArmed = false;
    renderMonth();
    renderEditor();
    $("editor").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function closeEditor() {
    S.editing = null;
    S.delArmed = false;
    renderMonth();
    renderEditor();
  }
  function saveEditor() {
    var key = S.editing;
    if (!key) return;
    var prev = S.days[key] || { breaks: [] };
    var body = {
      type: $("ed-type").value,
      in: $("ed-in").value || null,
      out: $("ed-out").value || null,
      breaks: prev.breaks || [],
      breakMin: $("ed-brk").value === "" ? null : Number($("ed-brk").value),
      note: $("ed-note").value.trim()
    };
    notice("");
    api("PUT", "/api/days/" + key, body).then(function (rec) {
      S.days[key] = rec;
      closeEditor();
      renderAll();
      refreshAdmin();
      if (window.TCExcel) window.TCExcel.auto("/api/export.xlsx?month=" + key.slice(0, 7)); // 保存時にExcelも自動で保存
    }).catch(fail);
  }
  function deleteDay() {
    var key = S.editing;
    api("DELETE", "/api/days/" + key).then(function () {
      delete S.days[key];
      closeEditor();
      renderAll();
      refreshAdmin();
    }).catch(fail);
  }

  // ---- 設定・パスワード ----
  function fillSettings() {
    var s = S.me.settings;
    $("s-start").value = s.start;
    $("s-end").value = s.end;
    $("s-std").value = s.std / 60;
    $("s-brk").value = s.brk;
  }
  function saveSettings() {
    var body = {
      start: $("s-start").value, end: $("s-end").value,
      std: Math.round(parseFloat($("s-std").value) * 60), brk: Math.round(Number($("s-brk").value))
    };
    notice("");
    api("PUT", "/api/settings", body).then(function (s) {
      S.me.settings = s;
      renderAll();
      refreshAdmin();
      notice("設定を保存しました。");
    }).catch(fail);
  }
  function changePassword() {
    api("POST", "/api/password", { current: $("pw-cur").value, next: $("pw-new").value }).then(function () {
      $("pw-cur").value = ""; $("pw-new").value = "";
      notice("パスワードを変更しました。");
    }).catch(fail);
  }

  // ---- 管理者メニュー ----
  // 管理者のときだけ、サーバーから管理メニューのプログラムを取得して表示する。
  // 一般社員のブラウザには、管理メニューの画面もプログラムも送られない。
  var adminScript = null;
  function adminContext() {
    return { S: S, api: api, esc: esc, fail: fail, notice: notice, rowsHtml: rowsHtml, totalsHtml: totalsHtml,
      monthKey: monthKey, host: document.querySelector(".sheet") };
  }
  function mountAdmin() {
    if (!S.me || S.me.role !== "admin") return;
    if (window.TCAdmin) { window.TCAdmin.mount(adminContext()); return; }
    if (adminScript) return; // 読み込み中
    adminScript = document.createElement("script");
    adminScript.src = "/api/admin/ui.js";
    adminScript.onload = function () {
      if (S.me && S.me.role === "admin" && window.TCAdmin) window.TCAdmin.mount(adminContext());
    };
    adminScript.onerror = function () { adminScript = null; };
    document.head.appendChild(adminScript);
  }
  function refreshAdmin(reset) {
    if (window.TCAdmin) window.TCAdmin.refresh(!!reset);
  }
  // ログアウトや有効期限切れのときは、管理メニューを画面とメモリから消す
  function teardownAdmin() {
    if (window.TCAdmin) window.TCAdmin.unmount();
    window.TCAdmin = undefined;
    if (adminScript && adminScript.parentNode) adminScript.parentNode.removeChild(adminScript);
    adminScript = null;
  }

  // ---- 時計 ----
  function tickClock() {
    var n = TC.jstNow();
    $("clock").textContent = p2(n.hh) + ":" + p2(n.mm) + ":" + p2(n.ss);
    $("clock-date").textContent = n.y + "年" + n.m + "月" + n.d + "日（" + DOW[n.dow] + "）";
    var key = dk(n.y, n.m, n.d);
    if (S.todayKey !== key) {
      S.todayKey = key;
      if (S.me) loadMonth({ y: n.y, m: n.m }).then(renderAll);
    }
  }

  // ---- イベント ----
  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    notice("");
    api("POST", "/api/login", { email: $("l-emp").value.trim(), password: $("l-pw").value }).then(function (me) {
      S.me = me;
      showApp();
    }).catch(function (err) { notice(err.message); $("l-pw").value = ""; });
  });
  $("force-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if ($("f-new").value !== $("f-new2").value) { notice("新しいパスワードが確認用と一致しません。"); return; }
    notice("");
    api("POST", "/api/password", { current: $("f-cur").value, next: $("f-new").value }).then(function () {
      return api("GET", "/api/me");
    }).then(function (me) {
      S.me = me;
      showApp();
      notice("パスワードを設定しました。");
    }).catch(function (err) { notice(err.message); });
  });
  $("logout").addEventListener("click", function () {
    api("POST", "/api/logout", {}).catch(function () {}).then(function () {
      S.me = null;
      showLogin("");
    });
  });
  $("btns").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-act]");
    if (b && !b.disabled) punch(b.getAttribute("data-act"));
  });
  $("rows").addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-key]");
    if (tr) openEditor(tr.getAttribute("data-key"));
  });
  $("rows").addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var tr = e.target.closest("tr[data-key]");
    if (tr) { e.preventDefault(); openEditor(tr.getAttribute("data-key")); }
  });
  $("editor").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.id === "ed-save") saveEditor();
    else if (b.id === "ed-close") closeEditor();
    else if (b.id === "ed-del") {
      if (!S.delArmed) { S.delArmed = true; renderEditor(); return; }
      deleteDay();
    }
  });
  function goMonth(v) {
    S.view = v;
    S.editing = null;
    renderMonth();
    renderEditor();
    loadMonth(v).then(function () { renderAll(); });
    refreshAdmin(true);
  }
  $("prev").addEventListener("click", function () {
    var m = S.view.m - 1, y = S.view.y;
    if (m < 1) { m = 12; y--; }
    goMonth({ y: y, m: m });
  });
  $("next").addEventListener("click", function () {
    var m = S.view.m + 1, y = S.view.y;
    if (m > 12) { m = 1; y++; }
    goMonth({ y: y, m: m });
  });
  $("this-month").addEventListener("click", function () {
    var n = TC.jstNow();
    goMonth({ y: n.y, m: n.m });
  });
  $("csv").addEventListener("click", function () {
    window.location.href = "/api/export.csv?month=" + monthKey(S.view);
  });
  $("xlsx").addEventListener("click", function () {
    window.location.href = "/api/export.xlsx?month=" + monthKey(S.view);
  });
  $("s-save").addEventListener("click", saveSettings);
  $("pw-save").addEventListener("click", changePassword);

  // ---- 起動 ----
  tickClock();
  setInterval(tickClock, 1000);
  api("GET", "/api/me").then(function (me) {
    S.me = me;
    showApp();
  }).catch(function () { showLogin(""); });
})();
