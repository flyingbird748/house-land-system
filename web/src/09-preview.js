'use strict';
/* ============================================================
 *  preview —— 房产预览：把已标注的房产土地点位铺在地图上，
 *  鼠标移到点位即浮出简要信息（名称/分类/面积/使用状态/产权/账面原值）。
 *  合规说明：底图与地理编码均使用腾讯地图（见 09-map.js）。
 * ============================================================ */

/** 简要信息卡片需要的字段 */
const PV_ROWS = [
  { k: '分类', get: (a) => esc(a.category || '-') },
  { k: '面积', get: (a) => `<b>${esc(fmt.area(a.area))}</b> ㎡` },
  { k: '使用状态', get: (a) => esc(a.useStatus || '-') },
  { k: '产权', get: (a) => pvTitle(a) },
  { k: '账面原值', get: (a) => `<b>${esc(fmt.money(a.originalValue))}</b>` },
];

function pvTitle(a) {
  const parts = [];
  if (a.hasTitle) parts.push(esc(a.hasTitle));
  if (a.titleType) parts.push(esc(fmt.cut(a.titleType, 16)));
  return parts.length ? parts.join(' · ') : '-';
}

/** 悬停态图标：外圈光环 + 放大，锚点仍在底部中心 */
function pvActiveIcon(color) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48">'
    + '<circle cx="18" cy="17" r="15" fill="' + color + '" fill-opacity="0.22" stroke="' + color + '" stroke-width="2.5"/>'
    + '<path d="M18 6C12.5 6 8 10.5 8 16c0 7.5 10 20 10 20s10-12.5 10-20c0-5.5-4.5-10-10-10z" fill="' + color + '" stroke="#ffffff" stroke-width="2"/>'
    + '<circle cx="18" cy="16" r="4.6" fill="#ffffff"/></svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/** 批量地址解析（供预览页在无坐标时快速生成点位） */
async function pvBatchGeocode(assets, onDone) {
  const todo = assets.filter((a) => !(Number.isFinite(a.lng) && Number.isFinite(a.lat)) && a.location);
  if (!todo.length) { toast('没有可用于解析的未标注资产', 'warn'); return; }
  const n = Math.min(todo.length, 60);
  const pname = (Geo.cfg && Geo.cfg.providerName) || '地图服务';
  if (!await confirmDlg(`将对前 <b>${n}</b> 条未标注资产按「坐落位置」调用${esc(pname)}地理编码解析坐标，<br>结果会<b>自动保存</b>，之后请人工核对点位是否准确。`)) return;

  try { await Geo.sdk(); } catch (e) { toast(e.message === 'NO_CONFIG' ? (e.msg || '地图服务未配置') : e.message, 'err'); return; }

  const items = [];
  let okCount = 0, failCount = 0;

  const dlg = modal({
    title: '批量地址解析',
    body: `<div id="bg-t" style="font-size:13px">正在解析 0 / ${n} …</div>
      <div style="margin-top:10px">${progressBar(0, n).outerHTML}</div>
      <div class="muted" id="bg-log" style="font-size:11.5px;margin-top:10px;max-height:180px;overflow:auto;line-height:1.7"></div>`,
    footer: false,
    maskClose: false,
  });
  const title = $('#bg-t', dlg.body);
  const bar = $('.p', dlg.body);
  const log = $('#bg-log', dlg.body);

  for (let i = 0; i < n; i++) {
    const a = todo[i];
    let addr = String(a.location).trim();
    if (!/重庆/.test(addr)) addr = '重庆市' + addr.replace(/^.*?(省|市)/, '');
    try {
      const loc = await Geo.geocode(addr);
      if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
        items.push({ id: a.id, lng: loc.lng, lat: loc.lat, address: a.location });
        okCount++;
        log.innerHTML += `<span style="color:var(--ok)">✓</span> ${esc(fmt.cut(a.name, 18))}<br>`;
      } else {
        failCount++;
        log.innerHTML += `<span style="color:var(--danger)">✕</span> ${esc(fmt.cut(a.name, 18))}（未返回结果）<br>`;
      }
    } catch (e) {
      failCount++;
      log.innerHTML += `<span style="color:var(--danger)">✕</span> ${esc(fmt.cut(a.name, 18))}（${esc(e.message || '失败')}）<br>`;
    }
    title.textContent = `正在解析 ${i + 1} / ${n} …`;
    bar.style.width = Math.round(((i + 1) / n) * 100) + '%';
    log.scrollTop = log.scrollHeight;
    await new Promise((r) => setTimeout(r, 120));
  }

  if (items.length) {
    try { await API.post('/api/assets/geo/batch', { items }); }
    catch (e) { toast(e.message, 'err'); }
  }
  dlg.close();
  toast(`解析完成：成功 ${okCount} 条，失败 ${failCount} 条`, okCount ? 'ok' : 'warn');
  if (onDone) await onDone();
}

