'use strict';
/**
 * 模块切换回归：切到「地图标注 / 房产预览」时，地图实例必须销毁旧实例、
 * 绑定当前 DOM 中的新容器并完成一次尺寸校正（resize），即“自动刷新”。
 *
 * 说明：不依赖真实腾讯地图 SDK 与密钥代理 —— 用桩件替换 window.TMap，
 * 只验证「实例生命周期 + 容器绑定 + 尺寸校正」这一层逻辑。
 *
 * 运行：node tools/map-switch-test.js   （需后端 http://127.0.0.1:8789 已启动）
 */
const { chromium } = require('playwright-core');
const path = require('path');
const { STUB } = require('./tmap-stub');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PREVIEW || 'http://127.0.0.1:8789/';
const APIBASE = process.env.APIBASE || 'http://127.0.0.1:8789';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

const errs = [];
let pass = 0, fail = 0;

async function step(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' —— ' + e.message);
  }
}

function ok(cond, msg) { if (!cond) throw new Error(msg); }


(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(STUB);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((b) => API.setBase(b), APIBASE);
  await page.waitForSelector('#lg-u');

  await step('登录', async () => {
    await page.fill('#lg-u', 'admin');
    await page.fill('#lg-p', 'admin123');
    await page.click('#lg-btn');
    await page.waitForSelector('#nav', { timeout: 15000 });
  });

  const nav = async (k) => {
    await page.click(`#nav a[data-k="${k}"]`);
    await page.waitForTimeout(900);
  };
  const snap = () => page.evaluate(() => {
    const s = window.__stub;
    const m = s.maps[s.maps.length - 1];
    return {
      maps: s.maps.length,
      destroys: s.destroys.slice(),
      destroyed: s.maps.filter((x) => x.destroyed).length,
      id: m && m.el ? m.el.id : null,
      connected: !!(m && m.el && m.el.isConnected),
      isCurrent: !!(m && m.el && m.el === document.getElementById(m.el.id)),
      w: m && m.el ? m.el.clientWidth : 0,
      h: m && m.el ? m.el.clientHeight : 0,
      resized: m ? m.resized : 0,
      // 地图页有 markers / tempMarker 两个点图层，取其中实际铺过点的最大值
      geoms: s.markers.filter((x) => x.kind === 'marker').reduce((m, x) => Math.max(m, x.lastLen || 0), 0),
    };
  });

  /* ---------------- 地图标注：首次进入 ---------------- */
  await nav('map');
  let s1 = await snap();
  await step('地图标注：首次进入创建实例并绑定当前容器', async () => {
    ok(s1.maps === 1, '实例数 ' + s1.maps);
    ok(s1.id === 'map', '容器 id ' + s1.id);
    ok(s1.connected && s1.isCurrent, '容器不在当前 DOM 中');
    ok(s1.w > 0 && s1.h > 0, '容器尺寸 ' + s1.w + 'x' + s1.h);
  });
  await step('地图标注：容器布局完成后校正尺寸（resize）', async () => {
    ok(s1.resized >= 1, 'resize 调用 ' + s1.resized);
  });
  await step('地图标注：点位已渲染', async () => {
    ok(s1.geoms > 0, '点位数量 ' + s1.geoms);
  });

  /* ---------------- 切走再切回 ---------------- */
  await nav('dashboard');
  await nav('map');
  let s2 = await snap();
  await step('切走后旧地图实例被销毁', async () => {
    ok(s2.destroyed >= 1, '已销毁实例 ' + s2.destroyed);
    ok(s2.destroys.indexOf('map') >= 0, '未调用 map.destroy');
  });
  await step('再次进入地图标注：重建实例并绑定新容器', async () => {
    ok(s2.maps === 2, '实例数 ' + s2.maps);
    ok(s2.id === 'map' && s2.connected && s2.isCurrent, '新实例未绑定当前容器');
    ok(s2.w > 0 && s2.h > 0, '容器尺寸 ' + s2.w + 'x' + s2.h);
    ok(s2.resized >= 1, '新实例未校正尺寸');
    ok(s2.geoms > 0, '新实例未重绘点位');
  });

  /* ---------------- 房产预览 ---------------- */
  await nav('preview');
  let s3 = await snap();
  await step('房产预览：首次进入创建实例并绑定当前容器', async () => {
    ok(s3.maps === 3, '实例数 ' + s3.maps);
    ok(s3.id === 'pv-map', '容器 id ' + s3.id);
    ok(s3.connected && s3.isCurrent, '容器不在当前 DOM 中');
    ok(s3.w > 0 && s3.h > 0, '容器尺寸 ' + s3.w + 'x' + s3.h);
    ok(s3.resized >= 1, 'resize 调用 ' + s3.resized);
    ok(s3.geoms > 0, '点位数量 ' + s3.geoms);
  });

  await nav('assets');
  await nav('preview');
  let s4 = await snap();
  await step('再次进入房产预览：销毁旧实例并重建', async () => {
    ok(s4.maps === 4, '实例数 ' + s4.maps);
    ok(s4.id === 'pv-map' && s4.connected && s4.isCurrent, '新实例未绑定当前容器');
    ok(s4.resized >= 1, '新实例未校正尺寸');
    ok(s4.geoms > 0, '新实例未重绘点位');
  });

  /* ---------------- 两个地图页来回切换 ---------------- */
  await nav('map');
  await nav('preview');
  await nav('map');
  let s5 = await snap();
  await step('两页来回切换后仍绑定正确容器', async () => {
    ok(s5.id === 'map' && s5.connected && s5.isCurrent, '容器绑定异常：' + s5.id);
    ok(s5.w > 0 && s5.h > 0, '容器尺寸 ' + s5.w + 'x' + s5.h);
    ok(s5.geoms > 0, '点位数量 ' + s5.geoms);
  });
  await step('切换过程中地图实例无泄漏（每次创建伴随销毁）', async () => {
    const st = await page.evaluate(() => ({ n: window.__stub.maps.length, d: window.__stub.maps.filter((x) => x.destroyed).length }));
    ok(st.n - st.d <= 1, `存在 ${st.n - st.d} 个未销毁实例`);
  });

  /* ---------------- 数据同步刷新 ---------------- */
  await step('切换进入后数据为服务端最新', async () => {
    const r = await page.evaluate(async () => {
      const before = MapPage.assets.length;
      const list = await API.getQ('/api/assets', { pageSize: 'all' });
      return { before, server: list.rows.length };
    });
    ok(r.before === r.server && r.before > 0, `页面 ${r.before} / 服务端 ${r.server}`);
  });

  /* ---------------- 手动刷新按钮 ---------------- */
  const resized = () => page.evaluate(() => {
    const m = window.__stub.maps[window.__stub.maps.length - 1];
    return m ? m.resized : -1;
  });
  await step('地图标注页「刷新」按钮重新拉取数据并校正地图', async () => {
    const before = await resized();
    await page.click('#mp-reload');
    await page.waitForTimeout(800);
    const after = await resized();
    ok(after > before, `resize 未增加（${before} → ${after}）`);
  });
  await nav('preview');
  await step('房产预览页「刷新」按钮重新拉取数据并校正地图', async () => {
    const before = await resized();
    await page.click('#pv-reload');
    await page.waitForTimeout(800);
    const after = await resized();
    ok(after > before, `resize 未增加（${before} → ${after}）`);
  });

  await page.screenshot({ path: path.join(SHOT, 'map-switch.png') });

  await step('无控制台报错', async () => {
    const real = errs.filter((e) => !/favicon|net::ERR_/.test(e));
    ok(real.length === 0, real.slice(0, 3).join(' | '));
  });

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})();
