'use strict';
/* ============================================================
 *  geo —— 地图适配层
 *
 *  页面不再直接依赖任何一家地图 SDK：统一通过 Geo.xxx 操作地图，
 *  具体用腾讯地图还是天地图由「系统设置」里的配置决定（后端 /api/map/config）。
 *
 *  新增一家地图服务商只需两步：
 *    1) 后端 server/lib/mapconfig.js 的 PROVIDERS 里加一项（含注册指引）；
 *    2) 本文件的 GeoAdapters 里实现同名适配器。
 * ============================================================ */

/* 占位符由运行环境在返回 HTML 时替换，源码中必须保持原样 */
const GEO_PROXY = 'http://127.0.0.1:__WB_HTTP_PORT__/_TMapService/_wbt/__WB_TMAP_SECRET__';

function proxyReady() { return GEO_PROXY.indexOf('__WB_') < 0; }

const DEFAULT_VIEW = { lat: 29.5889, lng: 106.5515, zoom: 12 }; // 重庆市江北区

/* ------------------------------ 坐标换算 ------------------------------ */
/* 系统内统一按 GCJ-02（火星坐标）存储；天地图底图是 CGCS2000（≈ WGS84），
   需要互换才能保证点位落在正确的地面位置。 */
const GCJ_PI = Math.PI;
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function gcjOutOfChina(lng, lat) {
  return !(lng > 72.004 && lng < 137.8347 && lat > 0.8293 && lat < 55.8271);
}

function gcjTLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * GCJ_PI) + 40.0 * Math.sin(y / 3.0 * GCJ_PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * GCJ_PI) + 320 * Math.sin(y * GCJ_PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function gcjTLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * GCJ_PI) + 40.0 * Math.sin(x / 3.0 * GCJ_PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * GCJ_PI) + 300.0 * Math.sin(x / 30.0 * GCJ_PI)) * 2.0 / 3.0;
  return ret;
}

function wgs84ToGcj02(lng, lat) {
  if (gcjOutOfChina(lng, lat)) return { lng, lat };
  const wgsLat = lat, wgsLng = lng;
  let dLat = gcjTLat(wgsLng - 105.0, wgsLat - 35.0);
  let dLng = gcjTLng(wgsLng - 105.0, wgsLat - 35.0);
  const radLat = wgsLat / 180.0 * GCJ_PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * GCJ_PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * GCJ_PI);
  return { lng: wgsLng + dLng, lat: wgsLat + dLat };
}

/** 反向换算：迭代逼近（两次即可收敛到厘米级） */
function gcj02ToWgs84(lng, lat) {
  if (gcjOutOfChina(lng, lat)) return { lng, lat };
  let wlng = lng, wlat = lat;
  for (let i = 0; i < 3; i++) {
    const g = wgs84ToGcj02(wlng, wlat);
    wlng += lng - g.lng;
    wlat += lat - g.lat;
  }
  return { lng: wlng, lat: wlat };
}

/* ------------------------------ 适配器：腾讯地图 GL ------------------------------ */

