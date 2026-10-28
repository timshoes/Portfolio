(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // arriving: the water is already covering the page; start draining it right away (a CSS animation, so no extra frame is needed)
  function washOff() {
    if (!root.classList.contains("wash-in")) return;
    root.classList.add("wash-go");
    setTimeout(function () { root.classList.remove("wash-in", "wash-go"); }, 1050);
  }
  washOff();
  // load and decode the surf images now, so the first wave never appears without its foam
  var wash = document.querySelector(".wash");
  if (wash) {
    var up = wash.getAttribute("data-up") || "";
    ["img/ocean-wave.webp", "img/ocean-deep.webp"].forEach(function (src) {
      var im = new Image(); im.src = up + src;
      if (im.decode) im.decode().catch(function () {});
    });
  }
  // back/forward cache: never leave the page covered
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) root.classList.remove("wash-out", "wash-in", "wash-go");
  });
  if (reduce) return;
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.target || a.hasAttribute("download")) return;
    var url = new URL(a.href, location.href);
    if (url.protocol !== location.protocol || url.host !== location.host) return;
    if (url.pathname === location.pathname && url.search === location.search) return; // same page, e.g. #brand
    e.preventDefault();
    try { sessionStorage.setItem("wash", "1"); } catch (err) {}
    root.classList.add("wash-out");
    setTimeout(function () { location.href = url.href; }, 1100);
  });
})();
