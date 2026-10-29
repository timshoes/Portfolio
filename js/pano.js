/* 360° video viewer: equirectangular video on WebGL, drag to look, optional scroll-to-pan.
   [data-pano]       inline viewer (data-src, data-poster, data-scroll)
   [data-pano-open]  button that opens a full-screen viewer (data-src, data-poster, data-label) */
(function () {
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var VS = "attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.,1.);}";
  var FS = [
    "precision highp float;varying vec2 v;uniform sampler2D t;uniform float yaw,pitch,th,asp;",
    "void main(){",
    " vec3 d=normalize(vec3(v.x*th*asp,v.y*th,-1.));",
    " float cp=cos(pitch),sp=sin(pitch);d=vec3(d.x,d.y*cp+d.z*sp,-d.y*sp+d.z*cp);",
    " float cy=cos(yaw),sy=sin(yaw);d=vec3(d.x*cy-d.z*sy,d.y,d.x*sy+d.z*cy);",
    " float lon=atan(d.x,-d.z);float lat=asin(clamp(d.y,-1.,1.));",
    " gl_FragColor=texture2D(t,vec2(lon/6.2831853+.5,.5-lat/3.1415927));}"
  ].join("\n");

  function Viewer(host, opts) {
    var self = this;
    this.host = host; this.yaw = opts.yaw || 0; this.pitch = 0; this.fov = opts.fov || 80;
    this.drift = reduce ? 0 : (opts.drift || 0); this.scrollYaw = 0; this.alive = true;
    host.classList.add("pano-on");
    if (opts.poster) host.style.backgroundImage = "url(" + opts.poster + ")";

    var video = this.video = document.createElement("video");
    video.src = opts.src; video.muted = opts.muted !== false; video.loop = true;
    video.playsInline = true; video.setAttribute("playsinline", ""); video.preload = "auto";

    var canvas = this.canvas = document.createElement("canvas");
    host.appendChild(canvas);
    var gl = this.gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!gl) { host.classList.add("pano-fallback"); return; }
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var U = {}; ["yaw", "pitch", "th", "asp"].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    var ready = false;

    // drag to look
    var drag = null;
    canvas.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY, yaw: self.yaw, pitch: self.pitch, type: e.pointerType };
      canvas.setPointerCapture(e.pointerId); host.classList.add("pano-grab"); self.touched = true;
      self.drift = 0; self.held = true;   // the automatic turn and the scroll turn stop for good once the visitor takes over
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var k = (self.fov * Math.PI / 180) / canvas.clientHeight;
      self.yaw = drag.yaw - (e.clientX - drag.x) * k;
      self.pitch = Math.max(-1.2, Math.min(1.2, drag.pitch - (e.clientY - drag.y) * k));
    });
    function end() { drag = null; host.classList.remove("pano-grab"); }
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);

    // scroll to pan: a quarter turn across the first screen of scrolling
    if (opts.scroll && !reduce) {
      window.addEventListener("scroll", function () { if (self.held) return; self.scrollYaw = Math.min(window.scrollY, 1600) / window.innerHeight * (Math.PI / 2); }, { passive: true });
    }

    // only play while on screen
    if ("IntersectionObserver" in window && !opts.modal) {
      new IntersectionObserver(function (es) {
        self.visible = es[0].isIntersecting;
        if (self.visible) self.play(); else video.pause();
      }).observe(host);
    } else { this.visible = true; }

    var last = performance.now();
    function frame(now) {
      if (!self.alive) return;
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (self.visible !== false) {
        if (!drag) self.yaw += self.drift * dt;
        var w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        }
        if (video.readyState >= 2) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
          if (!ready) { ready = true; host.classList.add("pano-ready"); }
        }
        if (ready) {
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.uniform1f(U.yaw, self.yaw + self.scrollYaw); gl.uniform1f(U.pitch, self.pitch);
          gl.uniform1f(U.th, Math.tan(self.fov * Math.PI / 360)); gl.uniform1f(U.asp, w / h);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    if (opts.autoplay !== false) this.play();
  }
  Viewer.prototype.play = function () { var p = this.video.play(); if (p && p.catch) p.catch(function () {}); };
  Viewer.prototype.destroy = function () {
    this.alive = false; this.video.pause(); this.video.removeAttribute("src"); this.video.load();
    var ext = this.gl && this.gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext();
  };

  // inline viewers
  document.querySelectorAll("[data-pano]").forEach(function (el) {
    var wide = el.clientWidth / Math.max(1, el.clientHeight);
    new Viewer(el, { src: el.dataset.src, poster: el.dataset.poster, scroll: el.hasAttribute("data-scroll"),
                     drift: 0.035, fov: wide < 1 ? 95 : 75, yaw: 0.35 });
  });

  // full-screen experience
  document.querySelectorAll("[data-pano-open]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var box = document.createElement("div");
      box.className = "pano-modal"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-label", btn.dataset.label || "360° experience");
      box.innerHTML = '<div class="pano-stage"></div>' +
        '<div class="pano-bar"><span class="pano-title"></span><span class="pano-tip">Drag to look around</span>' +
        '<button type="button" class="pano-sound">Sound off</button><button type="button" class="pano-close">Close</button></div>';
      box.querySelector(".pano-title").textContent = btn.dataset.label || "";
      document.body.appendChild(box); document.documentElement.classList.add("pano-lock");
      var v = new Viewer(box.querySelector(".pano-stage"), { src: btn.dataset.src, poster: btn.dataset.poster, modal: true, muted: false, fov: 85 });
      var snd = box.querySelector(".pano-sound");
      function label() { snd.textContent = v.video.muted ? "Sound on" : "Sound off"; }
      v.video.addEventListener("volumechange", label);
      var p = v.video.play(); // opened by a click, so sound is allowed in most browsers
      if (p && p.catch) p.catch(function () { v.video.muted = true; label(); v.play(); });
      label();
      snd.addEventListener("click", function () { v.video.muted = !v.video.muted; });
      function close() {
        v.destroy(); box.remove(); document.documentElement.classList.remove("pano-lock");
        document.removeEventListener("keydown", key); btn.focus();
      }
      function key(e) { if (e.key === "Escape") close(); }
      box.querySelector(".pano-close").addEventListener("click", close);
      document.addEventListener("keydown", key);
      box.querySelector(".pano-close").focus();
    });
  });
})();
