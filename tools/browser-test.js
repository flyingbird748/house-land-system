'use strict';
/** 浏览器端冒烟：用本机 Chrome 跑一遍主要页面，收集控制台错误并截图 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8789';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

const errors = [];
const logs = [];

(async () => {
  if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on('console', (m) => {
    const t = m.text();
    logs.push(m.type() + ': ' + t);
    if (m.type() === 'error') errors.push('[console] ' + t);
  });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.startsWith(BASE)) errors.push('[requestfailed] ' + u + ' ' + (r.failure() || {}).errorText);
  });

  const step = async (name, fn) => {
    const before = errors.length;
    await fn();
    const n = errors.length - before;
    console.log(`  ${n ? 'FAIL' : ' OK '}  ${name}${n ? ' — 新增错误 ' + n : ''}`);
  };

  console.log('== 浏览器冒烟 ==');

  await step('打开登录页', async () => {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#lg-u', { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOT, '01-login.png') });
  });

  await step('管理员登录', async () => {
    await page.fill('#lg-u', 'admin');
    await page.fill('#lg-p', 'admin123');
    await page.click('#lg-btn');
    await page.waitForSelector('.sidebar', { timeout: 10000 });
  });

  await step('数据看板渲染', async () => {
    await page.click('#nav a[data-k="dashboard"]');
    await page.waitForSelector('.kpis .kpi', { timeout: 10000 });
    await page.waitForTimeout(900);
    const n = await page.$$eval('.kpi .vl', (els) => els.map((e) => e.textContent.trim()));
    console.log('        KPI:', n.join(' | '));
    const charts = await page.$$eval('svg', (els) => els.length);
    console.log('        SVG 图表数:', charts);
    await page.screenshot({ path: path.join(SHOT, '02-dashboard.png'), fullPage: false });
  });

  await step('资产台账列表', async () => {
    await page.click('#nav a[data-k="assets"]');
    await page.waitForSelector('table.tbl tbody tr', { timeout: 10000 });
    const cnt = await page.$$eval('table.tbl tbody tr', (e) => e.length);
    console.log('        首页行数:', cnt);
    await page.screenshot({ path: path.join(SHOT, '03-list.png') });
  });

  await step('关键字搜索', async () => {
    await page.fill('.toolbar .search .inp', '车库');
    await page.waitForTimeout(600);
    const total = await page.$eval('.pager .info', (e) => e.textContent.trim());
    console.log('        搜索结果:', total);
  });

  await step('打开资产详情', async () => {
    await page.click('table.tbl tbody tr .link[data-act="view"]');
    await page.waitForSelector('.dlg .sec-title', { timeout: 6000 });
    await page.screenshot({ path: path.join(SHOT, '04-detail.png') });
    await page.click('.dlg-f .btn');
  });

  await step('打开编辑表单', async () => {
    await page.click('table.tbl tbody tr .link[data-act="edit"]');
    await page.waitForSelector('.dlg .tabs .tb', { timeout: 6000 });
    const tabs = await page.$$eval('.dlg .tabs .tb', (e) => e.map((x) => x.textContent.trim()));
    console.log('        表单分组:', tabs.join(' / '));
    await page.click('.dlg .tabs .tb:nth-child(2)');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOT, '05-form.png') });
    await page.click('.dlg-f .btn');
    await page.waitForTimeout(200);
  });

  await step('地图页（无代理时应提示配置）', async () => {
    await page.click('#nav a[data-k="map"]');
    await page.waitForSelector('.map-page', { timeout: 8000 });
    await page.waitForTimeout(1200);
    const stat = await page.$eval('#mp-stat', (e) => e.textContent.trim()).catch(() => '(无)');
    console.log('        侧栏统计:', stat);
    await page.screenshot({ path: path.join(SHOT, '06-map.png') });
  });

  await step('Excel 导入页', async () => {
    await page.click('#nav a[data-k="import"]');
    await page.waitForSelector('#drop', { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOT, '07-import.png') });
  });

  await step('Excel 导入（真实文件全流程）', async () => {
    await page.setInputFiles('#file', 'C:\\Users\\Rain_Drop\\Desktop\\房产土地统计表（江北-测试）.xlsx');
    await page.waitForSelector('#tp-map .map-tbl', { timeout: 25000 });
    const info = await page.$eval('#imp-2 .card-h span.muted', (e) => e.textContent.trim());
    console.log('        解析信息:', info.replace(/\s+/g, ' '));
    await page.screenshot({ path: path.join(SHOT, '11-import-preview.png') });
    await page.click('.tabs .tb[data-t="pv"]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOT, '12-import-data.png') });
    await page.click('#im-go');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#im-res');
        return !!el && el.textContent.indexOf('导入完成') >= 0;
      },
      null,
      { timeout: 40000 }
    );
    const res = await page.$eval('#im-res', (e) => e.textContent.trim());
    console.log('        结果:', res.replace(/\s+/g, ' '));
    await page.screenshot({ path: path.join(SHOT, '13-import-done.png') });
  });

  await step('导出 Excel', async () => {
    await page.click('#nav a[data-k="assets"]');
    await page.waitForSelector('.pager .btn', { timeout: 8000 });
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.click('.pager .btn'),
    ]);
    const p = await dl.path();
    const size = fs.statSync(p).size;
    const buf = fs.readFileSync(p);
    const parsed = require('../server/lib/xlsx.js').parseXlsx(buf);
    const rows = parsed.sheets[parsed.sheetNames[0]];
    console.log(`        下载 ${path.basename(p)}  ${size} bytes  工作表「${parsed.sheetNames[0]}」${rows.length} 行 x ${rows[0].length} 列`);
    console.log('        首行首列:', rows[0].slice(0, 3).join(' / '), '| 数据行:', String(rows[1][1]).slice(0, 20));
    fs.copyFileSync(p, path.join(SHOT, 'export.xlsx'));
  });

  await step('用户管理', async () => {
    await page.click('#nav a[data-k="users"]');
    // 先等新页面骨架出现再数行：否则会数到上一页残留的表格（竞态会显示 0 行）
    await page.waitForFunction(() => (document.querySelector('#content h3') || {}).textContent === '系统用户', null, { timeout: 8000 });
    await page.waitForSelector('table.tbl tbody tr', { timeout: 8000 });
    const n = await page.$$eval('table.tbl tbody tr', (e) => e.length);
    console.log('        用户数:', n);
    if (!n) throw new Error('用户表渲染出 0 行');
    await page.screenshot({ path: path.join(SHOT, '08-users.png') });
  });

  await step('单位管理', async () => {
    await page.click('#nav a[data-k="units"]');
    await page.waitForSelector('table.tbl tbody tr', { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOT, '09-units.png') });
  });

  await step('操作日志', async () => {
    await page.click('#nav a[data-k="logs"]');
    await page.waitForSelector('table.tbl tbody tr', { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOT, '10-logs.png') });
  });

  await step('退出登录', async () => {
    await page.click('#um-btn');
    await page.click('#mi-out');
    await page.waitForSelector('#lg-u', { timeout: 6000 });
  });

  await browser.close();

  console.log('\n控制台错误数:', errors.length);
  errors.slice(0, 20).forEach((e) => console.log('   ', e));
  fs.writeFileSync(path.join(SHOT, 'console.log'), logs.join('\n'), 'utf8');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
