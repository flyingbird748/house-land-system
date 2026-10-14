'use strict';
/**
 * 腾讯地图 GL 桩件（供浏览器端注入，避免测试依赖真实 key / 密钥代理）。
 * 记录实例创建与销毁、容器绑定、resize 调用，并支持 emit 主动派发图层事件。
 */
function STUB() {
  const rec = { maps: [], markers: [], destroys: [] };
  window.__stub = rec;

  class LatLng {
    constructor(lat, lng) { this.lat = lat; this.lng = lng; }
    getLat() { return this.lat; }
    getLng() { return this.lng; }
  }
  class LatLngBounds { constructor() { this.n = 0; } extend() { this.n++; return this; } }
  class Evt {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    /** 测试用：主动派发事件（模拟 SDK 的点击/悬停回调） */
    emit(ev, payload) { (this._h[ev] || []).forEach((f) => f(payload)); }
  }
  class Map extends Evt {
    constructor(el, opts) {
      super();
      this.el = typeof el === 'string' ? document.getElementById(el) : el;
      this.opts = opts;
      this.resized = 0;
      this.destroyed = false;
      this.center = opts && opts.center ? opts.center : new LatLng(29.5889, 106.5515);
      this.zoom = (opts && opts.zoom) || 12;
      rec.maps.push(this);
      if (this.el) {
        const c = document.createElement('div');
        c.className = 'stub-canvas';
        c.style.cssText = 'position:absolute;inset:0';
        this.el.appendChild(c);
      }
    }
    setCenter(p) { this.center = p; }
    setZoom(z) { this.zoom = z; }
    fitBounds() {}
    getCenter() { return this.center || new LatLng(29.5889, 106.5515); }
    getZoom() { return this.zoom == null ? 12 : this.zoom; }
    projectToContainer() { return { x: 200, y: 200 }; }
    resize() { this.resized++; }
    destroy() { this.destroyed = true; rec.destroys.push('map'); if (this.el) this.el.innerHTML = ''; }
  }
  class Layer extends Evt {
    constructor(kind, opts) { super(); this.kind = kind; this.opts = opts || {}; this.geoms = []; this.styles = {}; rec.markers.push(this); }
    setStyles(s) { this.styles = s || {}; }
    setGeometries(g) { this.geoms = g || []; this.lastLen = this.geoms.length; }
    updateGeometries(g) { this.geoms = (this.geoms || []).concat(g || []); }
    setMap(m) { this.map = m; }
    destroy() { this.destroyed = true; rec.destroys.push(this.kind); }
  }
  class InfoWin extends Evt {
    constructor(o) { super(); this.o = o || {}; this.opened = false; }
    setContent() {} setPosition() {}
    open() { this.opened = true; } close() { this.opened = false; }
    destroy() { rec.destroys.push('infowindow'); }
  }
  class Style { constructor(o) { Object.assign(this, o || {}); } }
  class Geocoder {
    getAddress() { return Promise.resolve({ result: { address: '重庆市江北区' } }); }
    getLocation() { return Promise.resolve({ result: { location: new LatLng(29.5889, 106.5515) } }); }
  }
  /** 关键词输入提示：返回与真实 SDK 一致的 { status, data:[{title,address,location}] } 结构 */
  class Suggestion {
    constructor(o) { Object.assign(this, o || {}); }
    getSuggestions(p) {
      (rec.suggestions = rec.suggestions || []).push(p);
      return Promise.resolve({
        status: 0,
        data: [
          { id: '1', title: '洋河一村', address: '重庆市江北区洋河一村', location: new LatLng(29.5901, 106.5523) },
          { id: '2', title: '洋河二村', address: '重庆市江北区洋河二村', location: new LatLng(29.5931, 106.5553) },
        ],
      });
    }
  }
  window.TMap = {
    Map, LatLng, LatLngBounds,
    MultiMarker: class extends Layer { constructor(o) { super('marker', o); } },
    MultiPolygon: class extends Layer { constructor(o) { super('polygon', o); } },
    MultiPolyline: class extends Layer { constructor(o) { super('polyline', o); } },
    InfoWindow: InfoWin,
    MarkerStyle: Style, PolygonStyle: Style, PolylineStyle: Style,
    service: { Geocoder, Suggestion },
  };
}

module.exports = { STUB };
