'use strict';
/* ============================================================
 *  map —— 资产标注
 *  地图服务商由「系统设置 → 地图服务」决定，页面通过 Geo 适配层操作地图，
 *  不再直接依赖某一家 SDK（见 00-geo.js）。
 * ============================================================ */

function markerIcon(color) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">'
    + '<path d="M13 1C6.9 1 2 5.9 2 12c0 8 11 21 11 21s11-13 11-21c0-6.1-4.9-11-11-11z" fill="' + color + '" stroke="#ffffff" stroke-width="2"/>'
    + '<circle cx="13" cy="12" r="4.2" fill="#ffffff"/></svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function tempIcon(color) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">'
    + '<path d="M13 1C6.9 1 2 5.9 2 12c0 8 11 21 11 21s11-13 11-21c0-6.1-4.9-11-11-11z" fill="' + color + '" stroke="#2159d6" stroke-width="2"/>'
    + '<circle cx="13" cy="12" r="4.2" fill="#2159d6"/></svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/* 地图容器高度兜底：
 * Android WebView 开启 wide viewport + overview 后，height:100% 百分比链可能解析成
 * 页面内容高度（实测塌陷到 8192px），WebGL 纹理超出 GPU 上限（常见 4096/8192），
 * 腾讯地图直接报「超过支持的最大纹理尺寸」并整块白屏。这里按视口高度显式设像素值：
 * 正常布局取父容器高度，异常时（父高远超视口）回退视口高度。 */
function fixMapHeight(el) {
  if (!el) return;
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || 0;
  const parentH = el.parentElement ? el.parentElement.clientHeight : 0;
  let h = parentH > 200 ? parentH : vh;
  if (vh > 0 && h > vh) h = vh; // 钳制：绝不超过视口高度
  if (h > 200) el.style.height = Math.round(h) + 'px';
}

/* ------------------------------ 页面 ------------------------------ */

