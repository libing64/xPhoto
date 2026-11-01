/* ==========================================================
   xPhoto — RAW 自动修图的网页端
   · 相册：读取 out/manifest.json
   · 编辑器：WebGL 单 pass 实时渲染，数学与 xphoto.py 的 render() 对齐
   ========================================================== */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ---------------- 参数定义 ---------------- */
  const GROUP = [
    {
      name: '光效',
      items: [
        { k: 'ev', label: '曝光', step: 0.01, dec: 2, unit: ' EV', zero: 0 },
        { k: 'contrast', label: '对比度', step: 1, dec: 0, zero: 0 },
        { k: 'highlights', label: '高光', step: 1, dec: 0, zero: 0 },
        { k: 'shadows', label: '阴影', step: 1, dec: 0, zero: 0 },
        { k: 'midtone', label: '中间调', step: 1, dec: 0, zero: 0 },
      ],
    },
    {
      name: '色彩',
      items: [
        { k: 'temp', label: '色温', step: 0.5, dec: 1, zero: 0 },
        { k: 'tint', label: '色调', step: 0.5, dec: 1, zero: 0 },
        { k: 'saturation', label: '饱和度', step: 1, dec: 0, zero: 0 },
        { k: 'vibrance', label: '鲜艳度', step: 1, dec: 0, zero: 0 },
      ],
    },
    {
      name: '色彩分级',
      items: [
        { k: 'shadowTint', label: '阴影色调', step: 1, dec: 0, zero: 0 },
        { k: 'highlightTint', label: '高光色调', step: 1, dec: 0, zero: 0 },
      ],
    },
    {
      name: '细节',
      items: [
        { k: 'clarity', label: '清晰度', step: 1, dec: 0, zero: 0 },
        { k: 'denoise', label: '降噪', step: 1, dec: 0, zero: 0 },
        { k: 'sharpen', label: '锐化', step: 1, dec: 0, zero: 0 },
      ],
    },
  ];

  /* 底座已经是 Python 端烘焙好的成品（out/<id>.jpg），所以这里的预设是
     「在自动结果之上再推一把」的增量；全零 = 原封不动的自动成品。 */
  const PRESETS = {
    base: { name: '原味', desc: '自动成品', p: {} },
    clear: {
      name: '通透', desc: '层次 +',
      p: { contrast: 8, shadows: 8, highlights: -6, midtone: 6, vibrance: 14, clarity: 18 },
    },
    film: {
      name: '胶片', desc: '柔高光',
      p: {
        contrast: -10, shadows: 14, highlights: -12, saturation: -8, vibrance: -4,
        temp: 4, shadowTint: -8, highlightTint: 6,
      },
    },
  };
  const PRESET_ORDER = ['base', 'clear', 'film'];

  /* ---------------- 状态 ---------------- */
  const state = {
    manifest: null,
    images: [],
    idx: 0,
    params: { ...PRESETS.base.p },
    presetKey: 'base',
    zoom: 1,
    panX: 0,
    panY: 0,
    split: 0.5,
    before: false,
    dirty: false,
    texW: 1,
    texH: 1,
    ready: false,
    glOk: true,
  };

  /* ---------------- WebGL ---------------- */
  const VERT = `#version 300 es
  in vec2 aPos;
  uniform float uZoom;
  uniform vec2 uPan;      // uv 单位
  out vec2 vUV;
  out vec2 vS;
  void main() {
    vec2 p = aPos * 0.5 + 0.5;        // 0..1, y 向上
    vec2 pd = vec2(p.x, 1.0 - p.y);   // 0..1, y 向下（画布空间）
    vS = pd;
    vUV = 0.5 + (pd - 0.5) / uZoom - uPan;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }`;

  const FRAG = `#version 300 es
  precision highp float;
  in vec2 vUV;
  in vec2 vS;
  out vec4 outColor;

  uniform sampler2D uTex;
  uniform vec2  uTexSize;
  uniform vec2  uTexel;
  uniform float uSplit;     // <0 关闭对比
  uniform int   uBefore;

  uniform float uEv, uContrast, uHighlights, uShadows, uMidtone,
                uTemp, uTint, uShadowTint, uHighlightTint,
                uSat, uVib, uClarity, uDenoise, uSharpen, uNoise, uWhite;

  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  float luma(vec3 c) { return dot(c, LW); }
  vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
  vec3 toDisp(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
  float invSS(float p) {
    float a = clamp(1.0 - 2.0 * p, -1.0, 1.0);
    return clamp(0.5 - sin(asin(a) / 3.0), 0.0, 1.0);
  }

  void main() {
    if (vUV.x < 0.0 || vUV.x > 1.0 || vUV.y < 0.0 || vUV.y > 1.0) discard;

    vec3 raw = texture(uTex, vUV).rgb;

    // 原片区域 / 按住对比：直接输出
    if (uBefore == 1 || (uSplit >= 0.0 && vS.x < uSplit)) {
      outColor = vec4(raw, 1.0);
      return;
    }

    vec3 c = raw;

    /* --- 1. 降噪：亮度/色度分离的双边近似 --- */
    if (uDenoise > 0.004) {
      float sigma = max(uNoise * 3.0, 0.004);
      vec3 sum = c;
      float wsum = 1.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          if (x == 0 && y == 0) continue;
          vec3 s = texture(uTex, vUV + vec2(float(x), float(y)) * uTexel * 1.6).rgb;
          float d = distance(s, c);
          float w = exp(-(d * d) / (2.0 * sigma * sigma));
          sum += s * w;
          wsum += w;
        }
      }
      vec3 dn = sum / wsum;
      float y0 = luma(c);
      float y1 = luma(dn);
      float k = clamp(uDenoise, 0.0, 1.0);
      float yOut = mix(y0, y1, 0.95 * pow(k, 1.3));
      vec3 cOut = mix(c - y0, dn - y1, 0.95 * k);
      c = max(vec3(0.0), vec3(yOut) + cOut);
    }

    /* --- 2. 曝光 / 白平衡（伪线性域）--- */
    vec3 lin = toLin(c) * exp2(uEv);
    lin.r *= 1.0 + 0.30 * uTemp + 0.05 * uTint;
    lin.b *= 1.0 - 0.30 * uTemp + 0.05 * uTint;
    lin.g *= 1.0 - 0.16 * uTint;
    /* 高光肩部：darktable sigmoid 的扩展 Reinhard（中灰不变，白点平滑渐进到 1） */
    if (uWhite > 0.0001) {
      lin = lin * (1.0 + lin / (uWhite * uWhite)) / (1.0 + lin);
    }
    c = toDisp(lin);

    /* --- 3. 阴影 / 高光 --- */
    float L = luma(c);
    float ws = 1.0 - smoothstep(0.0, 0.58, L);
    c = c + uShadows * 0.30 * ws * (1.0 - c);
    float wh = smoothstep(0.36, 0.96, L);
    c = c * (1.0 + uHighlights * 0.34 * wh);
    c = clamp(c, 0.0, 1.0);

    /* --- 4. 对比 --- */
    if (uContrast > 0.0001) {
      c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
    } else if (uContrast < -0.0001) {
      c = mix(c, vec3(invSS(c.r), invSS(c.g), invSS(c.b)), -uContrast);
    }

    /* --- 5. 中间调 --- */
    if (abs(uMidtone) > 0.0001) {
      float L2 = luma(c);
      float bell = 1.0 - pow(abs(2.0 * L2 - 1.0), 1.7);
      c *= 1.0 + uMidtone * 0.42 * bell;
    }

    /* --- 6. 清晰度（双尺度局部对比，借 mipmap 取模糊）--- */
    if (abs(uClarity) > 0.0001) {
      float shortSide = min(uTexSize.x, uTexSize.y);
      float lodF = max(0.0, log2(shortSide / 420.0));
      float lodB = max(0.0, log2(shortSide / 42.0));
      vec3 bF = textureLod(uTex, vUV, lodF).rgb;
      vec3 bB = textureLod(uTex, vUV, lodB).rgb;
      float yc = luma(c);
      float fine = clamp(yc - luma(bF), -0.18, 0.18);
      float broad = clamp(yc - luma(bB), -0.25, 0.25);
      c += uClarity * 1.05 * (0.55 * fine + 0.50 * broad);
    }

    /* --- 7. 色彩分级：阴影/高光分离色调（color balance rgb）--- */
    if (abs(uShadowTint) > 0.0001 || abs(uHighlightTint) > 0.0001) {
      float Yg = luma(c);
      float ws = 1.0 - smoothstep(0.02, 0.55, Yg);
      float wh = smoothstep(0.45, 1.0, Yg);
      float g = uShadowTint * ws + uHighlightTint * wh;
      c.r *= 1.0 + 0.14 * g;
      c.b *= 1.0 - 0.14 * g;
      c.g *= 1.0 + 0.02 * g;
    }

    /* --- 8. 饱和度 / 鲜艳度（肤色保护）--- */
    if (abs(uSat) > 0.0001 || abs(uVib) > 0.0001) {
      float Y = luma(c);
      float mx = max(c.r, max(c.g, c.b));
      float mn = min(c.r, min(c.g, c.b));
      float s = (mx - mn) / max(mx, 1e-5);
      float hue = degrees(atan(sqrt(3.0) * (c.g - c.b), 2.0 * c.r - c.g - c.b));
      hue = mod(hue + 360.0, 360.0);
      float skin = (hue > 8.0 && hue < 46.0 && s > 0.10 && s < 0.70) ? 0.4 : 1.0;
      float gain = 1.0 + uSat + uVib * (1.0 - s) * 0.95 * skin;
      c = vec3(Y) + (c - vec3(Y)) * max(gain, 0.0);
    }

    /* --- 9. 锐化 --- */
    if (uSharpen > 0.0001) {
      vec3 bs = textureLod(uTex, vUV, 0.75).rgb;
      float d = clamp(luma(c) - luma(bs), -0.12, 0.12);
      c += d * uSharpen * 1.1;
    }

    outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`;

  const gl = {
    ctx: null,
    prog: null,
    tex: null,
    u: {},
  };

  function initGL() {
    const canvas = $('#gl');
    const ctx = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!ctx) return false;
    gl.ctx = ctx;

    const sh = (type, src) => {
      const s = ctx.createShader(type);
      ctx.shaderSource(s, src);
      ctx.compileShader(s);
      if (!ctx.getShaderParameter(s, ctx.COMPILE_STATUS)) {
        console.error(ctx.getShaderInfoLog(s), src);
        throw new Error('shader compile failed');
      }
      return s;
    };
    const p = ctx.createProgram();
    ctx.attachShader(p, sh(ctx.VERTEX_SHADER, VERT));
    ctx.attachShader(p, sh(ctx.FRAGMENT_SHADER, FRAG));
    ctx.linkProgram(p);
    if (!ctx.getProgramParameter(p, ctx.LINK_STATUS)) {
      throw new Error(ctx.getProgramInfoLog(p));
    }
    gl.prog = p;

    const buf = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), ctx.STATIC_DRAW);
    const loc = ctx.getAttribLocation(p, 'aPos');
    ctx.enableVertexAttribArray(loc);
    ctx.vertexAttribPointer(loc, 2, ctx.FLOAT, false, 0, 0);

    gl.u = {};
    ['uZoom', 'uPan', 'uTex', 'uTexSize', 'uTexel', 'uSplit', 'uBefore', 'uEv',
      'uContrast', 'uHighlights', 'uShadows', 'uMidtone', 'uTemp', 'uTint',
      'uShadowTint', 'uHighlightTint',
      'uSat', 'uVib', 'uClarity', 'uDenoise', 'uSharpen', 'uNoise', 'uWhite']
      .forEach((n) => { gl.u[n] = ctx.getUniformLocation(p, n); });

    gl.tex = ctx.createTexture();
    ctx.bindTexture(ctx.TEXTURE_2D, gl.tex);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR_MIPMAP_LINEAR);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);

    ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, false);
    return true;
  }

  function uploadImage(img) {
    const ctx = gl.ctx;
    ctx.bindTexture(ctx.TEXTURE_2D, gl.tex);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, img);
    ctx.generateMipmap(ctx.TEXTURE_2D);
    state.texW = img.naturalWidth;
    state.texH = img.naturalHeight;
  }

  /* ---------------- 布局与渲染 ---------------- */
  function canvasRect() {
    const canvas = $('#gl');
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const iw = state.texW;
    const ih = state.texH;
    const fit = Math.min(cw / iw, ch / ih);
    const w = iw * fit * state.zoom;
    const h = ih * fit * state.zoom;
    const x = (cw - w) / 2 + state.panX;
    const y = (ch - h) / 2 + state.panY;
    return { x, y, w, h, cw, ch, fit };
  }

  function render() {
    if (!state.ready || !gl.ctx) return;
    const ctx = gl.ctx;
    const canvas = $('#gl');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (canvas.width !== Math.round(canvas.clientWidth * dpr) ||
        canvas.height !== Math.round(canvas.clientHeight * dpr)) {
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    }

    ctx.viewport(0, 0, canvas.width, canvas.height);
    ctx.clearColor(0, 0, 0, 0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);

    const r = canvasRect();
    if (r.w < 1 || r.h < 1) return;
    const vx = Math.round(r.x * dpr);
    const vy = Math.round((r.ch - r.y - r.h) * dpr);
    const vw = Math.max(1, Math.round(r.w * dpr));
    const vh = Math.max(1, Math.round(r.h * dpr));
    ctx.viewport(vx, vy, vw, vh);

    const p = state.params;
    ctx.useProgram(gl.prog);
    ctx.activeTexture(ctx.TEXTURE0);
    ctx.bindTexture(ctx.TEXTURE_2D, gl.tex);
    ctx.uniform1i(gl.u.uTex, 0);
    ctx.uniform2f(gl.u.uTexSize, state.texW, state.texH);
    ctx.uniform2f(gl.u.uTexel, 1 / state.texW, 1 / state.texH);
    ctx.uniform1f(gl.u.uZoom, state.zoom);
    ctx.uniform2f(gl.u.uPan, state.panX / r.w, state.panY / r.h);
    ctx.uniform1f(gl.u.uSplit, state.before ? -1 : (state.split >= 0 ? state.split : -1));
    ctx.uniform1i(gl.u.uBefore, state.before ? 1 : 0);

    ctx.uniform1f(gl.u.uEv, +p.ev || 0);
    ctx.uniform1f(gl.u.uContrast, (p.contrast || 0) / 100);
    ctx.uniform1f(gl.u.uHighlights, (p.highlights || 0) / 100);
    ctx.uniform1f(gl.u.uShadows, (p.shadows || 0) / 100);
    ctx.uniform1f(gl.u.uMidtone, (p.midtone || 0) / 100);
    ctx.uniform1f(gl.u.uTemp, (p.temp || 0) / 100);
    ctx.uniform1f(gl.u.uTint, (p.tint || 0) / 100);
    ctx.uniform1f(gl.u.uShadowTint, (p.shadowTint || 0) / 100);
    ctx.uniform1f(gl.u.uHighlightTint, (p.highlightTint || 0) / 100);
    ctx.uniform1f(gl.u.uSat, (p.saturation || 0) / 100);
    ctx.uniform1f(gl.u.uVib, (p.vibrance || 0) / 100);
    ctx.uniform1f(gl.u.uClarity, (p.clarity || 0) / 100);
    ctx.uniform1f(gl.u.uDenoise, (p.denoise || 0) / 100);
    ctx.uniform1f(gl.u.uSharpen, (p.sharpen || 0) / 100);
    ctx.uniform1f(gl.u.uNoise, currentImage().analysis?.noiseSigma || 0.005);
    ctx.uniform1f(gl.u.uWhite, currentImage().analysis?.whiteLin ?? 1);

    ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);

    // 分割线：参数全零时两边是同一张图，线就没意义，先藏起来
    const neutral = isNeutral(p);
    const line = $('#splitLine');
    if (state.before || state.split < 0 || neutral) {
      line.classList.add('hidden');
    } else {
      line.classList.remove('hidden');
      line.style.left = (r.x + r.w * state.split) + 'px';
    }
    $('#tagBefore').classList.toggle('dim', state.before || neutral);
    $('#tagAfter').classList.toggle('dim', state.before);
  }

  function isNeutral(p) {
    return GROUP.every((g) => g.items.every((it) => Math.abs(p[it.k] || 0) < 0.005));
  }

  function requestRender() {
    if (state.dirty) return;
    state.dirty = true;
    requestAnimationFrame(() => {
      state.dirty = false;
      try { render(); } catch (e) { console.error(e); }
    });
  }

  /* ---------------- 编辑器 ---------------- */
  const currentImage = () => state.images[state.idx];

  function openEditor(i) {
    state.idx = clamp(i, 0, state.images.length - 1);
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.before = false;
    state.ready = false;
    $('#gl').style.display = '';
    if (fallbackImg) { fallbackImg.remove(); fallbackImg = null; }

    const img = currentImage();
    state.presetKey = 'base';
    state.params = { ...PRESETS.base.p };

    $('#gallery').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    $('#edName').textContent = `${img.id}`;
    $('#lnkFull').href = img.path;

    const e = img.exif;
    const chips = [
      img.engine === 'darktable' ? 'darktable 显影' : '原生显影',
      e.camera, e.lens !== '—' ? e.lens : null,
      e.iso ? `ISO ${e.iso}` : null, e.shutter, e.aperture, e.focal,
    ].filter(Boolean);
    $('#edExif').innerHTML = chips.map((c) => `<span>${c}</span>`).join('');
    $('#tagBefore').textContent = '自动成品';
    $('#tagAfter').textContent = '当前调整';

    buildPresets();
    buildSliders();
    buildAnalysis();
    buildFilmstrip();
    syncControls();
    updateZoomLabel();

    const tex = new Image();
    tex.onload = () => {
      if (!state.glOk) {
        showFallback(img.path);
        return;
      }
      try {
        uploadImage(tex);
        state.ready = true;
        state.split = 0.5;
        requestRender();
      } catch (e) {
        console.error(e);
        state.glOk = false;
        showFallback(img.path);
      }
      setTimeout(() => $('#stageHint').classList.add('fade'), 3200);
    };
    tex.src = img.path;
    try { history.replaceState(null, '', '#' + img.id); } catch (e) { /* file:// 下忽略 */ }
  }

  let fallbackImg = null;
  function showFallback(src) {
    state.ready = false;
    $('#gl').style.display = 'none';
    $('#splitLine').classList.add('hidden');
    if (!fallbackImg) {
      fallbackImg = document.createElement('img');
      fallbackImg.className = 'fallback';
      $('#stage').prepend(fallbackImg);
    }
    fallbackImg.src = src;
    toast('当前浏览器未启用 WebGL2，只显示自动修图结果');
  }

  function closeEditor() {
    $('#editor').classList.add('hidden');
    $('#gallery').classList.remove('hidden');
    state.ready = false;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* noop */ }
  }

  function buildPresets() {
    const box = $('#presets');
    box.innerHTML = '';
    PRESET_ORDER.forEach((k) => {
      const meta = PRESETS[k];
      const b = document.createElement('button');
      b.className = 'preset' + (state.presetKey === k ? ' on' : '');
      b.dataset.k = k;
      b.innerHTML = `<b>${meta.name}</b><i>${meta.desc}</i>`;
      b.onclick = () => applyPreset(k);
      box.appendChild(b);
    });
  }

  function applyPreset(k) {
    if (!PRESETS[k]) return;
    state.presetKey = k;
    state.params = { ...PRESETS[k].p };
    document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    syncControls();
    requestRender();
  }

  function buildSliders() {
    const box = $('#sliders');
    box.innerHTML = '';
    GROUP.forEach((g) => {
      const wrap = document.createElement('div');
      wrap.className = 's-group';
      wrap.innerHTML = `<p class="s-group-name">${g.name}</p>`;
      g.items.forEach((it) => {
        const [mn, mx] = (state.manifest.paramRange && state.manifest.paramRange[it.k]) || defaultRange(it.k);
        const row = document.createElement('div');
        row.className = 'srow';
        row.innerHTML = `
          <div class="srow-head">
            <label>${it.label}</label>
            <output data-out="${it.k}">0</output>
          </div>
          <input type="range" id="sl-${it.k}" min="${mn}" max="${mx}" step="${it.step}" value="0">`;
        const input = row.querySelector('input');
        input.addEventListener('input', () => {
          state.params[it.k] = parseFloat(input.value);
          markDirty(it.k);
          syncOne(it.k);
          requestRender();
        });
        wrap.appendChild(row);
      });
      box.appendChild(wrap);
    });
  }

  const defaultRange = (k) => ({
    ev: [-2, 2], contrast: [-60, 80], highlights: [-80, 40], shadows: [-40, 80],
    midtone: [-50, 50], temp: [-30, 30], tint: [-30, 30], saturation: [-60, 60],
    vibrance: [-40, 60], clarity: [-40, 60], denoise: [0, 100], sharpen: [0, 100],
    shadowTint: [-40, 40], highlightTint: [-40, 40],
  }[k] || [0, 100]);

  function slotOf(k) {
    for (const g of GROUP) for (const it of g.items) if (it.k === k) return it;
    return null;
  }

  function syncOne(k) {
    const it = slotOf(k);
    const input = document.getElementById('sl-' + k);
    const out = document.querySelector(`[data-out="${k}"]`);
    if (!it || !input) return;
    const v = state.params[k] ?? 0;
    input.value = v;
    const shown = Math.abs(v) < 1e-9 ? 0 : v;
    out.textContent = shown.toFixed(it.dec) + (it.unit || '');
    const [mn, mx] = [parseFloat(input.min), parseFloat(input.max)];
    const pct = ((v - mn) / (mx - mn)) * 100;
    const z = ((it.zero - mn) / (mx - mn)) * 100;
    const a = Math.min(pct, z), b = Math.max(pct, z);
    input.style.setProperty('--track',
      `linear-gradient(90deg, #e6e2db ${a}%, #b8532e ${a}%, #b8532e ${b}%, #e6e2db ${b}%)`);
    out.classList.toggle('mod', Math.abs(v - (it.zero || 0)) > 1e-6);
  }

  function syncControls() {
    GROUP.forEach((g) => g.items.forEach((it) => syncOne(it.k)));
  }

  function markDirty() { /* 预设高亮：与预设不同则取消高亮 */
    let match = null;
    for (const k of PRESET_ORDER) {
      const pr = PRESETS[k].p;
      const keys = new Set([...Object.keys(pr), ...Object.keys(state.params)]);
      const same = [...keys].every((kk) => Math.abs((pr[kk] || 0) - (state.params[kk] || 0)) < 0.02);
      if (same) { match = k; break; }
    }
    state.presetKey = match;
    document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.k === match));
  }

  function buildAnalysis() {
    const a = currentImage().analysis || {};
    const rows = [
      ['噪声 σ', a.noiseSigma ? a.noiseSigma.toFixed(4) : '—'],
      ['肤色占比', a.skinRatio != null ? (a.skinRatio * 100).toFixed(1) + '%' : '—'],
      ['过曝像素', a.clipped != null ? (a.clipped * 100).toFixed(2) + '%' : '—'],
      ['白点增益', a.whiteGain ? '×' + a.whiteGain.toFixed(2) : '—'],
      ['中位亮度', `${a.medianBefore?.toFixed(2)} → ${a.medianAfter?.toFixed(2)}`],
      ['动态范围', `${a.contrastBefore?.toFixed(2)} → ${a.contrastAfter?.toFixed(2)}`],
    ];
    $('#analysis').innerHTML = rows.map(
      ([k, v]) => `<div><div class="stat-k">${k}</div><div class="stat-v">${v}</div></div>`
    ).join('');

    const p = currentImage().params || {};
    const list = GROUP.flatMap((g) => g.items)
      .filter((it) => Math.abs(p[it.k] || 0) > 0.005)
      .map((it) => {
        const v = p[it.k];
        const sign = v > 0 ? '+' : '';
        return `<span><i>${it.label}</i>${sign}${v.toFixed(it.dec)}${it.unit || ''}</span>`;
      });
    $('#baked').innerHTML = list.length ? list.join('') : '<span class="muted">这张没有任何需要调整的项</span>';
  }

  function buildFilmstrip() {
    const box = $('#filmstrip');
    box.innerHTML = '';
    state.images.forEach((img, i) => {
      const d = document.createElement('button');
      d.className = 'film' + (i === state.idx ? ' on' : '');
      d.innerHTML = `<img src="${img.preview || img.path}" alt="${img.id}" loading="lazy">`;
      d.onclick = () => openEditor(i);
      box.appendChild(d);
    });
    const active = box.querySelector('.film.on');
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function updateZoomLabel() {
    $('#zoomLabel').textContent = state.zoom <= 1.001 ? '适合' : Math.round(state.zoom * 100) + '%';
  }

  function setZoom(z) {
    const r = canvasRect();
    state.zoom = clamp(z, 1, 8);
    // 缩放后重新夹住平移
    const cw = r.cw, ch = r.ch;
    const w = state.texW * r.fit * state.zoom;
    const h = state.texH * r.fit * state.zoom;
    const mx = Math.max(0, (w - cw) / 2);
    const my = Math.max(0, (h - ch) / 2);
    state.panX = clamp(state.panX, -mx, mx);
    state.panY = clamp(state.panY, -my, my);
    if (state.zoom <= 1.001) { state.panX = 0; state.panY = 0; }
    updateZoomLabel();
    requestRender();
  }

  /* ---------------- 交互 ---------------- */
  function bindStage() {
    const stage = $('#stage');
    let draggingSplit = false;
    let draggingPan = false;
    let moved = false;
    let last = { x: 0, y: 0 };

    const setSplitFromEvent = (ev) => {
      const r = $('#gl').getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width;
      state.split = clamp(x, 0.02, 0.98);
      requestRender();
    };

    stage.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const rect = $('#gl').getBoundingClientRect();
      const r = canvasRect();
      const lineX = rect.left + r.x + r.w * state.split;
      moved = false;
      if (Math.abs(ev.clientX - lineX) < 26 && state.split >= 0 && !state.before) {
        draggingSplit = true;
        stage.setPointerCapture(ev.pointerId);
        setSplitFromEvent(ev);
      } else if (state.zoom > 1.001) {
        draggingPan = true;
        last = { x: ev.clientX, y: ev.clientY };
        stage.classList.add('dragging');
        stage.setPointerCapture(ev.pointerId);
      }
    });

    stage.addEventListener('pointermove', (ev) => {
      if (draggingSplit) { setSplitFromEvent(ev); return; }
      if (draggingPan) {
        moved = true;
        const r = canvasRect();
        const w = state.texW * r.fit * state.zoom;
        const h = state.texH * r.fit * state.zoom;
        const mx = Math.max(0, (w - r.cw) / 2);
        const my = Math.max(0, (h - r.ch) / 2);
        state.panX = clamp(state.panX + (ev.clientX - last.x), -mx, mx);
        state.panY = clamp(state.panY + (ev.clientY - last.y), -my, my);
        last = { x: ev.clientX, y: ev.clientY };
        requestRender();
      }
    });

    const endDrag = () => {
      draggingSplit = false;
      draggingPan = false;
      stage.classList.remove('dragging');
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    stage.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const f = Math.exp(-ev.deltaY * 0.0016);
      setZoom(state.zoom * f);
    }, { passive: false });

    stage.addEventListener('dblclick', () => { setZoom(1); });

    $('#btnZoomIn').onclick = () => setZoom(state.zoom * 1.25);
    $('#btnZoomOut').onclick = () => setZoom(state.zoom / 1.25);
    $('#btnZoomFit').onclick = () => setZoom(1);

    const hold = $('#btnHold');
    const press = (on) => {
      state.before = on;
      hold.classList.toggle('active', on);
      requestRender();
    };
    hold.addEventListener('pointerdown', (e) => { e.preventDefault(); press(true); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) =>
      hold.addEventListener(t, () => press(false)));
  }

  function bindEditor() {
    $('#btnBack').onclick = closeEditor;
    $('#btnReset').onclick = () => { applyPreset('base'); toast('已回到自动成品'); };
    $('#btnExport').onclick = exportCurrent;
    $('#btnExportBig').onclick = exportCurrent;

    document.addEventListener('keydown', (e) => {
      if ($('#editor').classList.contains('hidden')) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' && e.target.type !== 'range') return;
      if (e.key === 'Escape') closeEditor();
      else if (e.key === 'ArrowRight') { e.preventDefault(); openEditor(state.idx + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); openEditor(state.idx - 1); }
      else if (e.key === '0') { setZoom(1); }
      else if (e.key.toLowerCase() === 'r') applyPreset('base');
      else if (e.key.toLowerCase() === 'e') exportCurrent();
      else if (e.key === ' ') { e.preventDefault(); state.before = true; requestRender(); }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ' && state.before) { state.before = false; requestRender(); }
    });
  }

  /* ---------------- 导出 ---------------- */
  async function exportCurrent() {
    const img = currentImage();
    if (!state.ready) return;
    const canvas = $('#gl');
    const old = {
      w: canvas.width, h: canvas.height,
      zoom: state.zoom, panX: state.panX, panY: state.panY, split: state.split,
    };
    canvas.width = state.texW;
    canvas.height = state.texH;
    state.zoom = 1; state.panX = 0; state.panY = 0; state.split = -1;

    // 直接整幅渲染
    const ctx = gl.ctx;
    ctx.viewport(0, 0, canvas.width, canvas.height);
    ctx.clearColor(0, 0, 0, 0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);
    const p = state.params;
    ctx.useProgram(gl.prog);
    ctx.activeTexture(ctx.TEXTURE0);
    ctx.bindTexture(ctx.TEXTURE_2D, gl.tex);
    ctx.uniform1i(gl.u.uTex, 0);
    ctx.uniform2f(gl.u.uTexSize, state.texW, state.texH);
    ctx.uniform2f(gl.u.uTexel, 1 / state.texW, 1 / state.texH);
    ctx.uniform1f(gl.u.uZoom, 1);
    ctx.uniform2f(gl.u.uPan, 0, 0);
    ctx.uniform1f(gl.u.uSplit, -1);
    ctx.uniform1i(gl.u.uBefore, 0);
    ctx.uniform1f(gl.u.uEv, +p.ev || 0);
    ctx.uniform1f(gl.u.uContrast, (p.contrast || 0) / 100);
    ctx.uniform1f(gl.u.uHighlights, (p.highlights || 0) / 100);
    ctx.uniform1f(gl.u.uShadows, (p.shadows || 0) / 100);
    ctx.uniform1f(gl.u.uMidtone, (p.midtone || 0) / 100);
    ctx.uniform1f(gl.u.uTemp, (p.temp || 0) / 100);
    ctx.uniform1f(gl.u.uTint, (p.tint || 0) / 100);
    ctx.uniform1f(gl.u.uShadowTint, (p.shadowTint || 0) / 100);
    ctx.uniform1f(gl.u.uHighlightTint, (p.highlightTint || 0) / 100);
    ctx.uniform1f(gl.u.uSat, (p.saturation || 0) / 100);
    ctx.uniform1f(gl.u.uVib, (p.vibrance || 0) / 100);
    ctx.uniform1f(gl.u.uClarity, (p.clarity || 0) / 100);
    ctx.uniform1f(gl.u.uDenoise, (p.denoise || 0) / 100);
    ctx.uniform1f(gl.u.uSharpen, (p.sharpen || 0) / 100);
    ctx.uniform1f(gl.u.uNoise, img.analysis?.noiseSigma || 0.005);
    ctx.uniform1f(gl.u.uWhite, img.analysis?.whiteLin ?? 1);
    ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.95));
    saveBlob(blob, `${img.id}_xphoto.jpg`);

    canvas.width = old.w; canvas.height = old.h;
    state.zoom = old.zoom; state.panX = old.panX; state.panY = old.panY; state.split = old.split;
    requestRender();
    toast('已导出 ' + `${img.id}_xphoto.jpg`);
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /* ---------------- 相册 ---------------- */
  function buildGallery() {
    const grid = $('#grid');
    grid.innerHTML = '';
    state.images.forEach((img, i) => {
      const card = document.createElement('article');
      card.className = 'card';
      const e = img.exif;
      card.innerHTML = `
        <div class="card-img">
          <img src="${img.preview || img.path}" alt="${img.id}" loading="lazy">
          <div class="card-chip">
            <span class="chip-mini on">自动</span>
            ${e.iso ? `<span class="chip-mini">ISO ${e.iso}</span>` : ''}
          </div>
        </div>
        <div class="card-body">
          <div>
            <div class="card-name">${img.id}</div>
            <div class="card-sub">${e.shutter} · ${e.aperture} · ${e.focal} · 降噪 ${Math.round(img.params.denoise)}</div>
          </div>
          <span class="card-go">编辑 →</span>
        </div>`;
      const im = card.querySelector('img');
      im.addEventListener('load', () => im.classList.add('ready'));
      card.onclick = () => openEditor(i);
      grid.appendChild(card);
    });

    const total = state.manifest.images.length;
    const size = state.manifest.images[0];
    const engName = state.manifest.engine === 'darktable' ? 'darktable'
      : state.manifest.engine === 'mixed' ? '混合' : '原生';
    $('#galleryStats').innerHTML = `
      <div><b>${total}</b><span>张 RAW</span></div>
      <div><b>${Math.round(state.manifest.processMs / 100) / 10}s</b><span>处理耗时</span></div>
      <div><b>${size ? size.width + '×' + size.height : '—'}</b><span>分辨率</span></div>
      <div><b>${engName}</b><span>显影引擎</span></div>`;
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
  }

  // 深链：index.html#DSC07910/vivid 直接打开某张图与某个预设
  function applyHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!h) return false;
    const [id, preset] = h.split('/');
    const i = state.images.findIndex((x) => x.id === id);
    if (i < 0) return false;
    openEditor(i);
    if (preset && PRESETS[preset]) applyPreset(preset);
    return true;
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    try {
      const res = await fetch('out/manifest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.manifest = await res.json();
      state.images = state.manifest.images || [];
      if (!state.images.length) throw new Error('manifest 里没有图片');

      try {
        state.glOk = initGL();
      } catch (e) {
        console.error('WebGL 初始化失败', e);
        state.glOk = false;
      }

      $('#boot').classList.add('hidden');
      $('#gallery').classList.remove('hidden');
      buildGallery();
      bindStage();
      bindEditor();
      window.addEventListener('resize', requestRender);
      window.addEventListener('hashchange', applyHash);
      applyHash();
    } catch (err) {
      const boot = $('#boot');
      boot.classList.add('error');
      boot.querySelector('.boot-text').innerHTML =
        `无法加载 <code>out/manifest.json</code>（${err.message}）。<br>` +
        `请先在项目根目录运行 <code>python xphoto.py --input data --output out</code>，` +
        `并用 <code>python -m http.server 8080</code> 打开 <code>http://localhost:8080</code>。`;
      console.error(err);
    }
  }

  boot();
})();