const TMapAdapter = {
  global: 'TMap',
  needKey: false, // 无 key 时可用运行环境代理

  loadUrl(key) {
    return 'https://map.qq.com/api/gljs?v=1.exp&libraries=service' + (key ? '&key=' + encodeURIComponent(key) : '');
  },
  beforeLoad(key) {
    if (!key && proxyReady()) window._TMapSecurityConfig = { serviceHost: GEO_PROXY };
  },
  missingKeyMsg() {
    return '当前未配置腾讯地图 Key，且页面不在内置预览环境中（无法使用免密钥代理）。请到「系统设置 → 地图服务」填写 Key。';
  },

  toMap(lat, lng) { return { lat, lng }; },
  fromMap(lat, lng) { return { lat, lng }; },

  createMap(divId, view) {
    const TMap = window.TMap;
    return new TMap.Map(divId, {
      zoom: view.zoom,
      center: new TMap.LatLng(view.lat, view.lng),
    });
  },
  setCenter(map, lat, lng) { map.setCenter(new window.TMap.LatLng(lat, lng)); },
  panTo(map, lat, lng, zoom) {
    map.setCenter(new window.TMap.LatLng(lat, lng));
    if (Number.isFinite(zoom)) map.setZoom(zoom);
  },
  setZoom(map, z) { map.setZoom(z); },
  fitBounds(map, pts, padding) {
    const TMap = window.TMap;
    if (!pts.length) return;
    if (pts.length === 1) { this.setCenter(map, pts[0].lat, pts[0].lng); map.setZoom(16); return; }
    try {
      const b = new TMap.LatLngBounds();
      pts.forEach((p) => b.extend(new TMap.LatLng(p.lat, p.lng)));
      map.fitBounds(b, { padding: padding || 70 });
    } catch (e) { this.setCenter(map, pts[0].lat, pts[0].lng); map.setZoom(13); }
  },
  getCenter(map) {
    const c = map.getCenter();
    return { lat: c.getLat(), lng: c.getLng() };
  },
  getZoom(map) { return map.getZoom(); },
  project(map, lat, lng) {
    const p = map.projectToContainer(new window.TMap.LatLng(lat, lng));
    return p ? { x: p.x, y: p.y } : null;
  },
  resize(map) { if (typeof map.resize === 'function') map.resize(); },
  onMap(map, ev, fn) {
    if (ev === 'viewchange') {
      ['pan', 'zoom', 'center_changed', 'zoom_changed'].forEach((e) => {
        try { map.on(e, fn); } catch (err) { /* 事件名不被支持时忽略 */ }
      });
      return;
    }
    map.on(ev === 'click' ? 'click' : ev, fn);
  },
  clickLngLat(evt) {
    const p = evt && evt.latLng;
    return p ? { lat: p.getLat(), lng: p.getLng() } : null;
  },
  destroy(map) { if (map && typeof map.destroy === 'function') map.destroy(); },

  createMarkerLayer(map, styles) {
    const TMap = window.TMap;
    const layer = new TMap.MultiMarker({ map, styles: toTMapStyles(TMap, styles), geometries: [] });
    layer._toTMap = (styles2) => toTMapStyles(TMap, styles2);
    return layer;
  },
  setLayerStyles(layer, styles) { layer.setStyles(toTMapStyles(window.TMap, styles)); },
  setLayerGeoms(layer, geoms) {
    const TMap = window.TMap;
    layer.setGeometries(geoms.map((g) => Object.assign({}, g, { position: new TMap.LatLng(g.position.lat, g.position.lng) })));
  },
  createPolygonLayer(map, style) {
    const TMap = window.TMap;
    return new TMap.MultiPolygon({
      map,
      styles: { p: new TMap.PolygonStyle({
        color: style.fillColor, showBorder: true, borderColor: style.borderColor, borderWidth: style.borderWidth,
      }) },
      geometries: [],
    });
  },
  createPolylineLayer(map, style) {
    const TMap = window.TMap;
    return new TMap.MultiPolyline({
      map,
      styles: { d: new TMap.PolylineStyle({ color: style.borderColor, width: style.borderWidth, borderWidth: 0 }) },
      geometries: [],
    });
  },
  setPathGeoms(layer, geoms) {
    const TMap = window.TMap;
    layer.setGeometries(geoms.map((g) => ({
      id: g.id, styleId: g.styleId, paths: g.paths.map((p) => new TMap.LatLng(p.lat, p.lng)),
    })));
  },
  createInfoWindow(map, opts) {
    const TMap = window.TMap;
    const build = () => {
      const iw = new TMap.InfoWindow({
        map,
        position: new TMap.LatLng(DEFAULT_VIEW.lat, DEFAULT_VIEW.lng),
        content: '<div class="iw">—</div>', // content 必须是字符串，空串会触发 SDK 解析告警
        offset: { x: 0, y: -34 },
        enableCustom: true,
      });
      iw.close();
      return iw;
    };
    try {
      return build();
    } catch (e) {
      /* 部分 WebView 环境下 InfoWindow 构造即抛错（地图尚未完成首次布局时）。
         返回惰性代理：首次真正使用时重试创建，仍失败则静默降级，
         保证不阻断地图初始化与点位渲染。 */
      let real = null;
      const ensure = () => {
        if (real !== null) return real;
        try { real = build(); } catch (e2) { real = null; }
        return real;
      };
      return {
        __lazy: true,
        open() { const i = ensure(); if (i) i.open(); },
        close() { if (real) real.close(); },
        setContent(html) { const i = ensure(); if (i) i.setContent(html); },
        setPosition(latlng) { const i = ensure(); if (i) i.setPosition(latlng); },
        destroy() { try { if (real) real.destroy(); } catch (e2) { /* 忽略 */ } },
      };
    }
  },
  setIwContent(iw, html) { iw.setContent(html); },
  setIwPosition(iw, lat, lng) { iw.setPosition(new window.TMap.LatLng(lat, lng)); },
  openIw(iw) { iw.open(); },
  closeIw(iw) { iw.close(); },
  layerOn(layer, ev, fn) { layer.on(ev, fn); },
  destroyLayer(layer) { if (layer && typeof layer.destroy === 'function') layer.destroy(); },
  destroyIw(iw) { if (iw && typeof iw.destroy === 'function') iw.destroy(); },

  async geocode(address) {
    const TMap = window.TMap;
    const geo = new TMap.service.Geocoder();
    const res = await geo.getLocation({ address });
    const loc = res && res.result && res.result.location;
    if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) return { lng: loc.lng, lat: loc.lat };
    return null;
  },
  async reverse(lat, lng) {
    const TMap = window.TMap;
    const geo = new TMap.service.Geocoder();
    const res = await geo.getAddress({ location: new TMap.LatLng(lat, lng) });
    const rr = res && res.result;
    return (rr && (rr.address || (rr.formatted_addresses && rr.formatted_addresses.recommend))) || '';
  },

  /**
   * 地点搜索：优先用浏览器端「关键词输入提示」（免密钥代理下同样可用），
   * 失败再退到服务端 WebServiceAPI（需要系统设置里已配置 Key）。
   */
  async suggest(keyword, n) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const TMap = window.TMap;
    try {
      if (TMap && TMap.service && TMap.service.Suggestion) {
        const sug = new TMap.service.Suggestion();
        const res = await sug.getSuggestions({ keyword: kw });
        const list = normalizeSuggestions(res && (res.data || res.result || res.suggestions), n || 10);
        if (list.length) return list;
      }
    } catch (e) { /* 浏览器端不可用时走服务端兜底 */ }
    return serverSuggest(kw, n || 10);
  },
};

