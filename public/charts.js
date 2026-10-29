/* ==========================================================================
   charts.js — 轻量 Canvas 图表库（零依赖）
   支持：折线图（多序列、渐变填充）、迷你走势图、环形进度
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------- 工具 ---------------- */

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /** 把 'var(--x)' 形式的颜色解析成实际颜色值 */
  function resolveColor(color, fallback) {
    if (!color) return fallback || cssVar('--accent', '#2f81f7');
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(String(color).trim());
    if (m) return cssVar(m[1], m[2] || fallback || '#2f81f7');
    return color;
  }

  function hexToRgba(color, alpha) {
    color = resolveColor(color);
    if (color.startsWith('#')) {
      let h = color.slice(1);
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const n = parseInt(h, 16);
      if (Number.isFinite(n)) {
        const r = (n >> 16) & 255;
        const g = (n >> 8) & 255;
        const b = n & 255;
        return `rgba(${r},${g},${b},${alpha})`;
      }
      return color;
    }
    if (color.startsWith('rgb(')) {
      return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
    }
    if (color.startsWith('rgba(')) return color;
    return color;
  }

  /** 让 canvas 适配 DPR，避免模糊 */
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  /** 计算“好看”的刻度上界 */
  function niceMax(value) {
    if (value <= 0) return 10;
    const exp = Math.floor(Math.log10(value));
    const base = Math.pow(10, exp);
    const norm = value / base;
    let nice;
    if (norm <= 1) nice = 1;
    else if (norm <= 1.2) nice = 1.2;
    else if (norm <= 1.5) nice = 1.5;
    else if (norm <= 2) nice = 2;
    else if (norm <= 2.5) nice = 2.5;
    else if (norm <= 3) nice = 3;
    else if (norm <= 4) nice = 4;
    else if (norm <= 5) nice = 5;
    else if (norm <= 6) nice = 6;
    else if (norm <= 8) nice = 8;
    else nice = 10;
    return nice * base;
  }

  function fmtAxis(v) {
    const abs = Math.abs(v);
    if (abs === 0) return '0';
    if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'G';
    if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    if (abs >= 10) return v.toFixed(0);
    if (abs >= 1) return v.toFixed(1);
    return v.toFixed(2);
  }

  /* ---------------- 折线图 ---------------- */

  class LineChart {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} opts
     *   series: [{ key, name, color, fill }]
     *   yMax: number | null（null 自动）
     *   yMin: number
     *   unit: string
     *   maxPoints: number
     *   smooth: boolean
     */
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.opts = Object.assign(
        {
          series: [],
          yMax: null,
          yMin: 0,
          unit: '',
          maxPoints: 180,
          smooth: true,
          showGrid: true,
          showAxis: true,
          padding: { top: 10, right: 8, bottom: 18, left: 38 },
        },
        opts
      );
      this.data = []; // [{ at, values: { key: number } }]
      this.hidden = new Set();
      this._raf = null;
      this._resize();
      this._onResize = () => this._resize();
      window.addEventListener('resize', this._onResize);
    }

    _resize() {
      this.draw();
    }

    push(point) {
      this.data.push(point);
      const max = this.opts.maxPoints;
      if (this.data.length > max) this.data.splice(0, this.data.length - max);
      this.scheduleDraw();
    }

    setData(points) {
      this.data = points.slice(-this.opts.maxPoints);
      this.scheduleDraw();
    }

    clear() {
      this.data = [];
      this.scheduleDraw();
    }

    toggleSeries(key) {
      if (this.hidden.has(key)) this.hidden.delete(key);
      else this.hidden.add(key);
      this.scheduleDraw();
    }

    scheduleDraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        this.draw();
      });
    }

    destroy() {
      window.removeEventListener('resize', this._onResize);
      if (this._raf) cancelAnimationFrame(this._raf);
    }

    draw() {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const o = this.opts;
      const pad = o.padding;
      const plotW = w - pad.left - pad.right;
      const plotH = h - pad.top - pad.bottom;

      if (plotW <= 0 || plotH <= 0) return;

      const textDim = cssVar('--text-faint', '#6e7681');
      const gridColor = cssVar('--chart-grid', 'rgba(139,148,158,0.12)');

      // ---- 计算 Y 轴范围 ----
      let yMax = o.yMax;
      let yMin = o.yMin;

      if (yMax === null) {
        let peak = 0;
        for (const d of this.data) {
          for (const s of o.series) {
            if (this.hidden.has(s.key)) continue;
            const v = d.values[s.key];
            if (typeof v === 'number' && Number.isFinite(v) && v > peak) peak = v;
          }
        }
        yMax = niceMax(peak * 1.12 || 10);
      }
      if (yMax <= yMin) yMax = yMin + 1;

      // ---- 根据刻度文本宽度动态调整左边距，避免标签被裁切 ----
      const ticksCount = 4;
      ctx.font = '10px ui-monospace, monospace';
      let maxLabelW = 0;
      if (o.showAxis) {
        for (let t = 0; t <= ticksCount; t++) {
          const val = yMin + ((yMax - yMin) * t) / ticksCount;
          const tw = ctx.measureText(fmtAxis(val)).width;
          if (tw > maxLabelW) maxLabelW = tw;
        }
      }
      const leftPad = Math.max(pad.left, Math.ceil(maxLabelW) + 12);
      const plotW2 = w - leftPad - pad.right;

      const yPos = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
      const xPos = (i) => {
        if (this.data.length <= 1) return leftPad + plotW2 / 2;
        return leftPad + (i / (this.data.length - 1)) * plotW2;
      };

      // ---- 网格与 Y 轴标签 ----
      if (o.showGrid) {
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let t = 0; t <= ticksCount; t++) {
          const val = yMin + ((yMax - yMin) * t) / ticksCount;
          const y = yPos(val);
          ctx.strokeStyle = gridColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(leftPad, Math.round(y) + 0.5);
          ctx.lineTo(w - pad.right, Math.round(y) + 0.5);
          ctx.stroke();

          if (o.showAxis) {
            ctx.fillStyle = textDim;
            ctx.fillText(fmtAxis(val), leftPad - 7, y);
          }
        }
      }

      // ---- 无数据 / 数据不足提示 ----
      if (this.data.length === 0) {
        ctx.fillStyle = textDim;
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('等待数据…', leftPad + plotW2 / 2, pad.top + plotH / 2);
        return;
      }

      // ---- 绘制每条序列 ----
      for (const s of o.series) {
        if (this.hidden.has(s.key)) continue;
        const color = resolveColor(s.color, cssVar('--accent', '#2f81f7'));
        const pts = [];
        let firstIdx = -1; // 首个有效点在 data 中的下标
        for (let i = 0; i < this.data.length; i++) {
          const v = this.data[i].values[s.key];
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          if (firstIdx === -1) firstIdx = i;
          pts.push({ x: xPos(i), y: yPos(Math.min(yMax, Math.max(yMin, v))) });
        }
        if (pts.length === 0) continue;

        // 序列若从图表中途才有数据（前面是 null），不做填充：
        // 否则闭合路径会从基线垂直拉起，形成难看的竖边。
        const canFill = s.fill !== false && pts.length > 1 && firstIdx === 0;

        // 渐变填充
        if (canFill) {
          const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
          grad.addColorStop(0, hexToRgba(color, 0.28));
          grad.addColorStop(1, hexToRgba(color, 0.01));
          const baseY = pad.top + plotH;
          ctx.beginPath();
          // 起点先落在底部，再以曲线升到第一个数据点（形成斜坡而非竖线）
          ctx.moveTo(pts[0].x, baseY);
          ctx.lineTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            const prev = pts[i - 1];
            if (o.smooth) {
              const cx = (prev.x + pts[i].x) / 2;
              ctx.bezierCurveTo(cx, prev.y, cx, pts[i].y, pts[i].x, pts[i].y);
            } else {
              ctx.lineTo(pts[i].x, pts[i].y);
            }
          }
          ctx.lineTo(pts[pts.length - 1].x, baseY);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
        }

        // 线条
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
          else if (o.smooth && i > 0) {
            const prev = pts[i - 1];
            const cx = (prev.x + pts[i].x) / 2;
            ctx.bezierCurveTo(cx, prev.y, cx, pts[i].y, pts[i].x, pts[i].y);
          } else ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();

        // 末端圆点
        const last = pts[pts.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  }

  /* ---------------- 迷你走势图 ---------------- */

  class Sparkline {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.opts = Object.assign({ color: null, maxPoints: 60, fill: true }, opts);
      this.values = [];
      this._resize = () => this.draw();
      window.addEventListener('resize', this._resize);
    }

    push(v) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      this.values.push(v);
      if (this.values.length > this.opts.maxPoints) this.values.shift();
      this.draw();
    }

    setData(arr) {
      this.values = arr.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice(-this.opts.maxPoints);
      this.draw();
    }

    destroy() {
      window.removeEventListener('resize', this._resize);
    }

    draw() {
      const { ctx, w, h } = fitCanvas(this.canvas);
      if (this.values.length < 2) return;

      const color = resolveColor(this.opts.color, cssVar('--accent', '#2f81f7'));
      const max = Math.max(...this.values, 1);
      const min = Math.min(...this.values, 0);
      const range = max - min || 1;

      const xPos = (i) => (i / (this.values.length - 1)) * w;
      const yPos = (v) => h - 2 - ((v - min) / range) * (h - 4);

      if (this.opts.fill) {
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, hexToRgba(color, 0.45));
        grad.addColorStop(1, hexToRgba(color, 0));
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < this.values.length; i++) {
          const x = xPos(i);
          const y = yPos(this.values[i]);
          if (i === 0) ctx.lineTo(x, y);
          else {
            const px = xPos(i - 1);
            const py = yPos(this.values[i - 1]);
            const cx = (px + x) / 2;
            ctx.bezierCurveTo(cx, py, cx, y, x, y);
          }
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      for (let i = 0; i < this.values.length; i++) {
        const x = xPos(i);
        const y = yPos(this.values[i]);
        if (i === 0) ctx.moveTo(x, y);
        else {
          const px = xPos(i - 1);
          const py = yPos(this.values[i - 1]);
          const cx = (px + x) / 2;
          ctx.bezierCurveTo(cx, py, cx, y, x, y);
        }
      }
      ctx.stroke();
    }
  }

  /* ---------------- 环形进度 ---------------- */

  function drawDonut(canvas, percent, opts = {}) {
    const { ctx, w, h } = fitCanvas(canvas);
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - (opts.thickness || 8) / 2 - 2;
    const thickness = opts.thickness || 8;
    const start = -Math.PI / 2;
    const p = Math.max(0, Math.min(100, percent)) / 100;

    // 底环
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = cssVar('--bg-elev-2', '#1c2128');
    ctx.lineWidth = thickness;
    ctx.stroke();

    // 进度环
    if (p > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start, start + Math.PI * 2 * p);
      ctx.strokeStyle = resolveColor(opts.color, cssVar('--accent', '#2f81f7'));
      ctx.lineWidth = thickness;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  /* ---------------- 柱状图（多核 CPU） ---------------- */

  function drawBars(canvas, values, opts = {}) {
    const { ctx, w, h } = fitCanvas(canvas);
    if (!values.length) return;

    const max = Math.max(...values, 1);
    const gap = opts.gap || 3;
    const barW = Math.max(2, (w - gap * (values.length - 1)) / values.length);

    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const ratio = Math.max(0, Math.min(1, v / Math.max(max, 100)));
      const barH = Math.max(1, ratio * (h - 2));
      const x = i * (barW + gap);
      const y = h - barH;

      let color = resolveColor(opts.color, cssVar('--accent', '#2f81f7'));
      if (opts.threshold) {
        if (v >= opts.threshold.crit) color = cssVar('--red', '#f85149');
        else if (v >= opts.threshold.warn) color = cssVar('--yellow', '#d29922');
        else color = cssVar('--green', '#3fb950');
      }

      ctx.fillStyle = hexToRgba(color, v > 0.5 ? 1 : 0.35);
      const r = Math.min(2, barW / 2);
      // 圆角矩形
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, barW, barH, [r, r, 0, 0]);
      } else {
        ctx.rect(x, y, barW, barH);
      }
      ctx.fill();
    }
  }

  /* ---------------- 导出 ---------------- */

  global.Charts = { LineChart, Sparkline, drawDonut, drawBars, cssVar, resolveColor, hexToRgba, fmtAxis };
})(window);
