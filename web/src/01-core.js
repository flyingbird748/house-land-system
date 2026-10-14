'use strict';
/* ============================================================
 *  core —— 基础工具 / 接口客户端 / 会话
 * ============================================================ */

/* ------------------------------ DOM ------------------------------ */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

const ESC_RULES = [[/&/g, '&#38;'], [/</g, '&#60;'], [/>/g, '&#62;'], [/"/g, '&#34;'], [/'/g, '&#39;']];

function esc(s) {
  let out = String(s == null ? '' : s);
  for (let i = 0; i < ESC_RULES.length; i++) out = out.replace(ESC_RULES[i][0], ESC_RULES[i][1]);
  return out;
}

/** 由 HTML 字符串创建节点 */
function h(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html).trim();
  return t.content.firstElementChild;
}

function on(node, ev, fn, opts) {
  if (!node) return node;
  node.addEventListener(ev, fn, opts);
  return node;
}

function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

/* ------------------------------ 地图实例释放 ------------------------------ */

/**
 * 释放腾讯地图实例 / 图层，返回 null。
 * SPA 切换页面会移除整个 DOM，但地图实例仍绑定在已移除的容器上，
 * 若不在离开时销毁，再次进入页面时新容器会是空白（"地图不显示"）。
 */
function disposeMapObj(o) {
  if (!o) return null;
  try { if (typeof o.destroy === 'function') { o.destroy(); return null; } } catch (e) { /* 忽略 */ }
  try { if (typeof o.setMap === 'function') o.setMap(null); } catch (e) { /* 忽略 */ }
  return null;
}

/** 等待地图容器完成布局后再执行（尺寸为 0 时地图会渲染异常） */
function whenMapSized(el, cb, tries) {
  let left = tries || 20;
  const step = () => {
    if (!el || !el.isConnected) return;
    const w = el.clientWidth, hh = el.clientHeight;
    if ((w > 0 && hh > 0) || left <= 0) { cb(w, hh); return; }
    left--;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ------------------------------ 格式化 ------------------------------ */

const fmt = {
  n(v, digits) {
    if (v === null || v === undefined || v === '') return '-';
    const num = Number(v);
    if (!Number.isFinite(num)) return String(v);
    return num.toLocaleString('zh-CN', { minimumFractionDigits: digits || 0, maximumFractionDigits: digits === undefined ? 2 : digits });
  },
  /** 面积：保留两位并去掉多余小数 */
  area(v) {
    if (v === null || v === undefined || v === '') return '-';
    const num = Number(v);
    if (!Number.isFinite(num)) return String(v);
    return (Math.round(num * 100) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  },
  /** 金额：按万元/亿元折算，便于阅读 */
  money(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) return '-';
    const abs = Math.abs(num);
    if (abs >= 1e8) return (num / 1e8).toFixed(2) + ' 亿元';
    if (abs >= 1e4) return (num / 1e4).toFixed(2) + ' 万元';
    return num.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 元';
  },
  moneyPlain(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) return '-';
    return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  date(v) {
    if (!v) return '-';
    const s = String(v);
    return s.length > 10 ? s.slice(0, 10) : s;
  },
  rel(v) {
    if (!v) return '-';
    const t = new Date(String(v).replace(' ', 'T')).getTime();
    if (!Number.isFinite(t)) return String(v).slice(0, 16);
    const diff = Date.now() - t;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 30 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
    return String(v).slice(0, 10);
  },
  pct(a, b) {
    if (!b) return '0%';
    return (Math.round((a / b) * 1000) / 10) + '%';
  },
  cut(s, n) {
    const str = String(s == null ? '' : s);
    return str.length > n ? str.slice(0, n) + '…' : str;
  },
};

/* ------------------------------ 配色 ------------------------------ */

const PALETTE = ['#2159d6', '#12a670', '#d98700', '#8b5cf6', '#0b8ec9', '#d92d20', '#0f9b8e', '#e0669b', '#6b7280', '#4a7c3f'];

const CAT_COLOR = {
  办公用房: '#2159d6',
  其他用房: '#8b5cf6',
  住宅: '#12a670',
  车库: '#d98700',
  周转房: '#0b8ec9',
  土地: '#4a7c3f',
  其他: '#6b7280',
  未填写: '#b3bac9',
};

const STATUS_COLOR = {
  自用: '#12a670',
  出租: '#0b8ec9',
  出借: '#8b5cf6',
  借用: '#d98700',
  闲置: '#d92d20',
  已拆除: '#6b7280',
  其他: '#6b7280',
  未填写: '#b3bac9',
};

function colorOf(map, key, i) {
  return map[key] || PALETTE[(i || 0) % PALETTE.length];
}

/* ------------------------------ 提示 ------------------------------ */

function toast(msg, type, ms) {
  const box = $('#toasts') || (function () {
    const d = document.createElement('div');
    d.id = 'toasts';
    document.body.appendChild(d);
    return d;
  })();
  const t = h(`<div class="toast ${type || 'ok'}"><span>${esc(msg)}</span></div>`);
  box.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .2s, transform .2s';
    t.style.opacity = '0';
    t.style.transform = 'translateY(-6px)';
    setTimeout(() => t.remove(), 220);
  }, ms || 2400);
}

/* ------------------------------ 弹窗 ------------------------------ */

function modal(opts) {
  const o = opts || {};
  const mask = h(`<div class="mask">
    <div class="dlg ${o.size || ''}">
      <div class="dlg-h"><h3>${esc(o.title || '')}</h3><div class="spacer"></div><div class="x">✕</div></div>
      <div class="dlg-b"></div>
      ${o.footer === false ? '' : '<div class="dlg-f"></div>'}
    </div>
  </div>`);
  const body = $('.dlg-b', mask);
  const foot = $('.dlg-f', mask);

  if (o.bodyNode) body.appendChild(o.bodyNode);
  else if (o.body) body.innerHTML = o.body;

  if (o.buttons) {
    o.buttons.forEach((b) => {
      const btn = h(`<button class="btn ${b.cls || ''}">${esc(b.text)}</button>`);
      on(btn, 'click', () => { if (b.onClick) b.onClick(apiClose); else apiClose(); });
      foot.appendChild(btn);
    });
  }

  const close = () => { mask.remove(); if (o.onClose) o.onClose(); };
  function apiClose() { close(); }
  on($('.x', mask), 'click', close);
  on(mask, 'click', (e) => { if (e.target === mask && o.maskClose !== false) close(); });
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  const origRemove = mask.remove.bind(mask);
  mask.remove = () => { document.removeEventListener('keydown', escHandler); origRemove(); };

  document.body.appendChild(mask);
  return { mask, body, foot, close };
}

function confirmDlg(msg, title) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title: title || '请确认',
      size: '',
      body: `<div style="font-size:13px;line-height:1.7">${msg}</div>`,
      // 注意：必须先 fin(...) 再 c()。c() 会触发 onClose → fin(false)，
      // 若顺序颠倒，点「确定」也会得到 false（历史 bug）。
      buttons: [
        { text: '取消', onClick: (c) => { fin(false); c(); } },
        { text: '确定', cls: 'pri', onClick: (c) => { fin(true); c(); } },
      ],
      onClose: () => fin(false),
    });
  });
}

