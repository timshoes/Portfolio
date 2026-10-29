/* Ocean water layer.
   A shallow-water simulation on a coarse grid that covers the viewport. Each cell
   stores how much water it holds; gravity, the cursor, touch and scrolling push it
   around, and the screen edges hold it in. The amount of water never changes, so
   when gravity no longer pins it to the bottom (phone laid flat) it spreads into a
   thinner, clearer sheet. WebGL draws it; the page stays clickable underneath.
   A visit starts with a stream of water pouring in from the top centre; the round
   button under the water in the bottom-left corner drains it into a hole and pours it back in. */
(function () {
  var script = document.currentScript;
  var LAB = !!(script && script.hasAttribute("data-lab"));
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (LAB) window.addEventListener("error", function (e) {
    // lab only: put crashes on screen so they can be reported from a phone
    if (!e.filename || e.filename.indexOf("water.js") < 0) return;
    var note = document.createElement("p");
    note.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:70;margin:0;padding:10px 14px;border-radius:12px;background:#1F2E3A;color:#FBF3E6;font:13px system-ui";
    note.textContent = "Water crashed: " + e.message + " (line " + e.lineno + ")";
    document.body.appendChild(note);
  });

  // tunables (the lab panel edits these)
  var S = {
    level: 0.13,   // share of screen height the water fills when the phone is upright
    clarity: 1.3,    // overall opacity
    foam: 1.6,       // shoreline foam amount
    cursor: 1.4,     // cursor and finger strength
    scroll: 0.8,     // scroll slosh strength
    calm: 1.15,       // how fast motion dies down
    surf: 0.6,     // incoming waves running up the shore
    speed: 0.5,   // wave speed, screen heights per second
    bend: 1       // how much the page bends under the water (Chrome-based browsers only)
  };
  var lab = {};   // lab panel elements; declared early because motion can start before the panel is built
  // a visitor's own settings from the Water Lab page follow them to every page
  try { var saved = JSON.parse(localStorage.getItem("water-lab") || "{}"); for (var k in saved) if (k in S) S[k] = +saved[k]; } catch (e) {}

  // ---------- page layer ----------
  // The canvas reaches OVER px past the top and bottom of the screen. Mobile toolbars change the screen
  // height while scrolling, and the extra water fills the gap until the layer catches up.
  var OVER = 140;
  var css = document.createElement("style");
  css.textContent =
    ".water-layer{position:fixed;left:0;top:-" + OVER + "px;width:100%;height:calc(100% + " + 2 * OVER + "px);z-index:50;pointer-events:none;display:block}" +
    ".site-head{position:relative;z-index:60}" +
    ".water-chip{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:61;font:600 14px var(--sans,system-ui);color:#1F2E3A;background:#FBF3E6;border:0;border-radius:999px;padding:10px 16px;box-shadow:0 4px 18px rgba(31,46,58,.25);cursor:pointer}" +
    "@media (max-width:520px){.water-chip{left:calc(84px + env(safe-area-inset-left,0px));right:16px;transform:none}}" +
    // drain / fill button, under the water; while draining it becomes the hole the water runs into
    ".water-tap{position:fixed;left:calc(16px + env(safe-area-inset-left,0px));bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:48;width:52px;height:52px;padding:0;border:0;border-radius:50%;display:grid;place-items:center;background:#FBF3E6;color:#1F2E3A;box-shadow:0 4px 18px rgba(31,46,58,.25);cursor:pointer;transition:background .4s,box-shadow .4s,transform .2s}" +
    ".water-tap:hover{transform:scale(1.06)}" +
    ".water-tap svg{width:26px;height:26px;transition:opacity .3s}" +
    ".water-tap.hole{background:radial-gradient(circle at 50% 42%,#01060a 0 42%,#0a2633 68%,#2a6478 100%);box-shadow:inset 0 6px 12px rgba(0,0,0,.75),0 0 0 3px rgba(251,243,230,.55)}" +
    ".water-tap.hole svg{opacity:0}" +
    ".water-tap:focus-visible,.water-chip:focus-visible,.wl button:focus-visible,.wl input:focus-visible{outline:2px solid #E8772A;outline-offset:2px}";
  document.head.appendChild(css);

  var canvas = document.createElement("canvas");
  canvas.className = "water-layer";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  var gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  // in the lab, say why the water is missing instead of failing silently
  function fail(why) {
    canvas.remove();
    if (!LAB) return;
    var note = document.createElement("p");
    note.className = "water-chip"; note.style.cursor = "default";
    note.textContent = "Water could not start: " + why;
    document.body.appendChild(note);
  }
  if (!gl) { fail("this browser blocked WebGL graphics"); return; }

  // ---------- simulation grid ----------
  var HMAX = 4;                 // depth that maps to full brightness in the texture
  var cols = 0, rows = 0, N = 0, cellPx = 1;
  var h, u, v, P, kf, ag, wm, tex8;
  var volume = 0, drift = 0;
  var W = 0, H = 0, dpr = 1;
  // full, pouring, draining, empty, or waiting (empty until the first pour of a visit)
  var mode = "full";
  try {
    if (localStorage.getItem("water-state") === "empty") mode = "empty";
    else if (!reduce && sessionStorage.getItem("water-in") !== "1") mode = "waiting";
  } catch (e) {}

  function bandRows() { return Math.max(2, S.level * rows); }
  function slopeG() { return 1 / bandRows(); }          // depth gained per row below the waterline, upright
  function targetVolume() { return cols * 0.5 * bandRows(); }

  function buildGrid(nc, nr) {
    var oh = h, oc = cols, or = rows;
    var frac = oh ? volume / targetVolume() : (mode === "full" ? 1 : 0);   // keep a half-poured screen half full
    cols = nc; rows = nr; N = cols * rows;
    h = new Float32Array(N); u = new Float32Array(N); v = new Float32Array(N);
    P = new Float32Array(N); kf = new Float32Array(N); ag = new Float32Array(N); wm = new Float32Array(N);
    tex8 = new Uint8Array(N * 4);
    volume = targetVolume() * frac;
    if (oh) {
      for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++)
        h[y * cols + x] = oh[Math.min(or - 1, (y * or / rows) | 0) * oc + Math.min(oc - 1, (x * oc / cols) | 0)];
    } else if (frac) fillFlat();
    normalize();
  }

  // water at rest along the bottom
  function fillFlat() {
    var L = bandRows(), top = rows - L;
    for (var y = 0; y < rows; y++) {
      var d = Math.max(0, (y + 0.5 - top) / L);
      for (var x = 0; x < cols; x++) h[y * cols + x] = d;
    }
  }

  function normalize() {
    var s = 0;
    for (var i = 0; i < N; i++) s += h[i];
    if (volume <= 0) { drift = 0; if (s > 0) h.fill(0); return; }
    drift = s / volume - 1;
    if (s > 0) { var f = volume / s; for (var j = 0; j < N; j++) h[j] *= f; }
  }

  // gravity in screen space: x right, y down, z into the screen (all 0..1)
  var grav = { x: 0, y: 1, z: 0 }, gravTarget = { x: 0, y: 1, z: 0 };

  function step(dt) {
    var c0 = 1, K = 2;
    var pz = K * grav.z + c0;
    var sp = S.speed * rows;
    var A = sp * sp / c0;
    var G = slopeG();
    var ax = A * G * grav.x, ay = A * G * grav.y;
    var damp = Math.exp(-0.9 * S.calm * dt);
    var x, y, i, out;
    for (i = 0; i < N; i++) P[i] = pz * h[i];
    for (y = 0; y < rows; y++) for (x = 0, i = y * cols; x < cols - 1; x++, i++)
      u[i] = u[i] * damp + dt * (A * (P[i] - P[i + 1]) + ax);
    for (i = 0; i < N - cols; i++)
      v[i] = v[i] * damp + dt * (A * (P[i] - P[i + cols]) + ay);
    // never let a cell send away more water than it holds
    for (y = 0, i = 0; y < rows; y++) for (x = 0; x < cols; x++, i++) {
      out = 0;
      if (x < cols - 1 && u[i] > 0) out += u[i];
      if (x > 0 && u[i - 1] < 0) out -= u[i - 1];
      if (y < rows - 1 && v[i] > 0) out += v[i];
      if (y > 0 && v[i - cols] < 0) out -= v[i - cols];
      out *= dt;
      kf[i] = out > h[i] ? h[i] / out : 1;
    }
    for (y = 0; y < rows; y++) for (x = 0, i = y * cols; x < cols - 1; x++, i++)
      u[i] *= u[i] > 0 ? kf[i] : kf[i + 1];
    for (i = 0; i < N - cols; i++)
      v[i] *= v[i] > 0 ? kf[i] : kf[i + cols];
    for (y = 0, i = 0; y < rows; y++) for (x = 0; x < cols; x++, i++) {
      var net = 0;
      if (x > 0) net += u[i - 1];
      if (x < cols - 1) net -= u[i];
      if (y > 0) net += v[i - cols];
      if (y < rows - 1) net -= v[i];
      var nh = h[i] + dt * net;
      h[i] = nh > 0 ? nh : 0;
    }
  }

  // push water at (cx, cy) in cells, radius r, with a flow (fx, fy) in cells/s
  function push(cx, cy, r, fx, fy, radial, dt) {
    var x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(cols - 1, Math.ceil(cx + r));
    var y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(rows - 1, Math.ceil(cy + r));
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      var dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.sqrt(dx * dx + dy * dy);
      if (d >= r) continue;
      var i = y * cols + x, w = (1 - d / r); w *= w;
      var depth = Math.min(h[i], 1.2);
      if (depth <= 0) continue;
      var k = w * depth * dt * 6;
      var nx = d > 0 ? dx / d : 0, ny = d > 0 ? dy / d : 0;
      u[i] += k * (fx + nx * radial);
      v[i] += k * (fy + ny * radial);
    }
  }

  function depthAt(px, py) {
    var x = Math.min(cols - 1, Math.max(0, (px / cellPx) | 0)), y = Math.min(rows - 1, Math.max(0, (py / (H / rows)) | 0));
    return h[y * cols + x];
  }

  // ---------- input ----------
  var ptr = { x: 0, y: 0, vx: 0, vy: 0, t: 0, fresh: false };
  function track(x, y) {
    var now = performance.now(), dt = Math.max(8, now - ptr.t) / 1000;
    if (ptr.t && now - ptr.t < 120) {
      ptr.vx += ((x - ptr.x) / dt - ptr.vx) * 0.5;
      ptr.vy += ((y - ptr.y) / dt - ptr.vy) * 0.5;
    } else { ptr.vx = 0; ptr.vy = 0; }
    ptr.x = x; ptr.y = y; ptr.t = now; ptr.fresh = true;
  }
  if (!reduce) {
    window.addEventListener("pointermove", function (e) { if (e.pointerType === "mouse" || e.pointerType === "pen") track(e.clientX, e.clientY); }, { passive: true });
    window.addEventListener("touchstart", function (e) { var t = e.touches[0]; ptr.t = 0; track(t.clientX, t.clientY); }, { passive: true });
    window.addEventListener("touchmove", function (e) { var t = e.touches[0]; track(t.clientX, t.clientY); }, { passive: true });
  }

  var lastScrollY = window.scrollY, scrollVel = 0;

  // device tilt
  var motion = { on: false, got: false, status: "off" };
  var sensorG = null, padG = null;
  function screenAngle() {
    var a = (screen.orientation && typeof screen.orientation.angle === "number") ? screen.orientation.angle : (window.orientation || 0);
    return a * Math.PI / 180;
  }
  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    // privacy shields (e.g. Brave) can report a fixed 0,0 reading, which would look like a phone lying flat
    if (e.beta === 0 && e.gamma === 0) { if (!motion.got) { motion.status = "blocked"; if (LAB) labStatus(); } return; }
    motion.got = true; motion.status = "on";
    var b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
    var x = Math.sin(g) * Math.cos(b), y = Math.sin(b), z = Math.abs(Math.cos(g) * Math.cos(b));
    var a = -screenAngle(), ca = Math.cos(a), sa = Math.sin(a);
    var gx = x * ca - y * sa, gy = x * sa + y * ca;
    // ignore hand tremor: only changes of more than a few degrees move the water
    if (sensorG && Math.abs(gx - sensorG.x) + Math.abs(gy - sensorG.y) + Math.abs(z - sensorG.z) < 0.06) return;
    sensorG = { x: gx, y: gy, z: z };
  }
  function startMotion() {
    if (motion.on) return;
    motion.on = true; motion.status = "waiting";
    window.addEventListener("deviceorientation", onOrient);
    setTimeout(function () { if (!motion.got) { motion.status = "no data"; if (LAB) labStatus(); } }, 1500);
    if (LAB) labStatus();
  }
  function askMotion() {
    var D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === "function") {
      return D.requestPermission().then(function (r) {
        if (r === "granted") { try { sessionStorage.setItem("water-motion", "1"); } catch (e) {} startMotion(); }
        else { motion.status = "denied"; if (LAB) labStatus(); }
        return r;
      }).catch(function () { motion.status = "blocked"; if (LAB) labStatus(); });
    }
    startMotion();
    return Promise.resolve("granted");
  }
  var touchy = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (!reduce && touchy && window.DeviceOrientationEvent) {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      var asked = false;
      try { asked = sessionStorage.getItem("water-motion") === "1"; } catch (e) {}
      if (asked) {
        // granted earlier this visit: renew quietly on the first tap
        window.addEventListener("touchend", function once() { window.removeEventListener("touchend", once); askMotion(); });
      } else {
        var chip = document.createElement("button");
        chip.className = "water-chip"; chip.type = "button"; chip.textContent = "Tilt your phone to move the water";
        chip.addEventListener("click", function () { askMotion(); chip.remove(); });
        document.body.appendChild(chip);
      }
    } else startMotion();
  }

  // ---------- renderer ----------
  var VS = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";
  var FS = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH", "precision highp float;", "#else", "precision mediump float;", "#endif",
    "uniform sampler2D uH;uniform vec2 uRes,uGrid;uniform float uOver,uCanH,uDpr,uCell,uTime,uAct,uClar,uFoam,uHMax;",
    "uniform vec4 uPour;uniform float uClock,uSplash;",
    "float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}",
    "float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}",
    "float fbm(vec2 p){float a=.5,s=0.;for(int k=0;k<3;k++){s+=a*noise(p);p=p*2.03+17.1;a*=.5;}return s;}",
    "float H(vec2 uv){float s=texture2D(uH,uv).r;return s*s*uHMax;}",
    // light patterns dancing on the sea floor: where two drifting noise fields meet
    "float caustic(vec2 p,float t){float a1=noise(p+vec2(t*.30,t*.20)),a2=noise(p*1.3-vec2(t*.25,-t*.15)+4.);",
    "return pow(clamp(1.-abs(a1-a2)*3.,0.,1.),8.);}",
    "vec4 water(){",
    " vec2 uv=vec2(gl_FragCoord.x/uRes.x,(uCanH-gl_FragCoord.y-uOver)/uRes.y);",
    // r: depth, g: churn, b: how recently this spot was under water
    " vec4 s=texture2D(uH,uv);float h=s.r*s.r*uHMax;",
    " if(h<.004&&s.b<.02)return vec4(0.);",
    " vec2 px=gl_FragCoord.xy/uDpr;float t=uTime;vec2 q=px/90.;",
    " float thr=.012+.012*fbm(q*1.3+vec2(t*.05,-t*.08));",
    " float wet=smoothstep(thr,thr+.012,h);",
    // wet sand: a darker band left behind when the water pulls back
    " float sa=.07*s.b*s.b*(1.-wet)*(.7+.3*noise(q*7.));",
    " vec3 sc=vec3(.36,.27,.17);",
    " if(wet<=0.)return vec4(sc*sa,sa);",
    " vec2 tx=1./uGrid;",
    " vec2 g=vec2(H(uv+vec2(tx.x,0.))-H(uv-vec2(tx.x,0.)),H(uv+vec2(0.,tx.y))-H(uv-vec2(0.,tx.y)))*.5;",
    // estimated distance to the shoreline, in css px
    " float distPx=h/max(length(g),1e-4)*uCell;",
    " float lace=fbm(q*4.+vec2(t*.12,t*.05)+g*14.);",
    // shoreline foam comes from motion: a wave or a splash whips it up, and it fades away as the water rests
    " float stir=clamp(max(uAct*2.5,s.g),0.,1.);",
    " float foam=(1.-smoothstep(0.,(6.+30.*lace)*(.4+.6*stir),distPx))*smoothstep(.2,.5,lace+.2)*(.08+.92*stir);",
    // whitecaps only where the water is deep enough to churn
    " foam=max(foam,smoothstep(.55,1.,s.g)*smoothstep(.42,.68,lace)*smoothstep(.12,.45,h));",
    " foam=clamp(foam*uFoam,0.,1.);",
    // surface: slow swell plus fine ripples, calmer where the water is thin
    " float calm=smoothstep(.02,.35,h);",
    " vec2 o1=q*2.2+vec2(t*.18,t*.11),o2=q*5.5+vec2(-t*.35,t*.22);",
    " vec2 rn=vec2(fbm(o1)-fbm(o1+vec2(.06,0.)),fbm(o1+9.)-fbm(o1+vec2(9.,9.06)))*10.;",
    " vec2 rf=vec2(noise(o2)-noise(o2+vec2(.08,0.)),noise(o2+5.)-noise(o2+vec2(5.,5.08)))*6.;",
    // at rest the surface is nearly still; ripples build up only while the water is moving
    " float live=max(uAct,s.g);",
    " vec2 rip=(rn*.35+rf*.25)*(.4+.6*calm)*(.2+.8*live);",
    " vec3 N=normalize(vec3(-g.x*5.+rip.x,g.y*5.+rip.y,1.));",
    // light absorbed by depth: red fades first, so shallows read turquoise and deep water blue
    " vec3 T=exp(-vec3(2.4,.75,.5)*h*1.3);",
    " float tr=(T.r+T.g+T.b)/3.;",
    " vec3 col=vec3(.03,.38,.55)*(1.-T)+vec3(.45,.90,.86)*T;",
    // caustics on the floor, split slightly by colour, brightest in mid-shallow water
    " vec2 cp=px/55.;",
    " vec3 cau=vec3(caustic(cp+vec2(.04,0.),t),caustic(cp,t),caustic(cp-vec2(.04,0.),t));",
    " col+=cau*vec3(.85,1.,.95)*tr*smoothstep(0.,.08,h)*.45;",
    // sky reflected more on sloped water
    " col=mix(col,vec3(.80,.93,1.),clamp(.03+.6*pow(1.-N.z,1.5),0.,.5));",
    // sun: a broad sheen and sharp glints on the ripples
    " vec3 R=reflect(-normalize(vec3(-.35,.55,.75)),N);",
    " float sheen=pow(max(R.z,0.),20.)*.15,glint=pow(max(R.z,0.),220.)*1.6*(.5+.5*calm)*(.15+.85*live);",
    " float a=uClar*(.14+.72*(1.-tr));",
    " col+=sheen+glint;a=max(a,min(glint,1.)*.8);",
    " col=mix(col,vec3(.984,.953,.902),foam);a=mix(a,.92,foam);",
    " a=clamp(a*wet,0.,.95);",
    // water over the wet sand, premultiplied
    " return vec4(col*a+sc*sa*(1.-a),a+sa*(1.-a));",
    "}",
    // the pouring stream: a clear glassy column (uPour: centre x, half width, top, bottom in css px)
    "vec4 stream(){",
    " if(uPour.y<=0.)return vec4(0.);",
    " float x=gl_FragCoord.x/uDpr,y=(uCanH-gl_FragCoord.y-uOver)/uDpr,t=uClock;",
    " if(y<uPour.z||y>uPour.w+uPour.y*4.)return vec4(0.);",
    " float f=clamp(y/max(uPour.w,1.),0.,1.);",
    // it narrows and wobbles as it falls, its edges rippling downward
    " float cx=uPour.x+sin(y*.021-t*9.)*2.5*f+(noise(vec2(y*.02-t*14.,1.))-.5)*7.*f;",
    " float w=uPour.y*(1.-.4*f)*(.75+.5*noise(vec2(y*.045-t*22.,7.)));",
    " float d=abs(x-cx)/w;",
    " float body=smoothstep(1.,.8,d)*smoothstep(uPour.z,uPour.z+30.,y)*smoothstep(uPour.w+6.,uPour.w-6.,y);",
    // glass: clear in the middle, darker rims, bright streaks running down
    " float hl=smoothstep(.6,.8,noise(vec2(x/w*1.5,y*.025-t*18.)))*(1.-d*d);",
    " float edge=smoothstep(.5,.95,d);",
    " vec3 c=mix(vec3(.82,.94,1.),vec3(.16,.40,.56),edge*.75)+hl*.6;",
    " float a=body*(.2+.55*edge+.45*hl);",
    // splash: droplets thrown up where the stream hits
    " vec2 sp=(vec2(x,y)-vec2(uPour.x,uPour.w))/vec2(uPour.y*4.5,uPour.y*3.5);",
    " float ring=(1.-smoothstep(.3,1.,length(sp)))*smoothstep(.5,-.2,sp.y);",
    " float dr=smoothstep(.78,.93,noise(vec2(x,y)*.22+vec2(t*3.,t*9.)))*ring*uSplash;",
    " c=mix(c,vec3(.97,.99,1.),dr);a=max(a,dr*.85);",
    " return vec4(c*a,a);",
    "}",
    "void main(){vec4 w=water(),s=stream();gl_FragColor=s+w*(1.-s.a);}"
  ].join("\n");

  function shader(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  var prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) { console.warn("[water]", err); fail("shader error (" + String(err.message || err).slice(0, 80) + ")"); return; }
  gl.useProgram(prog);
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var aLoc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
  var U = {};
  ["uH", "uRes", "uOver", "uCanH", "uGrid", "uDpr", "uCell", "uTime", "uAct", "uClar", "uFoam", "uHMax", "uPour", "uClock", "uSplash"].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
  var texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(U.uH, 0);

  function resize() {
    W = window.innerWidth || document.documentElement.clientWidth;
    H = window.innerHeight || document.documentElement.clientHeight;
    if (W < 50 || H < 50) return;   // some browsers report 0 before layout; frame() retries
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);   // the water is soft; more pixels cost more than they show
    canvas.width = Math.round(W * dpr); canvas.height = Math.round((H + 2 * OVER) * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    var nc = Math.max(32, Math.min(180, Math.round(W / (W < 700 ? 8 : 9))));
    var nr = Math.max(16, Math.round(H / (W / nc)));
    if (nc !== cols || nr !== rows) buildGrid(nc, nr);
    cellPx = W / cols;
  }

  function draw(time) {
    if (!N) return;
    for (var i = 0; i < N; i++) {
      var e = Math.sqrt(Math.min(h[i] / HMAX, 1)) * 255;
      tex8[i * 4] = e;
      tex8[i * 4 + 1] = Math.min(255, ag[i] * 255);
      tex8[i * 4 + 2] = wm[i] * 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, tex8);
    gl.uniform2f(U.uRes, canvas.width, H * dpr);
    gl.uniform1f(U.uOver, OVER * dpr);
    gl.uniform1f(U.uCanH, canvas.height);
    gl.uniform2f(U.uGrid, cols, rows);
    gl.uniform1f(U.uDpr, dpr);
    gl.uniform1f(U.uCell, cellPx);
    gl.uniform1f(U.uTime, flow % 600);
    gl.uniform1f(U.uAct, act);
    gl.uniform1f(U.uClar, S.clarity);
    gl.uniform1f(U.uFoam, S.foam);
    gl.uniform1f(U.uHMax, HMAX);
    gl.uniform4f(U.uPour, stream.x, stream.on ? stream.w : 0, stream.top, stream.bot);
    gl.uniform1f(U.uClock, (time / 1000) % 600);
    gl.uniform1f(U.uSplash, stream.splash);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // churned water shows whitecaps; spots the water just left stay dark (wet sand) for a moment
  // also measures how much the water is moving overall (act, 0..1): at rest the shading slows and calms
  function updateAgitation(dt) {
    var decay = Math.exp(-dt * 2.5), dry = Math.exp(-dt / 1.8), scale = 1 / (S.speed * rows * 0.35);
    var flowSum = 0, hSum = 0;
    wetMax = 0;
    for (var y = 0, i = 0; y < rows; y++) for (var x = 0; x < cols; x++, i++) {
      var fu = x < cols - 1 ? u[i] : 0, fv = y < rows - 1 ? v[i] : 0;
      var vel = Math.sqrt(fu * fu + fv * fv) / (h[i] + 0.15) * scale;
      flowSum += Math.sqrt(fu * fu + fv * fv); hSum += h[i];
      var a = Math.min(1, vel * 1.2);   // local motion: drives foam, whitecaps and ripples
      ag[i] = Math.max(ag[i] * decay, a);
      wm[i] = h[i] > 0.02 ? 1 : wm[i] * dry;
      if (wm[i] > wetMax) wetMax = wm[i];
    }
    // average speed weighted by depth, so a thin film draining down the screen barely counts
    var target = Math.min(1, flowSum / Math.max(1e-6, hSum) * scale * ACT_GAIN);
    act += (target - act) * Math.min(1, dt * (target > act ? 6 : 1.2));
    flow += dt * (0.12 + 0.88 * act);
  }

  // ---------- page bending under the water ----------
  // Chrome-based browsers can run an SVG ripple filter on whatever sits behind an element
  // (backdrop-filter: url()). A layer under the canvas, clipped to the water's outline, bends the page there.
  var bend = null;
  if (!reduce && navigator.userAgentData) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    svg.innerHTML = '<filter id="water-bend" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.04" numOctaves="2" seed="4"></feTurbulence><feDisplacementMap in="SourceGraphic" scale="14" xChannelSelector="R" yChannelSelector="G"/></filter>';
    document.body.appendChild(svg);
    var layer = document.createElement("div");
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = "position:fixed;left:0;top:-" + OVER + "px;width:100%;height:calc(100% + " + 2 * OVER + "px);z-index:49;pointer-events:none;backdrop-filter:url(#water-bend);display:none";
    document.body.appendChild(layer);
    bend = { layer: layer, map: svg.querySelector("feDisplacementMap"), clip: "", scale: -1, sc: 0, tops: [], tick: 0 };
  }
  // The bending pattern itself is still; only its strength and outline follow the water, both eased,
  // so text under calm water holds steady.
  function updateBend() {
    if (!bend || ++bend.tick % 2) return;
    if (S.bend <= 0) { if (bend.clip !== "off") { bend.layer.style.display = "none"; bend.clip = "off"; } return; }
    // outline: where each sampled column first gets wet, between rows rather than on them, eased over time
    var rowPx = H / rows, step = Math.max(1, Math.round(cols / 40)), pts = [], wetSum = 0, wetN = 0, any = false, WET = 0.02;
    for (var x = 0, k = 0; x < cols; x += step, k++) {
      var top = H + OVER;
      for (var y = 0; y < rows; y++) {
        var hv = h[y * cols + x];
        if (hv > WET) {
          var above = y > 0 ? h[(y - 1) * cols + x] : hv;
          top = (y - 1 + (hv > above ? (WET - above) / (hv - above) : 1) + 0.5) * rowPx;
          any = true; break;
        }
      }
      var prev = bend.tops[k];
      bend.tops[k] = prev == null || Math.abs(top - prev) > H * 0.5 ? top : prev + (top - prev) * 0.35;
      pts.push(Math.round(x * cellPx) + "px " + Math.round(bend.tops[k] + OVER) + "px");
    }
    bend.tops.length = k;
    for (var i = 0; i < N; i += 7) if (h[i] > 0.03) { wetSum += h[i]; wetN++; }
    if (!any) { if (bend.clip !== "none") { bend.layer.style.display = "none"; bend.clip = "none"; } return; }
    var clip = "polygon(0 100%," + pts.join(",") + ",100% " + pts[pts.length - 1].split(" ")[1] + ",100% 100%)";
    if (clip !== bend.clip) { bend.layer.style.clipPath = clip; bend.layer.style.display = "block"; bend.clip = clip; }
    // thin water bends the page less
    var target = 16 * S.bend * Math.min(1, Math.max(0.2, (wetSum / Math.max(1, wetN)) / 0.5)) * (0.25 + 0.75 * act);
    bend.sc += (target - bend.sc) * 0.15;
    var sc = Math.round(bend.sc * 2) / 2;
    if (sc !== bend.scale) { bend.map.setAttribute("scale", sc); bend.scale = sc; }
  }

  // ---------- frame loop ----------
  var ACT_GAIN = 8, act = 0, flow = 0, wetMax = 0, idle = false;
  var last = 0, raf = 0, surfClock = 2.5, surfPulse = 0, surfPhase = 0;
  var fps = 60, frameCount = 0, fpsClock = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!N) { resize(); return; }
    var dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    // drained and dry: clear once, then do nothing until the water comes back
    if ((mode === "empty" || mode === "waiting") && volume <= 0 && wetMax < 0.01 && !stream.on) {
      if (!idle) { idle = true; draw(now); if (bend) { bend.layer.style.display = "none"; bend.clip = "none"; } }
      return;
    }
    idle = false;
    frameCount++; fpsClock += dt;
    if (fpsClock > 0.5) { fps = frameCount / fpsClock; frameCount = 0; fpsClock = 0; if (LAB) labReadout(); }

    // gravity source: lab tilt pad, then phone sensor, then straight down
    var src = padG || sensorG || { x: 0, y: 1, z: 0 };
    gravTarget = src;
    var gk = Math.min(1, dt * (padG ? 8 : 2));   // the phone sensor is eased more gently than the lab tilt pad
    grav.x += (gravTarget.x - grav.x) * gk;
    grav.y += (gravTarget.y - grav.y) * gk;
    grav.z += (gravTarget.z - grav.z) * gk;

    // cursor and finger: only when over the water, harder with speed
    if (ptr.fresh && now - ptr.t < 100) {
      var cx = ptr.x / cellPx, cy = ptr.y / (H / rows);
      var wetHere = depthAt(ptr.x, ptr.y) > 0.01 || depthAt(ptr.x, ptr.y + cellPx * 1.5) > 0.01;
      if (wetHere) {
        var vx = ptr.vx / cellPx, vy = ptr.vy / cellPx;
        var spd = Math.sqrt(vx * vx + vy * vy), cap = 90;
        if (spd > cap) { vx *= cap / spd; vy *= cap / spd; spd = cap; }
        var r = Math.max(2, cols * 0.035) * (1 + spd / cap);
        push(cx, cy, r, vx * 0.8 * S.cursor, vy * 0.8 * S.cursor, spd * 0.5 * S.cursor, dt);
      }
    }

    // scrolling drags the water with the page, then it settles
    var sy = window.scrollY, dy = sy - lastScrollY; lastScrollY = sy;
    scrollVel += ((dy / Math.max(dt, 0.008)) - scrollVel) * 0.35;
    if (Math.abs(scrollVel) > 5 && S.scroll > 0) {
      var sv = Math.max(-3000, Math.min(3000, scrollVel)) / cellPx * S.scroll;
      var kk = dt * 0.9;
      for (var y = 0, i = 0; y < rows; y++) for (var x = 0; x < cols; x++, i++) {
        if (h[i] <= 0) continue;
        var d = Math.min(h[i], 1.2);
        v[i] -= kk * sv * d;
        u[i] += kk * sv * d * 0.35 * Math.sin(x / cols * 9.4 + surfPhase);
      }
    }

    // surf: a swell every few seconds runs up the shore and drains back
    if (S.surf > 0) {
      surfClock -= dt;
      if (surfClock <= 0) { surfPulse = 0.45; surfPhase = Math.random() * 6.28; surfClock = 4 + Math.random() * 3; }
      if (surfPulse > 0) {
        surfPulse -= dt;
        var gl2 = Math.sqrt(grav.x * grav.x + grav.y * grav.y);
        if (gl2 > 0.2) {
          var ux = -grav.x / gl2, uy = -grav.y / gl2, amp = S.surf * S.speed * rows * 0.9 * dt;
          for (var y3 = 0, j = 0; y3 < rows; y3++) for (var x3 = 0; x3 < cols; x3++, j++) {
            if (h[j] <= 0) continue;
            var along = 0.65 + 0.35 * Math.sin(x3 / cols * 6.0 + y3 / rows * 6.0 + surfPhase);
            var dd = Math.min(h[j], 1) * amp * along;
            u[j] += ux * dd; v[j] += uy * dd;
          }
        }
      }
    }

    if (stream.on) pourStep(dt);
    if (mode === "draining") drainStep(dt);

    // stable sub-steps
    var c = S.speed * rows * Math.sqrt(2 * grav.z + 1) * 1.6;
    var n = Math.max(1, Math.ceil(dt * c / 0.45));
    for (var s = 0; s < n; s++) step(dt / n);
    normalize();
    updateAgitation(dt);
    draw(now);
    updateBend();
  }

  // ---------- pour in and drain ----------
  var fillT = 0;
  var stream = { on: false, release: false, x: 0, w: 0, top: 0, bot: 0, vt: 0, vb: 0, splash: 0 };
  function startPour() {
    mode = "pouring"; fillT = 0;
    stream.on = true; stream.release = false; stream.top = stream.bot = -30; stream.vt = stream.vb = 0;
    setTap();
  }
  // a stream falls from the top centre, plunges into the water where it lands and fills it up
  function pourStep(dt) {
    var rowPx = H / rows, g = H * 7;
    stream.x = W / 2; stream.w = Math.max(7, Math.min(16, W * 0.011));
    var c = Math.min(cols - 1, (stream.x / cellPx) | 0), land = H;
    for (var y = 0; y < rows; y++) if (h[y * cols + c] > 0.25) { land = y * rowPx; break; }
    stream.vb += g * dt; stream.bot = Math.min(land, stream.bot + stream.vb * dt);
    if (stream.release) { stream.vt += g * dt; stream.top += stream.vt * dt; }
    if (stream.top >= stream.bot) { stream.on = false; stream.splash = 0; return; }
    var landed = stream.bot >= land - 1;
    stream.splash += ((landed && !stream.release ? 1 : 0) - stream.splash) * Math.min(1, dt * 6);
    if (mode !== "pouring" || !landed) return;
    fillT += dt;
    var target = targetVolume(), amt = Math.min(target - volume, target / 2.4 * dt);
    if (amt <= 0) { mode = "full"; volume = target; stream.release = true; setTap(); return; }
    var hw = Math.max(1, stream.w / cellPx), ly = Math.min(rows - 1, (land / rowPx) | 0), fall = S.speed * rows * 2;
    // the water it brings spreads out under the surface, so the level rises instead of piling up a mound
    var sig = Math.max(3, cols * 0.14), wsum = 0, x, i;
    for (x = 0; x < cols; x++) wsum += Math.exp(-((x - c) * (x - c)) / (sig * sig)) * (rows - ly);
    for (y = ly; y < rows; y++) for (x = 0; x < cols; x++) {
      i = y * cols + x;
      h[i] += amt * Math.exp(-((x - c) * (x - c)) / (sig * sig)) / wsum;
      // right under the stream it is driven down and churned into bubbles
      if (y < ly + 2 && Math.abs(x - c) <= hw) { v[i] = Math.max(v[i], h[i] * fall); ag[i] = 1; }
    }
    push(c + 0.5, ly + 0.5, Math.max(2, hw * 3), 0, 0, S.speed * rows * 0.6, dt);
    volume += amt;
  }
  function drainStep(dt) {
    fillT += dt;
    var r = tap.getBoundingClientRect(), rowPx = H / rows;
    var hx = (r.left + r.width / 2) / cellPx, hy = (r.top + r.height / 2) / rowPx, R = Math.max(1.5, r.width / 2 / cellPx);
    // everything is drawn toward the hole and swirls as it nears it
    var pull = S.speed * rows * 2 * Math.min(1, fillT / 0.5), fade = fillT > 2 ? Math.exp(-dt * (fillT - 2) * 2) : 1, gone = 0;
    for (var y = 0, i = 0; y < rows; y++) for (var x = 0; x < cols; x++, i++) {
      if (h[i] <= 0) continue;
      var dx = hx - x - 0.5, dy = hy - y - 0.5, d = Math.sqrt(dx * dx + dy * dy) + 1e-3;
      var k = pull * dt * Math.min(h[i], 1), sw = d < R * 5 ? 0.8 * (1 - d / (R * 5)) : 0;
      u[i] += k * (dx - sw * dy) / d;
      v[i] += k * (dy + sw * dx) / d;
      var take = d < R * 1.4 ? h[i] * Math.min(1, dt * 12) : 0;
      take += (h[i] - take) * (1 - fade);   // the last thin film soaks away
      h[i] -= take; gone += take;
    }
    volume = Math.max(0, volume - gone);
    if (volume < targetVolume() * 0.003 || fillT > 7) {
      h.fill(0); u.fill(0); v.fill(0); volume = 0;
      mode = "empty"; setTap();
    }
  }

  var ICON_DRAIN = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M8 9h8M7 12h10M8 15h8\"/></svg>";
  var ICON_FILL = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 3c3.5 4.6 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 2.5-6.4 6-11z\"/><path d=\"M12 11v6M9 14h6\" stroke-linecap=\"round\"/></svg>";
  var tap = document.createElement("button");
  tap.type = "button"; tap.className = "water-tap";
  document.body.appendChild(tap);
  function setTap() {
    var empty = mode === "empty" || mode === "waiting";
    tap.classList.toggle("hole", mode === "draining");
    tap.innerHTML = empty ? ICON_FILL : ICON_DRAIN;
    var label = empty || mode === "draining" ? "Pour the water back in" : "Drain the water";
    tap.setAttribute("aria-label", label); tap.title = label;
  }
  function remember(state) {
    try { state ? localStorage.setItem("water-state", state) : localStorage.removeItem("water-state"); sessionStorage.setItem("water-in", "1"); } catch (e) {}
  }
  tap.addEventListener("click", function () {
    var draining = mode === "full" || mode === "pouring";
    remember(draining ? "empty" : null);
    if (reduce) {
      // no animation: the water is simply there or gone
      mode = draining ? "empty" : "full";
      h.fill(0); volume = 0;
      if (!draining) { volume = targetVolume(); fillFlat(); normalize(); }
      draw(0); setTap(); return;
    }
    if (draining) { mode = "draining"; fillT = 0; stream.release = true; setTap(); }
    else startPour();
  });
  setTap();
  if (mode === "waiting") setTimeout(function () {
    if (mode !== "waiting") return;
    remember(null);
    startPour();
  }, 900);

  function start() { if (!raf && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  document.addEventListener("visibilitychange", function () { document.hidden ? stop() : start(); });

  var resizeQueued = false;
  window.addEventListener("resize", function () {
    if (resizeQueued) return; resizeQueued = true;
    requestAnimationFrame(function () { resizeQueued = false; resize(); if (reduce) draw(0); });
  });

  resize();
  if (reduce) draw(0); else start();

  // ---------- lab panel ----------
  function labStatus() {
    if (!lab.motion) return;
    var m = { off: "Motion: off", waiting: "Motion: waiting for data", on: "Motion: live from your phone", "no data": "Motion: no data (blocked here, use the tilt pad)", denied: "Motion: permission declined", blocked: "Motion: blocked here, use the tilt pad" };
    lab.motion.textContent = m[motion.status] || motion.status;
  }
  function labReadout() {
    if (!lab.read) return;
    lab.read.textContent = Math.round(fps) + " fps · grid " + cols + "×" + rows + " · volume drift " + (drift * 100).toFixed(3) + "% · gravity " + grav.x.toFixed(2) + ", " + grav.y.toFixed(2) + ", flat " + grav.z.toFixed(2) + " · activity " + act.toFixed(2);
  }
  if (LAB && !reduce) buildLab();

  function buildLab() {
    var st = document.createElement("style");
    st.textContent =
      // the way in to the settings: big, warm and gently pulsing so visitors notice it
      ".wl-toggle{position:fixed;right:calc(14px + env(safe-area-inset-right,0px));top:calc(50% - 28px);z-index:62;display:flex;align-items:center;gap:10px;font:700 16px var(--sans,system-ui);background:#E8772A;color:#1F2E3A;border:3px solid #FBF3E6;border-radius:999px;padding:13px 20px 13px 16px;cursor:pointer;box-shadow:0 8px 24px rgba(31,46,58,.35)}" +
      ".wl-toggle:hover{background:#F5A04E}" +
      ".wl-toggle svg{width:24px;height:24px;flex:none}" +
      ".wl-toggle::after{content:\"\";position:absolute;inset:-3px;border-radius:999px;border:3px solid #E8772A;animation:wl-pulse 2.4s ease-out infinite;pointer-events:none}" +
      "@keyframes wl-pulse{0%{transform:scale(1);opacity:.8}100%{transform:scale(1.25,1.6);opacity:0}}" +
      "@media (prefers-reduced-motion:reduce){.wl-toggle::after{animation:none;opacity:0}}" +
      "@media (max-width:700px){.wl-toggle{top:auto;right:auto;left:50%;transform:translateX(-50%);bottom:calc(18vh + 64px + env(safe-area-inset-bottom,0px));white-space:nowrap}}" +
      ".wl{position:fixed;right:calc(12px + env(safe-area-inset-right,0px));top:calc(64px + env(safe-area-inset-top,0px));z-index:63;width:min(300px,calc(100vw - 24px));max-height:calc(100% - 96px);overflow:auto;background:#FBF3E6;color:#1F2E3A;border-radius:16px;padding:16px;font:14px var(--sans,system-ui);box-shadow:0 10px 40px rgba(31,46,58,.35)}" +
      ".wl-top{display:flex;justify-content:space-between;align-items:center;gap:8px}" +
      ".wl button.b{font:600 13px var(--sans,system-ui);border:1px solid #1F2E3A;background:transparent;color:#1F2E3A;border-radius:999px;padding:7px 12px;cursor:pointer}" +
      ".wl h2{margin:0 0 4px;font:400 22px var(--display,Georgia,serif);color:#C4561A}" +
      ".wl p{margin:0 0 12px;color:#3B4A55;font-size:13px}" +
      ".wl label{display:grid;grid-template-columns:1fr auto;gap:2px 8px;margin:0 0 10px;font-weight:600;font-size:13px}" +
      ".wl label span{font-variant-numeric:tabular-nums;color:#6E5236;font-weight:500}" +
      ".wl input[type=range]{grid-column:1/-1;width:100%;accent-color:#E8772A}" +
      ".wl .pad{position:relative;width:132px;height:132px;margin:4px auto 8px;border-radius:50%;background:radial-gradient(circle,#8CCBE8 0,#4A9FCF 100%);touch-action:none;cursor:grab}" +
      ".wl .pad i{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#FBF3E6;border:3px solid #1F2E3A;pointer-events:none}" +
      ".wl .row{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}" +
      ".wl button.b{font:600 13px var(--sans,system-ui);border:1px solid #1F2E3A;background:transparent;color:#1F2E3A;border-radius:999px;padding:7px 12px;cursor:pointer}" +
      ".wl .read{font-size:12px;color:#3B4A55;font-variant-numeric:tabular-nums;margin:8px 0 0}" +
      ".wl .sub{font-weight:600;font-size:13px;margin:12px 0 2px}";
    document.head.appendChild(st);

    // open by default where there is room beside the page; on phones it waits for a tap
    var open = window.innerWidth >= 900;
    try { var o = sessionStorage.getItem("water-lab-open"); if (o) open = o === "1"; } catch (e) {}
    var tog = document.createElement("button");
    tog.type = "button"; tog.className = "wl-toggle";
    tog.innerHTML = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M2 9c2.5-2.5 4.5-2.5 7 0s4.5 2.5 7 0 4.5-2.5 6 0\"/><path d=\"M2 16c2.5-2.5 4.5-2.5 7 0s4.5 2.5 7 0 4.5-2.5 6 0\"/></svg><span>Make your own waves</span>";
    var panel = document.createElement("div");
    panel.className = "wl"; panel.hidden = !open;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Water lab settings");
    panel.innerHTML = "<div class=\"wl-top\"><h2>Water lab</h2><button type=\"button\" class=\"b\">Close</button></div><p>Make the water your own. Your settings follow you to every page of this site.</p>";
    function setOpen(o) {
      panel.hidden = !o; tog.hidden = o;
      try { sessionStorage.setItem("water-lab-open", o ? "1" : "0"); } catch (e) {}
    }
    tog.hidden = open;
    tog.addEventListener("click", function () { setOpen(true); });
    panel.querySelector(".wl-top button").addEventListener("click", function () { setOpen(false); });

    function save() { try { localStorage.setItem("water-lab", JSON.stringify(S)); } catch (e) {} }
    var sliders = [
      ["level", "Water level", 0.05, 0.4, 0.01, function (x) { return Math.round(x * 100) + "%"; }],
      ["clarity", "Opacity", 0.3, 1.4, 0.05],
      ["foam", "Foam", 0, 1.6, 0.05],
      ["cursor", "Cursor and finger", 0, 2.5, 0.05],
      ["scroll", "Scroll slosh", 0, 2.5, 0.05],
      ["calm", "Settling speed", 0.2, 3, 0.05],
      ["surf", "Surf", 0, 1.5, 0.05],
      ["speed", "Wave speed", 0.25, 1, 0.05],
      ["bend", "Page bending (Chrome, Edge, Brave)", 0, 2, 0.1]
    ];
    sliders.forEach(function (d) {
      var key = d[0], fmt = d[5] || function (x) { return (+x).toFixed(2); };
      var lb = document.createElement("label");
      var id = "wl-" + key;
      lb.htmlFor = id;
      lb.innerHTML = d[1] + "<span></span><input type=\"range\" id=\"" + id + "\" min=\"" + d[2] + "\" max=\"" + d[3] + "\" step=\"" + d[4] + "\">";
      var out = lb.querySelector("span"), inp = lb.querySelector("input");
      inp.value = S[key]; out.textContent = fmt(S[key]);
      inp.addEventListener("input", function () {
        S[key] = +inp.value; out.textContent = fmt(S[key]);
        if (key === "level" && mode === "full") { volume = targetVolume(); }
        save();
      });
      panel.appendChild(lb);
    });

    var sub = document.createElement("div"); sub.className = "sub"; sub.textContent = "Tilt pad (stands in for your phone)";
    panel.appendChild(sub);
    var hint = document.createElement("p");
    hint.textContent = "The dot shows which way is down. Drag it to the centre to lay the phone flat.";
    panel.appendChild(hint);
    var pad = document.createElement("div"); pad.className = "pad";
    var dot = document.createElement("i"); pad.appendChild(dot);
    panel.appendChild(pad);
    function placeDot(gx, gy) { dot.style.left = (50 + gx * 50) + "%"; dot.style.top = (50 + gy * 50) + "%"; }
    placeDot(0, 1);
    function padMove(e) {
      var r = pad.getBoundingClientRect();
      var x = ((e.clientX - r.left) / r.width) * 2 - 1, y = ((e.clientY - r.top) / r.height) * 2 - 1;
      var l = Math.sqrt(x * x + y * y);
      if (l > 1) { x /= l; y /= l; l = 1; }
      padG = { x: x, y: y, z: Math.sqrt(Math.max(0, 1 - l * l)) };
      placeDot(x, y);
    }
    pad.addEventListener("pointerdown", function (e) { pad.setPointerCapture(e.pointerId); padMove(e); });
    pad.addEventListener("pointermove", function (e) { if (pad.hasPointerCapture(e.pointerId)) padMove(e); });

    var row = document.createElement("div"); row.className = "row";
    function btn(label, fn) { var b = document.createElement("button"); b.type = "button"; b.className = "b"; b.textContent = label; b.addEventListener("click", fn); row.appendChild(b); return b; }
    btn("Upright", function () { padG = null; placeDot(0, 1); });
    btn("Lay flat", function () { padG = { x: 0, y: 0, z: 1 }; placeDot(0, 0); });
    btn("Use phone motion", function () { padG = null; placeDot(0, 1); askMotion(); });
    panel.appendChild(row);
    lab.motion = document.createElement("p"); panel.appendChild(lab.motion); labStatus();

    row = document.createElement("div"); row.className = "row"; panel.appendChild(row);
    btn("Reset to default", function () {
      try { localStorage.removeItem("water-lab"); } catch (e) {}
      location.reload();
    });
    lab.read = document.createElement("p"); lab.read.className = "read"; panel.appendChild(lab.read);

    document.body.appendChild(tog);
    document.body.appendChild(panel);
  }
})();