function toTMapStyles(TMap, styles) {
  const out = {};
  Object.keys(styles || {}).forEach((k) => {
    const s = styles[k];
    out[k] = new TMap.MarkerStyle({
      width: s.width, height: s.height, src: s.src,
      anchor: { x: s.anchorX, y: s.anchorY },
    });
  });
  return out;
}

/* ------------------------------ 适配器：天地图 JS API 4.0 ------------------------------ */

const TiandituAdapter = {
  global: 'T',
  needKey: true,

  loadUrl(key) {
    return 'https://api.tianditu.gov.cn/api?v=4.0&tk=' + encodeURIComponent(key);
  },
  beforeLoad() { /* 天地图无需前置配置 */ },
  missingKeyMsg() {
    return '未配置天地图密钥（tk）。请到「系统设置 → 地图服务」选择天地图并填写密钥。';
  },

  /** 存储坐标（GCJ-02）→ 天地图底图坐标（CGCS2000 ≈ WGS84） */
  toMap(lat, lng) { return gcj02ToWgs84(lng, lat); },
  fromMap(lat, lng) { return wgs84ToGcj02(lng, lat); },

  createMap(divId, view) {
    const T = window.T;
    // 经纬度直投，避免再做一次投影换算
    const map = new T.Map(divId, { projection: 'EPSG:4326' });
    const c = this.toMap(view.lat, view.lng);
    map.centerAndZoom(new T.LngLat(c.lng, c.lat), view.zoom);
    try { map.enableScrollWheelZoom(); } catch (e) { /* 忽略 */ }
    return map;
  },
  setCenter(map, lat, lng) {
    const c = this.toMap(lat, lng);
    map.panTo(new window.T.LngLat(c.lng, c.lat));
  },
  panTo(map, lat, lng, zoom) {
    const c = this.toMap(lat, lng);
    if (Number.isFinite(zoom)) map.panTo(new window.T.LngLat(c.lng, c.lat), zoom);
    else map.panTo(new window.T.LngLat(c.lng, c.lat));
  },
  setZoom(map, z) { map.setZoom(z); },
  fitBounds(map, pts, padding) {
    const T = window.T;
    if (!pts.length) return;
    const view = pts.map((p) => { const c = this.toMap(p.lat, p.lng); return new T.LngLat(c.lng, c.lat); });
    if (view.length === 1) { map.panTo(view[0], 16); return; }
    try { map.setViewport(view); } catch (e) { map.panTo(view[0], 13); }
  },
  getCenter(map) {
    const c = map.getCenter();
    const lat = c.getLat(), lng = c.getLng();
    return this.fromMap(lat, lng);
  },
  getZoom(map) { return map.getZoom(); },
  project(map, lat, lng) {
    const c = this.toMap(lat, lng);
    const p = map.lngLatToContainer(new window.T.LngLat(c.lng, c.lat));
    if (!p) return null;
    const x = typeof p.getX === 'function' ? p.getX() : p.x;
    const y = typeof p.getY === 'function' ? p.getY() : p.y;
    return (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
  },
  resize(map) { if (typeof map.checkResize === 'function') map.checkResize(); },
  onMap(map, ev, fn) {
    if (ev === 'viewchange') {
      ['move', 'moveend', 'zoomend', 'drag'].forEach((e) => {
        try { map.addEventListener(e, fn); } catch (err) { /* 忽略 */ }
      });
      return;
    }
    const name = ev === 'click' ? 'click' : ev;
    map.addEventListener(name, fn);
  },
  clickLngLat(evt) {
    const p = (evt && (evt.lnglat || evt.lngLat)) || null;
    if (!p) return null;
    const lat = typeof p.getLat === 'function' ? p.getLat() : p.lat;
    const lng = typeof p.getLng === 'function' ? p.getLng() : p.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return this.fromMap(lat, lng); // 天地图坐标 → 存储坐标
  },

  createMarkerLayer(map, styles) { return tdOverlayLayer(map, 'marker', styles); },
  setLayerStyles(layer, styles) { layer.setStyles(styles); },
  setLayerGeoms(layer, geoms) { layer.setGeometries(geoms); },
  createPolygonLayer(map, style) { return tdOverlayLayer(map, 'polygon', style); },
  createPolylineLayer(map, style) { return tdOverlayLayer(map, 'polyline', style); },
  setPathGeoms(layer, geoms) { layer.setGeometries(geoms); },
  createInfoWindow(map) {
    const T = window.T;
    const iw = new T.InfoWindow();
    try { iw.setContent('<div class="iw">—</div>'); } catch (e) { /* 忽略 */ }
    return { _iw: iw, _map: map, _open: false };
  },
  setIwContent(iw, html) { iw._iw.setContent(html); },
  setIwPosition(iw, lat, lng) {
    const c = this.toMap(lat, lng);
    iw._iw.setLngLat(new window.T.LngLat(c.lng, c.lat));
    if (iw._open && iw._map) { iw._map.removeOverLay(iw._iw); iw._map.addOverLay(iw._iw); }
  },
  openIw(iw) {
    if (!iw || !iw._map) return;
    iw._map.addOverLay(iw._iw);
    iw._open = true;
  },
  closeIw(iw) {
    if (!iw || !iw._map) return;
    try { iw._map.removeOverLay(iw._iw); } catch (e) { /* 忽略 */ }
    iw._open = false;
  },
  layerOn(layer, ev, fn) { layer.on(ev, fn); },
  destroyLayer(layer) { if (layer && typeof layer.destroy === 'function') layer.destroy(); },
  destroyIw(iw) { this.closeIw(iw); },
  destroy(map) {
    try { map.clearOverLays(); } catch (e) { /* 忽略 */ }
  },

  async geocode(address) {
    const r = await API.getQ('/api/geo/geocode', { address });
    if (r && Number.isFinite(r.lng) && Number.isFinite(r.lat)) {
      // 天地图返回的是 CGCS2000 坐标，必须换算成系统存储坐标 GCJ-02，
      // 否则打点会与底图错位数百米（跟点击取点走同一条换算）。
      const g = this.fromMap(r.lat, r.lng);
      return { lng: g.lng, lat: g.lat };
    }
    return null;
  },
  async reverse(lat, lng) {
    const c = this.toMap(lat, lng); // 服务端按天地图坐标查询
    const r = await API.getQ('/api/geo/reverse', { lng: c.lng, lat: c.lat });
    return (r && r.address) || '';
  },

  /** 地点搜索：走服务端代理（天地图搜索服务需服务端密钥），结果同样换算为 GCJ-02 */
  async suggest(keyword, n) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const raw = await serverSuggest(kw, n || 10);
    // 服务端按天地图原生坐标（CGCS2000）返回，转换后才是系统存储坐标
    const list = raw.map((it) => {
      const g = this.fromMap(it.lat, it.lng);
      return Object.assign({}, it, { lng: g.lng, lat: g.lat });
    });
    if (list.length) return list;
    // 搜索服务不可用时退化为地址解析（单点，够用）
    const loc = await this.geocode(kw);
    return loc ? [{ title: kw, address: '', lng: loc.lng, lat: loc.lat }] : [];
  },
};

