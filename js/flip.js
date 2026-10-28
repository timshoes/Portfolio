/* Page-through viewer for style guides and slide sets.
   Markup: <div class="flip" data-flip> with one <figure> per page. Without this script every page shows,
   stacked; with it, one page at a time with previous/next, a page count, arrow keys and swipe. */
(function () {
  document.querySelectorAll("[data-flip]").forEach(function (box) {
    var pages = Array.prototype.slice.call(box.querySelectorAll(":scope > figure"));
    if (pages.length < 2) return;
    var at = 0;
    box.classList.add("flip-on");
    box.setAttribute("tabindex", "0");
    box.setAttribute("role", "region");
    if (!box.hasAttribute("aria-label")) box.setAttribute("aria-label", "Pages");

    var bar = document.createElement("div");
    bar.className = "flip-bar";
    bar.innerHTML = '<button type="button" class="flip-prev" aria-label="Previous page">←</button>' +
      '<span class="flip-count" aria-live="polite"></span>' +
      '<button type="button" class="flip-next" aria-label="Next page">→</button>';
    box.appendChild(bar);
    var prev = bar.querySelector(".flip-prev"), next = bar.querySelector(".flip-next"), count = bar.querySelector(".flip-count");

    function show(i) {
      at = Math.max(0, Math.min(pages.length - 1, i));
      pages.forEach(function (p, k) { p.hidden = k !== at; });
      count.textContent = (at + 1) + " / " + pages.length;
      prev.disabled = at === 0;
      next.disabled = at === pages.length - 1;
    }
    prev.addEventListener("click", function () { show(at - 1); });
    next.addEventListener("click", function () { show(at + 1); });
    box.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { show(at - 1); e.preventDefault(); }
      if (e.key === "ArrowRight") { show(at + 1); e.preventDefault(); }
    });
    var x0 = null, y0 = 0;
    box.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    box.addEventListener("touchend", function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) show(at + (dx < 0 ? 1 : -1));
      x0 = null;
    });
    show(0);
  });
})();
