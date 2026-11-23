/*
 * 管理メニュー（管理者だけに配信される）
 * 一般社員がログインしたときは、このファイルも管理メニューの画面も、ブラウザに送られません。
 * サーバー側の /api/admin/ui.js が、管理者のセッションでなければ 403 を返します。
 */
(function () {
  "use strict";

  var TC = window.TC;
  var fmt = TC.fmt;
  var ctx = null;      // app.js から受け取る部品
  var root = null;     // 管理メニューの要素
  var st = { user: null, deact: false };

  var TEMPLATE = `
    <section class="panel admin" id="admin">
      <h3>管理者メニュー（<span id="admin-month"></span>）</h3>
      <div class="admin-sec">
        <div class="detail-head">
          <p class="label">全社員の月次集計</p>
          <a class="btn small" id="admin-csv" href="#">一覧をCSVで保存</a>
        </div>
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>氏名</th><th>メールアドレス</th><th>社員番号</th><th class="num">出勤</th><th class="num">所定</th>
                <th class="num">総実働</th><th class="num">残業</th><th class="num">深夜</th><th class="num">有給</th><th class="num">欠勤</th>
              </tr>
            </thead>
            <tbody id="admin-rows"></tbody>
          </table>
        </div>
        <div id="admin-detail"></div>
      </div>
      <div class="admin-sec">
        <p class="label">社員を追加</p>
        <div class="fields inline">
          <div class="field"><label for="n-mail">メールアドレス</label><input id="n-mail" type="email" maxlength="254" autocomplete="off" inputmode="email" autocapitalize="none"></div>
          <div class="field"><label for="n-name">氏名</label><input id="n-name" type="text" maxlength="40"></div>
          <div class="field"><label for="n-emp">社員番号（任意）</label><input id="n-emp" type="text" maxlength="20"></div>
          <div class="field"><label for="n-pw">仮パスワード（8文字以上）</label><input id="n-pw" type="text" autocomplete="off"></div>
          <div class="field"><label for="n-role">権限</label>
            <select id="n-role"><option value="employee">一般</option><option value="admin">管理者</option></select>
          </div>
        </div>
        <p class="hint">仮パスワードを本人に伝えてください。本人は初回ログイン時に、自分のパスワードへ変更します。</p>
        <div class="actions"><button class="btn small in" id="n-save" type="button">追加する</button></div>
      </div>
    </section>
  `;

  function $(id) { return document.getElementById(id); }

  function mount(c) {
    ctx = c;
    if (!root) {
      var tmp = document.createElement("div");
      tmp.innerHTML = TEMPLATE.trim();
      root = tmp.firstElementChild;
      ctx.host.appendChild(root);
      root.addEventListener("click", onClick);
    }
    refresh(true);
  }

  function unmount() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null; ctx = null;
    st = { user: null, deact: false };
  }

  // reset が true のときは、開いている社員の詳細を閉じる（月を切り替えたときなど）
  function refresh(reset) {
    if (!root || !ctx) return;
    if (reset) { st.user = null; st.deact = false; $("admin-detail").innerHTML = ""; }
    var S = ctx.S, key = ctx.monthKey(S.view);
    $("admin-month").textContent = S.view.y + "年" + S.view.m + "月";
    $("admin-csv").setAttribute("href", "/api/admin/export.csv?month=" + key);
    ctx.api("GET", "/api/admin/summary?month=" + key).then(function (data) {
      if (!root) return;
      $("admin-rows").innerHTML = data.rows.map(function (r) {
        return '<tr><td><button class="linkish" type="button" data-uid="' + r.id + '">' + ctx.esc(r.name) + "</button></td>" +
          "<td>" + ctx.esc(r.email) + "</td><td>" + ctx.esc(r.empNo || "") + "</td>" +
          '<td class="num">' + r.days + '</td><td class="num">' + r.sched + '</td><td class="num">' + fmt(r.work) +
          '</td><td class="num">' + fmt(r.ot) + '</td><td class="num">' + fmt(r.night) +
          '</td><td class="num">' + r.paid + '</td><td class="num">' + r.absent + "</td></tr>";
      }).join("");
    }).catch(ctx.fail);
    if (st.user) openUser(st.user);
  }

  function openUser(id) {
    st.user = id;
    var S = ctx.S, key = ctx.monthKey(S.view);
    ctx.api("GET", "/api/admin/users/" + id + "/days?month=" + key).then(function (data) {
      if (!root || st.user !== id) return;
      var u = data.user;
      var t = TC.monthStats(data.days, S.view.y, S.view.m, u.settings);
      var self = u.id === S.me.id;
      $("admin-detail").innerHTML =
        '<div class="detail-head"><h3>' + ctx.esc(u.name) + "（" + ctx.esc(u.email) + "）</h3>" +
        '<a class="btn small" href="/api/admin/export.csv?month=' + key + "&user=" + u.id + '">この社員のCSV</a></div>' +
        '<div class="totals">' + ctx.totalsHtml(t) + "</div>" +
        '<div class="tablewrap"><table><thead><tr><th>日</th><th>曜</th><th>区分</th><th class="num">出勤</th><th class="num">退勤</th><th class="num">休憩</th><th class="num">実働</th><th class="num">残業</th><th class="num">深夜</th><th>備考</th></tr></thead><tbody>' +
        ctx.rowsHtml(S.view, data.days, u.settings, {}) + "</tbody></table></div>" +
        '<div class="fields inline"><div class="field"><label for="a-pw">仮パスワードで再設定（8文字以上）</label><input id="a-pw" type="text" autocomplete="off"></div></div>' +
        '<div class="actions"><button class="btn small" type="button" data-adm="pw" data-uid="' + u.id + '">再設定する</button>' +
        (self ? "" : '<button class="btn small' + (st.deact ? " danger-armed" : "") + '" type="button" data-adm="off" data-uid="' + u.id + '">' +
          (st.deact ? "もう一度押すと無効にします" : "この社員を無効にする") + "</button>") +
        '<button class="btn small" type="button" data-adm="close">閉じる</button></div>';
    }).catch(ctx.fail);
  }

  function addUser() {
    var body = { email: $("n-mail").value.trim(), name: $("n-name").value.trim(), empNo: $("n-emp").value.trim(),
      password: $("n-pw").value, role: $("n-role").value };
    ctx.notice("");
    ctx.api("POST", "/api/admin/users", body).then(function () {
      $("n-mail").value = ""; $("n-emp").value = ""; $("n-name").value = ""; $("n-pw").value = "";
      ctx.notice("社員を追加しました。仮パスワードを本人に伝えてください。");
      refresh(false);
    }).catch(ctx.fail);
  }

  function onClick(e) {
    var t = e.target;
    if (t.closest("#n-save")) { addUser(); return; }
    var rowBtn = t.closest("#admin-rows button[data-uid]");
    if (rowBtn) { st.deact = false; openUser(Number(rowBtn.getAttribute("data-uid"))); return; }
    var b = t.closest("#admin-detail button[data-adm]");
    if (!b) return;
    var act = b.getAttribute("data-adm"), uid = Number(b.getAttribute("data-uid"));
    if (act === "close") {
      st.user = null; st.deact = false; $("admin-detail").innerHTML = "";
    } else if (act === "pw") {
      ctx.api("POST", "/api/admin/users/" + uid + "/password", { password: $("a-pw").value }).then(function () {
        $("a-pw").value = "";
        ctx.notice("パスワードを再設定しました。本人に仮パスワードを伝えてください。次回ログイン時に本人が変更します。");
      }).catch(ctx.fail);
    } else if (act === "off") {
      if (!st.deact) { st.deact = true; openUser(uid); return; }
      st.deact = false;
      ctx.api("PUT", "/api/admin/users/" + uid + "/active", { active: false }).then(function () {
        st.user = null;
        $("admin-detail").innerHTML = "";
        ctx.notice("社員を無効にしました。");
        refresh(false);
      }).catch(ctx.fail);
    }
  }

  window.TCAdmin = { mount: mount, refresh: refresh, unmount: unmount };
})();