/* ------------------------------ 页面 ------------------------------ */

const PreviewPage = {
  title: '房产预览',
  map: null,
  markers: null,
  highlight: null,
  polygons: null,
  assets: [],
  kw: '',
  cat: 'all',
  status: '',
  hasTitle: '',
  hoverId: null,
  tipTimer: null,
  detailOpen: false, // 详情弹窗打开期间，禁止简要信息浮卡弹出（避免两卡重叠）

  /** 离开页面：销毁地图实例。再次进入时重新创建，避免地图绑在已移除的容器上 */
  leave() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this.tipTimer) { clearTimeout(this.tipTimer); this.tipTimer = null; }
    this.hoverId = null;
    this.detailOpen = false;
    this.geoms = null;
    this._projKey = '';
    this._projPts = null;
    this.markers = Geo.destroyLayer(this.markers);
    this.polygons = Geo.destroyLayer(this.polygons);
    this.map = Geo.destroyMap(this.map);
    this.rootEl = null;
  },

  render(root) {
    if (guard(root, 'read')) return;
    const self = this;
    this.leave(); // 每次进入都从干净的地图状态开始（相当于自动刷新）
    root.style.padding = '0';
    this.rootEl = root;
    this.hoverId = null;

    const page = h(`<div class="map-page">
      <div class="map-side">
        <div class="hd">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
            <input class="inp" id="pv-kw" placeholder="搜索名称 / 坐落位置 / 使用单位" style="flex:1">
            <button class="btn sm" id="pv-reload" title="刷新">↻</button>
          </div>
          <div class="chips" id="pv-cats"></div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <select class="inp" id="pv-st" style="flex:1"></select>
            <select class="inp" id="pv-ti" style="flex:1"></select>
          </div>
        </div>
        <div class="lst" id="pv-lst"><div class="empty" style="padding:24px">加载中…</div></div>
        <div style="padding:8px 12px;border-top:1px solid var(--line-2)">
          <div style="display:flex;gap:6px">
            <button class="btn sm" id="pv-fit" style="flex:1">全览点位</button>
            <button class="btn sm" id="pv-reset">重置</button>
          </div>
          <div class="muted" style="font-size:11px;margin-top:6px" id="pv-stat"></div>
        </div>
      </div>
      <div class="pv-stage" id="pv-stage">
        <div id="pv-map" class="pv-canvas"></div>
        <div class="pv-stat" id="pv-badge" style="display:none"></div>
        <div class="pv-legend" id="pv-legend"></div>
        <div class="pv-tip" id="pv-tip"></div>
        <div class="map-toolbar">
          <div class="map-box" id="pv-keybox" style="display:none"></div>
          <div class="map-box"><span class="muted" style="font-size:12px">鼠标移到点位查看简要信息 · 点击查看详情</span></div>
        </div>
        <div class="pv-mask" id="pv-mask" style="display:none"></div>
      </div>
    </div>`);
    root.appendChild(page);

    const kw = $('#pv-kw', page);
    let t;
    on(kw, 'input', () => { clearTimeout(t); t = setTimeout(() => { self.kw = kw.value.trim(); self.renderList(); }, 200); });
    on($('#pv-reload', page), 'click', () => {
      self.load().then(() => self.refresh()).catch((e) => toast(e.message, 'err'));
    });
    on($('#pv-fit', page), 'click', () => self.fitAll());
    on($('#pv-reset', page), 'click', () => {
      kw.value = ''; self.kw = ''; self.cat = 'all'; self.status = ''; self.hasTitle = '';
      $$('#pv-cats .chip', page).forEach((c) => c.classList.toggle('on', c.dataset.f === 'all'));
      $('#pv-st', page).value = '';
      $('#pv-ti', page).value = '';
      self.renderList();
      self.fitAll();
    });
    on($('#pv-st', page), 'change', function () { self.status = this.value; self.renderList(); });
    on($('#pv-ti', page), 'change', function () { self.hasTitle = this.value; self.renderList(); });
    on($('#pv-stage', page), 'mouseleave', () => self.hideTip());
    on($('#pv-stage', page), 'mousemove', (e) => self.onStageMove(e));

    this.load()
      .then(() => this.initMap())
      .catch((e) => {
        if (e.message === 'NO_CONFIG') this.showKeySetup(e);
        else toast(e.message, 'err');
      });
  },

  /* ------------------------------ 数据 ------------------------------ */

  isMarked(a) { return Number.isFinite(a.lng) && Number.isFinite(a.lat); },

  async load() {
    const r = await API.getQ('/api/assets', Scope.params({ pageSize: 'all', sort: 'rowNo', order: 'asc' }));
    this.assets = r.rows;
    this.buildFilters();
    this.renderList();
    await this.loadImages();
  },

  /** 一次性拉齐图片索引（元数据，不含二进制），悬停浮卡据此渲染缩略图 */
  async loadImages() {
    this.imgMap = {};
    try {
      const ids = this.assets.filter((a) => this.isMarked(a)).map((a) => a.id);
      if (!ids.length) return;
      const r = await API.getQ('/api/images', { ids: ids.join(',') });
      this.imgMap = (r && r.map) || {};
    } catch (e) { /* 图片取不到不影响点位与列表 */ }
  },

  filtered() {
    const kw = this.kw.toLowerCase();
    return this.assets.filter((a) => {
      if (!this.isMarked(a)) return false;
      if (this.cat !== 'all' && (a.category || '未填写') !== this.cat) return false;
      if (this.status && (a.useStatus || '') !== this.status) return false;
      if (this.hasTitle && (a.hasTitle || '') !== this.hasTitle) return false;
      if (kw && ![a.name, a.location, a.useUnit, a.assetNo, a.unit].join(' ').toLowerCase().includes(kw)) return false;
      return true;
    });
  },

  buildFilters() {
    const marked = this.assets.filter((a) => this.isMarked(a));
    const box = $('#pv-cats', this.rootEl);
    if (box && !box.dataset.built) {
      const cats = [...new Set(marked.map((a) => a.category || '未填写'))];
      clear(box);
      const mk = (f, label) => {
        const c = h(`<span class="chip ${f === this.cat ? 'on' : ''}" data-f="${esc(f)}">${esc(label)}</span>`);
        on(c, 'click', () => {
          this.cat = f;
          $$('#pv-cats .chip', this.rootEl).forEach((x) => x.classList.remove('on'));
          c.classList.add('on');
          this.renderList();
        });
        box.appendChild(c);
      };
      mk('all', '全部');
      cats.forEach((c) => mk(c, c));
      box.dataset.built = '1';
    }

    const opts = ((Session.options || {}).fields || []);
    const fillSel = (id, key, state) => {
      const sel = $('#' + id, this.rootEl);
      if (!sel || sel.options.length) return;
      const f = opts.find((x) => x.key === key) || {};
      sel.appendChild(h('<option value="">' + (f.label || key) + '：全部</option>'));
      (f.options || []).forEach((o) => sel.appendChild(h(`<option value="${esc(o)}">${esc(o)}</option>`)));
      sel.value = state;
    };
    fillSel('pv-st', 'useStatus', this.status);
    fillSel('pv-ti', 'hasTitle', this.hasTitle);
  },

  renderList() {
    const box = $('#pv-lst', this.rootEl);
    if (!box) return;
    this._projKey = ''; // 过滤条件变化后投影缓存作废
    const list = this.filtered();

    clear(box);
    if (!list.length) {
      box.appendChild(h('<div class="empty" style="padding:24px">没有匹配的已标注资产</div>'));
    }
    list.forEach((a) => {
      const it = h(`<div class="it done ${this.hoverId === a.id ? 'on' : ''}" data-id="${a.id}">
        <div class="pin" style="color:${esc(colorOf(CAT_COLOR, a.category || '未填写', 0))}">◉</div>
        <div style="min-width:0;flex:1">
          <div class="nm ellip">${esc(a.name || '未命名资产')}</div>
          <div class="mt ellip">${esc(a.location || a.unit || '')}</div>
          <div class="mt" style="margin-top:3px">
            <span class="tag b">${esc(a.category || '-')}</span>
            <span class="tag n" style="margin-left:4px">${esc(a.useStatus || '-')}</span>
            <span class="tag n" style="margin-left:4px">${esc(fmt.area(a.area))} ㎡</span>
          </div>
        </div>
      </div>`);
      on(it, 'mouseenter', () => this.showTip(a, true));
      on(it, 'mouseleave', () => this.hideTip());
      on(it, 'click', () => this.focus(a.id));
      box.appendChild(it);
    });

    const st = $('#pv-stat', this.rootEl);
    if (st) {
      const all = this.assets.filter((a) => this.isMarked(a)).length;
      st.innerHTML = `显示 ${list.length} / 已标注 ${all} 条 ｜ 全部 ${this.assets.length} 条`;
    }

    const badge = $('#pv-badge', this.rootEl);
    if (badge) {
      if (list.length) {
        badge.style.display = '';
        const area = list.reduce((s, a) => s + (Number(a.area) || 0), 0);
        const val = list.reduce((s, a) => s + (Number(a.originalValue) || 0), 0);
        badge.innerHTML = `当前显示 <b>${list.length}</b> 处 ｜ 面积 ${esc(fmt.area(area))} ㎡ ｜ 原值 ${esc(fmt.money(val))}`;
      } else {
        badge.style.display = 'none';
      }
    }

    this.renderLegend(list);
    this.renderMask();
    // 列表与地图点位始终同源：筛选/搜索后同步重绘点位
    if (this.markers) {
      this.hoverId = null;
      this.hideTip();
      this.renderMarkers();
    }
  },

  renderLegend(list) {
    const box = $('#pv-legend', this.rootEl);
    if (!box) return;
    const cats = [...new Set(list.map((a) => a.category || '未填写'))];
    clear(box);
    cats.forEach((c, i) => {
      box.appendChild(h(`<div class="li"><span class="dot" style="background:${esc(colorOf(CAT_COLOR, c, i))}"></span>${esc(c)}</div>`));
    });
  },

  renderMask() {
    const mask = $('#pv-mask', this.rootEl);
    if (!mask) return;
    const marked = this.assets.filter((a) => this.isMarked(a)).length;
    if (marked) { mask.style.display = 'none'; return; }
    mask.style.display = '';
    clear(mask);
    mask.appendChild(h(`<div>
      <div class="ic">⌖</div>
      <div class="t">还没有已标注的点位</div>
      <div class="s">共 ${this.assets.length} 条房屋土地数据，均未完成地图标注。<br>可先按「坐落位置」自动解析坐标，或到地图标注页逐条打点。</div>
      <div class="a">
        ${Session.can('geo') ? '<button class="btn pri sm" id="pv-m-geo">一键地址解析</button>' : ''}
        <button class="btn sm" id="pv-m-go">前往地图标注</button>
      </div>
    </div>`));
    const g = $('#pv-m-geo', mask);
    if (g) on(g, 'click', () => pvBatchGeocode(this.assets, () => this.load()));
    const go2 = $('#pv-m-go', mask);
    if (go2) on(go2, 'click', () => { location.hash = '#/map'; });
  },

  /* ------------------------------ 地图 ------------------------------ */

  async initMap() {
    await Geo.sdk();
    const self = this;
    const el = document.getElementById('pv-map');
    if (!el) return;
    if (this.map) { this.renderMarkers(); return; }

    fixMapHeight(el); // WebView 高度链塌陷兜底，同地图标注页

    // 容器 id 交给适配层；默认视野取自系统设置
    this.map = Geo.createMap('pv-map', Geo.center());

    this.markers = Geo.markerLayer(this.map, {});
    // SDK 的 hover 需要鼠标在点内连续移动才触发，仅作为补充；
    // 主要的悬停判定由容器级命中检测完成（见 onStageMove）。
    Geo.layerOn(this.markers, 'hover', (evt) => {
      const id = evt && evt.geometry && evt.geometry.id;
      if (!id) return;
      const a = self.assets.find((x) => x.id === id);
      if (a) self.showTip(a, false);
    });
    Geo.layerOn(this.markers, 'click', (evt) => {
      const id = evt && evt.geometry && evt.geometry.id;
      const a = id && self.assets.find((x) => x.id === id);
      if (a) self.openDetail(a);
    });

    this.polygons = Geo.polygonLayer(this.map, {
      fillColor: 'rgba(33,89,214,0.16)', borderColor: '#2159d6', borderWidth: 2,
    });

    // 地图平移/缩放时浮动卡位置会失效，直接隐藏
    Geo.onMap(this.map, 'viewchange', () => self.hideTip());

    this.refresh(el);
  },

  /** 刷新地图：重绘点位，等容器布局完成后再校正尺寸与视野 */
  refresh(el) {
    this.renderMarkers();
    const box = el || document.getElementById('pv-map');
    whenMapSized(box, () => {
      if (!this.map) return;
      fixMapHeight(box);
      Geo.resize(this.map);
      this.fitAll();
    });
  },

  renderMarkers() {
    if (!this.markers) return;
    const list = this.filtered();

    const cats = [...new Set(list.map((a) => a.category || '未填写'))];
    const styles = {};
    cats.forEach((c, i) => {
      const color = colorOf(CAT_COLOR, c, i);
      styles['s' + i] = { src: markerIcon(color), width: 26, height: 34, anchorX: 13, anchorY: 34 };
      styles['a' + i] = { src: pvActiveIcon(color), width: 36, height: 48, anchorX: 18, anchorY: 48 };
    });

    const hid = this.hoverId;
    this.geoms = list.map((a) => {
      const i = cats.indexOf(a.category || '未填写');
      return {
        id: a.id,
        styleId: a.id === hid ? 'a' + i : 's' + i,
        position: { lat: a.lat, lng: a.lng },
        _base: 's' + i,
        _on: 'a' + i,
      };
    });

    const polys = list
      .filter((a) => Array.isArray(a.polygon) && a.polygon.length >= 3)
      .map((a) => ({ id: a.id, styleId: 'p', paths: a.polygon.map((p) => ({ lat: p.lat, lng: p.lng })) }));

    Geo.setStyles(this.markers, styles);
    // 注意：必须整体替换。腾讯 SDK 的 updateGeometries 是「合并更新」，
    // 不会移除已消失的点位；天地图适配层则按 id 增量维护，多余的会自动移除。
    Geo.setMarkers(this.markers, this.geoms);
    Geo.setPaths(this.polygons, polys);
    this._projKey = '';
  },

  /** 用样式切换实现悬停高亮（避免额外图层拦截点击） */
  applyHoverStyle(id) {
    if (!this.markers || !this.geoms) return;
    const gs = this.geoms.map((g) => Object.assign({}, g, { styleId: g.id === id ? g._on : g._base }));
    Geo.setMarkers(this.markers, gs);
  },

  fitAll() {
    if (!this.map) return;
    const list = this.filtered();
    if (!list.length) {
      const c = Geo.center();
      Geo.setCenter(this.map, c.lat, c.lng);
      Geo.setZoom(this.map, c.zoom);
      return;
    }
    if (list.length === 1) {
      Geo.panTo(this.map, list[0].lat, list[0].lng, 16);
      return;
    }
    Geo.fitBounds(this.map, list.map((a) => ({ lat: a.lat, lng: a.lng })));
  },

  /**
   * 点击点位打开详情：先立即收起简要信息浮卡，并在弹窗打开期间禁止浮卡再次弹出，
   * 关闭后恢复悬停预览（避免「简要信息」与「详细信息」重叠显示）。
   */
  openDetail(a) {
    this.detailOpen = true;
    this._mx = null;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this.hideTip(true);
    AssetForm.view(a, () => {
      this.detailOpen = false;
      this._mx = null;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    });
  },

  focus(id) {
    const a = this.assets.find((x) => x.id === id);
    if (!a || !this.isMarked(a)) return;
    if (this.map) Geo.panTo(this.map, a.lat, a.lng, 16);
    this.showTip(a, true);
    $$('#pv-lst .it', this.rootEl).forEach((x) => x.classList.toggle('on', x.dataset.id === id));
  },

  /* ------------------------------ 悬停浮卡 ------------------------------ */

  /** 当前点位的容器像素坐标（按视图状态缓存，避免每帧重复投影） */
  projPoints() {
    const list = this.filtered();
    if (!this.map) return [];
    let key = '';
    try {
      const c = Geo.getCenter(this.map);
      key = [Geo.getZoom(this.map), c.lat.toFixed(6), c.lng.toFixed(6), list.length].join('|');
    } catch (e) { key = ''; }
    if (key && key === this._projKey && this._projPts) return this._projPts;

    const pts = [];
    for (let i = 0; i < list.length; i++) {
      const p = Geo.project(this.map, list[i].lat, list[i].lng);
      if (p && Number.isFinite(p.x)) pts.push({ a: list[i], x: p.x, y: p.y });
    }
    this._projKey = key;
    this._projPts = pts;
    return pts;
  },

  /** 容器像素命中检测：找出鼠标下的点位（图标 26×34，锚点在底部中心） */
  hitTest(px, py) {
    const pts = this.projPoints();
    let best = null, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = px - pts[i].x;
      const dy = py - (pts[i].y - 17); // 图标中心
      if (Math.abs(dx) > 15 || Math.abs(dy) > 20) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = pts[i].a; }
    }
    return best;
  },

  /** 鼠标移动：只记录最新位置，用 rAF 合并处理，保证停下的那一帧也会判定 */
  onStageMove(e) {
    const stage = $('#pv-stage', this.rootEl);
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    this._mx = e.clientX - r.left;
    this._my = e.clientY - r.top;
    if (this._raf) return;
    const self = this;
    this._raf = requestAnimationFrame(() => {
      self._raf = null;
      self.resolveHover();
    });
  },

  resolveHover() {
    if (this._mx == null || this.detailOpen) return;
    const a = this.hitTest(this._mx, this._my);
    if (a) {
      if (this.hoverId !== a.id) this.showTip(a, false);
      else this.positionTip(a);
    } else if (this.hoverId) {
      this.hideTip();
    }
  },

  /** 与 a 落在同一屏幕位置（4px 内）的其他资产数量 */
  coLocated(a) {
    const pts = this.projPoints();
    const me = pts.find((p) => p.a.id === a.id);
    if (!me) return 0;
    return pts.filter((p) => p.a.id !== a.id && Math.abs(p.x - me.x) <= 4 && Math.abs(p.y - me.y) <= 4).length;
  },

  showTip(a, fromList) {
    if (this.detailOpen) return; // 详情弹窗打开时不显示简要信息
    const tip = $('#pv-tip', this.rootEl);
    if (!tip) return;
    clearTimeout(this.tipTimer);
    this.hoverId = a.id;

    const rows = PV_ROWS.map((r) => `<div class="kv"><span class="k">${esc(r.k)}</span><span class="v">${r.get(a)}</span></div>`).join('');
    const sub = [a.useUnit, a.location].filter(Boolean).map((s) => esc(fmt.cut(s, 26))).join(' · ');
    const extra = [];
    if (a.titleNo) extra.push('证号 ' + esc(a.titleNo));
    if (a.unit) extra.push(esc(fmt.cut(a.unit, 20)));
    extra.push('点击查看完整资料');

    // 共址提示：多条资产落在同一像素（同一楼栋多套房屋很常见）
    const near = this.coLocated(a);
    const nearTip = near ? `<div class="ft" style="border-top:none;padding-top:2px">该位置另有 <b>${near}</b> 处资产，可在左侧列表逐条查看</div>` : '';

    // 缩略图：取已上传图片（最多 3 张），按 正面 / 侧面 / 室内 的顺序展示
    const thumbs = Img.thumbRow(a.id, this.imgMap && this.imgMap[a.id]);

    tip.innerHTML = `<div class="tt">${esc(a.name || '未命名资产')}</div>`
      + (sub ? `<div class="ts">${sub}</div>` : '')
      + thumbs
      + rows
      + `<div class="ft">${extra.join(' · ')}</div>`
      + nearTip;
    tip.style.display = '';

    // 点位高亮（样式切换）
    this.applyHoverStyle(a.id);

    $$('#pv-lst .it', this.rootEl).forEach((x) => x.classList.toggle('on', x.dataset.id === a.id));

    this.positionTip(a, fromList);
    requestAnimationFrame(() => tip.classList.add('on'));
  },

  positionTip(a, forceInside) {
    const tip = $('#pv-tip', this.rootEl);
    const stage = $('#pv-stage', this.rootEl);
    if (!tip || !stage || !this.map) return;
    const p = Geo.project(this.map, a.lat, a.lng);
    if (!p || !Number.isFinite(p.x)) return;

    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const w = tip.offsetWidth || 272;
    const h = tip.offsetHeight || 160;

    let left = p.x - w / 2;
    let top = p.y - 34 - h - 10;
    let below = false;
    if (top < 8) { top = p.y + 12; below = true; }
    left = Math.max(8, Math.min(left, W - w - 8));
    top = Math.max(8, Math.min(top, H - h - 8));

    tip.classList.toggle('below', below);
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
    // 小箭头对准点位（考虑左右夹紧后的偏移）
    const ax = Math.max(12, Math.min(p.x - left, w - 12));
    tip.style.setProperty('--ax', Math.round(ax) + 'px');
    if (forceInside) tip.classList.add('on');
  },

  /** immediate=true 时立即隐藏（打开详情弹窗用），否则保留 200ms 淡出 */
  hideTip(immediate) {
    const tip = $('#pv-tip', this.rootEl);
    if (!tip) return;
    clearTimeout(this.tipTimer);
    this.hoverId = null;
    tip.classList.remove('on');
    this.applyHoverStyle(null);
    $$('#pv-lst .it', this.rootEl).forEach((x) => x.classList.remove('on'));
    if (immediate) { tip.style.display = 'none'; return; }
    this.tipTimer = setTimeout(() => { if (!tip.classList.contains('on')) tip.style.display = 'none'; }, 200);
  },

  /* ------------------------------ 地图未配置时的引导 ------------------------------ */

  showKeySetup(e) {
    const box = $('#pv-keybox', this.rootEl);
    geoNotReady((e && e.msg) || '地图服务未配置');
    if (!box) return;
    box.style.display = '';
    box.innerHTML = `
      <div style="max-width:360px;font-size:12px;line-height:1.8">
        <div style="font-weight:600;font-size:12.5px;margin-bottom:4px">地图服务未配置</div>
        ${esc((e && e.msg) || '请在「系统设置 → 地图服务」中选择服务商并填写密钥。')}
        ${Session.isSysAdmin() ? '<div style="margin-top:8px"><button class="btn pri sm" id="pv-tk-go">前往系统设置</button></div>' : '<div style="margin-top:6px">请联系系统管理员配置。</div>'}
      </div>`;
    const go = $('#pv-tk-go', box);
    if (go) on(go, 'click', () => { location.hash = '#/settings'; });
  },
};

Pages.preview = PreviewPage;
