'use strict';
/**
 * 天地图 JS API 4.0 桩件（供浏览器端注入，避免测试依赖真实 tk）。
 * 记录地图/覆盖物的创建与销毁，并支持读取当前点位坐标与容器投影。
 */
function STUB_TDT() {
  const rec = { maps: [], overlays: [], added: [], removed: [], destroys: [] };
  window.__tdt = rec;

  class LngLat {
    constructor(lng, lat) { this.lng = lng; this.lat = lat; }
    getLng() { return this.lng; }
    getLat() { return this.lat; }
  }
  class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    getX() { return this.x; }
    getY() { return this.y; }
  }
  class Icon {
    constructor(o) { Object.assign(this, o || {}); }
  }
  class Evt {
    constructor() { this._h = {}; }
    addEventListener(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    emit(ev, payload) { (this._h[ev] || []).forEach((f) => f(payload || {})); }
  }
  class Overlay extends Evt {
    constructor(kind, opt) { super(); this.kind = kind; this.opt = opt || {}; rec.overlays.push(this); }
  }
  class Marker extends Overlay {
    constructor(lnglat, opt) { super('marker', opt); this.lnglat = lnglat; }
    getLngLat() { return this.lnglat; }
    setLngLat(p) { this.lnglat = p; }
    setIcon(i) { (this.opt = this.opt || {}).icon = i; }
  }
  class InfoWindow extends Overlay {
    constructor() { super('infowindow', {}); this.content = ''; this.opened = false; }
    setContent(c) { this.content = c; }
    setLngLat(p) { this.lnglat = p; }
  }
  class Map extends Evt {
    constructor(el, opts) {
      super();
      this.el = typeof el === 'string' ? document.getElementById(el) : el;
      this.opts = opts || {};
      this.view = [];
      this.zoom = 12;
      this.center = new LngLat(106.5515, 29.5889);
      this.checked = 0;
      this.destroyed = false;
      rec.maps.push(this);
      if (this.el) {
        const c = document.createElement('div');
        c.className = 'stub-canvas';
        c.style.cssText = 'position:absolute;inset:0';
        this.el.appendChild(c);
      }
    }
    centerAndZoom(p, z) { this.center = p; if (Number.isFinite(z)) this.zoom = z; }
    panTo(p, z) { this.center = p; if (Number.isFinite(z)) this.zoom = z; }
    setZoom(z) { this.zoom = z; }
    getZoom() { return this.zoom; }
    getCenter() { return this.center; }
    enableScrollWheelZoom() {}
    checkResize() { this.checked++; }
    setViewport(view) { this.view = view || []; this.fitted = (view || []).length; }
    lngLatToContainer(p) { return new Point(200, 200); }
    addOverLay(o) { rec.added.push(o && o.kind || 'overlay'); }
    removeOverLay(o) { rec.removed.push(o && o.kind || 'overlay'); }
    clearOverLays() { rec.destroys.push('clear'); }
  }

  window.T = {
    Map, LngLat, Point, Icon, Marker, InfoWindow,
    Polygon: class extends Overlay { constructor(pts, opt) { super('polygon', opt); this.pts = pts; } },
    Polyline: class extends Overlay { constructor(pts, opt) { super('polyline', opt); this.pts = pts; } },
  };
}

module.exports = { STUB_TDT };
