'use strict';
/**
 * 地图标注页「位置搜索」端到端（接口 + 真实 Chrome + 双桩件）：
 *   · 接口：未登录 401、缺关键词 400、正常返回候选地点（坐标合法）
 *   · 腾讯地图：浏览器端关键词提示 → 候选列表 → 点击后地图放大到该位置（zoom 17）
 *   · 搜索定位点用独立样式渲染，清除后消失
 *   · 直接输入「经度,纬度」不调用搜索服务，直接定位
 *   · 正在标注时点击候选地点 → 直接进入「确认标注位置」弹窗
 *   · 无浏览器端提示服务时回退服务端 /api/geo/search
 *   · 天地图：服务端返回 CGCS2000，定位前已换算为 GCJ-02（往返一致）
 *
 * 运行：node tools/map-search-test.js（需后端 http://127.0.0.1:8789）
 */
const { chromium } = require('playwright-core');
const path = require('path');
const { STUB } = require('./tmap-stub');
const { STUB_TDT } = require('./tianditu-stub');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PREVIEW || 'http://127.0.0.1:8789/';
const APIBASE = process.env.APIBASE || 'http://127.0.0.1:8789';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

/** 服务端返回的候选点（按天地图口径 CGCS2000 理解，用于验证换算） */
const RAW = { lng: 106.5401, lat: 29.5702 };
const SERVER_ITEMS = [
  { title: 'SERVER-地点A', address: '重庆市江北区某地A', lng: RAW.lng, lat: RAW.lat },
  { title: 'SERVER-地点B', address: '重庆市江北区某地B', lng: RAW.lng + 0.01, lat: RAW.lat + 0.01 },
];

let pass = 0, fail = 0;
const errs = [];

async function step(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-4 : eps);

