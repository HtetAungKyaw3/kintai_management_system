(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  var drawer = $("drawer"), back = $("drawer-back"), openBtn = $("menu-open");
  var timer = null;

  function open() {
    back.hidden = false;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    openBtn.setAttribute("aria-expanded", "true");
    document.body.classList.add("menu-lock");
  }
  function close() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    openBtn.setAttribute("aria-expanded", "false");
    back.hidden = true;
    document.body.classList.remove("menu-lock");
  }
  function say(msg) {
    var el = $("notice");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(function () { el.hidden = true; el.textContent = ""; }, 4000);
  }
  function mark(btn) {
    Array.prototype.forEach.call(drawer.querySelectorAll(".msub button"), function (b) { b.classList.remove("on"); });
    btn.classList.add("on");
  }
  function scrollTo(id) {
    var el = $(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  var actions = {
    register: function () { Pages.hide(); scrollTo("clock"); },
    edit: function () { Pages.hide(); scrollTo("rows"); say("修正したい日の行を選んでください。"); },
    print: function () { window.print(); }
  };

  openBtn.addEventListener("click", open);
  back.addEventListener("click", close);
  $("menu-close").addEventListener("click", close);
  $("logout").addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  drawer.addEventListener("click", function (e) {
    var t = e.target.closest("button");
    if (!t) return;
    var g = t.getAttribute("data-toggle");
    if (g) {
      var list = $(g), expanded = t.getAttribute("aria-expanded") === "true";
      t.setAttribute("aria-expanded", expanded ? "false" : "true");
      list.hidden = expanded;
      return;
    }
    var go = t.getAttribute("data-go");
    if (go) {
      if (go !== "print") mark(t);
      close();
      if (actions[go]) actions[go](); else Pages.show(go);
    }
  });
})();
