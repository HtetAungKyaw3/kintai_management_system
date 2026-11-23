/*
 * 勤怠計算の共通モジュール。
 * ブラウザ（window.TC）とサーバー（require）の両方から使い、集計結果を一致させる。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TC = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DOW = ["日", "月", "火", "水", "木", "金", "土"];
  var TYPES = { work: "出勤", paid: "有給休暇", comp: "代休", absent: "欠勤" };

  // 国民の祝日（内閣府公表の2026年・2027年）。以降の年は毎年追記してください。
  var HOL = {
    "2026-01-01": "元日", "2026-01-12": "成人の日", "2026-02-11": "建国記念の日", "2026-02-23": "天皇誕生日",
    "2026-03-20": "春分の日", "2026-04-29": "昭和の日", "2026-05-03": "憲法記念日", "2026-05-04": "みどりの日",
    "2026-05-05": "こどもの日", "2026-05-06": "振替休日", "2026-07-20": "海の日", "2026-08-11": "山の日",
    "2026-09-21": "敬老の日", "2026-09-22": "国民の休日", "2026-09-23": "秋分の日", "2026-10-12": "スポーツの日",
    "2026-11-03": "文化の日", "2026-11-23": "勤労感謝の日",
    "2027-01-01": "元日", "2027-01-11": "成人の日", "2027-02-11": "建国記念の日", "2027-02-23": "天皇誕生日",
    "2027-03-21": "春分の日", "2027-03-22": "振替休日", "2027-04-29": "昭和の日", "2027-05-03": "憲法記念日",
    "2027-05-04": "みどりの日", "2027-05-05": "こどもの日", "2027-07-19": "海の日", "2027-08-11": "山の日",
    "2027-09-20": "敬老の日", "2027-09-23": "秋分の日", "2027-10-11": "スポーツの日", "2027-11-03": "文化の日",
    "2027-11-23": "勤労感謝の日"
  };

  var DEFAULTS = { start: "09:00", end: "18:00", std: 480, brk: 60 };

  function p2(n) { return String(n).padStart(2, "0"); }
  function dk(y, m, d) { return y + "-" + p2(m) + "-" + p2(d); }
  function dowOf(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  // 日本時間（JST）の現在時刻。サーバーの時刻設定に左右されない。
  function jstNow(ms) {
    var d = new Date((ms == null ? Date.now() : ms) + 9 * 3600 * 1000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay(),
      hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds() };
  }
  function toMin(s) {
    if (typeof s !== "string" || !/^\d{1,2}:\d{2}$/.test(s)) return null;
    var a = s.split(":");
    var h = Number(a[0]), m = Number(a[1]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }
  function fmt(min) { return Math.floor(min / 60) + ":" + p2(min % 60); }

  function isOff(y, m, d) {
    var w = dowOf(y, m, d);
    return w === 0 || w === 6 || !!HOL[dk(y, m, d)];
  }

  // 打刻の状態: idle(未出勤) / working / break / done
  function statusOf(r) {
    if (!r || r.type !== "work" || !r.in) return "idle";
    if (r.out) return "done";
    var bs = r.breaks || [];
    if (bs.length && !bs[bs.length - 1].e) return "break";
    return "working";
  }

  // 1日分の勤務時間を計算する。st は { std, brk }（分）
  function calc(r, st) {
    st = st || DEFAULTS;
    var z = { ok: false, span: 0, brk: 0, work: 0, ot: 0, night: 0 };
    if (!r || r.type !== "work") return z;
    var a = toMin(r.in), b0 = toMin(r.out);
    if (a == null || b0 == null) return z;
    var b = b0 < a ? b0 + 1440 : b0;
    var span = b - a;
    var punched = 0, bl = [];
    (r.breaks || []).forEach(function (x) {
      var s = toMin(x.s), e = toMin(x.e);
      if (s == null || e == null) return;
      if (s < a) { s += 1440; e += 1440; }
      if (e < s) e += 1440;
      bl.push([s, e]);
      punched += e - s;
    });
    var brk;
    if (r.breakMin !== null && r.breakMin !== undefined && r.breakMin !== "" && !isNaN(Number(r.breakMin))) brk = Number(r.breakMin);
    else if (punched > 0) brk = punched;
    else brk = span > 360 ? st.brk : 0;
    var work = Math.max(0, span - brk);
    var ot = Math.max(0, work - st.std);
    function ov(x1, x2, y1, y2) { return Math.max(0, Math.min(x2, y2) - Math.max(x1, y1)); }
    var night = 0;
    // 深夜: 0:00-5:00 と 22:00-29:00（翌5:00）
    [[0, 300], [1320, 1740], [2760, 3180]].forEach(function (w) {
      night += ov(a, b, w[0], w[1]);
      bl.forEach(function (k) { night -= ov(Math.max(k[0], a), Math.min(k[1], b), w[0], w[1]); });
    });
    return { ok: true, span: span, brk: brk, work: work, ot: ot, night: Math.max(0, night),
      inM: a, outM: b0, overnight: b0 < a };
  }

  // 月次の集計。days は { "YYYY-MM-DD": 記録 }
  function monthStats(days, y, m, st) {
    var N = daysIn(y, m);
    var t = { days: 0, work: 0, ot: 0, night: 0, paid: 0, absent: 0, sched: 0 };
    for (var d = 1; d <= N; d++) {
      if (!isOff(y, m, d)) t.sched++;
      var r = days[dk(y, m, d)];
      if (!r) continue;
      if (r.type === "paid") t.paid++;
      else if (r.type === "absent") t.absent++;
      else if (r.type === "work") {
        var c = calc(r, st);
        if (c.ok) { t.days++; t.work += c.work; t.ot += c.ot; t.night += c.night; }
      }
    }
    return t;
  }

  return { DOW: DOW, TYPES: TYPES, HOL: HOL, DEFAULTS: DEFAULTS, p2: p2, dk: dk, dowOf: dowOf, daysIn: daysIn,
    jstNow: jstNow, toMin: toMin, fmt: fmt, isOff: isOff, statusOf: statusOf, calc: calc, monthStats: monthStats };
});
