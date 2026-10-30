/* Bobble-head surfer banner (home page). A WebGL breaking wave with a rag-doll surfer whose
   board you can drag around; the head stays put. Markup: <div class="surf-header"> with
   canvas.wave, canvas.fx and an optional .surf-hint inside. Head image: img/surf-head.webp. */
(() => {
  // ---------------------------------------------------------------------------
  // Config. cutout:true = the image already has a transparent background (otherwise a
  // soft oval mask is applied). Crop box in image pixels: cx, cy = head centre, rx, ry =
  // half size, neckY = where the body attaches under the chin. flip mirrors the face.
  // neckLine: two image points; skin-coloured pixels below this line are erased so the
  // beard, not the neck, forms the bottom outline (set to null to turn it off).
  // ---------------------------------------------------------------------------
  const HEAD = { src: 'img/surf-head.webp', cutout: true, flip: true, cx: 625, cy: 620, rx: 420, ry: 600, neckY: 1165,
    neckLine: [[300, 935], [820, 1228]] };

  const root = document.querySelector('.surf-header');
  if (!root) return;
  // Reduced motion: the wave holds still and there is no ambient spray; dragging still works
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const glc = root.querySelector('canvas.wave');
  const c2 = root.querySelector('canvas.fx');
  const ctx = c2.getContext('2d');
  const hint = root.querySelector('.surf-hint');
  const TAU = Math.PI * 2;

  // World: origin = centre of header, 1 unit = U px, y down (shader flips to y up).
  let W = 0, H = 0, U = 1, DPR = 1, GS = 1;
  const QUALITY = [1, 0.8, 0.65, 0.5];          // wave render scale steps (see adaptQuality)
  let qLevel = 0;

  // Wave geometry (shared with the shader, y-up world units)
  // Side-on wave: open shoulder to the left, barrel mouth (an upright oval MA x MB) on the right.
  const MA = 0.38, MB = 0.64, LIPT = 0.152;   // wave is ~20% shorter; its base stays where the board rides
  const tube = { x: 0.62, y: -0.14 };           // centre of the barrel's mouth
  function crestY(x, t) {
    const xr = x - tube.x;
    let c = tube.y + MB + LIPT - 0.50 * (1 - smooth(-3.4, -0.25, xr));
    c -= 0.19 * smooth(MA + 0.5, MA + 1.8, xr);
    c += 0.035 * Math.sin(t * 0.7) * smooth(-3.0, 0, xr);
    c += (0.035 * Math.sin(x * 2.4 - t * 1.8) + 0.02 * Math.sin(x * 5.3 - t * 2.9)) * (1 - smooth(-0.6, 0, xr));
    return c;
  }
  function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  // ---------------------------------------------------------------------------
  // WebGL wave
  // ---------------------------------------------------------------------------
  const FRAG = `
precision highp float;
uniform vec2 uRes; uniform vec2 uOrigin; uniform float uUnit; uniform float uTime; uniform vec2 uC;
const float A = ${MA.toFixed(3)}; const float B = ${MB.toFixed(3)}; const float LIPT = ${LIPT.toFixed(3)};
const float TAU = 6.2831853;
// Sunny palette
const vec3 SKY_TOP = vec3(0.16, 0.44, 0.80);
const vec3 SKY_HOR = vec3(0.62, 0.80, 0.93);
const vec3 AQUA    = vec3(0.16, 0.74, 0.78);   // thin, sunlit water near the curl
const vec3 AQUA_HI = vec3(0.52, 0.95, 0.93);
const vec3 BASE    = vec3(0.02, 0.21, 0.31);   // deep teal at the foot of the wave
const vec3 FOAMC   = vec3(0.92, 0.96, 0.97);

// ---- noise. Cost is counted in noise() calls; every layer below is budgeted. ----
float hash(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1.,0.)), u.x), mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), u.x), u.y); }
const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6);
// rotated fbm: isotropic detail (clouds, foam, mist)
float fbm3(vec2 p){ return 0.5*noise(p) + 0.25*noise(ROT*p) + 0.125*noise(ROT*ROT*p); }
float fbm4(vec2 p){ return fbm3(p) + 0.0625*noise(ROT*ROT*ROT*p); }
// axis-aligned fbm: keeps stretched (streaky) shapes stretched
float afbm3(vec2 p){ return 0.5*noise(p) + 0.25*noise(p*2.0 + 3.1) + 0.125*noise(p*4.0 + 7.7); }
float afbm2(vec2 p){ return 0.5*noise(p) + 0.25*noise(p*2.0 + 3.1); }
float ridge(float n){ return 1.0 - abs(2.0*n - 1.0); }
// billow: rounded, puffy lobes (cauliflower whitewater)
float billow(vec2 p){ return 0.5*abs(2.0*noise(p) - 1.0) + 0.25*abs(2.0*noise(ROT*p) - 1.0) + 0.125*abs(2.0*noise(ROT*ROT*p) - 1.0)
  + 0.0625*abs(2.0*noise(ROT*ROT*ROT*p) - 1.0); }
// cellular edges for foam lace (only evaluated in front of the wave)
float cells(vec2 p){
  vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    float d = length(g + vec2(hash(i + g), hash(i + g + 17.3)) - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}

// Side-on view: the open shoulder runs off to the left, the lip pitches over on the right.
// uC is the centre of the barrel's mouth (an upright oval, A wide and B tall).
float crestY(float x, float T){
  float xr = x - uC.x;
  float top = uC.y + B + LIPT;
  float c = top - 0.50 * (1.0 - smoothstep(-3.4, -0.25, xr));     // shoulder tapers away to the left
  c -= 0.19 * smoothstep(A + 0.5, A + 1.8, xr);                    // broken whitewater on the right
  c += 0.035 * sin(T*0.7) * smoothstep(-3.0, 0.0, xr);             // the swell rises and falls
  // ripples run along the crest toward the barrel as the wave peels
  c += (0.035 * sin(x*2.4 - T*1.8) + 0.02 * sin(x*5.3 - T*2.9)) * (1.0 - smoothstep(-0.6, 0.0, xr));
  return c;
}

// ---- behind the wave ----
vec3 skyCol(vec2 p, float hor){
  float h = p.y - hor;
  vec3 c = mix(SKY_HOR, SKY_TOP, smoothstep(0.0, 1.0, h / 0.9));
  // cumulus near the horizon: lit from above (compare with a sample a little higher)
  vec2 q = vec2(p.x*0.75 + uTime*0.01, p.y*1.5);
  float cl = fbm4(q), clu = fbm4(q + vec2(0.0, 0.075));
  float dens = smoothstep(0.48, 0.66, cl - h*0.12) * smoothstep(-0.02, 0.08, h);
  vec3 cloud = mix(vec3(0.70, 0.79, 0.88), vec3(0.99, 0.99, 1.0), clamp(0.55 + (clu - cl)*6.0, 0.0, 1.0));
  return mix(c, cloud, dens);
}
vec3 seaCol(vec2 p, float hor, float T){
  float d = max(hor - p.y, 0.0);
  float sx = p.x * 2.5 / (0.12 + d * 2.0);                    // perspective: chop compresses toward the horizon
  float n = afbm3(vec2(sx + T*0.08, p.y * 45.0));
  vec3 c = mix(vec3(0.20, 0.50, 0.64), vec3(0.06, 0.33, 0.45), smoothstep(0.0, 0.45, d)) * (0.85 + 0.3*n);
  c = mix(c, vec3(0.85, 0.92, 0.95), smoothstep(0.80, 0.95, n) * 0.4);
  return mix(c, SKY_HOR, (1.0 - smoothstep(0.0, 0.025, d)) * 0.6);
}

// ---- the wave face ----
// Water is drawn UP the face, speeds up near the lip and leans over toward the barrel. Two
// texture layers ride that flow and cross-fade, so it can accelerate without smearing.
// Per layer: broad tone + streaks + chop (2 samples for its slope) + reflections = 5 cheap fbms.
vec3 faceCol(vec2 p, float crest, float T){
  float xr = p.x - uC.x;
  float base = uC.y - B - 0.10;
  float hh = clamp((crest - p.y) / max(crest - base, 0.2), 0.0, 1.0);   // 0 at the crest, 1 at the foot
  float curl = exp(-pow((xr + 0.55) / 1.35, 2.0));                      // the steep, concave section
  float glow = (1.0 - smoothstep(0.04, 0.88, hh)) * (0.45 + 0.55*curl);
  vec3 c = mix(BASE, vec3(0.04, 0.45, 0.52), 1.0 - hh);
  c = mix(c, AQUA, glow);
  c = mix(c, AQUA_HI, glow*glow*0.55);
  c = mix(c, vec3(0.55, 1.0, 0.85), pow(1.0 - hh, 5.0) * (0.35 + 0.65*curl) * 0.5);   // sun through the thin crest

  // Flow: water is drawn UP the face and speeds up near the lip. Instead of pushing a texture
  // around (which folds over on itself where fast water overtakes slow water), we sample along a
  // "travel time" coordinate u: u grows slowly near the crest, so a steady scroll u + T moves
  // features faster there - up to ~3x - and they stretch out like fast water, but can never
  // overtake each other or run backwards. One layer, no cross-fading.
  float Hc = max(crest - (uC.y - B - 0.10), 0.2);
  float u = 2.2 * Hc * (0.3*hh + 0.28*pow(hh, 2.5));          // integral of 1/speed from the crest down
  float bend = curl * pow(1.0 - hh, 2.0) * (0.75 + 0.12*sin(T*0.9));   // streamlines lean into the curl
  float fx = (p.x - bend) * 14.0;
  float sv = u + T*0.9;                                          // adding time moves features up
  float tone   = afbm2(vec2(fx*0.35, sv*0.6));
  float streak = pow(ridge(afbm3(vec2(fx + 3.0, sv))), 6.0);
  float rf     = smoothstep(0.42, 0.95, afbm2(vec2(fx*0.06, sv*0.9)));        // soft, wide sky reflections
  // chop: small horizontal ripples - these are what visibly travel up the face
  float ch0 = afbm3(vec2(fx*0.25 + 11.0, sv*4.0));
  float ch1 = afbm3(vec2(fx*0.25 + 11.0, sv*4.0 + 0.12));
  vec2 chop = vec2(ch0, ch1 - ch0);
  c *= 0.86 + 0.28*tone;
  c = mix(c, vec3(0.80, 0.98, 0.97), streak * 0.25 * (0.3 + glow));
  c = mix(c, mix(SKY_HOR, vec3(1.0), 0.3), rf * 0.2 * smoothstep(0.15, 0.6, hh));      // glassy sky reflections
  float chopLit = clamp(0.5 - chop.y * 5.0, 0.0, 1.0);
  c *= 0.84 + 0.32*chopLit;
  float hi = pow(chopLit, 14.0);
  c += vec3(0.88, 0.96, 1.0) * hi * 0.22 * (0.35 + 0.65*hh);
  c = mix(c, vec3(0.93, 0.97, 0.98), smoothstep(0.7, 0.95, hi * chop.x * 2.0) * 0.35);  // white flecks of chop

  // a heavy bright lip with a feathered spray line along the whole crest
  float dc0 = crest - p.y;
  float lipZ = 1.0 - smoothstep(0.0, 0.10, dc0);
  if (lipZ > 0.0) {
    float lf = smoothstep(0.45, 0.75, fbm3(vec2(p.x*9.0 - T*1.2, p.y*14.0 - T*2.4)));
    c = mix(c, AQUA_HI, lipZ * 0.35);
    c = mix(c, vec3(0.96, 0.99, 1.0), lipZ * lf * 0.9);
  }
  // the lip pitching out: a bright leading sheet over a dark hollow band, thickening toward the barrel
  float pitch = smoothstep(-2.0, -0.9, xr) * (1.0 - smoothstep(-0.05, 0.35, xr));
  float dc = dc0 / (0.4 + 0.6*smoothstep(-2.0, 0.0, xr));
  c = mix(c, c * vec3(0.35, 0.55, 0.65), smoothstep(0.05, 0.09, dc) * (1.0 - smoothstep(0.10, 0.32, dc)) * pitch * 0.75);
  c = mix(c, AQUA_HI * 1.05, (1.0 - smoothstep(0.035, 0.07, dc)) * pitch * 0.5);
  // foam scum rising off the foot of the face
  if (hh > 0.8) c = mix(c, vec3(0.85, 0.94, 0.96), smoothstep(0.80, 1.0, hh) * pow(ridge(afbm2(vec2(p.x*2.2, p.y*12.0 - T*3.0))), 4.0) * 0.6);
  return c;
}

// billowing whitewater: puffy forms rolling up and out, lit from the upper left (one extra
// sample toward the light gives the shading), blue-grey in the folds
vec3 whiteCol(vec2 p, float T, out float b0){
  vec2 bq = p*1.4 + vec2(-T*0.18, -T*0.36);
  b0 = billow(bq);
  float bl = billow(bq + vec2(0.035, -0.05));
  float lit = clamp(0.62 + (b0 - bl)*4.0, 0.0, 1.0);
  float fluff = noise(p*28.0 + vec2(T*0.6, -T*0.9));                // fine foamy grain
  return mix(vec3(0.46, 0.60, 0.68), vec3(0.98, 0.99, 1.0), clamp(lit*0.7 + smoothstep(0.2, 0.65, b0)*0.4, 0.0, 1.0)) * (0.94 + 0.08*fluff);
}

void main(){
  vec2 p = (gl_FragCoord.xy - uOrigin) / uUnit;
  float T = uTime;
  vec2 M = uC;
  float xr = p.x - M.x;
  float hor = M.y + B + LIPT + 0.22;           // horizon sits high: ocean behind the wave
  vec2 dp = p - M;
  float lean = 0.32 + 0.08*sin(T*1.1);         // the lip throws out and draws back
  vec2 eu = vec2(dp.x + lean*max(dp.y, -0.2*B) - 0.18*smoothstep(0.3*B, B, dp.y), dp.y) / vec2(A, B);
  float e = length(eu);

  float crest = crestY(p.x, T);
  float sd = crest - p.y + (0.5*noise(vec2(p.x*5.0 + T*0.7, p.y*5.0 + T*1.3)) + 0.25*noise(vec2(p.x*10.0 - T, p.y*10.0)) - 0.375)
             * (0.08 + 0.24*smoothstep(A, A + 1.5, xr));
  float wa = smoothstep(-0.012, 0.018, sd);
  vec3 col = vec3(0.0);

  // ---- behind the wave (skipped where the wave covers it) ----
  if (wa < 0.999) {
    vec3 back = p.y > hor ? skyCol(p, hor) : seaCol(p, hor, T);
    float above = max(-sd, 0.0);
    float plumeMask = smoothstep(-2.6, -1.0, xr) * (1.0 - smoothstep(0.1, 0.7, xr));
    float plume = exp(-above / (0.05 + 0.42*plumeMask)) * (0.3 + 0.7*plumeMask);
    float lm = smoothstep(A - 0.1, A + 0.9, xr) * exp(-above * 3.0);
    if (plume + lm > 0.01) {
      // spray streams up and back on the wind
      vec2 wd = vec2(-0.33, 0.94);
      vec2 wq = vec2(dot(p, vec2(wd.y, -wd.x)), dot(p, wd));
      float sp = afbm3(vec2(wq.x*5.0, wq.y*2.0 - T*1.8));
      float mistv = fbm3(vec2(p.x*2.0 - T*0.15, p.y*2.5 - T*0.6));
      back = mix(back, vec3(0.96, 0.98, 1.0), clamp(plume * (smoothstep(0.4, 0.85, sp)*0.7 + mistv*0.6), 0.0, 0.95));
      back = mix(back, vec3(0.92, 0.95, 0.97), lm * smoothstep(0.25, 0.7, mistv) * 0.85);
    }
    col = back;
  }

  // ---- the wave ----
  if (wa > 0.001) {
    float baseY = M.y - B - 0.10 + 0.02*sin(p.x*3.0 + T);
    float tz = 1.0 - smoothstep(baseY - 0.08, baseY + 0.04, p.y);
    float wwZ = smoothstep(A + 0.05, A + 0.5, xr + (noise(vec2(p.x*1.5, p.y*2.0 - T*0.4)) - 0.5)*0.5);
    bool nearCurl = xr > -A - 0.35;              // the barrel, curtain, whitewater and landing all live here

    vec3 water = vec3(0.0);
    if (tz < 0.999 && wwZ < 0.999) water = faceCol(p, crest, T);

    float b0 = 0.5;
    vec3 white = FOAMC;
    if (nearCurl) white = whiteCol(p, T, b0);

    if (e < 1.05) {
      // inside the curl: a hollow tube lit through the lip, with a foam ball churning in the pocket
      float inside = 1.0 - smoothstep(0.9, 1.05, e);
      float ang = atan(eu.y, eu.x);
      float swirl = afbm2(vec2(ang * 2.2 + T * 3.1, e*4.0 - T*0.9));
      vec3 tube = mix(vec3(0.06, 0.40, 0.46), vec3(0.02, 0.24, 0.31), 1.0 - smoothstep(0.2, 0.95, e)) * (0.8 + 0.4*swirl);
      tube = mix(tube, AQUA_HI * (0.85 + 0.25*swirl), smoothstep(0.45, 0.95, eu.y) * 0.5);
      water = mix(water, tube, inside * 0.85);
      vec2 fb = (eu - vec2(0.18, -0.42)) / vec2(0.62, 0.5);
      float ball = 1.0 - smoothstep(0.55, 1.0, length(fb) + (b0 - 0.5)*0.6);
      water = mix(water, white, ball * inside);
    }

    if (nearCurl) {
      // Where the lip comes over and down: the water follows one clockwise loop around the barrel,
      // so the curtain's streaks run along that loop and fade in past the top of the curl.
      float cv = (p.y - M.y) / B;
      float ca = atan(eu.y, eu.x);
      float curtainZ = smoothstep(-0.35, 0.25, xr) * smoothstep(0.92, 1.12, e) * (1.0 - smoothstep(1.1, 1.65, ca));
      if (curtainZ > 0.001) {
        float cn = afbm3(vec2(e*14.0, ca*2.5 + T*3.0));
        vec3 curtain = mix(AQUA, AQUA_HI, smoothstep(0.1, 1.0, cv)) * (0.85 + 0.3*cn);
        curtain = mix(curtain, white, clamp(smoothstep(0.55, 0.8, cn)*0.5 + (1.0 - smoothstep(-0.9, 0.3, cv))*0.8 + smoothstep(1.0, 1.4, e)*0.7, 0.0, 1.0));
        water = mix(water, curtain, curtainZ * (1.0 - wwZ));
      }
      water = mix(water, white, wwZ * smoothstep(0.0, 0.1, xr));
      // explosion where the lip lands
      float ld = length((p - vec2(M.x + A*0.55, M.y - B)) / vec2(0.85, 0.5));
      water = mix(water, white, (1.0 - smoothstep(0.5, 1.0, ld + (b0 - 0.5)*0.6)) * 0.95);
    }

    if (tz > 0.001) {
      // flatter water out front, drawn up into the wave: everything here flows upward
      float fx = p.x - T*0.12, ty = p.y - T*0.35;
      float tn = afbm3(vec2(fx*1.2, ty*16.0));
      vec3 trough = mix(vec3(0.10, 0.44, 0.52), vec3(0.24, 0.60, 0.66), tn);
      trough = mix(trough, SKY_HOR, smoothstep(0.55, 0.8, afbm2(vec2(fx*2.0, ty*30.0))) * 0.35);
      float warp = noise(vec2(fx*2.0, ty*8.0));
      float lc = cells(vec2(fx*8.0 + warp*3.0, ty*30.0 + warp*2.0));
      float patchN = afbm2(vec2(fx*0.9 + 3.0, ty*5.5));
      float lace = (1.0 - smoothstep(0.0, 0.06, lc)) * smoothstep(0.4, 0.7, patchN) * 0.6;
      float foamPatch = smoothstep(0.55, 0.75, patchN) * (0.4 + 0.6*smoothstep(-1.0, 1.5, xr));
      trough = mix(trough, vec3(0.90, 0.95, 0.96), clamp(lace*0.85 + foamPatch*0.6, 0.0, 1.0));
      water = mix(water, trough, tz);
    }
    col = mix(col, water, wa);
  }

  // bright, slightly punchy grade with a light vignette
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.08);
  vec2 uv = gl_FragCoord.xy / uRes;
  col *= 1.0 - 0.14 * pow(length(uv - 0.5) * 1.2, 2.0);
  col += (hash(gl_FragCoord.xy + fract(T)*100.0) - 0.5) * 0.02;
  gl_FragColor = vec4(col, 1.0);
}`;

  const gl = glc.getContext('webgl', { antialias: false, premultipliedAlpha: false });
  let prog, uni = {};
  if (gl) {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['uRes', 'uOrigin', 'uUnit', 'uTime', 'uC']) uni[n] = gl.getUniformLocation(prog, n);
  }

  function resize() {
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height) return;          // hidden or not laid out yet: keep the last size
    W = r.width; H = r.height;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    U = Math.min(H / 2, W / 1.25);
    c2.width = Math.round(W * DPR); c2.height = Math.round(H * DPR);
    GS = Math.min(DPR, 1.5) * QUALITY[qLevel];   // crisp, capped at 1.5x on retina
    glc.width = Math.round(W * GS); glc.height = Math.round(H * GS);
    if (gl) gl.viewport(0, 0, glc.width, glc.height);
  }
  new ResizeObserver(resize).observe(root);
  // Pause everything while the header is scrolled out of view
  let onScreen = true;
  new IntersectionObserver(([en]) => { onScreen = en.isIntersecting; }).observe(root);
  // Adaptive resolution: if frames run slow, render the wave at a lower resolution (it is soft
  // water, so this is hard to notice). It only steps down, so it never flickers between levels.
  let slowT = 0, avgDt = 1 / 60;
  function adaptQuality(dt) {
    avgDt += (dt - avgDt) * 0.05;
    slowT = avgDt > 1 / 45 ? slowT + dt : 0;
    if (slowT > 1 && qLevel < QUALITY.length - 1) { qLevel++; slowT = 0; resize(); }
  }
  resize();

  // ---------------------------------------------------------------------------
  // Head image -> soft-edged bobble head
  // ---------------------------------------------------------------------------
  let headCan = null;
  const img = new Image();
  img.onload = () => {
    const w = HEAD.rx * 2, h = HEAD.ry * 2;
    headCan = document.createElement('canvas'); headCan.width = w; headCan.height = h;
    const hc = headCan.getContext('2d');
    if (HEAD.flip) { hc.translate(w, 0); hc.scale(-1, 1); }
    hc.drawImage(img, -(HEAD.cx - HEAD.rx), -(HEAD.cy - HEAD.ry));
    hc.setTransform(1, 0, 0, 1, 0, 0);
    if (!HEAD.cutout) {
      hc.globalCompositeOperation = 'destination-in';
      hc.save(); hc.translate(HEAD.rx, HEAD.ry); hc.scale(1, HEAD.ry / HEAD.rx);
      const g = hc.createRadialGradient(0, 0, HEAD.rx * 0.82, 0, 0, HEAD.rx);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      hc.fillStyle = g; hc.fillRect(-HEAD.rx, -HEAD.rx, HEAD.rx * 2, HEAD.rx * 2);
      hc.restore();
    }
    if (HEAD.neckLine) maskNeck(hc, w, h);
  };
  // Erase the skin under the jaw so the beard's wispy edge becomes the outline.
  // Grey/white beard hairs have low saturation; skin is warm and saturated.
  function maskNeck(hc, w, h) {
    const toCan = ([x, y]) => {
      const cx = x - (HEAD.cx - HEAD.rx);
      return [HEAD.flip ? w - cx : cx, y - (HEAD.cy - HEAD.ry)];
    };
    const [a, b] = HEAD.neckLine.map(toCan);
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
    if (ny < 0) { nx = -nx; ny = -ny; }                // normal points down, toward the neck
    let data;
    try { data = hc.getImageData(0, 0, w, h); } catch (e) { return; }   // e.g. opened from file://
    const d = data.data;
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - 30));
    for (let y = y0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const below = (x - a[0]) * nx + (y - a[1]) * ny;
        if (below < -12) continue;
        const i = (y * w + x) * 4; if (!d[i + 3]) continue;
        const r = d[i], g = d[i + 1], bl = d[i + 2], mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
        const sat = mx ? (mx - mn) / mx : 0;
        const skin = smooth(0.17, 0.30, sat) * (r > bl ? 1 : 0);
        const region = smooth(-12, 22, below);
        d[i + 3] = d[i + 3] * (1 - skin * region);
      }
    }
    hc.putImageData(data, 0, 0);
  }
  img.src = HEAD.src;

  // Head sizing in world units
  const HEAD_RY = 0.48;                        // half height of the head on screen
  const HEAD_S = HEAD_RY / HEAD.ry;            // world units per image px
  const HEAD_C = { x: 0, y: -0.30 };           // the head stays here
  const BODY_LIFT_PX = 20;                    // raise the body (not the head) by this many screen pixels
  const NECK_Y = HEAD_C.y + (HEAD.neckY - HEAD.cy) * HEAD_S;
  const liftUnits = () => (U > 20 ? BODY_LIFT_PX / U : 0);
  const N = { x: 0, y: NECK_Y - liftUnits() }; // neck pin

  // ---------------------------------------------------------------------------
  // Rag doll (verlet). Rest pose is relative to the neck, y down.
  // ---------------------------------------------------------------------------
  const BS = 0.86;                             // body scale (smaller body = bigger bobble)
  const REST_RAW = {
    neck: [0, 0], shL: [-0.115, 0.06], shR: [0.115, 0.06], hipL: [-0.08, 0.31], hipR: [0.08, 0.31],
    // arms out wide for balance: back arm (L, mirrored to screen right) straight, front arm (R) softly bent
    elbL: [-0.27, 0.13], handL: [-0.42, 0.20], elbR: [0.27, 0.12], handR: [0.41, 0.22],
    kneeL: [-0.23, 0.45], footL: [-0.22, 0.70], kneeR: [0.23, 0.44], footR: [0.22, 0.70]
  };
  const REST = Object.fromEntries(Object.entries(REST_RAW).map(([k, v]) => [k, [-v[0] * BS, v[1] * BS]])); // mirrored: riding left
  const HIP_Y = 0.31 * BS;
  const STIFF = { neck: 0, shL: .3, shR: .3, hipL: .25, hipR: .25, elbL: .14, handL: .12, elbR: .12, handR: .09,
    kneeL: .12, kneeR: .12, footL: 0, footR: 0 };
  const PINNED = new Set(['neck', 'footL', 'footR']);
  const LINKS = [['neck', 'shL'], ['neck', 'shR'], ['shL', 'shR'], ['shL', 'hipL'], ['shR', 'hipR'], ['hipL', 'hipR'],
    ['shL', 'hipR'], ['shR', 'hipL'], ['neck', 'hipL'], ['neck', 'hipR'],
    ['shL', 'elbL'], ['elbL', 'handL'], ['shR', 'elbR'], ['elbR', 'handR'],
    ['hipL', 'kneeL'], ['kneeL', 'footL'], ['hipR', 'kneeR'], ['kneeR', 'footR']];
  const BOARD_REST = 0.735 * BS, FOOT_OFF = 0.22 * BS, FOOT_LIFT = 0.035 * BS, BOARD_L = 0.98 * BS;
  const REACH_MAX = 0.79 * BS, REACH_MIN = 0.30 * BS;

  const pts = {};
  for (const k in REST) { const x = N.x + REST[k][0], y = N.y + REST[k][1]; pts[k] = { x, y, px: x, py: y }; }
  const links = LINKS.map(([a, b]) => ({ a: pts[a], b: pts[b], an: a, bn: b,
    len: Math.hypot(REST[a][0] - REST[b][0], REST[a][1] - REST[b][1]) }));
  // Rail grabs: a hand that comes near the board while you drag it latches onto the rail
  // (stored in board-local coords: u along the board, n across it) until you let go.
  const grabs = { handL: null, handR: null };
  const grabCool = { handL: 0, handR: 0 };
  const ARM_REACH = Math.hypot(REST.shL[0] - REST.elbL[0], REST.shL[1] - REST.elbL[1]) +
    Math.hypot(REST.elbL[0] - REST.handL[0], REST.elbL[1] - REST.handL[1]);

  const B = { x: N.x, y: N.y + BOARD_REST, vx: 0, vy: 0, a: 0, rel: 0, relV: 0, relT: 0, spinning: false,
    flip: 0, flipping: false, omega: 0, pvx: 0, pvy: 0 };
  const head = { a: 0, v: 0 };

  let drag = false, ptr = { x: 0, y: 0 }, grab = { x: 0, y: 0 }, interacted = false;
  let lastMoveT = 0, popT = 0, nextPop = 4;

  function frame() {
    const dx = B.x - N.x, dy = B.y - N.y, d = Math.hypot(dx, dy) || 1e-4;
    const dv = { x: dx / d, y: dy / d }, rv = { x: dv.y, y: -dv.x };
    return { dv, rv, d };
  }

  function resetPose() {
    for (const k in REST) { const p = pts[k]; p.x = p.px = N.x + REST[k][0]; p.y = p.py = N.y + REST[k][1]; }
    Object.assign(B, { x: N.x, y: N.y + BOARD_REST, vx: 0, vy: 0, rel: 0, relV: 0, relT: 0, spinning: false, flip: 0, flipping: false, omega: 0 });
    head.a = head.v = 0;
  }
  function step(dt, t) {
    if (!Number.isFinite(B.x + B.y + B.rel + pts.handL.x + head.a)) resetPose();   // recover from any bad frame
    // ---- board ----
    let tx, ty, k, c;
    if (drag) { tx = ptr.x + grab.x; ty = ptr.y + grab.y; k = 700; c = 45; }
    else {
      tx = N.x + (REDUCED ? 0 : 0.03 * Math.sin(t * 0.8));
      ty = N.y + BOARD_REST + (REDUCED ? 0 : 0.015 * Math.sin(t * 1.6));
      if (popT > 0) { ty -= 0.16 * Math.sin(Math.PI * (1 - popT / 0.45)); popT -= dt; }
      k = 90; c = 5.5;
    }
    B.pvx = B.vx; B.pvy = B.vy;
    B.vx += (k * (tx - B.x) - c * B.vx) * dt;
    B.vy += (k * (ty - B.y) - c * B.vy) * dt;
    B.x += B.vx * dt; B.y += B.vy * dt;
    let { dv, rv, d } = frame();
    if (d > REACH_MAX || d < REACH_MIN) {
      const cd = Math.min(REACH_MAX, Math.max(REACH_MIN, d));
      B.x = N.x + dv.x * cd; B.y = N.y + dv.y * cd;
      const vr = B.vx * dv.x + B.vy * dv.y; B.vx -= vr * dv.x * 0.9; B.vy -= vr * dv.y * 0.9;
      d = cd;
    }
    const omega = ((B.x - N.x) * B.vy - (B.y - N.y) * B.vx) / (d * d);
    const dOmega = omega - B.omega; B.omega = omega;

    // board spin relative to the body
    if (B.spinning) {
      B.rel += B.relV * dt; B.relV *= Math.pow(0.4, dt);
      if (Math.abs(B.relV) < 4) { B.spinning = false; B.relT = Math.round(B.rel / TAU) * TAU; }
    } else {
      B.relV -= dOmega * 0.5;
      const idle = drag ? 0 : 0.07 * Math.sin(t * 0.8 + 0.6);
      B.relV += ((B.relT + idle - B.rel) * 60 - B.relV * 6) * dt;
      B.rel += B.relV * dt;
    }
    if (B.flipping) { B.flip += dt * TAU / 0.5; if (B.flip >= TAU) { B.flip = 0; B.flipping = false; } }
    B.a = Math.atan2(rv.y, rv.x) + B.rel;

    // head bobble
    const ax = (B.vx - B.pvx) / dt;
    head.v += (-dOmega * 0.35 / dt * 0.01 - ax * 0.0009) ;
    head.v += (-head.a * 120 - head.v * 5) * dt;
    head.a += head.v * dt;
    head.a = Math.max(-0.45, Math.min(0.45, head.a));

    // ---- rag doll ----
    const ca = Math.cos(B.a), sa = Math.sin(B.a);
    const foot = (s) => ({ x: B.x + ca * FOOT_OFF * s + sa * FOOT_LIFT, y: B.y + sa * FOOT_OFF * s - ca * FOOT_LIFT });
    const pins = { neck: N, footL: foot(1), footR: foot(-1) };   // pose is mirrored (riding left)
    const onBoard = (u, n) => ({ x: B.x + ca * u - sa * n, y: B.y + sa * u + ca * n });
    for (const hk of ['handL', 'handR']) {
      const h = pts[hk], sh = hk === 'handL' ? pts.shL : pts.shR;
      grabCool[hk] = Math.max(0, grabCool[hk] - dt);
      if (!grabs[hk] && drag && !grabCool[hk]) {
        const rx = h.x - B.x, ry = h.y - B.y, u = rx * ca + ry * sa, n = -rx * sa + ry * ca;
        if (Math.abs(u) < BOARD_L * 0.45 && Math.abs(n) < 0.075) grabs[hk] = { u, n: Math.max(-0.03, Math.min(0.03, n)) };
      }
      if (grabs[hk]) {
        const g = onBoard(grabs[hk].u, grabs[hk].n);
        // let go if the board gets pulled out of reach
        if (Math.hypot(g.x - sh.x, g.y - sh.y) > ARM_REACH * 1.35) { grabs[hk] = null; grabCool[hk] = 0.4; }
        else pins[hk] = g;
      }
    }
    const legScale = Math.min(1.1, Math.max(0.35, d / BOARD_REST));
    const G = 1.6 * dt * dt;
    for (const kk in pts) {
      const p = pts[kk];
      if (pins[kk]) { p.x = p.px = pins[kk].x; p.y = p.py = pins[kk].y; continue; }
      const vx = (p.x - p.px) * 0.985, vy = (p.y - p.py) * 0.985;
      p.px = p.x; p.py = p.y; p.x += vx; p.y += vy + G;
      const [lx, ly0] = REST[kk];
      const ly = ly0 > HIP_Y ? HIP_Y + (ly0 - HIP_Y) * legScale : ly0;
      const gx = N.x + rv.x * lx + dv.x * ly, gy = N.y + rv.y * lx + dv.y * ly;
      p.x += (gx - p.x) * STIFF[kk]; p.y += (gy - p.y) * STIFF[kk];
    }
    for (let it = 0; it < 10; it++) {
      for (const L of links) {
        const ddx = L.b.x - L.a.x, ddy = L.b.y - L.a.y, dist = Math.hypot(ddx, ddy) || 1e-5;
        const ia = pins[L.an] ? 0 : 1, ib = pins[L.bn] ? 0 : 1, w = ia + ib; if (!w) continue;
        const diff = (dist - L.len) / dist / w;
        L.a.x += ddx * diff * ia; L.a.y += ddy * diff * ia;
        L.b.x -= ddx * diff * ib; L.b.y -= ddy * diff * ib;
      }
    }

    // ---- spray ----
    const speed = Math.hypot(B.vx, B.vy);
    const onFace = B.y > -crestY(B.x, t) + 0.05;          // anywhere below the crest is wave face
    if (onFace) {
      // carving up the face throws a big fan of spray off the rail, in front of the surfer
      const climb = Math.min(6, Math.max(0, -B.vy));
      for (let i = 0; i < climb * 520 * dt; i++) {
        const u = (Math.random() * 1.2 - 0.3) * BOARD_L / 2;  // mostly the tail half (+u)
        const px = B.x + ca * u - sa * 0.02, py = B.y + sa * u + ca * 0.02;
        const q = spawn(px, py, B.vx * 0.5 + (Math.random() - 0.5) * 0.9,
          Math.max(-2.6, B.vy * (0.6 + Math.random() * 0.5)) - Math.random() * 0.7,
          0.5 + Math.random() * 0.6, 0.004 + Math.random() * 0.012, 0.9);
        if (q) q.front = true;
        // mist puffs stay behind the surfer so they never fog the face
        if (Math.random() < 0.12) spawn(px, py, B.vx * 0.3, Math.max(-1.5, B.vy * 0.4) - 0.3, 1.0 + Math.random() * 0.6, 0.05 + Math.random() * 0.07, 0.25);
      }
    }
    if (onFace) {
      const rate = 70 + speed * 160;
      for (let i = 0; i < rate * dt; i++) {
        const tail = BOARD_L / 2 - Math.random() * 0.15;     // riding left, so the tail is on the right
        spawn(B.x + ca * tail, B.y + sa * tail + 0.02,
          ca * (0.5 + Math.random() * 0.5) - B.vx * 0.3 + (Math.random() - 0.5) * 0.3,
          -0.4 - Math.random() * 0.6 - Math.abs(B.vy) * 0.2, 0.35 + Math.random() * 0.35, 0.004 + Math.random() * 0.008, 0.75);
        if (Math.random() < 0.08) spawn(B.x + ca * tail, B.y + sa * tail, ca * 0.4, -0.3, 0.8, 0.04 + Math.random() * 0.04, 0.2);
      }
    }
    if (REDUCED) return;                         // no ambient spray with reduced motion
    // spray feathering off the crest, blown back over the top
    const xL = -W / 2 / U, xR = W / 2 / U;
    const lipEnd = Math.min(xR, tube.x + MA * 0.8);
    for (let i = 0; i < 70 * dt * Math.max(0, lipEnd - xL); i++) {
      const x = xL + Math.random() * (lipEnd - xL);
      const y = -crestY(x, t);
      spawn(x, y, (Math.random() - 0.4) * 0.25, -0.25 - Math.random() * 0.45, 0.9 + Math.random(), 0.004 + Math.random() * 0.01, 0.7);
      if (Math.random() < 0.15) spawn(x, y, 0.05, -0.15, 1.6, 0.05 + Math.random() * 0.06, 0.12);
    }
    // the big plume over the curl: droplets and puffs thrown up and back on the wind
    const plumeL = Math.max(xL, tube.x - 2.2), plumeR = Math.min(xR, tube.x + 0.3);
    for (let i = 0; i < 150 * dt * Math.max(0, plumeR - plumeL); i++) {
      const x = plumeL + Math.random() * (plumeR - plumeL);
      const k = Math.exp(-Math.pow((x - tube.x + 0.8) / 0.9, 2));     // strongest just behind the barrel
      if (Math.random() > k) continue;
      const y = -crestY(x, t);
      spawn(x, y, -0.15 - Math.random() * 0.35, -0.7 - Math.random() * 0.9, 0.6 + Math.random() * 0.6, 0.003 + Math.random() * 0.007, 0.9);
      if (Math.random() < 0.25) spawn(x, y + 0.02, -0.12 - Math.random() * 0.2, -0.35 - Math.random() * 0.4, 1.4 + Math.random(), 0.05 + Math.random() * 0.08, 0.16);
    }
    // explosion where the lip lands, right of the barrel
    const exX = tube.x + MA * 0.2;
    if (exX < xR + 0.2) for (let i = 0; i < 60 * dt; i++) {
      spawn(exX + Math.random() * (MA + 0.8), -(tube.y - MB) + 0.02, (Math.random() - 0.3) * 0.6, -0.8 - Math.random() * 1.4,
        1.2 + Math.random(), 0.04 + Math.random() * 0.09, 0.2);
      if (Math.random() < 0.5) spawn(exX + Math.random() * MA, -(tube.y - MB), (Math.random() - 0.5) * 0.8, -1.2 - Math.random(),
        0.7, 0.005 + Math.random() * 0.01, 0.8);
    }
  }

  // ---------------------------------------------------------------------------
  // Particles
  // ---------------------------------------------------------------------------
  const parts = [];
  function spawn(x, y, vx, vy, life, size, alpha) {
    if (parts.length > 1500) return null;
    const q = { x, y, vx, vy, life, max: life, size, alpha }; parts.push(q); return q;
  }
  function updateParts(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt; if (p.life <= 0) { parts.splice(i, 1); continue; }
      p.vy += 1.3 * dt * (p.size > 0.03 ? 0.15 : 1); p.vx *= 0.995;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
  }
  const sprite = document.createElement('canvas'); sprite.width = sprite.height = 64;
  { const s = sprite.getContext('2d'), g = s.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(240,250,252,.8)'); g.addColorStop(1, 'rgba(230,245,250,0)');
    s.fillStyle = g; s.fillRect(0, 0, 64, 64); }
  function drawParts(filter) {
    for (const p of parts) {
      if (!filter(p)) continue;
      const f = p.life / p.max;
      ctx.globalAlpha = p.alpha * Math.min(1, f * 2.5) * Math.min(1, (1 - f) * 10 + 0.2);
      const s = p.size * (p.size > 0.03 ? 1 + (1 - f) * 1.5 : 1);
      ctx.drawImage(sprite, p.x - s, p.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------
  // Drawing the surfer
  // ---------------------------------------------------------------------------
  const LIGHT = { x: -0.6, y: -0.8 };          // sun is up and to the left (matches the wave shader)
  const SKIN = { dark: '#8f5641', base: '#cf9176', hi: '#f2c4a8', rim: '#b9775d' };            // matched to the face photo
  const SHORTS = { dark: '#0d2c63', base: '#1f5fc4', hi: '#5c9cf0', rim: '#16438f', gloss: true };
  const BOARD = { deck: ['#ffb453', '#f7a03a', '#ee8f2b'], rail: ['#f7a640', '#d66a17', '#9c4310'],
    bottom: ['#ffd9a0', '#f3a54b', '#c86a1d'], stringer: 'rgba(150,80,25,.18)' };     // golden-hour orange
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const sstep = t => t * t * (3 - 2 * t);

  const LIMB_BULK = 1.15;                      // overall muscle mass
  // Half-widths along a limb, [t, +normal side, -normal side]
  const PROF = {
    thigh:   [[0, .046, .046], [.3, .048, .047], [.75, .037, .036], [1, .031, .030]],
    shin:    [[0, .030, .030], [.22, .034, .036], [.6, .025, .026], [.9, .019, .019], [1, .019, .019]],
    upper:   [[0, .036, .036], [.25, .034, .033], [.7, .027, .026], [1, .024, .023]],
    fore:    [[0, .025, .024], [.3, .027, .026], [.85, .019, .018], [1, .018, .017]],
  };
  function profAt(prof, t) {
    for (let i = 1; i < prof.length; i++) {
      if (t <= prof[i][0]) {
        const [t0, l0, r0] = prof[i - 1], [t1, l1, r1] = prof[i], k = sstep((t - t0) / (t1 - t0));
        return [(l0 + (l1 - l0) * k) * LIMB_BULK, (r0 + (r1 - r0) * k) * LIMB_BULK];
      }
    }
    const l = prof[prof.length - 1]; return [l[1] * LIMB_BULK, l[2] * LIMB_BULK];
  }
  // Light-facing side of a direction's normal: returns +1/-1
  const litSide = (nx, ny) => (nx * LIGHT.x + ny * LIGHT.y >= 0 ? 1 : -1);
  // Rounded-form shading across a limb or torso: soft for skin, a tighter sheen for wet fabric,
  // plus a little bounced light from the water on the shadow edge
  function sheenGrad(cx, cy, nx, ny, w, col) {
    const s = litSide(nx, ny);
    const g = ctx.createLinearGradient(cx + nx * w * s, cy + ny * w * s, cx - nx * w * s, cy - ny * w * s);
    if (col.gloss) {
      g.addColorStop(0, col.base); g.addColorStop(0.12, col.hi); g.addColorStop(0.28, col.base);
      g.addColorStop(0.82, col.dark); g.addColorStop(1, col.rim);
    } else {
      g.addColorStop(0, col.base); g.addColorStop(0.2, col.hi); g.addColorStop(0.5, col.base);
      g.addColorStop(0.86, col.dark); g.addColorStop(1, col.rim);
    }
    return g;
  }

  function sculpt(a, b, prof, col) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-4;
    const nx = -dy / len, ny = dx / len, an = Math.atan2(ny, nx);
    const L = [], R = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14, [wl, wr] = profAt(prof, t), cx = a.x + dx * t, cy = a.y + dy * t;
      L.push([cx + nx * wl, cy + ny * wl]); R.push([cx - nx * wr, cy - ny * wr]);
    }
    const [al, ar] = profAt(prof, 0), [bl, br] = profAt(prof, 1);
    ctx.beginPath();
    ctx.moveTo(L[0][0], L[0][1]);
    for (const q of L) ctx.lineTo(q[0], q[1]);
    ctx.arc(b.x + nx * (bl - br) / 2, b.y + ny * (bl - br) / 2, (bl + br) / 2, an, an - Math.PI, true);
    for (let i = R.length - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
    ctx.arc(a.x + nx * (al - ar) / 2, a.y + ny * (al - ar) / 2, (al + ar) / 2, an + Math.PI, an, true);
    ctx.closePath();
    const m = lerp(a, b, 0.4), [ml, mr] = profAt(prof, 0.4);
    ctx.fillStyle = sheenGrad(m.x, m.y, nx, ny, Math.max(ml, mr) * 1.05, col);
    ctx.fill();
  }

  // Closed Catmull-Rom curve through points
  function smoothPath(P) {
    const n = P.length;
    ctx.moveTo(P[0].x, P[0].y);
    for (let i = 0; i < n; i++) {
      const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
      ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
    }
  }

  function drawTorso(p) {
    const mS = lerp(p.shL, p.shR, 0.5), mH = lerp(p.hipL, p.hipR, 0.5);
    const tl = Math.hypot(mH.x - mS.x, mH.y - mS.y) || 1e-4;
    const dn = { x: (mH.x - mS.x) / tl, y: (mH.y - mS.y) / tl };
    const sw = { x: -dn.y, y: dn.x };
    const hw = Math.max(0.07, Math.hypot(p.shR.x - p.shL.x, p.shR.y - p.shL.y) / 2);
    const P = (v, u) => ({ x: mS.x + sw.x * v + dn.x * u * tl, y: mS.y + sw.y * v + dn.y * u * tl });
    const s = litSide(sw.x, sw.y);
    const soft = (pts, width, color) => {      // a soft shading stroke for muscle definition
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i += 2) ctx.quadraticCurveTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      ctx.stroke();
    };

    // no neck: the beard sits straight onto the shoulders

    const side = k => [P(k * hw * 0.42, -0.17), P(k * hw * 0.85, -0.06), P(k * hw * 1.12, 0.04), P(k * hw * 1.22, 0.16), P(k * hw * 1.08, 0.42),
      P(k * hw * 0.86, 0.72), P(k * hw * 0.92, 0.98)];
    const outline = [...side(1), P(0, 1.10), ...side(-1).reverse()];
    ctx.beginPath(); smoothPath(outline); ctx.closePath();
    ctx.fillStyle = sheenGrad(mS.x + dn.x * tl * 0.35, mS.y + dn.y * tl * 0.35, sw.x, sw.y, hw * 1.25, SKIN);
    ctx.fill();
    ctx.save(); ctx.clip();
    // sunlit chest
    const c = P(s * hw * 0.45, 0.2);
    const rg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, hw * 0.9);
    rg.addColorStop(0, 'rgba(255,225,200,.35)'); rg.addColorStop(1, 'rgba(255,225,200,0)');
    ctx.fillStyle = rg; ctx.fillRect(mS.x - 1, mS.y - 1, 2, 2);
    const shade = 'rgba(110,55,38,.32)', light = 'rgba(255,228,205,.35)';
    // collarbones
    for (const k of [1, -1]) soft([P(k * hw * 0.12, 0.0), P(k * hw * 0.5, -0.02), P(k * hw * 0.95, 0.04)], 0.006, light);
    // pecs: soft shadow along the lower edge
    for (const k of [1, -1]) soft([P(k * hw * 0.06, 0.24), P(k * hw * 0.5, 0.44), P(k * hw * 1.0, 0.28)], 0.016, shade);
    // centre line and abs
    soft([P(0, 0.1), P(0, 0.4), P(0, 0.72)], 0.007, shade);
    for (const u of [0.5, 0.62]) for (const k of [1, -1]) soft([P(k * hw * 0.06, u), P(k * hw * 0.28, u + 0.03), P(k * hw * 0.42, u)], 0.007, shade);
    // obliques
    for (const k of [1, -1]) soft([P(k * hw * 0.95, 0.42), P(k * hw * 0.62, 0.62), P(k * hw * 0.6, 0.84)], 0.014, 'rgba(110,55,38,.22)');
    // navel
    const nv = P(0, 0.76); ctx.fillStyle = 'rgba(95,45,30,.55)'; ctx.beginPath(); ctx.ellipse(nv.x, nv.y, 0.006, 0.009, Math.atan2(dn.y, dn.x) - Math.PI / 2, 0, TAU); ctx.fill();

    // boardshorts: waistband sits just below the navel
    const wb = 0.82;
    ctx.beginPath(); smoothPath([P(-hw * 1.4, wb + 0.02), P(0, wb + 0.05), P(hw * 1.4, wb + 0.02), P(hw * 1.4, 1.3), P(-hw * 1.4, 1.3)]);
    ctx.closePath();
    ctx.fillStyle = sheenGrad(P(0, 0.95).x, P(0, 0.95).y, sw.x, sw.y, hw * 1.1, SHORTS); ctx.fill();
    soft([P(-hw * 1.2, wb + 0.03), P(0, wb + 0.06), P(hw * 1.2, wb + 0.03)], 0.006, 'rgba(10,30,70,.6)');
    // drawstring
    const d0 = P(0, wb + 0.06);
    ctx.strokeStyle = '#f2f4f7'; ctx.lineWidth = 0.003;
    ctx.beginPath(); ctx.moveTo(d0.x, d0.y); ctx.quadraticCurveTo(P(-hw * 0.12, wb + 0.2).x, P(-hw * 0.12, wb + 0.2).y, P(-hw * 0.05, wb + 0.28).x, P(-hw * 0.05, wb + 0.28).y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(d0.x, d0.y); ctx.quadraticCurveTo(P(hw * 0.14, wb + 0.18).x, P(hw * 0.14, wb + 0.18).y, P(hw * 0.1, wb + 0.25).x, P(hw * 0.1, wb + 0.25).y); ctx.stroke();
    ctx.restore();
  }

  function drawHand(e, h) {
    const dx = h.x - e.x, dy = h.y - e.y, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
    ctx.save(); ctx.translate(h.x + ux * 0.012, h.y + uy * 0.012); ctx.rotate(Math.atan2(uy, ux));
    const s = litSide(-uy, ux);
    const g = ctx.createLinearGradient(0, -0.03 * s, 0, 0.03 * s);
    g.addColorStop(0, SKIN.hi); g.addColorStop(0.45, SKIN.base); g.addColorStop(1, SKIN.dark);
    ctx.fillStyle = g;
    // palm + relaxed fingers
    ctx.beginPath(); smoothPath([{ x: -0.006, y: -0.019 }, { x: 0.03, y: -0.021 }, { x: 0.058, y: -0.012 }, { x: 0.064, y: 0.004 },
      { x: 0.05, y: 0.018 }, { x: 0.02, y: 0.02 }, { x: -0.006, y: 0.016 }]); ctx.closePath(); ctx.fill();
    // thumb
    ctx.beginPath(); ctx.ellipse(0.022, -0.022, 0.018, 0.008, -0.5, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(110,60,40,.45)'; ctx.lineWidth = 0.002;
    for (const y of [-0.006, 0.004, 0.013]) { ctx.beginPath(); ctx.moveTo(0.036, y); ctx.lineTo(0.058, y * 0.8); ctx.stroke(); }
    ctx.restore();
  }

  function drawFoot(f) {
    ctx.save(); ctx.translate(f.x, f.y + 0.004); ctx.rotate(B.a);
    const g = ctx.createLinearGradient(0, -0.03, 0, 0.022);
    g.addColorStop(0, SKIN.hi); g.addColorStop(0.5, SKIN.base); g.addColorStop(1, SKIN.dark);
    ctx.fillStyle = g;
    // seen from slightly above: heel tucked behind, toes splayed toward us
    ctx.beginPath(); smoothPath([{ x: -0.03, y: -0.004 }, { x: -0.012, y: -0.02 }, { x: 0.018, y: -0.02 }, { x: 0.036, y: -0.006 },
      { x: 0.036, y: 0.012 }, { x: 0.0, y: 0.02 }, { x: -0.03, y: 0.014 }]); ctx.closePath(); ctx.fill();
    ctx.fillStyle = SKIN.base;
    for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.ellipse(-0.022 + i * 0.012, 0.018, 0.0055 - i * 0.0004, 0.005, 0, 0, TAU); ctx.fill(); }
    ctx.restore();
  }

  // kneecap: a little highlight and a crease under it
  function drawKnee(h, k, a) {
    const dx = a.x - h.x, dy = a.y - h.y;
    ctx.save(); ctx.translate(k.x, k.y); ctx.rotate(Math.atan2(dy, dx) - Math.PI / 2);
    const g = ctx.createRadialGradient(-0.004, -0.004, 0, 0, 0, 0.026);
    g.addColorStop(0, 'rgba(255,225,205,.45)'); g.addColorStop(1, 'rgba(255,225,205,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, -0.004, 0.026, 0.024, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(110,55,38,.3)'; ctx.lineWidth = 0.003; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-0.012, 0.016); ctx.quadraticCurveTo(0, 0.022, 0.012, 0.016); ctx.stroke();
    ctx.restore();
  }

  // the loose leg of the boardshorts over the top of the thigh
  function drawShortsLeg(h, k) {
    const end = lerp(h, k, 0.62);
    sculpt(lerp(h, k, -0.3), end, [[0, .058, .058], [0.35, .052, .052], [1, .044, .044]], SHORTS);
    const dx = k.x - h.x, dy = k.y - h.y, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l, w = 0.043 * LIMB_BULK;
    // hem
    ctx.strokeStyle = 'rgba(8,25,60,.7)'; ctx.lineWidth = 0.005; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(end.x + nx * w, end.y + ny * w); ctx.lineTo(end.x - nx * w, end.y - ny * w); ctx.stroke();
    // white side stripe
    const sd = litSide(nx, ny) * -1, a0 = lerp(h, k, 0.0), a1 = lerp(h, k, 0.58);
    ctx.strokeStyle = 'rgba(245,248,252,.9)'; ctx.lineWidth = 0.007;
    ctx.beginPath(); ctx.moveTo(a0.x + nx * w * 0.7 * sd, a0.y + ny * w * 0.7 * sd); ctx.lineTo(a1.x + nx * w * 0.72 * sd, a1.y + ny * w * 0.72 * sd); ctx.stroke();
  }

  // ---------------------------------------------------------------------------
  // The board: a white shortboard seen from slightly above (rails, rocker, thruster fins, tail pad)
  // ---------------------------------------------------------------------------
  const BW = 0.105, VIEW_K = 0.28;
  const bWidth = t => BW * (t < 0.42 ? 0.6 + 0.4 * Math.sin(t / 0.42 * Math.PI / 2) : Math.pow(Math.max(0, Math.cos((t - 0.42) / 0.58 * Math.PI / 2)), 0.75));
  const bRock = t => -(0.075 * Math.pow(t, 3.2)) - 0.016 * Math.pow(1 - t, 2.6);
  const bThick = t => 0.024 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.94 + 0.03))), 0.6);
  const bX = t => (t - 0.5) * BOARD_L;

  function boardPath(fn, from = 0, to = 1, steps = 28) {
    for (let i = 0; i <= steps; i++) { const t = from + (to - from) * i / steps, [x, y] = fn(t); ctx.lineTo(x, y); }   // lineTo starts a path if empty, and continues one otherwise
  }
  function boardToWorld(lx, ly) {
    const fy = flipScale(), ca = Math.cos(B.a), sa = Math.sin(B.a), x = -lx, y = ly * fy;
    return { x: B.x + ca * x - sa * y, y: B.y + sa * x + ca * y };
  }
  function flipScale() { const fc = Math.cos(B.flip); return Math.abs(fc) < 0.08 ? 0.08 * Math.sign(fc || 1) : fc; }

  function drawBoard() {
    ctx.save();
    ctx.translate(B.x, B.y); ctx.rotate(B.a);
    const fy = flipScale(), deck = fy > 0;
    ctx.scale(-1, fy);                          // nose points left
    const far = t => [bX(t), bRock(t) - bWidth(t) * VIEW_K];
    const near = t => [bX(t), bRock(t) + bWidth(t) * VIEW_K];
    const nearB = t => [bX(t), bRock(t) + bWidth(t) * VIEW_K + bThick(t)];

    // thruster fins hanging under the tail
    for (const [t, off, h] of [[0.07, 0.6, 0.05], [0.13, 0.95, 0.055], [0.13, 0.15, 0.05]]) {
      const x = bX(t), y = bRock(t) + bWidth(t) * VIEW_K * off + bThick(t) * 0.8;
      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, 'rgba(25,40,48,.95)'); g.addColorStop(1, 'rgba(60,90,100,.75)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x - 0.012, y);
      ctx.quadraticCurveTo(x - 0.016, y + h * 0.7, x - 0.03, y + h); ctx.quadraticCurveTo(x + 0.012, y + h * 0.4, x + 0.03, y);
      ctx.closePath(); ctx.fill();
    }
    // near rail (the board's visible thickness), resin-tinted toward the bottom
    ctx.beginPath(); boardPath(near); boardPath(nearB, 1, 0); ctx.closePath();
    let g = ctx.createLinearGradient(0, -0.01, 0, 0.05);
    if (deck) { g.addColorStop(0, BOARD.rail[0]); g.addColorStop(0.55, BOARD.rail[1]); g.addColorStop(1, BOARD.rail[2]); }
    else { g.addColorStop(0, BOARD.deck[0]); g.addColorStop(1, BOARD.deck[2]); }
    ctx.fillStyle = g; ctx.fill();
    // deck (or bottom, mid-flip)
    ctx.beginPath(); boardPath(far); boardPath(near, 1, 0); ctx.closePath();
    g = ctx.createLinearGradient(0, -0.04, 0, 0.03);
    if (deck) { g.addColorStop(0, BOARD.deck[0]); g.addColorStop(0.55, BOARD.deck[1]); g.addColorStop(1, BOARD.deck[2]); }
    else { g.addColorStop(0, BOARD.bottom[0]); g.addColorStop(0.5, BOARD.bottom[1]); g.addColorStop(1, BOARD.bottom[2]); }
    ctx.fillStyle = g; ctx.fill();
    ctx.save(); ctx.clip();
    if (deck) {
      // stringer
      ctx.strokeStyle = BOARD.stringer; ctx.lineWidth = 0.0028;
      ctx.beginPath(); boardPath(t => [bX(t), bRock(t)], 0.0, 0.995); ctx.stroke();
      // tail traction pad: inset from the rails with a rounded front, so the tail reads as one piece
      const padIn = 0.6, t0 = 0.025, t1 = 0.19;
      ctx.beginPath(); boardPath(t => [bX(t), bRock(t) - bWidth(t) * VIEW_K * padIn], t0, t1, 8);
      ctx.quadraticCurveTo(bX(t1 + 0.03), bRock(t1), bX(t1), bRock(t1) + bWidth(t1) * VIEW_K * padIn);
      boardPath(t => [bX(t), bRock(t) + bWidth(t) * VIEW_K * padIn], t1, t0, 8);
      ctx.quadraticCurveTo(bX(t0 - 0.012), bRock(t0), bX(t0), bRock(t0) - bWidth(t0) * VIEW_K * padIn);
      ctx.closePath();
      ctx.fillStyle = 'rgba(74,44,24,.55)'; ctx.fill();
      ctx.strokeStyle = 'rgba(60,30,12,.25)'; ctx.lineWidth = 0.0016;
      for (let i = 1; i < 6; i++) { const t = t0 + i * 0.028; ctx.beginPath(); ctx.moveTo(bX(t), bRock(t) - bWidth(t) * VIEW_K * padIn * 0.85); ctx.lineTo(bX(t), bRock(t) + bWidth(t) * VIEW_K * padIn * 0.85); ctx.stroke(); }
      // wax haze where the front foot goes
      const wx = bX(0.68), wy = bRock(0.68);
      const wg = ctx.createRadialGradient(wx, wy, 0, wx, wy, 0.16);
      wg.addColorStop(0, 'rgba(255,255,248,.55)'); wg.addColorStop(1, 'rgba(255,255,248,0)');
      ctx.fillStyle = wg; ctx.fillRect(wx - 0.2, wy - 0.1, 0.4, 0.2);
    }
    // wet sheen
    ctx.strokeStyle = 'rgba(255,240,220,.35)'; ctx.lineWidth = 0.003;
    ctx.beginPath(); boardPath(t => [bX(t), bRock(t) + bWidth(t) * VIEW_K - 0.004], 0.25, 0.85, 16); ctx.stroke();
    ctx.restore();
    // crisp outline
    ctx.strokeStyle = 'rgba(20,40,45,.35)'; ctx.lineWidth = 0.002;
    ctx.beginPath(); boardPath(far); boardPath(nearB, 1, 0); ctx.closePath(); ctx.stroke();
    ctx.restore();
  }

  function drawLeash(ankleTop, ankle) {
    const plug = boardToWorld(bX(0.035), bRock(0.035));
    const cuff = lerp(ankleTop, ankle, 0.86);
    const mid = lerp(plug, cuff, 0.5);
    ctx.strokeStyle = '#121518'; ctx.lineWidth = 0.006; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(plug.x, plug.y);
    ctx.quadraticCurveTo(mid.x + 0.03, mid.y + 0.09, cuff.x, cuff.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(120,130,140,.5)'; ctx.lineWidth = 0.0018;
    ctx.beginPath(); ctx.moveTo(plug.x, plug.y - 0.002); ctx.quadraticCurveTo(mid.x + 0.03, mid.y + 0.087, cuff.x, cuff.y - 0.002); ctx.stroke();
    // velcro cuff
    ctx.fillStyle = '#1b1f23'; ctx.beginPath(); ctx.ellipse(cuff.x, cuff.y, 0.024, 0.012, B.a, 0, TAU); ctx.fill();
    ctx.fillStyle = '#d9a12b'; ctx.beginPath(); ctx.ellipse(cuff.x, cuff.y, 0.024, 0.003, B.a, 0, TAU); ctx.fill();
  }

  function drawSurfer() {
    const p = pts;
    // soft shadow of the board on the water
    if (B.y > N.y + 0.55) {
      ctx.save(); ctx.translate(B.x - 0.04, B.y + 0.07); ctx.rotate(B.a); ctx.scale(1, 0.12);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.5);
      g.addColorStop(0, 'rgba(0,30,40,.35)'); g.addColorStop(1, 'rgba(0,30,40,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 0.5, 0, TAU); ctx.fill(); ctx.restore();
    }
    drawParts(q => q.board);
    drawBoard();

    // legs (footL is the back foot, over the tail)
    for (const [h, k, f] of [[p.hipL, p.kneeL, p.footL], [p.hipR, p.kneeR, p.footR]]) {
      sculpt(k, f, PROF.shin, SKIN);
      drawFoot(f);
      sculpt(h, k, PROF.thigh, SKIN);
      drawKnee(h, k, f);
      drawShortsLeg(h, k);
    }
    drawLeash(p.kneeL, p.footL);

    // upper arms go under the torso so the deltoids cover the joint; forearms and hands on top
    const arms = [[p.shL, p.elbL, p.handL], [p.shR, p.elbR, p.handR]];
    for (const [s, e] of arms) sculpt(lerp(s, e, 0.05), e, PROF.upper, SKIN);
    drawTorso(p);
    for (const [s, e, h] of arms) {
      sculpt(e, h, PROF.fore, SKIN);
      drawHand(e, h);
      sculpt(lerp(e, s, 0.35), e, [[0, .029, .028], [1, .024, .023]], SKIN);   // elbow, over the forearm
    }
  }

  function drawHead() {
    ctx.save();
    ctx.translate(N.x, N.y); ctx.rotate(head.a);
    // contact shadow on the shoulders
    const sg = ctx.createRadialGradient(0, 0.02, 0, 0, 0.02, 0.2);
    sg.addColorStop(0, 'rgba(0,0,0,.45)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg; ctx.beginPath(); ctx.ellipse(0, 0.03, 0.22, 0.09, 0, 0, TAU); ctx.fill();
    const cy = HEAD_C.y - N.y;
    const w = HEAD.rx * 2 * HEAD_S, h = HEAD.ry * 2 * HEAD_S;
    if (headCan) ctx.drawImage(headCan, -w / 2, cy - h / 2, w, h);
    else { ctx.fillStyle = SKIN.base; ctx.beginPath(); ctx.ellipse(0, cy, w / 2 * 0.85, h / 2 * 0.9, 0, 0, TAU); ctx.fill(); }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  function toWorld(e) {
    const r = c2.getBoundingClientRect();
    return { x: (e.clientX - r.left - W / 2) / U, y: (e.clientY - r.top - H / 2) / U };
  }
  // On touch screens the banner must still scroll the page: only a touch that starts on or near the
  // board grabs it (and blocks scrolling); anywhere else the page scrolls as normal.
  const nearBoard = (m) => Math.hypot(m.x - B.x, m.y - B.y) < 0.45;
  c2.addEventListener('touchstart', e => {
    const t0 = e.touches[0]; if (t0 && nearBoard(toWorld(t0))) e.preventDefault();
  }, { passive: false });
  c2.addEventListener('pointerdown', e => {
    const m = toWorld(e);
    if (e.pointerType === 'touch' && !nearBoard(m)) return;
    c2.setPointerCapture(e.pointerId);
    drag = true; ptr = m; c2.classList.add('dragging');
    grab = Math.hypot(m.x - B.x, m.y - B.y) < 0.35 ? { x: B.x - m.x, y: B.y - m.y } : { x: 0, y: 0 };
    if (!interacted) { interacted = true; if (hint) hint.classList.add('gone'); }
    B.spinning = false; B.relT = Math.round(B.rel / TAU) * TAU;
  });
  c2.addEventListener('pointermove', e => { if (drag) ptr = toWorld(e); });
  const release = () => {
    if (!drag) return;
    drag = false; c2.classList.remove('dragging');
    for (const hk in grabs) if (grabs[hk]) { grabs[hk] = null; grabCool[hk] = 0.4; }
    const spin = B.omega;
    if (Math.abs(spin) > 5) { B.spinning = true; B.relV += spin * 1.4; }
    if (Math.abs(B.vy) > 3.5 && !B.flipping) B.flipping = true;
  };
  c2.addEventListener('pointerup', release);
  c2.addEventListener('pointercancel', release);

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------
  const DT = 1 / 120;
  let acc = 0, last = performance.now(), t = 0;
  function loop(now) {
    if (!onScreen) { last = now; requestAnimationFrame(loop); return; }   // scrolled away: do no work
    let dtR = Math.min(0.05, (now - last) / 1000); last = now;
    adaptQuality(dtR);
    acc += dtR;
    while (acc >= DT) {
      t += DT;
      N.y = NECK_Y - liftUnits();                 // keeps the lift in px whatever the header size
      tube.x = Math.min(0.62, (W / 2 / U) * 0.72) + 0.03 * Math.sin(t * 0.45);
      tube.y = -0.14 + 0.025 * Math.sin(t * 0.6 + 1.0);
      if (!interacted && !REDUCED) { nextPop -= DT; if (nextPop <= 0 && !drag) { popT = 0.45; nextPop = 6 + Math.random() * 4; } }
      step(DT, t);
      updateParts(DT);
      acc -= DT;
    }
    for (const p of parts) if (p.board === undefined) p.board = !p.front && p.size < 0.03 && p.y > N.y + 0.4 && Math.abs(p.x - B.x) < 0.8;

    if (gl) {
      gl.uniform2f(uni.uRes, glc.width, glc.height);
      gl.uniform2f(uni.uOrigin, glc.width / 2, glc.height / 2);
      gl.uniform1f(uni.uUnit, U * GS);
      gl.uniform1f(uni.uTime, REDUCED ? 8 : t % 600);
      gl.uniform2f(uni.uC, tube.x, tube.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c2.width, c2.height);
    ctx.setTransform(DPR * U, 0, 0, DPR * U, DPR * W / 2, DPR * H / 2);
    drawParts(p => !p.board && !p.front);
    drawSurfer();
    drawHead();
    drawParts(p => p.front);                     // carve spray flies in front of the surfer
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