/** 天地图没有 MultiMarker，这里自建一个「按 id 增量维护覆盖物」的图层 */
function tdOverlayLayer(map, kind, style) {
  const items = new Map(); // id -> { obj, sig }
  const handlers = {};
  const self = {
    kind,
    _map: map,
    styles: style,
    setStyles(s) { self.styles = s; },
    setGeometries(list) {
      const keep = new Set((list || []).map((g) => g.id));
      items.forEach((it, id) => {
        if (!keep.has(id)) { try { map.removeOverLay(it.obj); } catch (e) { /* 忽略 */ } items.delete(id); }
      });
      (list || []).forEach((g) => {
        const sig = JSON.stringify([g.styleId, g.position || g.paths]);
        const cur = items.get(g.id);
        if (cur && cur.sig === sig) return;
        if (cur) { try { map.removeOverLay(cur.obj); } catch (e) { /* 忽略 */ } items.delete(g.id); }
        let obj = null;
        try {
          obj = kind === 'marker' ? tdMarker(map, g, style) : tdPath(map, g, kind, style);
        } catch (e) { console.error(e); return; }
        if (!obj) return;
        (handlers.click || []).forEach((fn) => {
          try { obj.addEventListener('click', () => fn({ geometry: { id: g.id } })); } catch (e) { /* 忽略 */ }
        });
        (handlers.hover || []).forEach((fn) => {
          try { obj.addEventListener('mouseover', () => fn({ geometry: { id: g.id } })); } catch (e) { /* 忽略 */ }
        });
        try { map.addOverLay(obj); } catch (e) { /* 忽略 */ }
        items.set(g.id, { obj, sig });
      });
    },
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    destroy() {
      items.forEach((it) => { try { map.removeOverLay(it.obj); } catch (e) { /* 忽略 */ } });
      items.clear();
    },
  };
  return self;
}

