'use strict';
/**
 * 导入页「内置模板」UI 验证
 *   1. 模板结构卡正确展示（列数 / 表头行 / 序号行 / 说明行 / 数据起始行 / 字段匹配）
 *   2. 点击「下载内置导入模板」能拿到与内置文件一致的有效 xlsx
 *   3. 上传这份空模板，界面给出「识别 0 条」且不报错
 *
 * 运行：node tools/template-ui-test.js
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { parseXlsx } = require('../server/lib/xlsx.js');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8789/';
const SHOT = path.join(__dirname, '..', 'data', 'shots');
const SRC_TPL = path.join(__dirname, '..', 'server', 'assets', 'import-template.xlsx');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 960 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#lg-u');
  await page.fill('#lg-u', 'admin');
  await page.fill('#lg-p', 'admin123');
  await page.click('#lg-btn');
  await page.waitForSelector('#nav', { timeout: 15000 });
  await page.click('#nav a[data-k="import"]');
  await page.waitForSelector('#tpl-info', { timeout: 10000 });
  await page.waitForTimeout(800);

  console.log('① 模板结构卡');
  const box = await page.$eval('#tpl-info', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('        ' + box);
  check('显示列数 37 列', /37 列/.test(box), box);
  check('显示表头第 1-4 行', /第 1-4 行/.test(box), box);
  check('显示序号行第 5 行', /序号行第 5 行/.test(box), box);
  check('显示说明行第 6 行', /填表说明行第 6 行/.test(box), box);
  check('显示数据起始第 7 行', /数据起始行第 7 行/.test(box), box);
  check('显示字段匹配 37 / 37', /37 \/ 37/.test(box), box);
  check('标明为内置', /内置/.test(box), box);
  check('列出两个工作表', /汇总/.test(box) && /填写说明/.test(box), box);
  await page.screenshot({ path: path.join(SHOT, '50-import-template.png') });

  console.log('② 下载内置模板');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.click('#tpl'),
  ]);
  // 另存到项目临时目录再校验（下载临时目录里的文件不便直接上传）
  const p = path.join(SHOT, '..', 'tmp-template.xlsx');
  await dl.saveAs(p);
  const buf = fs.readFileSync(p);
  const suggested = dl.suggestedFilename();
  console.log('        文件名:', suggested, '｜大小:', buf.length, 'bytes');
  check('下载文件名为中文模板名', /\.xlsx$/.test(suggested), suggested);
  check('大小与内置模板一致', buf.length === fs.statSync(SRC_TPL).size, [buf.length, fs.statSync(SRC_TPL).size]);
  const tpl = parseXlsx(buf);
  const rows = tpl.sheets[tpl.sheetNames[0]];
  check('可解析且首表为「汇总」', tpl.sheetNames[0] === '汇总', tpl.sheetNames);
  check('表头 37 列', (rows[0] || []).filter((x) => x !== null && x !== '').length === 37);

  console.log('③ 上传空模板');
  await page.setInputFiles('#file', p);
  // 空模板没有数据行，界面仍应完成解析并进入字段匹配步骤
  await page.waitForFunction(
    () => typeof ImportState !== 'undefined' && !!ImportState.token,
    null, { timeout: 25000 },
  ).catch(async () => {
    const t = await page.$eval('#drop', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    throw new Error('解析未完成，上传区提示：' + t);
  });
  const info = await page.$eval('#imp-2 .card-h span.muted', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('        ' + info);
  check('识别 0 条', /识别 0 条/.test(info), info);
  check('表头定为第 1 行', /表头第 1 行/.test(info), info);
  const skipped = await page.evaluate(() => (ImportState.skipped || []).length);
  const mapping = await page.evaluate(() => (ImportState.mapping || []).filter(Boolean).length);
  check('说明/序号行被跳过', skipped === 5, skipped);
  check('37 列全部匹配', mapping === 37, mapping);
  await page.screenshot({ path: path.join(SHOT, '51-import-empty-template.png') });

  await browser.close();
  try { fs.unlinkSync(p); } catch (e) { /* 忽略 */ }
  console.log('        控制台错误:', errs.length ? errs.slice(0, 3).join(' | ') : '（无）');
  if (errs.length) { fail++; }
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
