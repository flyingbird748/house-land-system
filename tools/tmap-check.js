'use strict';
/** 校验腾讯地图 GL JS 的真实 API 表面：类是否存在、构造参数是否被接受 */
const { chromium } = require('playwright-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8789';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(BASE + '/');
  await page.waitForSelector('#lg-u');

  const result = await page.evaluate(async () => {
    // 使用一个无效的代理地址，仅验证 SDK 自身的 API 表面
    window._TMapSecurityConfig = { serviceHost: 'http://127.0.0.1:1/_TMapService/_wbt/dev' };
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://map.qq.com/api/gljs?v=1.exp&libraries=service';
      s.onload = res;
      s.onerror = () => rej(new Error('SDK 加载失败'));
      document.head.appendChild(s);
    });

    const out = { keys: [], missing: [], errors: [] };
    if (!window.TMap) { out.errors.push('window.TMap 未定义'); return out; }

    const need = ['Map', 'LatLng', 'LatLngBounds', 'MultiMarker', 'MarkerStyle', 'InfoWindow',
      'MultiPolygon', 'PolygonStyle', 'MultiPolyline', 'PolylineStyle', 'MultiLabel', 'LabelStyle'];
    need.forEach((k) => (window.TMap[k] ? out.keys.push(k) : out.missing.push(k)));
    const svc = window.TMap.service || {};
    ['Geocoder', 'Search', 'Suggestion', 'Driving'].forEach((k) => (svc[k] ? out.keys.push('service.' + k) : out.missing.push('service.' + k)));

    // 真正构造一遍，使用与页面中一致的参数
    const host = document.createElement('div');
    host.style.cssText = 'width:600px;height:400px;position:fixed;left:0;top:0;z-index:-1';
    document.body.appendChild(host);
    try {
      const TMap = window.TMap;
      const map = new TMap.Map(host, { zoom: 12, center: new TMap.LatLng(29.5889, 106.5515) });
      out.errors.push('map-ok');

      const ms = new TMap.MarkerStyle({ width: 26, height: 34, src: 'data:image/svg+xml,%3Csvg/%3E', anchor: { x: 13, y: 34 } });
      out.errors.push('markerstyle-ok');
      const mk = new TMap.MultiMarker({ map, styles: { a: ms }, geometries: [] });
      mk.setGeometries([{ id: '1', styleId: 'a', position: new TMap.LatLng(29.58, 106.55) }]);
      mk.setStyles({ a: ms });
      let clicked = false;
      mk.on('click', () => { clicked = true; });
      out.errors.push('multimarker-ok');

      const ps = new TMap.PolygonStyle({ color: 'rgba(33,89,214,0.2)', showBorder: true, borderColor: '#2159d6', borderWidth: 2 });
      const pg = new TMap.MultiPolygon({ map, styles: { p: ps }, geometries: [] });
      pg.setGeometries([{ id: '1', styleId: 'p', paths: [new TMap.LatLng(29.5, 106.5), new TMap.LatLng(29.6, 106.5), new TMap.LatLng(29.6, 106.6)] }]);
      out.errors.push('multipolygon-ok');

      const ls = new TMap.PolylineStyle({ color: '#2159d6', width: 3, borderWidth: 0 });
      const ln = new TMap.MultiPolyline({ map, styles: { d: ls }, geometries: [] });
      ln.setGeometries([{ id: '1', styleId: 'd', paths: [new TMap.LatLng(29.5, 106.5), new TMap.LatLng(29.6, 106.6)] }]);
      out.errors.push('multipolyline-ok');

      const iw = new TMap.InfoWindow({ map, position: new TMap.LatLng(29.58, 106.55), content: '<b>hi</b>', offset: { x: 0, y: -34 }, enableCustom: true });
      iw.setContent('<div style="color:red">测试</div>');
      iw.open();
      iw.close();
      out.errors.push('infowindow-ok');

      const b = new TMap.LatLngBounds();
      b.extend(new TMap.LatLng(29.5, 106.5));
      b.extend(new TMap.LatLng(29.7, 106.7));
      map.fitBounds(b, { padding: 70 });
      out.errors.push('latlngbounds-ok');

      map.setCenter(new TMap.LatLng(29.5889, 106.5515));
      map.setZoom(14);
      let clickEvt = null;
      map.on('click', (e) => { clickEvt = e; });
      out.errors.push('map-events-ok');

      out.markerCount = mk.getGeometries().length;
      out.infoWindow = typeof iw.setContent === 'function';
      const geo = new TMap.service.Geocoder();
      out.geocoderMethods = ['getLocation', 'getAddress'].filter((m) => typeof geo[m] === 'function');
    } catch (e) {
      out.errors.push('构造异常: ' + e.message);
    }
    return out;
  });

  console.log('存在的类:', result.keys.join(', '));
  console.log('缺失的类:', result.missing.length ? result.missing.join(', ') : '（无）');
  console.log('构造函数校验:', (result.errors || []).join(' | '));
  console.log('Geocoder 方法:', (result.geocoderMethods || []).join(', '));
  console.log('MultiMarker.getGeometries():', result.markerCount);
  console.log('页面异常:', errs.length ? errs.join(' | ') : '（无）');

  await browser.close();
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
