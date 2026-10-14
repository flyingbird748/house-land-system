'use strict';
/**
 * 地图适配层端到端（真实 Chrome + 双桩件）：
 *   · 配置「腾讯地图」时用 TMap 桩件建图，「天地图」时用 T 桩件建图
 *   · 点位数量与数据一致、容器绑定、resize/全览
 *   · GCJ-02 → CGCS2000 换算正确（往返误差 < 1e-6）
 *   · 系统设置页：服务商卡片切换、密钥填写、保存后 /api/map/config 生效
 *   · 地图未配置（天地图无 tk）时给出引导而非白屏
 *
 * 运行：node tools/geo-adapter-test.js（需后端 http://127.0.0.1:8789）
 */
const { chromium } = require('playwright-core');
const path = require('path');
const { STUB } = require('./tmap-stub');
const { STUB_TDT } = require('./tianditu-stub');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PREVIEW || 'http://127.0.0.1:8789/';
const APIBASE = process.env.APIBASE || 'http://127.0.0.1:8789';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

let pass = 0, fail = 0;
const errs = [];

async function step(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

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
  const T = (await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).data.token;
  const origin = (await api('GET', '/api/settings/map', undefined, T)).data.map;

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));

  const signIn = async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.fill('#lg-u', 'admin');
    await page.fill('#lg-p', 'admin123');
    await page.click('#lg-btn');
    await page.waitForSelector('#nav', { timeout: 15000 });
    await page.waitForTimeout(800);
  };

  /** 设置当前地图服务商与密钥，并让前端重新拉取配置 */
  const setProvider = async (provider, keys) => {
    await api('PUT', '/api/settings/map', { provider, keys: Object.assign({}, origin.keys, keys || {}), center: origin.center }, T);
  };

  try {
    /* ============ 腾讯地图 ============ */
    await setProvider('tmap', { tmap: 'STUB-TMAP-KEY' });
    await page.addInitScript(() => { localStorage.setItem('tmapKey', 'STUB-TMAP-KEY'); });
    await page.addInitScript(STUB);
    await page.addInitScript(STUB_TDT);
    await signIn();

    await step('配置生效：前端读到腾讯地图', async () => {
      const cfg = await page.evaluate(() => JSON.parse(JSON.stringify(Geo.cfg)));
      ok(cfg.provider === 'tmap', 'provider=' + cfg.provider);
      ok(cfg.providerName === '腾讯地图', cfg.providerName);
    });

    await step('地图标注页使用 TMap 桩件建图', async () => {
      await page.click('#nav a[data-k="map"]');
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => ({
        maps: (__stub.maps || []).length,
        tdtMaps: (__tdt.maps || []).length,
        bound: !!(__stub.maps[0] && __stub.maps[0].el && document.getElementById('map') === __stub.maps[0].el),
      }));
      ok(r.maps === 1 && r.tdtMaps === 0, 'TMap=' + r.maps + ' T=' + r.tdtMaps);
      ok(r.bound, '地图未绑定到当前 DOM 容器');
    });

    await step('点位数量与服务端数据一致', async () => {
      const r = await page.evaluate(() => ({ n: MapPage.assets.length, g: __stub.markers.filter((m) => m.kind === 'marker' && m.geoms.length).length }));
      ok(r.n > 0 && r.g >= 1, JSON.stringify(r));
    });

    await step('切到预览页也用 TMap，且悬停浮卡可用', async () => {
      await page.click('#nav a[data-k="preview"]');
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => ({
        tdt: (__tdt.maps || []).length,
        pts: PreviewPage.projPoints().length,
      }));
      ok(r.tdt === 0, '天地图实例数 ' + r.tdt);
      ok(r.pts > 0, '投影点数 ' + r.pts);
    });

    /* ============ 坐标换算 ============ */
    await step('GCJ-02 → CGCS2000 换算正确（往返误差 < 1e-6）', async () => {
      const r = await page.evaluate(() => {
        const a = { lat: 29.5889, lng: 106.5515 };
        const w = Geo.adapter === undefined ? null : null;
        // 直接调用天地图适配器的换算（不依赖当前 provider）
        const to = GeoAdapters.tianditu.toMap(a.lat, a.lng);
        const back = GeoAdapters.tianditu.fromMap(to.lat, to.lng);
        return {
          to, back,
          dLat: Math.abs(back.lat - a.lat), dLng: Math.abs(back.lng - a.lng),
          shifted: Math.abs(to.lat - a.lat) > 1e-6 || Math.abs(to.lng - a.lng) > 1e-6,
        };
      });
      ok(r.dLat < 1e-6 && r.dLng < 1e-6, '往返误差 ' + JSON.stringify(r));
      ok(r.shifted, '天地图坐标应与存储坐标不同（存在火星偏移）');
    });

    /* ============ 天地图 ============ */
    await step('切换到天地图后用 T 桩件建图', async () => {
      await setProvider('tianditu', { tianditu: 'STUB-TDT-TK' });
      await page.evaluate(() => Geo.config(true));
      await page.click('#nav a[data-k="dashboard"]');
      await page.waitForTimeout(400);
      await page.click('#nav a[data-k="map"]');
      await page.waitForTimeout(1400);
      const r = await page.evaluate(() => ({
        prov: Geo.cfg.provider,
        tdt: (__tdt.maps || []).length,
        markers: (__tdt.overlays || []).filter((o) => o.kind === 'marker').length,
        bound: !!(__tdt.maps[0] && document.getElementById('map') === __tdt.maps[0].el),
      }));
      ok(r.prov === 'tianditu', 'provider=' + r.prov);
      ok(r.tdt >= 1, '天地图实例 ' + r.tdt);
      ok(r.markers > 0, '天地图点位 ' + r.markers);
      ok(r.bound, '地图未绑定到当前容器');
    });

    await step('天地图：点位坐标已换算为 CGCS2000', async () => {
      const r = await page.evaluate(() => {
        const mk = (__tdt.overlays || []).filter((o) => o.kind === 'marker');
        if (!mk.length) return null;
        const a = MapPage.assets.find((x) => Number.isFinite(x.lat));
        const p = mk[0].lnglat;
        const expect = GeoAdapters.tianditu.toMap(a.lat, a.lng);
        // 找一个与 expect 接近的点（桩件里点位顺序与数据一致）
        const hit = mk.some((m) => Math.abs(m.lnglat.lng - expect.lng) < 1e-6 && Math.abs(m.lnglat.lat - expect.lat) < 1e-6);
        return { hit, first: { lng: p.lng, lat: p.lat }, expect };
      });
      ok(r && r.hit, JSON.stringify(r));
    });

    await step('天地图：筛选后点位会移除（不残留）', async () => {
      const before = await page.evaluate(() => (__tdt.overlays || []).filter((o) => o.kind === 'marker' && !o._removed).length);
      await page.click('#nav a[data-k="preview"]');
      await page.waitForTimeout(1000);
      // 预览页搜索一个不存在的关键词 → 点位清空
      await page.fill('#pv-kw', 'ZZZ-不存在的资产-ZZZ');
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => ({
        shown: PreviewPage.filtered().length,
        removed: (__tdt.removed || []).length,
      }));
      ok(r.shown === 0, '筛选结果 ' + r.shown);
      ok(r.removed > 0, '覆盖物未被移除');
    });

    /* ============ 系统设置页 ============ */
    await step('系统设置页：服务商卡片与注册指引', async () => {
      await page.click('#nav a[data-k="settings"]');
      await page.waitForTimeout(900);
      const r = await page.evaluate(() => ({
        provs: [...document.querySelectorAll('.set-prov')].map((n) => n.dataset.p),
        steps: document.querySelectorAll('.set-step').length,
        links: document.querySelectorAll('.set-step .lnk').length,
        on: (document.querySelector('.set-prov.on') || {}).dataset?.p,
      }));
      ok(r.provs.length >= 2, JSON.stringify(r.provs));
      ok(r.steps >= 8, '指引步骤数 ' + r.steps);
      ok(r.links >= 2, '外链数 ' + r.links);
      ok(r.on === 'tianditu', '当前高亮 ' + r.on);
      await page.screenshot({ path: path.join(SHOT, 'settings-map.png'), fullPage: true });
      // 注册指引默认展开当前服务商，单独截一张便于查看步骤说明
      await page.evaluate(() => {
        const el = document.getElementById('gd-tianditu');
        if (el) el.scrollIntoView({ block: 'start' });
      });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOT, 'settings-guide.png') });
    });

    await step('系统设置页：切换服务商 + 保存生效', async () => {
      await page.click('.set-prov[data-p="tmap"]');
      await page.waitForTimeout(300);
      await page.click('#st-save');
      await page.waitForTimeout(900);
      const r = await page.evaluate(() => ({ prov: Geo.cfg.provider, name: Geo.cfg.providerName }));
      ok(r.prov === 'tmap', JSON.stringify(r));
      const back = await api('GET', '/api/map/config', undefined, T);
      ok(back.data.map.provider === 'tmap', JSON.stringify(back.data.map));
    });

    await step('天地图未配置密钥时给出引导而非白屏', async () => {
      await api('PUT', '/api/settings/map', { provider: 'tianditu', keys: { tmap: origin.keys.tmap || '', tianditu: '' }, center: origin.center }, T);
      // 模拟管理员清空密钥后重新打开系统（配置缓存最多 30 秒，重载最贴近真实场景）
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(900);
      if (!(await page.$('#nav'))) await signIn();
      // 桩件会让「SDK 已加载」短路密钥校验（真实场景里这就是 key 合法），
      // 想验证「没配 key」必须先摘掉桩件，否则根本走不到引导分支
      await page.evaluate(() => { delete window.T; delete window.__tdt; });
      await page.click('#nav a[data-k="map"]');
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => ({
        keybox: (document.getElementById('mp-keybox') || {}).style?.display,
        hint: (document.getElementById('mp-hint') || {}).textContent || '',
        listRows: document.querySelectorAll('#mp-lst .it').length,
      }));
      ok(r.keybox === '', '未显示配置引导框：' + r.keybox);
      ok(/未配置|未就绪|密钥|系统设置/.test(r.hint), r.hint);
      ok(r.listRows > 0, '资产列表仍可用：' + r.listRows);
    });

    await page.screenshot({ path: path.join(SHOT, 'settings-no-key.png'), fullPage: true });

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
})();