function tdMarker(map, g, styles) {
  const T = window.T;
  const s = (styles && styles[g.styleId]) || {};
  const c = TiandituAdapter.toMap(g.position.lat, g.position.lng);
  const opt = {};
  if (s.src) {
    opt.icon = new T.Icon({
      iconUrl: s.src,
      iconSize: new T.Point(s.width || 26, s.height || 34),
      iconAnchor: new T.Point(s.anchorX || ((s.width || 26) / 2), s.anchorY || (s.height || 34)),
    });
  }
  return new T.Marker(new T.LngLat(c.lng, c.lat), opt);
}

function tdPath(map, g, kind, style) {
  const T = window.T;
  const pts = (g.paths || []).map((p) => {
    const c = TiandituAdapter.toMap(p.lat, p.lng);
    return new T.LngLat(c.lng, c.lat);
  });
  if (pts.length < 2) return null;
  if (kind === 'polygon') {
    return new T.Polygon(pts, {
      color: (style && style.borderColor) || '#2159d6',
      weight: (style && style.borderWidth) || 2,
      opacity: 0.9,
      fillColor: (style && style.fillColor) || 'rgba(33,89,214,0.20)',
      fillOpacity: 0.2,
    });
  }
  return new T.Polyline(pts, {
    color: (style && style.borderColor) || '#2159d6',
    weight: (style && style.borderWidth) || 3,
    opacity: 0.9,
  });
}

/* ------------------------------ 地点搜索（共用） ------------------------------ */

/**
 * 把各家返回的候选地点统一成 [{ title, address, lng, lat }]。
 * 兼容三种坐标写法：{ lng, lat } 数值、SDK 的 LatLng（getLng/getLat）、"lng lat" 字符串。
 */