const MapPage = {
  title: '地图标注',
  map: null,
  markers: null,
  tempMarker: null,
  polygonLayer: null,
  polyLayer: null,
  infoWin: null,
  assets: [],
  markingId: null,
  tempPos: null,
  filter: 'all',
  kw: '',
  drawing: false,
  poly: [],
  /* 位置搜索 */
  SEA_ZOOM: 17,      // 搜索结果定位后放大到的层级（街道级，便于在此基础上打点）
  searchItems: [],
  searchPos: null,
  _seaSeq: 0,
  _seaDocFn: null,

  /** 离开页面：销毁地图实例。再次进入时重新创建，避免地图绑在已移除的容器上 */
  leave() {
    this.markingId = null;
    this.tempPos = null;
    this.poly = [];
    this.drawing = false;
    this.searchPos = null;
    this.searchItems = [];
    this._seaSeq++;
    if (this._seaDocFn) { document.removeEventListener('mousedown', this._seaDocFn); this._seaDocFn = null; }
    this.infoWin = Geo.destroyIw(this.infoWin);
    this.markers = Geo.destroyLayer(this.markers);
    this.tempMarker = Geo.destroyLayer(this.tempMarker);
    this.polygonLayer = Geo.destroyLayer(this.polygonLayer);
    this.polyLayer = Geo.destroyLayer(this.polyLayer);
    this.map = Geo.destroyMap(this.map);
    this.rootEl = null;
  },

  render(root) {
    if (guard(root, 'geo')) return;
    const self = this;
    this.leave(); // 每次进入都从干净的地图状态开始（相当于自动刷新）
    root.style.padding = '0';
    this.rootEl = root;

    const page = h(`<div class="map-page">
      <div class="map-side">
        <div class="hd">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
            <input class="inp" id="mp-kw" placeholder="搜索资产名称/坐落位置" style="flex:1">
            <button class="btn sm" id="mp-reload" title="刷新">↻</button>
          </div>
          <div class="chips">
            <span class="chip on" data-f="all">全部</span>
            <span class="chip" data-f="no">未标注</span>
            <span class="chip" data-f="yes">已标注</span>
          </div>
        </div>
        <div class="lst" id="mp-lst"><div class="empty" style="padding:24px">加载中…</div></div>
        <div style="padding:8px 12px;border-top:1px solid var(--line-2)">
          <div style="display:flex;gap:6px">
            <button class="btn sm" id="mp-geo" style="flex:1">地址批量解析</button>
            <button class="btn sm" id="mp-fit">全览</button>
          </div>
          <div class="muted" style="font-size:11px;margin-top:6px" id="mp-stat"></div>
        </div>
      </div>
      <div style="flex:1;position:relative">
        <div id="map"></div>
        <div class="map-hint" id="mp-hint" style="display:none"></div>
        <div class="map-toolbar">
          <div class="map-box mp-sea-box" id="mp-sea-box">
            <div class="mp-sea">
              <input class="inp" id="mp-sea" placeholder="搜索地点：街道 / 小区 / 楼宇，或直接输入 经度,纬度" autocomplete="off">
              <button class="btn sm pri" id="mp-sea-go">定位</button>
              <button class="btn sm" id="mp-sea-clr" title="清除搜索定位" style="display:none">清除</button>
            </div>
            <div class="muted" style="font-size:11px;margin-top:5px">搜索后会放大到街道级，便于在地图上打点标注</div>
            <div class="mp-sea-res" id="mp-sea-res" style="display:none"></div>
          </div>
          <div class="map-box" id="mp-keybox" style="display:none"></div>
          <div class="map-box" id="mp-draw" style="display:none">
            <div style="display:flex;gap:6px;align-items:center">
              <span class="muted" style="font-size:12px">用地范围</span>
              <button class="btn sm" id="mp-draw-on">开始绘制</button>
              <button class="btn sm pri" id="mp-draw-ok" style="display:none">完成</button>
              <button class="btn sm" id="mp-draw-clr" style="display:none">撤销</button>
            </div>
          </div>
          <div class="map-box">
            <span class="muted" id="mp-mode" style="font-size:12px">点击左侧资产 → 在地图上打点标注</span>
            <button class="btn sm" id="mp-exit" style="display:none;margin-left:8px">退出标注</button>
          </div>
        </div>
      </div>
    </div>`);
    root.appendChild(page);

    const kw = $('#mp-kw', page);
    let t;
    on(kw, 'input', () => { clearTimeout(t); t = setTimeout(() => { self.kw = kw.value.trim(); self.renderList(); }, 200); });
    $$('.chip', page).forEach((c) => on(c, 'click', () => {
      $$('.chip', page).forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      self.filter = c.dataset.f;
      self.renderList();
    }));
    on($('#mp-reload', page), 'click', () => {
      self.load().then(() => self.refresh()).catch((e) => toast(e.message, 'err'));
    });
    /* ---- 位置搜索 ---- */
    const sea = $('#mp-sea', page);
    let st;
    on(sea, 'input', () => { clearTimeout(st); st = setTimeout(() => self.runSearch(), 350); });
    on(sea, 'keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(st); self.runSearch(); }
      else if (e.key === 'Escape') self.hideSeaRes();
    });
    on($('#mp-sea-go', page), 'click', () => { clearTimeout(st); self.runSearch(); });
    on($('#mp-sea-clr', page), 'click', () => self.clearSea());
    on($('#mp-exit', page), 'click', () => self.exitMarking());
    // 点击搜索框以外的地方收起候选列表（放在 document 上，避免结果项还没触发 click 就被移除）
    this._seaDocFn = (e) => {
      const box = $('#mp-sea-box', page);
      if (box && !box.contains(e.target)) self.hideSeaRes();
    };
    document.addEventListener('mousedown', this._seaDocFn);

    on($('#mp-fit', page), 'click', () => self.fitAll());
    on($('#mp-geo', page), 'click', () => self.batchGeocode());
    on($('#mp-draw-on', page), 'click', () => self.startDraw());
    on($('#mp-draw-ok', page), 'click', () => self.finishDraw());
    on($('#mp-draw-clr', page), 'click', () => self.undoDraw());

    this.load()
      .then(() => this.initMap())
      .catch((e) => {
        if (e.message === 'NO_CONFIG') this.showKeySetup(e);
        else toast(e.message, 'err');
      });
  },

  isMarked(a) { return Number.isFinite(a.lng) && Number.isFinite(a.lat); },

  /* ------------------------------ 数据 ------------------------------ */

  async load() {
    const r = await API.getQ('/api/assets', Scope.params({ pageSize: 'all', sort: 'rowNo', order: 'asc' }));
    this.assets = r.rows;
    this.renderList();
    this.renderMarkers();
  },

  renderList() {
    const box = $('#mp-lst', this.rootEl);
    if (!box) return;
    const kw = this.kw.toLowerCase();
    let list = this.assets.slice();
    if (this.filter === 'no') list = list.filter((a) => !this.isMarked(a));
    if (this.filter === 'yes') list = list.filter((a) => this.isMarked(a));
    if (kw) list = list.filter((a) => [a.name, a.location, a.useUnit, a.assetNo].join(' ').toLowerCase().includes(kw));

    clear(box);
    if (!list.length) box.appendChild(h('<div class="empty" style="padding:24px">没有匹配的资产</div>'));
    list.slice(0, 500).forEach((a) => {
      const marked = this.isMarked(a);
      const it = h(`<div class="it ${marked ? 'done' : ''} ${this.markingId === a.id ? 'on' : ''}" data-id="${a.id}">
        <div class="pin">${marked ? '◉' : '◎'}</div>
        <div style="min-width:0;flex:1">
          <div class="nm ellip">${esc(a.name || '未命名资产')}</div>
          <div class="mt ellip">${esc(a.location || a.unit || '')}</div>
          <div class="mt" style="margin-top:3px">
            <span class="tag ${a.category === '办公用房' ? 'b' : 'n'}">${esc(a.category || '-')}</span>
            <span class="tag ${marked ? 'g' : 'n'}" style="margin-left:4px">${marked ? '已标注' : '待标注'}</span>
          </div>
        </div>
      </div>`);
      on(it, 'click', () => this.focus(a.id));
      box.appendChild(it);
    });

    const marked = this.assets.filter((a) => this.isMarked(a)).length;
    const st = $('#mp-stat', this.rootEl);
    if (st) st.innerHTML = `列表 ${list.length} / ${this.assets.length} 条 ｜ 已标注 <b>${marked}</b> 条`;
  },

  /* ------------------------------ 地图初始化 ------------------------------ */

  async initMap() {
    await Geo.sdk();
    const self = this;
    const el = document.getElementById('map');
    if (!el || this.map) return;

    // Android WebView（useWideViewPort + overview 模式）下 height:100% 链可能塌陷成
    // 内容高度（实测 8192px），WebGL 纹理超限 → 地图整块白屏。创建前显式按视口高度兜底。
    fixMapHeight(el);

    // 容器 id 交给适配层（各家用法不同）；默认视野取自系统设置
    this.map = Geo.createMap('map', Geo.center());

    this.markers = Geo.markerLayer(this.map, {});
    Geo.layerOn(this.markers, 'click', (evt) => {
      const id = evt.geometry && evt.geometry.id;
      const a = self.assets.find((x) => x.id === id);
      if (a) self.showInfo(a);
    });

    this.tempMarker = Geo.markerLayer(this.map, {
      t: { src: tempIcon('#f0a500'), width: 26, height: 34, anchorX: 13, anchorY: 34 }, // 待确认的标注点
      q: { src: tempIcon('#2f7de1'), width: 26, height: 34, anchorX: 13, anchorY: 34 }, // 搜索定位点
    });

    this.polygonLayer = Geo.polygonLayer(this.map, {
      fillColor: 'rgba(33,89,214,0.20)', borderColor: '#2159d6', borderWidth: 2,
    });

    this.polyLayer = Geo.polylineLayer(this.map, { borderColor: '#2159d6', borderWidth: 3 });

    this.infoWin = Geo.infoWindow(this.map);

    Geo.onMap(this.map, 'click', (evt) => self.onMapClick(evt));

    this.refresh(el);
  },

  /** 刷新地图：重绘点位，等容器布局完成后再校正尺寸与视野 */
  refresh(el) {
    this.renderMarkers();
    const box = el || document.getElementById('map');
    whenMapSized(box, () => {
      if (!this.map) return;
      fixMapHeight(box);
      Geo.resize(this.map);
      this.fitAll();
    });
  },

  onMapClick(evt) {
    const p = Geo.clickLngLat(evt);
    if (!p) return;
    const { lat, lng } = p;
    if (this.drawing) {
      this.poly.push({ lng: Math.round(lng * 1e6) / 1e6, lat: Math.round(lat * 1e6) / 1e6 });
      this.renderDraft();
      return;
    }
    if (!this.markingId) return;
    Geo.closeIw(this.infoWin);
    this.tempPos = { lng, lat };
    this.renderTemp();
    this.confirmMark();
  },

  /** 临时图层：搜索定位点（q）与待确认标注点（t）一起渲染，避免后者把前者覆盖掉 */
  renderTemp() {
    if (!this.tempMarker || this.drawing) return;
    const gs = [];
    if (this.searchPos) {
      gs.push({ id: 'sea', styleId: 'q', position: { lat: this.searchPos.lat, lng: this.searchPos.lng } });
    }
    if (this.tempPos) {
      gs.push({ id: 'tmp', styleId: 't', position: { lat: this.tempPos.lat, lng: this.tempPos.lng } });
    }
    Geo.setMarkers(this.tempMarker, gs);
  },

  /* ------------------------------ 位置搜索 ------------------------------ */

  /** 解析「经度,纬度」文本；系统内坐标一律按经度在前展示，反序也能容错识别 */
  parseLngLat(s) {
    const m = String(s || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，、\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2]);
    if (Math.abs(a) <= 180 && Math.abs(b) <= 90) return { lng: a, lat: b };
    if (Math.abs(b) <= 180 && Math.abs(a) <= 90) return { lng: b, lat: a };
    return null;
  },

  async runSearch() {
    const inp = $('#mp-sea', this.rootEl);
    const box = $('#mp-sea-res', this.rootEl);
    if (!inp || !box) return;
    const q = (inp.value || '').trim();
    if (!q) { this.hideSeaRes(); return; }
    if (!this.map) { toast('地图尚未就绪，无法定位。请先到「系统设置 → 地图服务」完成配置', 'warn'); return; }

    // 直接输入坐标：不走搜索服务，立即定位
    const c = this.parseLngLat(q);
    if (c) {
      this.hideSeaRes();
      this.locate({ title: '坐标定位', address: q, lng: c.lng, lat: c.lat }, true);
      return;
    }

    const seq = ++this._seaSeq;
    box.style.display = '';
    box.innerHTML = '<div class="mp-sea-tip">搜索中…</div>';
    try {
      const list = await Geo.suggest(q, 10);
      if (seq !== this._seaSeq) return; // 已有更新的请求，丢弃旧结果
      this.searchItems = list || [];
      this.renderSeaRes();
    } catch (e) {
      if (seq !== this._seaSeq) return;
      this.searchItems = [];
      box.style.display = '';
      box.innerHTML = `<div class="mp-sea-tip err">搜索失败：${esc(e.message || '未知错误')}</div>`
        + '<div class="mp-sea-tip">可稍后重试，或在「系统设置 → 地图服务」更换密钥；也可以直接输入「经度,纬度」定位</div>';
    }
  },

  renderSeaRes() {
    const box = $('#mp-sea-res', this.rootEl);
    if (!box) return;
    box.style.display = '';
    clear(box);
    if (!this.searchItems.length) {
      box.appendChild(h('<div class="mp-sea-tip">没有找到匹配的位置：可补全地址（带上区县/街道）后重试，'
        + '或直接输入「经度,纬度」定位</div>'));
      return;
    }
    this.searchItems.slice(0, 8).forEach((it, i) => {
      const row = h(`<div class="mp-sea-item" data-i="${i}">
        <div class="t">${esc(it.title || '未命名地点')}</div>
        <div class="a">${esc(it.address || '')}</div>
        <div class="c mono">${Number(it.lng).toFixed(6)}, ${Number(it.lat).toFixed(6)}</div>
      </div>`);
      on(row, 'click', () => this.locate(it));
      box.appendChild(row);
    });
  },

  hideSeaRes() {
    const box = $('#mp-sea-res', this.rootEl);
    if (box) { box.style.display = 'none'; clear(box); }
  },

  /** 定位到搜索结果：地图放大到街道级并落下临时点位（keepText：保留输入框原文） */
  locate(it, keepText) {
    const lat = Number(it && it.lat), lng = Number(it && it.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (!this.map) { toast('地图尚未就绪，无法定位', 'warn'); return; }

    this.searchPos = { lng, lat };
    this.renderTemp();
    Geo.panTo(this.map, lat, lng, this.SEA_ZOOM);
    this.hideSeaRes();

    const inp = $('#mp-sea', this.rootEl);
    if (inp && !keepText) inp.value = it.title || inp.value;
    const clr = $('#mp-sea-clr', this.rootEl);
    if (clr) clr.style.display = '';

    const a = this.assets.find((x) => x.id === this.markingId);
    if (a && Session.canWriteAsset(a)) {
      // 正在标注：把搜索到的位置直接作为候选点交给确认流程
      this.tempPos = { lng, lat };
      this.confirmMark();
      return;
    }
    const mode = $('#mp-mode', this.rootEl);
    const name = it.title || '该位置';
    if (mode) mode.innerHTML = `<span class="tag b">已定位：${esc(fmt.cut(name, 14))}</span>`;
    toast(`已定位到「${name}」，点击左侧资产后即可在该位置打点`, 'ok');
  },

  clearSea() {
    this.searchPos = null;
    this.searchItems = [];
    this._seaSeq++;
    const inp = $('#mp-sea', this.rootEl);
    if (inp) inp.value = '';
    const clr = $('#mp-sea-clr', this.rootEl);
    if (clr) clr.style.display = 'none';
    this.hideSeaRes();
    this.renderTemp();
  },

  /* ------------------------------ 图层渲染 ------------------------------ */

  renderMarkers() {
    if (!this.markers) return;
    const marked = this.assets.filter((a) => this.isMarked(a));

    const cats = [...new Set(marked.map((a) => a.category || '未填写'))];
    const styles = {};
    cats.forEach((c, i) => {
      styles['s' + i] = { src: markerIcon(colorOf(CAT_COLOR, c, i)), width: 26, height: 34, anchorX: 13, anchorY: 34 };
    });

    const geoms = marked.map((a) => ({
      id: a.id,
      styleId: 's' + cats.indexOf(a.category || '未填写'),
      position: { lat: a.lat, lng: a.lng },
    }));

    const polys = marked
      .filter((a) => Array.isArray(a.polygon) && a.polygon.length >= 3)
      .map((a) => ({
        id: a.id,
        styleId: 'p',
        paths: a.polygon.map((p) => ({ lat: p.lat, lng: p.lng })),
      }));

    Geo.setStyles(this.markers, styles);
    // 注意：必须整体替换（天地图适配层按 id 增量维护，多余的会自动移除），
    // 否则筛选后已消失的点位会残留在地图上。
    Geo.setMarkers(this.markers, geoms);
    Geo.setPaths(this.polygonLayer, polys);
  },

  fitAll() {
    if (!this.map) return;
    const marked = this.assets.filter((a) => this.isMarked(a));
    if (!marked.length) {
      const c = Geo.center();
      Geo.setCenter(this.map, c.lat, c.lng);
      Geo.setZoom(this.map, c.zoom);
      return;
    }
    Geo.fitBounds(this.map, marked.map((a) => ({ lat: a.lat, lng: a.lng })));
  },

  /* ------------------------------ 标注流程 ------------------------------ */

  focus(id) {
    const a = this.assets.find((x) => x.id === id);
    if (!a) return;
    // 下级单位数据只读：只定位查看，不进入标注模式
    if (!Session.canWriteAsset(a)) {
      this.exitMarking();
      if (this.map && this.isMarked(a)) {
        Geo.panTo(this.map, a.lat, a.lng, 16);
        this.showInfo(a);
      }
      toast('下级单位数据为只读，仅可查看', 'warn');
      return;
    }
    this.markingId = id;
    this.tempPos = null;
    this.poly = [];
    this.drawing = false;
    this.syncDrawUI();
    this.renderList();

    const hint = $('#mp-hint', this.rootEl);
    const mode = $('#mp-mode', this.rootEl);
    if (hint) {
      hint.style.display = '';
      hint.innerHTML = `正在标注：<b>${esc(a.name || '')}</b> — ${this.isMarked(a) ? '已有点位，可点击地图重新选点' : '在地图上点击目标位置'}`;
    }
    if (mode) mode.innerHTML = '<span class="tag b">标注模式</span>';
    const ex = $('#mp-exit', this.rootEl);
    if (ex) ex.style.display = '';

    if (this.map && this.isMarked(a)) {
      Geo.panTo(this.map, a.lat, a.lng, 16);
      this.showInfo(a);
    } else if (this.infoWin) {
      Geo.closeIw(this.infoWin);
    }
  },

  exitMarking() {
    this.markingId = null;
    this.tempPos = null;
    this.poly = [];
    this.drawing = false;
    this.renderTemp(); // 清掉待确认的标注点，搜索定位点保留
    if (this.polyLayer) Geo.setPaths(this.polyLayer, []);
    this.syncDrawUI();
    const hint = $('#mp-hint', this.rootEl);
    if (hint) hint.style.display = 'none';
    const mode = $('#mp-mode', this.rootEl);
    if (mode) mode.textContent = '点击左侧资产 → 在地图上打点标注';
    const ex = $('#mp-exit', this.rootEl);
    if (ex) ex.style.display = 'none';
    this.renderList();
  },

  /** 信息窗内容会被序列化为字符串，因此用全局函数绑定点击 */
  showInfo(a) {
    if (!this.infoWin) return;
    const self = this;
    const html = `<div class="iw">
      <div class="t">${esc(a.name || '未命名资产')}</div>
      <div class="r">${esc(a.category || '-')} ｜ ${esc(a.useStatus || '-')} ｜ ${esc(fmt.area(a.area))} ㎡</div>
      <div class="r">${esc(a.location || '')}</div>
      <div class="r muted">${a.lng}, ${a.lat}${a.geoBy ? ' · ' + esc(a.geoBy) : ''}</div>
      <div class="r muted">${esc(a.unit || '未填写单位')}${Session.canWriteAsset(a) ? '' : ' · <b>只读</b>（下级单位数据仅可查看）'}</div>
      <div class="a">
        <button class="btn sm" onclick="MapPage.iwView('${a.id}')">详情</button>
        ${Session.canWriteAsset(a) ? `
        <button class="btn sm" onclick="MapPage.iwEdit('${a.id}')">资料</button>
        <button class="btn sm" onclick="MapPage.iwRemark('${a.id}')">重新标注</button>
        <button class="btn sm danger" onclick="MapPage.iwClear('${a.id}')">清除</button>` : ''}
      </div>
    </div>`;
    Geo.setIwContent(this.infoWin, html);
    Geo.setIwPosition(this.infoWin, a.lat, a.lng);
    Geo.openIw(this.infoWin);
  },

  /** 只读详情（下级单位资产在此只能查看） */
  iwView(id) {
    const a = this.assets.find((x) => x.id === id);
    if (!a) return;
    Geo.closeIw(this.infoWin);
    AssetForm.view(a);
  },
  iwEdit(id) {
    const a = this.assets.find((x) => x.id === id);
    if (!a) return;
    if (!Session.canWriteAsset(a)) { toast('下级单位数据为只读，不能修改', 'warn'); return; }
    Geo.closeIw(this.infoWin); // 先收起地图信息窗，避免与资料弹窗叠在一起
    AssetForm.edit(a, () => this.load());
  },
  iwRemark(id) {
    Geo.closeIw(this.infoWin);
    this.focus(id);
  },
  async iwClear(id) {
    const a = this.assets.find((x) => x.id === id);
    if (!await confirmDlg(`确定清除 <b>${esc((a && a.name) || '')}</b> 的地图标注吗？`)) return;
    try {
      await API.put('/api/assets/' + id + '/geo', { lng: null, lat: null });
      toast('已清除标注', 'ok');
      Geo.closeIw(this.infoWin);
      this.exitMarking();
      this.load();
    } catch (e) { toast(e.message, 'err'); }
  },

  async confirmMark() {
    const a = this.assets.find((x) => x.id === this.markingId);
    if (!a || !this.tempPos) return;
    const { lng, lat } = this.tempPos;

    let addr = '';
    try {
      addr = (await Geo.reverse(lat, lng)) || '';
    } catch (e) { /* 逆地理编码失败不阻断标注 */ }

    const coordName = (Geo.cfg && Geo.cfg.coord) || 'GCJ-02';
    const body = h(`<div>
      <div style="font-size:13px;margin-bottom:10px">将资产 <b>${esc(a.name || '')}</b> 标注到该位置：</div>
      <div class="muted" style="font-size:12px;line-height:1.9">
        坐标：<span class="mono">${lng.toFixed(6)}, ${lat.toFixed(6)}</span>（${esc(coordName)}）<br>
        解析地址：${esc(addr || '（未能解析）')}<br>
        原坐落位置：${esc(a.location || '（空）')}
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px">
        <input type="checkbox" id="ck-addr" ${addr ? 'checked' : ''}> 同时用解析地址更新「坐落位置」字段
      </label>
    </div>`);

    const self = this;
    modal({
      title: '确认标注位置',
      bodyNode: body,
      buttons: [
        {
          text: '取消', onClick: (c) => {
            c();
            self.tempPos = null;
            self.renderTemp();
          },
        },
        {
          text: '保存标注', cls: 'pri', onClick: async (close) => {
            try {
              await API.put('/api/assets/' + a.id + '/geo', { lng, lat, address: addr });
              if ($('#ck-addr').checked && addr) {
                await API.put('/api/assets/' + a.id, Object.assign({}, a, { location: addr }));
              }
              toast('标注已保存', 'ok');
              close();
              self.tempPos = null;
              self.renderTemp();
              self.exitMarking();
              self.load();
            } catch (e) { toast(e.message, 'err'); }
          },
        },
      ],
    });
  },

  /* ------------------------------ 用地范围绘制 ------------------------------ */

  syncDrawUI() {
    const box = $('#mp-draw', this.rootEl);
    if (!box) return;
    box.style.display = this.markingId ? '' : 'none';
    const on2 = $('#mp-draw-on', box);
    const ok2 = $('#mp-draw-ok', box);
    const clr = $('#mp-draw-clr', box);
    if (!on2) return;
    on2.style.display = this.drawing ? 'none' : '';
    ok2.style.display = this.drawing ? '' : 'none';
    clr.style.display = this.drawing ? '' : 'none';
    if (this.drawing) {
      const hint = $('#mp-hint', this.rootEl);
      if (hint) { hint.style.display = ''; hint.innerHTML = `正在绘制用地范围：<b>${this.poly.length}</b> 个顶点 · 继续在地图上点击添加，完成后点「完成」`; }
    }
  },

  startDraw() {
    const a = this.assets.find((x) => x.id === this.markingId);
    if (!a) { toast('请先选择一条资产', 'warn'); return; }
    if (!this.isMarked(a)) { toast('请先完成点位标注，再绘制用地范围', 'warn'); return; }
    this.drawing = true;
    this.poly = Array.isArray(a.polygon) ? a.polygon.slice() : [];
    Geo.closeIw(this.infoWin);
    this.renderDraft();
    this.syncDrawUI();
  },

  renderDraft() {
    if (!this.polyLayer) return;
    const pts = this.poly.map((p) => ({ lat: p.lat, lng: p.lng }));
    if (pts.length >= 2) {
      Geo.setPaths(this.polyLayer, [{ id: 'draft', styleId: 'd', paths: pts.concat([pts[0]]) }]);
    } else {
      Geo.setPaths(this.polyLayer, []);
    }
    Geo.setMarkers(this.tempMarker, this.poly.map((p, i) => ({
      id: 'v' + i, styleId: 't', position: { lat: p.lat, lng: p.lng },
    })));
    this.syncDrawUI();
  },

  undoDraw() {
    this.poly.pop();
    this.renderDraft();
  },

  async finishDraw() {
    const a = this.assets.find((x) => x.id === this.markingId);
    if (!a) return;
    if (this.poly.length < 3) { toast('用地范围至少需要 3 个顶点', 'warn'); return; }
    try {
      await API.put('/api/assets/' + a.id + '/geo', { lng: a.lng, lat: a.lat, polygon: this.poly });
      toast('用地范围已保存', 'ok');
      this.drawing = false;
      this.poly = [];
      if (this.polyLayer) Geo.setPaths(this.polyLayer, []);
      this.renderTemp();
      this.syncDrawUI();
      this.load();
    } catch (e) { toast(e.message, 'err'); }
  },

  /* ------------------------------ 批量地理编码 ------------------------------ */

  async batchGeocode() {
    const todo = this.assets.filter((a) => !this.isMarked(a) && a.location);
    if (!todo.length) { toast('没有可用于解析的未标注资产', 'warn'); return; }
    const n = Math.min(todo.length, 60);
    const pname = (Geo.cfg && Geo.cfg.providerName) || '地图服务';
    if (!await confirmDlg(`将对前 <b>${n}</b> 条未标注资产按「坐落位置」调用${esc(pname)}地理编码解析坐标，<br>结果会<b>自动保存</b>，之后请人工核对点位是否准确。`)) return;

    try { await Geo.sdk(); } catch (e) {
      if (e.message === 'NO_CONFIG') this.showKeySetup(e);
      else toast(e.message, 'err');
      return;
    }

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
    this.load();
  },

  /* ------------------------------ 地图未配置时的引导 ------------------------------ */

  /** e：Geo.sdk() 抛出的 NO_CONFIG 错误（msg 已按服务商给出具体说明） */
  showKeySetup(e) {
    const box = $('#mp-keybox', this.rootEl);
    const hint = $('#mp-hint', this.rootEl);
    if (hint) { hint.style.display = ''; hint.innerHTML = '地图服务未就绪：资产列表可用，但无法在地图上打点'; }
    geoNotReady((e && e.msg) || '地图服务未配置');
    if (!box) return;
    box.style.display = '';
    box.innerHTML = `
      <div style="max-width:360px;font-size:12px;line-height:1.8">
        <div style="font-weight:600;font-size:12.5px;margin-bottom:4px">地图服务未配置</div>
        ${esc((e && e.msg) || '请在「系统设置 → 地图服务」中选择服务商并填写密钥。')}
        ${Session.isSysAdmin() ? '<div style="margin-top:8px"><button class="btn pri sm" id="tk-go">前往系统设置</button></div>' : '<div style="margin-top:6px">请联系系统管理员配置。</div>'}
      </div>`;
    const go = $('#tk-go', box);
    if (go) on(go, 'click', () => { location.hash = '#/settings'; });
  },
};

Pages.map = MapPage;
