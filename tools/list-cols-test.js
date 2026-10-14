'use strict';
/* 资产台账「列设置 / 全字段显示」端到端验证 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8789/';
const SHOT = path.join(__dirname, '..', 'data', 'shots');
const DB = path.join(__dirname, '..', 'data', 'db.json');

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + ' —— ' + e.message); fail++; }
}

(async () => {
  if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 960 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#lg-u');
  await page.fill('#lg-u', 'admin');
  await page.fill('#lg-p', 'admin123');
  await page.click('#lg-btn');
  await page.waitForSelector('#nav', { timeout: 15000 });
  await page.click('#nav a[data-k="assets"]');
  await page.waitForSelector('table.tbl tbody tr', { timeout: 15000 });
  await page.waitForTimeout(600);

  // ---------- 1. 默认列数 = 源表全字段 ----------
  let cols = [];
  await step('默认展示源表全部字段', async () => {
    cols = await page.evaluate(() => [...document.querySelectorAll('table.tbl thead th')].map((t) => t.textContent.replace(/[⇅▲▼]/g, '').trim()));
    const real = cols.filter((t) => t !== '操作' && t !== '');
    console.log('    列数(含选择框/操作): ' + cols.length + '，字段列: ' + real.length);
    console.log('    表头: ' + real.join(' | '));
    if (real.length < 37) throw new Error('字段列只有 ' + real.length + ' 个，源表应有 37 个');
    for (const must of ['行次', '资产名称', '所属单位', '坐落位置', '产权面积(㎡)', '原值(元)', '产权证号', '房龄(年)', '备注']) {
      if (real.indexOf(must) < 0) throw new Error('缺少列: ' + must);
    }
  });

  await page.screenshot({ path: path.join(SHOT, '40-list-allcols.png') });

  // ---------- 2. 单元格内容与源数据一致 ----------
  await step('表格数值与数据库一致（抽查前 5 行）', async () => {
    const rows = await page.evaluate(() => [...document.querySelectorAll('table.tbl tbody tr')].slice(0, 5).map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())));
    const src = db.assets.slice(0, 5);
    let ok = 0, bad = [];
    src.forEach((a, i) => {
      const txt = rows[i].join(' | ');
      const nameHit = txt.indexOf(String(a.name).slice(0, 8)) >= 0;
      const noHit = txt.indexOf(String(a.assetNo)) >= 0;
      const areaHit = txt.indexOf(String(a.area)) >= 0 || txt.indexOf(String(a.area).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) >= 0;
      if (nameHit && noHit && areaHit) ok++; else bad.push(a.name.slice(0, 12) + ' name=' + nameHit + ' no=' + noHit + ' area=' + areaHit);
    });
    if (ok !== src.length) throw new Error('不一致: ' + bad.join('; '));
    console.log('    ' + ok + '/' + src.length + ' 行数据一致（名称/编号/面积）');
  });

  // ---------- 3. 冻结列 ----------
  await step('横向滚动后资产名称列保持冻结', async () => {
    const before = await page.evaluate(() => {
      const th = [...document.querySelectorAll('table.tbl thead th')].find((t) => t.textContent.includes('资产名称'));
      return th.getBoundingClientRect().x;
    });
    await page.evaluate(() => { document.querySelector('.tbl-wrap.lst').scrollLeft = 900; });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const th = [...document.querySelectorAll('table.tbl thead th')].find((t) => t.textContent.includes('资产名称'));
      return { x: th.getBoundingClientRect().x, sl: document.querySelector('.tbl-wrap.lst').scrollLeft };
    });
    console.log('    滚动 ' + after.sl + 'px 前/后 x = ' + Math.round(before) + ' / ' + Math.round(after.x));
    if (after.sl < 100) throw new Error('表格未产生横向滚动');
    if (Math.abs(after.x - before) > 2) throw new Error('名称列未冻结，位移 ' + Math.round(after.x - before) + 'px');
  });

  await page.screenshot({ path: path.join(SHOT, '41-list-scrolled.png') });
  await page.evaluate(() => { document.querySelector('.tbl-wrap.lst').scrollLeft = 0; });

  // ---------- 4. 列设置：全部字段 ----------
  await step('列设置可切到「全部字段」', async () => {
    await page.click('.toolbar .btn:has-text("列设置")');
    await page.waitForSelector('.colpick', { timeout: 8000 });
    const n0 = await page.evaluate(() => document.querySelectorAll('.colpick .ci input:checked').length);
    await page.click('.colpick [data-p="all"]');
    await page.waitForTimeout(200);
    const n1 = await page.evaluate(() => document.querySelectorAll('.colpick .ci input:checked').length);
    console.log('    默认勾选 ' + n0 + ' → 全部字段 ' + n1);
    await page.screenshot({ path: path.join(SHOT, '42-colpick.png') });
    await page.click('.colpick ~ .dlg-f .btn.pri, .dlg-f .btn.pri');
    await page.waitForTimeout(900);
    const cnt = await page.evaluate(() => document.querySelectorAll('table.tbl thead th').length);
    console.log('    应用后表头列数: ' + cnt);
    if (n1 <= n0) throw new Error('全选未生效');
    if (cnt !== n1 + 2) throw new Error('表头列数 ' + cnt + ' 与勾选数 ' + n1 + ' 不符（应 +2）');
  });

  await page.screenshot({ path: path.join(SHOT, '43-list-fullcols.png') });

  await step('全部字段下含经度/纬度/创建时间', async () => {
    const hs = await page.evaluate(() => [...document.querySelectorAll('table.tbl thead th')].map((t) => t.textContent.replace(/[⇅▲▼]/g, '').trim()));
    for (const must of ['经度', '纬度', '创建时间', '标注地址']) {
      if (hs.indexOf(must) < 0) throw new Error('缺少 ' + must);
    }
    const firstLng = await page.evaluate(() => {
      const i = [...document.querySelectorAll('table.tbl thead th')].findIndex((t) => t.textContent.includes('经度'));
      return document.querySelector('table.tbl tbody tr').children[i].textContent.trim();
    });
    console.log('    首行经度: ' + firstLng);
    if (!/\d+\.\d+/.test(firstLng)) throw new Error('经度未渲染为数值');
  });

  // ---------- 5. 核心视图 + 记忆 ----------
  await step('切到「核心视图」并记住选择', async () => {
    await page.click('.toolbar .btn:has-text("列设置")');
    await page.waitForSelector('.colpick', { timeout: 8000 });
    await page.click('.colpick [data-p="core"]');
    await page.waitForTimeout(200);
    await page.click('.dlg-f .btn.pri');
    await page.waitForTimeout(900);
    const cnt = await page.evaluate(() => document.querySelectorAll('table.tbl thead th').length);
    console.log('    核心视图列数(含选择框/操作): ' + cnt);
    if (cnt !== 12) throw new Error('核心视图应为 10 字段 + 2，实际 ' + cnt);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('table.tbl tbody tr', { timeout: 15000 });
    await page.waitForTimeout(600);
    const cnt2 = await page.evaluate(() => document.querySelectorAll('table.tbl thead th').length);
    if (cnt2 !== cnt) throw new Error('刷新后未记住列选择: ' + cnt2);
    console.log('    刷新后仍为 ' + cnt2 + ' 列（已持久化）');
  });

  await page.screenshot({ path: path.join(SHOT, '44-list-core.png') });

  // ---------- 6. 恢复默认（源表全字段）供用户使用 ----------
  await step('恢复为源表全字段', async () => {
    await page.click('.toolbar .btn:has-text("列设置")');
    await page.waitForSelector('.colpick', { timeout: 8000 });
    await page.click('.colpick [data-p="src"]');
    await page.waitForTimeout(200);
    await page.click('.dlg-f .btn.pri');
    await page.waitForTimeout(900);
    const cnt = await page.evaluate(() => document.querySelectorAll('table.tbl thead th').length);
    console.log('    恢复后列数: ' + cnt);
  });

  // ---------- 7. 筛选与排序仍可用 ----------
  await step('全字段下列表筛选仍生效', async () => {
    await page.fill('.toolbar .search .inp', '车库');
    await page.waitForTimeout(900);
    const n = await page.evaluate(() => document.querySelectorAll('table.tbl tbody tr').length);
    const total = await page.evaluate(() => document.querySelector('.pager .info').textContent.trim());
    console.log('    搜索「车库」→ ' + total);
    if (!n) throw new Error('筛选结果为空');
    await page.fill('.toolbar .search .inp', '');
    await page.waitForTimeout(900);
  });

  await page.screenshot({ path: path.join(SHOT, '45-list-final.png') });

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('控制台错误: ' + (errs.length ? errs.slice(0, 5).join(' | ') : '（无）'));
  process.exit(fail || errs.length ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