function normalizeSuggestions(list, n) {
  const max = n || 10;
  return (Array.isArray(list) ? list : []).map((d) => {
    if (!d) return null;
    const p = d.location || d.latLng || d.point || d;
    let lng = NaN, lat = NaN;
    if (p && typeof p === 'object') {
      lng = Number(typeof p.getLng === 'function' ? p.getLng() : p.lng);
      lat = Number(typeof p.getLat === 'function' ? p.getLat() : p.lat);
    } else if (typeof p === 'string') {
      const ab = p.split(/[,\s]+/);
      lng = Number(ab[0]); lat = Number(ab[1]);
    }
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
    return { title: String(d.title || d.name || ''), address: String(d.address || ''), lng, lat };
  }).filter(Boolean).slice(0, max);
}

/** 服务端代理搜索：腾讯走 WebServiceAPI，天地图走服务端搜索接口（都需要已配置密钥） */
async function serverSuggest(keyword, n) {
  try {
    const r = await API.getQ('/api/geo/search', { keyword, limit: n || 10 });
    return normalizeSuggestions(r && r.items, n || 10);
  } catch (e) {
    return [];
  }
}

const GeoAdapters = { tmap: TMapAdapter, tianditu: TiandituAdapter };

/* ------------------------------ 统一入口 ------------------------------ */

