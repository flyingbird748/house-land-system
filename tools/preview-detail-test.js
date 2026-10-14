'use strict';
/**
 * 房产预览：点击点位打开详情时，「简要信息浮卡」必须让位给「详细信息弹窗」，
 * 二者不得重叠显示；弹窗关闭后悬停预览要能恢复。
 *
 * 运行：node tools/preview-detail-test.js   （需后端 http://127.0.0.1:8789 已启动）
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

const tipState = (page) => page.evaluate(() => {
  const tip = document.getElementById('pv-tip');
  if (!tip) return { exists: false };
  const cs = getComputedStyle(tip);
  return {
    exists: true,
    display: tip.style.display || cs.display,
    on: tip.classList.contains('on'),
    z: parseInt(cs.zIndex || '0', 10),
  };
});
const maskState = (page) => page.evaluate(() => {
  const m = document.querySelector('.mask');
  if (!m) return { exists: false };
  return { exists: true, z: parseInt(getComputedStyle(m).zIndex || '0', 10), title: (m.querySelector('h3') || {}).textContent || '' };
});

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(STUB);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((b) => API.setBase(b), APIBASE);
  await page.waitForSelector('#lg-u');

  await step('登录并进入房产预览', async () => {
    await page.fill('#lg-u', 'admin');
    await page.fill('#lg-p', 'admin123');
    await page.click('#lg-btn');
    await page.waitForSelector('#nav', { timeout: 15000 });
    await page.click('#nav a[data-k="preview"]');
    await page.waitForTimeout(1200);
    ok(await page.evaluate(() => !!PreviewPage.markers), '地图未初始化');
  });

  let firstId = null;
  await step('悬停列表项 → 显示简要信息浮卡', async () => {
    firstId = await page.evaluate(() => (PreviewPage.filtered()[0] || {}).id);
    ok(!!firstId, '没有已标注资产');
    await page.hover('#pv-lst .it');
    await page.waitForTimeout(350);
    const t = await tipState(page);
    ok(t.exists && t.display !== 'none', '浮卡未显示：' + JSON.stringify(t));
  });

  await step('点击点位（SDK click 事件）→ 打开详细信息弹窗', async () => {
    await page.evaluate((id) => {
      PreviewPage.markers.emit('click', { geometry: { id } });
    }, firstId);
    await page.waitForTimeout(400);
    const m = await maskState(page);
    ok(m.exists, '详情弹窗未打开');
  });

  await step('详情打开后简要信息浮卡必须隐藏（不重叠）', async () => {
    const t = await tipState(page);
    ok(t.display === 'none', '浮卡仍显示：' + JSON.stringify(t));
    ok(!t.on, '浮卡仍处于激活态');
  });

  await step('浮卡层级必须低于弹窗遮罩', async () => {
    const t = await tipState(page);
    const m = await maskState(page);
    ok(m.exists && t.z < m.z, `浮卡 z=${t.z} 未低于遮罩 z=${m.z}`);
  });

  await step('详情打开期间鼠标移动不再弹出浮卡', async () => {
    const box = await page.evaluate(() => {
      const s = document.getElementById('pv-stage').getBoundingClientRect();
      return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.move(box.x + 6, box.y + 4);
    await page.waitForTimeout(400);
    const t = await tipState(page);
    ok(t.display === 'none', '浮卡又被触发：' + JSON.stringify(t));
    ok(await page.evaluate(() => PreviewPage.detailOpen === true), 'detailOpen 标志未置位');
  });

  await page.screenshot({ path: path.join(SHOT, 'pv-detail-open.png') });

  await step('关闭详情弹窗后恢复悬停预览', async () => {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.mask .dlg-f .btn')];
      const b = btns.find((x) => x.textContent.trim() === '关闭') || btns[btns.length - 1];
      b.click();
    });
    await page.waitForTimeout(400);
    ok(!(await maskState(page)).exists, '弹窗未关闭');
    ok(await page.evaluate(() => PreviewPage.detailOpen === false), 'detailOpen 未复位');
    await page.hover('#pv-lst .it');
    await page.waitForTimeout(350);
    const t = await tipState(page);
    ok(t.display !== 'none', '浮卡未恢复：' + JSON.stringify(t));
  });

  await step('列表点击定位（focus）仍可显示浮卡', async () => {
    await page.click('#pv-lst .it');
    await page.waitForTimeout(350);
    const t = await tipState(page);
    ok(t.display !== 'none', '浮卡未显示：' + JSON.stringify(t));
    ok(!(await maskState(page)).exists, '列表点击不应打开详情弹窗');
  });

  await step('无控制台报错', async () => {
    const real = errs.filter((e) => !/favicon|net::ERR_/.test(e));
    ok(real.length === 0, real.slice(0, 3).join(' | '));
  });

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})();