/* ------------------------------ 接口 ------------------------------ */

const API = (function () {
  const DEFAULT_PORT = 8789;
  let base = localStorage.getItem('apiBase');
  if (!base) {
    base = (location.hostname === '127.0.0.1' || location.hostname === 'localhost') && location.port === String(DEFAULT_PORT)
      ? ''
      : `http://127.0.0.1:${DEFAULT_PORT}`;
  }

  return {
    get base() { return base; },
    setBase(v) { base = String(v || '').replace(/\/+$/, ''); localStorage.setItem('apiBase', base); },

    async call(method, path, body) {
      let res;
      try {
        res = await fetch(base + path, {
          method,
          headers: Object.assign(
            { 'Content-Type': 'application/json' },
            Session.token ? { Authorization: 'Bearer ' + Session.token } : {}
          ),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        throw new Error('无法连接后端服务（' + base + '）。请确认服务已启动：node server/server.js');
      }
      const ct = res.headers.get('content-type') || '';
      if (res.status === 401) {
        Session.clear();
        boot();
        throw new Error('登录已过期，请重新登录');
      }
      if (!ct.includes('json')) {
        if (res.status >= 400) throw new Error('请求失败 ' + res.status);
        return { status: res.status, blob: await res.blob() };
      }
      const data = await res.json();
      if (res.status >= 400) throw new Error(data.error || ('请求失败 ' + res.status));
      return data;
    },

    get(p) { return API.call('GET', p); },
    post(p, b) { return API.call('POST', p, b); },
    put(p, b) { return API.call('PUT', p, b); },
    del(p) { return API.call('DELETE', p); },

    /** 带查询串的 GET */
    getQ(p, params) {
      const q = new URLSearchParams();
      Object.keys(params || {}).forEach((k) => {
        const v = params[k];
        if (v === null || v === undefined || v === '' || v === false) return;
        if (Array.isArray(v)) { if (v.length) q.set(k, v.join(',')); return; }
        q.set(k, String(v));
      });
      const s = q.toString();
      return API.call('GET', p + (s ? '?' + s : ''));
    },
  };
})();

/** 带鉴权头下载文件（window.open 无法携带 Authorization，必须先取回 blob） */
async function downloadAuth(pathWithQuery, filename) {
  const res = await fetch(API.base + pathWithQuery, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, Session.token ? { Authorization: 'Bearer ' + Session.token } : {}),
  });
  if (!res.ok) {
    let msg = '下载失败 ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* 非 JSON 响应 */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ------------------------------ 会话 ------------------------------ */

const Session = {
  token: localStorage.getItem('token') || '',
  user: null,
  options: null,

  save(token, user) {
    this.token = token;
    this.user = user;
    localStorage.setItem('token', token);
  },
  clear() {
    this.token = '';
    this.user = null;
    this.options = null;
    localStorage.removeItem('token');
  },
  can(p) {
    if (!this.user) return false;
    const roles = (this.options && this.options.roles) || {};
    const r = roles[this.user.role];
    return !!r && r.can.indexOf(p) >= 0;
  },
  /** 是否系统管理员（可见并管理全部单位） */
  isSysAdmin() { return !!this.user && this.user.role === 'admin'; },
  /**
   * 当前用户所属单位名称（'' = 未绑定）。
   * 注意：非系统管理员未绑定单位时可见范围为空（与后端 org.js 一致），
   * 不能退化成「可见全部」，否则就是越权。
   */
  myUnit() { return (this.user && this.user.unit) || ''; },
  /** 是否可修改某单位的资产：系统管理员全部可改；其余仅本单位可改（下级单位只读） */
  canWriteUnit(unitName) {
    if (!this.user) return false;
    if (this.isSysAdmin()) return true;
    if (!this.myUnit()) return false;
    return String(unitName || '') === this.myUnit();
  },
  canWriteAsset(asset) { return !!asset && this.canWriteUnit(asset.unit); },
  async loadOptions(force) {
    if (this.options && !force) return this.options;
    this.options = await API.get('/api/options');
    return this.options;
  },
  field(key) {
    const f = (this.options && this.options.fields || []).find((x) => x.key === key);
    return f || { key, label: key, type: 'text', options: [] };
  },
};

/* ------------------------------ 单位作用域 ------------------------------ */

/**
 * Scope —— 全局「当前单位」作用域。左侧单位树点选后，看板 / 台账 / 地图 / 预览 / 导出
 * 均只显示该单位的数据。unit 为空串表示「全部单位」。
 * 非管理员（绑定了所属单位）只能看到并锁定在自己的单位，后端也会再兜一层过滤。
 */
const Scope = {
  unit: '',        // 当前查看单位名称；'' = 全部单位
  tree: [],        // 层级树：[{ id, name, parent, level, path, children: [...] }]
  units: [],       // 可见单位名称（树的前序遍历，含数据中已出现但未登记的单位）
  counts: {},      // { 单位名: 资产条数 } 精确口径（含下级用 countTree）
  total: 0,
  collapsed: false, // 整棵树折叠
  fold: {},        // { 单位 id: true } 单个节点折叠
  _subs: [],

  key() { return 'scopeUnit:' + (((Session.user || {}).id) || ''); },
  /** 是否可切换到「全部单位」：仅系统管理员 */
  canAll() { return Session.isSysAdmin(); },
  label() { return this.unit || '全部单位'; },

  /** 登录/刷新后初始化：恢复上次选择，并拉取单位层级与数量 */
  async init() {
    const me = Session.user || {};
    const saved = localStorage.getItem(this.key());
    let u = saved == null ? '' : String(saved);
    if (!this.canAll()) u = me.unit || '';
    this.unit = u;
    this.collapsed = localStorage.getItem(this.key() + ':collapsed') === '1';
    try { this.fold = JSON.parse(localStorage.getItem(this.key() + ':fold') || '{}') || {}; }
    catch (e) { this.fold = {}; }
    await this.refresh();
    if (!this.canAll()) this.unit = me.unit || '';
    else if (this.unit && this.units.length && this.units.indexOf(this.unit) < 0) this.unit = ''; // 单位已删除
  },

  /** 拉取单位层级 + 可见范围内的单位分布数量 */
  async refresh() {
    try {
      const [us, st] = await Promise.all([API.get('/api/units'), API.get('/api/stats')]);
      const visible = us.visible ? new Set(us.visible) : null;
      let rows = (us.rows || []).filter((r) => !visible || visible.has(r.name));
      // 数据中出现但未在单位表登记的单位（仅在其可见时才补进树，作为顶级节点）
      const known = new Set(rows.map((r) => r.name));
      (st.byUnit || []).map((x) => x.name).filter((n) => n && n !== '未填写' && !known.has(n)).forEach((n) => {
        if (visible && !visible.has(n)) return;
        rows.push({ id: 'v:' + n, name: n, parent: '', code: '', sort: 9999, level: 0, virtual: true });
      });
      this.tree = this.buildTree(rows);
      this.units = [];
      const walk = (arr) => arr.forEach((n) => { this.units.push(n.name); walk(n.children || []); });
      walk(this.tree);
      this.counts = {};
      (st.byUnit || []).forEach((x) => { this.counts[x.name] = x.count; });
      this.total = st.total || 0;
    } catch (e) {
      this.tree = this.tree || [];
      this.units = this.units || [];
    }
  },

  /** 由扁平行（含 parent）构建层级树 */
  buildTree(rows) {
    const nodes = rows.map((r) => Object.assign({ children: [] }, r));
    const byId = new Map();
    nodes.forEach((n) => byId.set(n.id, n));
    const roots = [];
    nodes.forEach((n) => {
      const p = n.parent ? byId.get(n.parent) : null;
      if (p && p !== n) p.children.push(n); else roots.push(n);
    });
    const sortRec = (arr) => {
      arr.sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
      arr.forEach((x) => sortRec(x.children));
    };
    sortRec(roots);
    return roots;
  },

  /** 精确条数 */
  countOf(name) { return this.counts[name] || 0; },

  /** 某单位及其全部下级的名称列表 */
  subtreeNames(name) {
    const find = (arr) => {
      for (const n of arr) {
        if (n.name === name) return n;
        const hit = find(n.children || []);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(this.tree);
    if (!node) return [name];
    const out = [];
    const walk = (n) => { out.push(n.name); (n.children || []).forEach(walk); };
    walk(node);
    return out;
  },

  /** 含全部下级单位的合计条数 */
  countTree(name) {
    return this.subtreeNames(name).reduce((s, n) => s + this.countOf(n), 0);
  },

  /** 该单位是否可选（非系统管理员只能在本单位及下级之间切换） */
  canSelect(name) {
    const next = String(name || '');
    if (!next) return this.canAll();
    return this.units.indexOf(next) >= 0;
  },

  set(name) {
    const next = String(name || '');
    if (!this.canSelect(next)) return;
    if (next === this.unit) return;
    this.unit = next;
    localStorage.setItem(this.key(), next);
    this.emit();
  },

  toggle() {
    this.collapsed = !this.collapsed;
    localStorage.setItem(this.key() + ':collapsed', this.collapsed ? '1' : '0');
    this.emit();
  },

  /** 单个节点的展开 / 收起 */
  toggleNode(id) {
    if (!id) return;
    this.fold[id] = !this.fold[id];
    localStorage.setItem(this.key() + ':fold', JSON.stringify(this.fold));
    this.emit();
  },

  /** 给接口查询串附加当前单位（页面自身的单位筛选由调用方做交集处理） */
  params(extra) { return Object.assign({ unit: this.unit }, extra || {}); },

  onChange(fn) { if (typeof fn === 'function') this._subs.push(fn); },
  emit() { this._subs.slice().forEach((f) => { try { f(); } catch (e) { console.error(e); } }); },

  reset() {
    this.unit = ''; this.tree = []; this.units = []; this.counts = {};
    this.total = 0; this.collapsed = false; this.fold = {}; this._subs = [];
  },
};