const Geo = {
  cfg: null,
  _sdkPromise: null,
  _sdkProvider: null,
  _cfgAt: 0,

  /** 读取地图配置（默认缓存 30 秒，管理员修改设置后可用 force 立即刷新） */
  async config(force) {
    if (this.cfg && !force && Date.now() - this._cfgAt < 30000) return this.cfg;
    let cfg = null;
    try {
      const r = await API.get('/api/map/config');
      cfg = r && r.map;
    } catch (e) { cfg = null; }
    if (!cfg) cfg = { provider: 'tmap', key: '', hasKey: false, center: Object.assign({}, DEFAULT_VIEW) };
    if (!cfg.center) cfg.center = Object.assign({}, DEFAULT_VIEW);
    // 兼容早期版本写在本地的腾讯地图 key
    if (!cfg.key && cfg.provider === 'tmap') {
      const local = (localStorage.getItem('tmapKey') || '').trim();
      if (local) { cfg.key = local; cfg.hasKey = true; }
    }
    this.cfg = cfg;
    this._cfgAt = Date.now();
    return cfg;
  },

  provider() { return (this.cfg && this.cfg.provider) || 'tmap'; },
  adapter() { return GeoAdapters[this.provider()] || TMapAdapter; },
  center() { return (this.cfg && this.cfg.center) || DEFAULT_VIEW; },

  /** 地图是否可用（配置齐全）。不可用时页面会给出引导 */
  async ready() {
    const cfg = await this.config();
    const ad = this.adapter();
    if (ad.needKey && !(cfg.key || '').trim()) return { ok: false, msg: ad.missingKeyMsg() };
    if (!ad.needKey && !(cfg.key || '').trim() && !proxyReady()) return { ok: false, msg: ad.missingKeyMsg() };
    return { ok: true };
  },

  /** 加载当前服务商的 SDK（返回全局命名空间，如 window.TMap / window.T） */
  async sdk(force) {
    // SDK 已就绪时直接复用：既避免重复加载脚本，也让注入了桩件的环境无需真实密钥
    if (!force) {
      const known = GeoAdapters[(this.cfg && this.cfg.provider) || 'tmap'] || TMapAdapter;
      if (window[known.global]) { this._sdkProvider = known.global; return window[known.global]; }
    }

    const cfg = await this.config(force);
    const ad = this.adapter();
    const key = (cfg.key || '').trim();

    if (ad.needKey && !key) { const e = new Error('NO_CONFIG'); e.msg = ad.missingKeyMsg(); throw e; }
    if (!ad.needKey && !key && !proxyReady()) { const e = new Error('NO_CONFIG'); e.msg = ad.missingKeyMsg(); throw e; }

    const g = ad.global;
    if (this._sdkPromise && this._sdkProvider === ad.global && !force) return this._sdkPromise;

    this._sdkProvider = ad.global;
    this._sdkPromise = new Promise((resolve, reject) => {
      ad.beforeLoad(key);
      const s = document.createElement('script');
      s.src = ad.loadUrl(key);
      s.onload = () => (window[g] ? resolve(window[g]) : reject(new Error('地图 SDK 已加载但未初始化，请刷新重试')));
      s.onerror = () => reject(new Error('地图 SDK 加载失败，请检查网络或系统设置里的密钥是否正确'));
      document.head.appendChild(s);
    }).catch((e) => { this._sdkPromise = null; throw e; });

    return this._sdkPromise;
  },

  /* ---- 坐标：存储（GCJ-02） ↔ 底图 ---- */
  toMap(lat, lng) { return this.adapter().toMap(lat, lng); },
  fromMap(lat, lng) { return this.adapter().fromMap(lat, lng); },

  /* ---- 地图 ---- */
  createMap(divId, view) { return this.adapter().createMap(divId, view || this.center()); },
  setCenter(map, lat, lng) { this.adapter().setCenter(map, lat, lng); },
  panTo(map, lat, lng, zoom) { this.adapter().panTo(map, lat, lng, zoom); },
  setZoom(map, z) { this.adapter().setZoom(map, z); },
  fitBounds(map, pts, padding) { this.adapter().fitBounds(map, pts, padding || 70); },
  getCenter(map) { return this.adapter().getCenter(map); },
  getZoom(map) { return this.adapter().getZoom(map); },
  project(map, lat, lng) {
    try { return this.adapter().project(map, lat, lng); } catch (e) { return null; }
  },
  resize(map) { try { this.adapter().resize(map); } catch (e) { /* 忽略 */ } },
  onMap(map, ev, fn) { try { this.adapter().onMap(map, ev, fn); } catch (e) { /* 忽略 */ } },
  clickLngLat(evt) { try { return this.adapter().clickLngLat(evt); } catch (e) { return null; } },
  destroyMap(map) {
    try { this.adapter().destroy(map); } catch (e) { /* 忽略 */ }
    return null;
  },

  /* ---- 图层 ---- */
  markerLayer(map, styles) { return this.adapter().createMarkerLayer(map, styles || {}); },
  polygonLayer(map, style) { return this.adapter().createPolygonLayer(map, style || {}); },
  polylineLayer(map, style) { return this.adapter().createPolylineLayer(map, style || {}); },
  setStyles(layer, styles) { this.adapter().setLayerStyles(layer, styles); },
  setMarkers(layer, geoms) { this.adapter().setLayerGeoms(layer, geoms); },
  setPaths(layer, geoms) { this.adapter().setPathGeoms(layer, geoms); },
  layerOn(layer, ev, fn) { this.adapter().layerOn(layer, ev, fn); },
  destroyLayer(layer) { try { this.adapter().destroyLayer(layer); } catch (e) { /* 忽略 */ } return null; },

  /* ---- 信息窗 ---- */
  infoWindow(map) { return this.adapter().createInfoWindow(map); },
  setIwContent(iw, html) { this.adapter().setIwContent(iw, html); },
  setIwPosition(iw, lat, lng) { this.adapter().setIwPosition(iw, lat, lng); },
  openIw(iw) { this.adapter().openIw(iw); },
  closeIw(iw) { this.adapter().closeIw(iw); },
  destroyIw(iw) { try { this.adapter().destroyIw(iw); } catch (e) { /* 忽略 */ } return null; },

  /* ---- 地理编码 ---- */
  async geocode(address) { return this.adapter().geocode(address); },
  async reverse(lat, lng) { return this.adapter().reverse(lat, lng); },

  /**
   * 地点搜索：关键词 → 候选地点 [{ title, address, lng, lat }]（已统一为 GCJ-02）。
   * 适配器没实现搜索时退化为地址解析的单点结果。
   */
  async suggest(keyword, n) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const ad = this.adapter();
    if (typeof ad.suggest === 'function') {
      const list = await ad.suggest(kw, n || 10);
      if (list && list.length) return list;
    }
    const loc = await this.geocode(kw);
    return loc ? [{ title: kw, address: '', lng: loc.lng, lat: loc.lat }] : [];
  },
};

/**
 * 统一的「地图未配置」引导。
 * 只出轻提示（toast）—— 地图页/预览页本身会渲染带「前往系统设置」按钮的引导卡，
 * 这里再弹模态确认框会与引导卡重复，且遮罩会挡住用户继续操作列表与工具栏。
 */
function geoNotReady(msg) {
  toast(msg || '地图服务未配置', 'err', 5000);
}
