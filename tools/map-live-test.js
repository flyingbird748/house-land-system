'use strict';
/** 在预览环境（代理可用）中验证地图底图与标注交互是否真正可用 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PREVIEW = process.env.PREVIEW || '';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

(async () => {
  if (!PREVIEW) { console.error('请通过 PREVIEW 环境变量传入预览地址'); process.exit(1); }
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  const tmapCalls = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('_TMapService') || u.includes('map.qq.com')) tmapCalls.push(r.status() + ' ' + u.slice(0, 110));
  });

  console.log('== 地图实环境验证 ==');
  await page.goto(PREVIEW, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#lg-u', { timeout: 15000 });
  await page.fill('#lg-u', 'admin');
  await page.fill('#lg-p', 'admin123');
  await page.click('#lg-btn');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  console.log('  登录成功');

  // 先给两条资产写入坐标，验证点位渲染
  await page.evaluate(async () => {
    const tk = localStorage.getItem('token');
    const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk };
    const list = await (await fetch('http://127.0.0.1:8789/api/assets?pageSize=3', { headers: h })).json();
    const pts = [[106.5773, 29.5912], [106.5320, 29.5760], [106.5510, 29.6110]];
    for (let i = 0; i < list.rows.length; i++) {
      await fetch('http://127.0.0.1:8789/api/assets/' + list.rows[i].id + '/geo', {
        method: 'PUT', headers: h,
        body: JSON.stringify({ lng: pts[i][0], lat: pts[i][1], address: '重庆市江北区测试标注点' }),
      });
    }
    return list.rows.length;
  });
  console.log('  已写入测试坐标');

  await page.click('#nav a[data-k="map"]');
  await page.waitForSelector('#map', { timeout: 15000 });
  await page.waitForTimeout(7000);

  const info = await page.evaluate(() => {
    const box = document.getElementById('map');
    const cv = box ? box.querySelector('canvas') : null;
    return {
      hasTMap: !!window.TMap,
      canvasCount: box ? box.querySelectorAll('canvas').length : 0,
      canvasSize: cv ? cv.width + 'x' + cv.height : '(无 canvas)',
      markerGeoms: MapPage.markers ? MapPage.markers.getGeometries().length : -1,
      keyBoxShown: (document.getElementById('mp-keybox') || {}).style?.display !== 'none',
      hint: (document.getElementById('mp-hint') || {}).textContent || '',
      webgl: (() => { try { return !!document.createElement('canvas').getContext('webgl'); } catch (e) { return false; } })(),
    };
  });
  console.log('  状态:', JSON.stringify(info));
  console.log('  地图相关请求:');
  tmapCalls.slice(0, 8).forEach((c) => console.log('     ', c));

  await page.screenshot({ path: path.join(SHOT, '20-map-live.png') });

  // 点击左侧第一条资产 → 在地图上点击落点 → 确认框
  await page.click('#mp-lst .it');
  await page.waitForTimeout(1200);
  const rect = await page.$eval('#map', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(rect.x + rect.w * 0.45, rect.y + rect.h * 0.5);
  await page.waitForTimeout(2500);
  const dlgTitle = await page.$eval('.dlg .dlg-h h3', (e) => e.textContent.trim()).catch(() => '(无弹窗)');
  console.log('  点击地图后弹窗:', dlgTitle);
  await page.screenshot({ path: path.join(SHOT, '21-map-mark.png') });

  if (dlgTitle === '确认标注位置') {
    await page.click('.dlg-f .btn.pri');
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => MapPage.markers.getGeometries().length);
    console.log('  保存后地图点位数量:', after);
    await page.screenshot({ path: path.join(SHOT, '22-map-marked.png') });
  }

  // 信息窗（自定义 HTML）是否真的渲染出来且按钮可点
  const iw = await page.evaluate(() => new Promise((res) => {
    const a = MapPage.assets.find((x) => Number.isFinite(x.lng) && Number.isFinite(x.lat));
    MapPage.showInfo(a);
    setTimeout(() => {
      const box = document.querySelector('.tmap-infowindow .iw') || document.querySelector('.iw');
      const btns = box ? box.querySelectorAll('button') : [];
      res({
        found: !!box,
        lines: box ? box.textContent.replace(/\s+/g, ' ').trim().slice(0, 70) : '',
        buttons: btns.length,
        inlineHandler: btns[0] ? (btns[0].getAttribute('onclick') || '(无)') : '',
      });
    }, 900);
  }));
  console.log('  信息窗:', JSON.stringify(iw));
  await page.screenshot({ path: path.join(SHOT, '23-infowindow.png') });

  const before = await page.locator('.dlg').count();
  await page.click('.iw button:has-text("资料")', { timeout: 5000 }).catch((e) => console.log('  点击信息窗按钮失败:', e.message.split('\n')[0]));
  await page.waitForTimeout(900);
  const after = await page.locator('.dlg').count();
  console.log('  点击「资料」按钮后弹窗数:', before, '->', after);
  const title = await page.$eval('.dlg .dlg-h h3', (e) => e.textContent.trim()).catch(() => '(无)');
  console.log('  弹窗标题:', title);
  await page.screenshot({ path: path.join(SHOT, '24-iw-action.png') });

  await browser.close();
  const real = errs.filter((e) => !/fileupdate|favicon|404/.test(e));
  console.log('  页面错误:', real.length ? real.slice(0, 5).join(' | ') : '（无）');
  console.log('  全部控制台消息:', errs.slice(0, 6).join(' | ') || '（无）');
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