async function api(method, p, body, token) {
  const res = await fetch(APIBASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = {};
  try { j = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, data: j };
}

(async () => {
  /* ============ 接口层 ============ */
  const T = (await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).data.token;
  ok(!!T, '登录失败，无法取得 token');
  const origin = (await api('GET', '/api/settings/map', undefined, T)).data.map;

  await step('接口：未登录调用地点搜索返回 401', async () => {
    const r = await api('GET', '/api/geo/search?keyword=' + encodeURIComponent('洋河一村'));
    ok(r.status === 401, 'status=' + r.status);
  });

  await step('接口：缺少关键词返回 400', async () => {
    const r = await api('GET', '/api/geo/search', undefined, T);
    ok(r.status === 400, 'status=' + r.status + ' ' + JSON.stringify(r.data));
  });

  await step('接口：关键词返回候选地点且坐标合法', async () => {
    const r = await api('GET', '/api/geo/search?keyword=' + encodeURIComponent('洋河一村') + '&limit=5', undefined, T);
    if (r.status === 200) {
      ok(Array.isArray(r.data.items) && r.data.items.length > 0, JSON.stringify(r.data).slice(0, 120));
      const bad = r.data.items.filter((it) => !(it.title && Math.abs(it.lng) <= 180 && Math.abs(it.lat) <= 90));
      ok(bad.length === 0, '存在非法条目：' + JSON.stringify(bad[0]));
    } else {
      // 密钥不可用时也要给出可读原因，而不是 500
      ok(r.status === 502 && /搜索|密钥|地图服务/.test(r.data.error || ''), 'status=' + r.status + ' ' + JSON.stringify(r.data));
    }
  });

  /* ============ 浏览器 ============ */
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));

  // 固定服务端搜索结果，避免测试依赖真实地图服务配额
  await page.route('**/api/geo/search*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: SERVER_ITEMS }),
  }));

  const setProvider = async (provider, keys) => {
    await api('PUT', '/api/settings/map', { provider, keys: Object.assign({}, origin.keys, keys || {}), center: origin.center }, T);
  };
  const signIn = async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.fill('#lg-u', 'admin');
    await page.fill('#lg-p', 'admin123');
    await page.click('#lg-btn');
    await page.waitForSelector('#nav', { timeout: 15000 });
    await page.waitForTimeout(800);
  };
  const gotoMap = async () => {
    await page.click('#nav a[data-k="map"]');
    await page.waitForSelector('#mp-sea', { timeout: 15000 });
    await page.waitForTimeout(1200);
  };

  try {
    await setProvider('tmap', { tmap: 'STUB-TMAP-KEY' });
    await page.addInitScript(() => { localStorage.setItem('tmapKey', 'STUB-TMAP-KEY'); });
    await page.addInitScript(STUB);
    await page.addInitScript(STUB_TDT);
    await signIn();
    await gotoMap();

    await step('地图标注页出现位置搜索框', async () => {
      const r = await page.evaluate(() => ({
        sea: !!document.getElementById('mp-sea'),
        go: !!document.getElementById('mp-sea-go'),
        ph: (document.getElementById('mp-sea') || {}).placeholder || '',
        tip: (document.querySelector('#mp-sea-box .muted') || {}).textContent || '',
      }));
      ok(r.sea && r.go, '搜索框缺失 ' + JSON.stringify(r));
      ok(/搜索地点/.test(r.ph), 'placeholder=' + r.ph);
      ok(/放大|打点/.test(r.tip), '提示文案=' + r.tip);
    });

    await step('输入关键词后列出候选地点', async () => {
      await page.fill('#mp-sea', '洋河一村');
      await page.waitForSelector('.mp-sea-item', { timeout: 8000 });
      const r = await page.evaluate(() => ({
        n: document.querySelectorAll('.mp-sea-item').length,
        t1: (document.querySelector('.mp-sea-item .t') || {}).textContent,
        c1: (document.querySelector('.mp-sea-item .c') || {}).textContent,
      }));
      ok(r.n === 2, '候选数 ' + r.n);
      ok(r.t1 === '洋河一村', '首条 ' + r.t1);
      ok(/106\.55/.test(r.c1 || ''), '坐标 ' + r.c1);
    });

    await step('点击候选地点：地图放大到该位置（zoom 17）', async () => {
      await page.click('.mp-sea-item');
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => {
        const m = __stub.maps[__stub.maps.length - 1];
        return { lat: m.center.getLat(), lng: m.center.getLng(), zoom: m.zoom };
      });
      ok(near(r.lat, 29.5901) && near(r.lng, 106.5523), JSON.stringify(r));
      ok(r.zoom === 17, 'zoom=' + r.zoom);
    });

    await step('搜索定位点独立渲染在临时图层（styleId = q）', async () => {
      const r = await page.evaluate(() => {
        const gs = (__stub.markers || []).filter((m) => m.kind === 'marker')
          .reduce((a, m) => a.concat(m.geoms || []), []);
        return { sea: gs.filter((g) => g.styleId === 'q'), tmp: gs.filter((g) => g.styleId === 't') };
      });
      ok(r.sea.length === 1 && r.sea[0].id === 'sea', JSON.stringify(r.sea));
      ok(near(r.sea[0].position.lat, 29.5901), JSON.stringify(r.sea[0]));
      ok(r.tmp.length === 0, '未标注时不应有待确认点位');
    });

    await step('清除搜索定位后点位与输入一起复位', async () => {
      await page.click('#mp-sea-clr');
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const gs = (__stub.markers || []).filter((m) => m.kind === 'marker')
          .reduce((a, m) => a.concat(m.geoms || []), []);
        return { sea: gs.filter((g) => g.styleId === 'q').length, val: document.getElementById('mp-sea').value, pos: MapPage.searchPos };
      });
      ok(r.sea === 0 && !r.pos, JSON.stringify(r));
      ok(r.val === '', '输入框未清空：' + r.val);
    });

    await step('直接输入「经度,纬度」不调用搜索服务即定位', async () => {
      const before = await page.evaluate(() => (__stub.suggestions || []).length);
      await page.fill('#mp-sea', '106.55,29.58');
      await page.click('#mp-sea-go');
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => {
        const m = __stub.maps[__stub.maps.length - 1];
        return {
          lat: m.center.getLat(), lng: m.center.getLng(), zoom: m.zoom,
          calls: (__stub.suggestions || []).length,
          pos: MapPage.searchPos,
          val: document.getElementById('mp-sea').value,
        };
      });
      ok(near(r.lng, 106.55) && near(r.lat, 29.58), JSON.stringify(r));
      ok(r.zoom === 17, 'zoom=' + r.zoom);
      ok(r.calls === before, '坐标输入不应调用搜索服务：' + before + ' → ' + r.calls);
      ok(r.val === '106.55,29.58', '坐标输入不应被地点名覆盖：' + r.val);
    });

    await step('标注中点击候选地点 → 直接进入标注确认（带该坐标）', async () => {
      await page.click('#mp-lst .it');
      await page.waitForTimeout(400);
      await page.fill('#mp-sea', '洋河一村');
      await page.waitForSelector('.mp-sea-item', { timeout: 8000 });
      await page.click('.mp-sea-item');
      await page.waitForSelector('.mask .dlg', { timeout: 8000 });
      const r = await page.evaluate(() => ({
        title: (document.querySelector('.mask .dlg-h h3') || {}).textContent,
        body: (document.querySelector('.mask .dlg-b') || {}).textContent || '',
      }));
      ok(/确认标注位置/.test(r.title || ''), '弹窗标题=' + r.title);
      ok(/106\.5523/.test(r.body), '弹窗未带搜索坐标：' + r.body.slice(0, 160));
      await page.click('.mask .dlg-f button'); // 取消，避免写入数据
      await page.waitForTimeout(300);
      const n = await page.evaluate(() => document.querySelectorAll('.mask').length);
      ok(n === 0, '弹窗未关闭');
      // 退出标注模式，否则后续搜索结果又会触发确认弹窗
      await page.click('#mp-exit');
      await page.waitForTimeout(300);
      const r2 = await page.evaluate(() => ({
        marking: MapPage.markingId,
        exitBtn: (document.getElementById('mp-exit') || {}).style?.display,
        mode: (document.getElementById('mp-mode') || {}).textContent || '',
      }));
      ok(!r2.marking && r2.exitBtn === 'none', JSON.stringify(r2));
      ok(/点击左侧资产/.test(r2.mode), '模式提示未复位：' + r2.mode);
    });

    await step('无浏览器端提示服务时回退服务端搜索', async () => {
      await page.evaluate(() => { delete window.TMap.service.Suggestion; });
      await page.fill('#mp-sea', '某地');
      await page.waitForSelector('.mp-sea-item', { timeout: 8000 });
      const r = await page.evaluate(() => [...document.querySelectorAll('.mp-sea-item .t')].map((n) => n.textContent));
      ok(r.length === 2 && r[0] === 'SERVER-地点A', JSON.stringify(r));
    });

    await step('腾讯地图：服务端结果不做坐标换算（原生即 GCJ-02）', async () => {
      await page.click('.mp-sea-item');
      await page.waitForTimeout(400);
      const pos = await page.evaluate(() => MapPage.searchPos);
      ok(near(pos.lng, RAW.lng) && near(pos.lat, RAW.lat), JSON.stringify(pos));
    });

    /* ============ 天地图：坐标系换算 ============ */
    await step('天地图：搜索结果换算为 GCJ-02 后再定位（往返一致）', async () => {
      await setProvider('tianditu', { tianditu: 'STUB-TDT-TK' });
      await page.evaluate(() => Geo.config(true));
      await page.click('#nav a[data-k="dashboard"]');
      await page.waitForTimeout(400);
      await gotoMap();

      await page.fill('#mp-sea', '某地');
      await page.waitForSelector('.mp-sea-item', { timeout: 8000 });
      await page.click('.mp-sea-item');
      await page.waitForTimeout(500);

      const r = await page.evaluate(() => {
        const raw = { lng: 106.5401, lat: 29.5702 };
        const gcj = GeoAdapters.tianditu.fromMap(raw.lat, raw.lng); // CGCS2000 → GCJ-02
        const m = __tdt.maps[__tdt.maps.length - 1];
        return {
          pos: MapPage.searchPos, gcj,
          moved: Math.abs(MapPage.searchPos.lng - raw.lng) > 1e-6,
          backLng: m.center.getLng(), backLat: m.center.getLat(),
        };
      });
      ok(r.moved, '天地图结果未做坐标换算：' + JSON.stringify(r.pos));
      ok(near(r.pos.lng, r.gcj.lng, 1e-6) && near(r.pos.lat, r.gcj.lat, 1e-6), JSON.stringify(r));
      ok(near(r.backLng, RAW.lng, 1e-6) && near(r.backLat, RAW.lat, 1e-6), '底图坐标往返不一致：' + JSON.stringify(r));
    });

    await page.screenshot({ path: path.join(SHOT, 'map-search.png') });

    await step('无控制台报错', async () => {
      const real = errs.filter((e) => !/favicon|net::ERR_|Failed to load resource/.test(e));
      ok(real.length === 0, real.slice(0, 3).join(' | '));
    });

    await browser.close();
  } finally {
    await api('PUT', '/api/settings/map', { provider: origin.provider, keys: origin.keys, center: origin.center }, T);
    console.log('  设置已还原');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
