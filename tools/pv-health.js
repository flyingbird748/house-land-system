'use strict';
/* 房产预览页健康检查（本地服务，不含地图代理） */
const { chromium } = require('playwright-core');
const CHROME = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8789/';
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 960 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#lg-u');
  await page.fill('#lg-u','admin'); await page.fill('#lg-p','admin123'); await page.click('#lg-btn');
  await page.waitForSelector('#nav',{timeout:15000});
  await page.click('#nav a[data-k="preview"]');
  await page.waitForTimeout(3500);
  const r = await page.evaluate(() => ({
    pageObj: typeof PreviewPage,
    assets: PreviewPage && PreviewPage.assets ? PreviewPage.assets.length : -1,
    filtered: PreviewPage && PreviewPage.filtered ? PreviewPage.filtered().length : -1,
    chips: document.querySelectorAll('#pv-cats .chip').length,
    listItems: document.querySelectorAll('#pv-lst .it').length,
    stage: !!document.getElementById('pv-stage'),
    tip: !!document.getElementById('pv-tip'),
    keybox: (() => { const k = document.getElementById('mp-keybox'); return k ? getComputedStyle(k).display : 'n/a'; })(),
    top: (document.querySelector('#pv-top') || {}).textContent || '',
  }));
  console.log('PreviewPage:', r.pageObj, '| 资产:', r.assets, '| 筛选后:', r.filtered);
  console.log('筛选芯片:', r.chips, '| 列表项:', r.listItems, '| 地图容器:', r.stage, '| 浮卡节点:', r.tip);
  console.log('顶栏:', r.top.replace(/\s+/g,' ').trim().slice(0, 120));
  await page.screenshot({ path: require('path').join(__dirname,'..','data','shots','46-preview-health.png') });
  await browser.close();
  console.log('页面异常:', errs.length ? errs.slice(0,3).join(' | ') : '（无）');
  if (errs.length || r.pageObj !== 'object' || r.assets <= 0 || !r.chips || !r.listItems) { console.log('结果: 未通过'); process.exit(1); }
  console.log('结果: 通过');
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
