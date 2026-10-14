'use strict';
/**
 * 二次确认弹窗回归测试：
 * 点「取消」必须不执行，点「确定」必须执行（历史 bug：点确定也返回 false，导致删除等操作静默失效）
 */
const { chromium } = require('playwright-core');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PREVIEW = process.env.PREVIEW || 'http://127.0.0.1:2991/static-html/cb924f07fdfc463b/index.html';
const APIBASE = process.env.APIBASE || 'http://127.0.0.1:8789';
const SHOT = path.join(__dirname, '..', 'data', 'shots');
const errs = [];

async function step(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' —— ' + e.message); process.exitCode = 1; }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));

  const NAME = '二次确认回归测试资产-' + Date.now().toString().slice(-6);
  let tempId = null;

  await page.goto(PREVIEW, { waitUntil: 'domcontentloaded' });
  await page.evaluate((b) => API.setBase(b), APIBASE);
  await page.waitForSelector('#lg-u');
  await page.fill('#lg-u', 'admin');
  await page.fill('#lg-p', 'admin123');
  await page.click('#lg-btn');
  await page.waitForSelector('#nav', { timeout: 15000 });

  await step('准备一条临时资产', async () => {
    const r = await page.evaluate(async (nm) => API.post('/api/assets', {
      unit: '国家税务总局重庆市江北区税务局', name: nm, assetNo: 'TEST-' + Date.now(),
      category: '办公用房', useStatus: '自用', area: 66.66, originalValue: 12345,
      location: '重庆市江北区测试路1号',
    }), NAME);
    tempId = (r.asset || r.row || {}).id;
    if (!tempId) throw new Error('创建失败: ' + JSON.stringify(r).slice(0, 120));
    console.log('    id =', tempId);
  });

  await step('列表页检索到该资产', async () => {
    await page.click('#nav a[data-k="assets"]');
    await page.waitForTimeout(1200);
    await page.fill('.toolbar .search .inp', NAME);
    await page.waitForTimeout(1400);
    const n = await page.evaluate(() => document.querySelectorAll('.tbl tbody tr').length);
    console.log('    命中行数:', n);
    if (n !== 1) throw new Error('未检索到唯一记录（' + n + '）');
  });

  await step('点「删除」后选「取消」——记录必须保留', async () => {
    await page.click('.act [data-act="del"]');
    await page.waitForSelector('.mask .dlg-f .btn.pri', { timeout: 8000 });
    const txt = await page.textContent('.mask .dlg-b');
    if (txt.indexOf('确定删除') < 0) throw new Error('确认文案不符: ' + txt.slice(0, 40));
    await page.click('.mask .dlg-f .btn:not(.pri)'); // 取消
    await page.waitForTimeout(900);
    const still = await page.evaluate(async (id) => {
      try { await API.get('/api/assets/' + id); return true; } catch (e) { return false; }
    }, tempId);
    console.log('    记录仍在:', still);
    if (!still) throw new Error('取消却仍然删除了记录');
  });

  await step('点「删除」后选「确定」——记录必须被删除', async () => {
    await page.click('.act [data-act="del"]');
    await page.waitForSelector('.mask .dlg-f .btn.pri', { timeout: 8000 });
    await page.click('.mask .dlg-f .btn.pri'); // 确定
    await page.waitForTimeout(1400);
    const gone = await page.evaluate(async (id) => {
      try { await API.get('/api/assets/' + id); return false; } catch (e) { return true; }
    }, tempId);
    console.log('    记录已消失:', gone);
    if (!gone) throw new Error('点了确定却没有删除');
  });

  await step('批量删除确认同样生效', async () => {
    const r = await page.evaluate(async () => API.post('/api/assets', {
      unit: '国家税务总局重庆市江北区税务局', name: '批量删除回归测试资产', assetNo: 'TESTB-' + Date.now(),
      category: '办公用房', useStatus: '自用', area: 1,
    }));
    const id = (r.asset || r.row || {}).id;
    await page.fill('.toolbar .search .inp', '批量删除回归测试资产');
    await page.waitForTimeout(1400);
    await page.click('.tbl tbody tr .ck');
    await page.waitForTimeout(400);
    await page.click('.pager .btn.danger');
    await page.waitForSelector('.mask .dlg-f .btn.pri', { timeout: 8000 });
    await page.click('.mask .dlg-f .btn.pri');
    await page.waitForTimeout(1400);
    const gone = await page.evaluate(async (aid) => {
      try { await API.get('/api/assets/' + aid); return false; } catch (e) { return true; }
    }, id);
    if (!gone) throw new Error('批量删除未生效');
  });

  await page.screenshot({ path: path.join(SHOT, '36-confirm.png') });
  await browser.close();
  console.log('\n控制台错误:', errs.length ? errs.slice(0, 6).join(' | ') : '（无）');
  console.log(process.exitCode ? '存在失败用例' : '全部通过');
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
