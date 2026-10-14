'use strict';
/* ============================================================
 *  charts —— 纯 SVG 图表（无第三方图表库）
 * ============================================================ */

const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
  return e;
}

/** 环形图：items = [{name, value, color}] */
function chartDonut(items, opts) {
  const o = opts || {};
  const size = o.size || 168;
  const r = o.r || (size / 2 - 16);
  const sw = o.width || 22;
  const total = items.reduce((s, it) => s + Math.max(0, it.value), 0);
  const cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;

  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: '100%', height: size, style: 'display:block' });
  svg.appendChild(svgEl('circle', { cx, cy, r, fill: 'none', stroke: '#eef1f6', 'stroke-width': sw }));

  let offset = 0;
  if (total > 0) {
    items.forEach((it) => {
      const v = Math.max(0, it.value);
      if (!v) return;
      const len = (v / total) * C;
      const c = svgEl('circle', {
        cx, cy, r, fill: 'none',
        stroke: it.color || '#2159d6',
        'stroke-width': sw,
        'stroke-dasharray': `${len} ${C - len}`,
        'stroke-dashoffset': -offset,
        transform: `rotate(-90 ${cx} ${cy})`,
      });
      c.appendChild(svgEl('title', {})).textContent = `${it.name}: ${v}`;
      svg.appendChild(c);
      offset += len;
    });
  }

  const t1 = svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', 'font-size': 22, 'font-weight': 650, fill: '#1c2434' });
  t1.textContent = o.centerValue !== undefined ? o.centerValue : total;
  const t2 = svgEl('text', { x: cx, y: cy + 15, 'text-anchor': 'middle', 'font-size': 11, fill: '#8b93a7' });
  t2.textContent = o.centerLabel || '合计';
  svg.appendChild(t1);
  svg.appendChild(t2);
  return svg;
}

/** 环形图图例 */
function chartLegend(items, unitFn) {
  const wrap = h('<div class="legend"></div>');
  items.forEach((it) => {
    const total = items.reduce((s, x) => s + Math.max(0, x.value), 0);
    const pct = total ? fmt.pct(it.value, total) : '0%';
    wrap.appendChild(h(`<div class="it" title="${esc(it.name)}">
      <span class="dot" style="background:${it.color}"></span>
      <span>${esc(fmt.cut(it.name, 10))}</span>
      <span class="muted">${esc(unitFn ? unitFn(it) : it.value)} · ${pct}</span>
    </div>`));
  });
  return wrap;
}

/** 横向条形（HTML）：items = [{name, value, color, text}] */
function chartBars(items, opts) {
  const o = opts || {};
  const max = Math.max(1, ...items.map((it) => Math.max(0, it.value)));
  const wrap = h('<div class="bars"></div>');
  if (!items.length) {
    wrap.appendChild(h('<div class="muted" style="padding:10px 0">暂无数据</div>'));
    return wrap;
  }
  items.forEach((it, i) => {
    const pctW = Math.max(2, (Math.max(0, it.value) / max) * 100);
    wrap.appendChild(h(`
      <div class="bar-row" title="${esc(it.name)}">
        <div class="nm">${esc(fmt.cut(it.name, 14))}</div>
        <div class="track"><div class="fill" style="width:${pctW}%;background:${it.color || colorOf({}, '', i)}"></div></div>
        <div class="vv">${esc(o.textFn ? o.textFn(it) : fmt.n(it.value))}</div>
      </div>`));
  });
  return wrap;
}

/** 纵向柱状图（SVG）：items = [{name, value, color}] */
function chartColumns(items, opts) {
  const o = opts || {};
  const W = o.width || 520, H = o.height || 200;
  const padL = 34, padR = 8, padT = 12, padB = 30;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...items.map((it) => Math.max(0, it.value)));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, style: 'display:block' });

  // 网格与 Y 轴刻度
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ih / 4) * i;
    svg.appendChild(svgEl('line', { x1: padL, y1: y, x2: W - padR, y2: y, stroke: '#eef1f6' }));
    const t = svgEl('text', { x: padL - 6, y: y + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: '#8b93a7' });
    t.textContent = Math.round((max / 4) * (4 - i));
    svg.appendChild(t);
  }

  const step = iw / Math.max(1, items.length);
  const bw = Math.min(46, step * 0.56);
  items.forEach((it, i) => {
    const v = Math.max(0, it.value);
    const bh = (v / max) * ih;
    const x = padL + step * i + (step - bw) / 2;
    const y = padT + ih - bh;
    const rect = svgEl('rect', { x, y, width: bw, height: Math.max(1, bh), rx: 3, fill: it.color || '#2159d6' });
    rect.appendChild(svgEl('title', {})).textContent = `${it.name}: ${v}`;
    svg.appendChild(rect);
    const vt = svgEl('text', { x: x + bw / 2, y: y - 4, 'text-anchor': 'middle', 'font-size': 10, fill: '#5b6478' });
    vt.textContent = v;
    svg.appendChild(vt);
    const lt = svgEl('text', { x: padL + step * i + step / 2, y: H - padB + 15, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#5b6478' });
    lt.textContent = fmt.cut(it.name, 6);
    svg.appendChild(lt);
  });
  return svg;
}

/** 进度条 */
function progressBar(value, total, color) {
  const p = total ? Math.min(100, (value / total) * 100) : 0;
  return h(`<div class="progress"><div class="p" style="width:${p}%;background:${color || 'var(--brand)'}"></div></div>`);
}

/** 看板小卡片 */
function kpiCard(label, value, sub, icon) {
  return h(`<div class="kpi">
    <div class="lb">${icon ? `<span>${icon}</span>` : ''}<span>${esc(label)}</span></div>
    <div class="vl">${value}</div>
    <div class="sub">${sub || ''}</div>
  </div>`);
}

function miniStat(label, value, color) {
  return h(`<div class="mini">
    <div class="lb">${esc(label)}</div>
    <div class="vl" style="color:${color || 'var(--text)'}">${value}</div>
  </div>`);
}

function cardBox(title, bodyNode, actions, cls) {
  const c = h(`<div class="card ${cls || ''}">
    <div class="card-h"><h3>${esc(title)}</h3><div class="spacer"></div><div class="acts"></div></div>
    <div class="card-b"></div>
  </div>`);
  (actions || []).forEach((a) => $('.acts', c).appendChild(a));
  if (typeof bodyNode === 'string') $('.card-b', c).innerHTML = bodyNode;
  else if (bodyNode) $('.card-b', c).appendChild(bodyNode);
  return c;
}
