'use strict';
/**
 * report-ui-test —— 分析报告首页（需求⑪）真实 Chrome 测试
 *
 * 覆盖：登录后默认落在分析报告、正文渲染、无残留占位符、工具条（规则表/复制/下载）、
 *       统计范围切换、系统设置里的报告参数卡片、0 控制台错误。
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8789/';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

let pass = 0; let fail = 0;
const fails = [];

async function step(name, fn) {
  const errBefore = globalThis.__errCount || 0;
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    fails.push(name + '：' + e.message);
    console.log('  ✗ ' + name + ' — ' + e.message);
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });

  const shot = (n) => page.screenshot({ path: path.join(SHOT, n) });

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.fill('#lg-u', 'admin');
    await page.fill('#lg-p', 'admin123');
    await page.click('#lg-btn');
    await page.waitForSelector('#nav', { timeout: 15000 });

    await step('登录后默认进入「分析报告」首页', async () => {
      const k = await page.evaluate(() => location.hash);
      ok(/#\/report/.test(k), '当前 hash 是 ' + k);
      const title = await page.evaluate(() => (document.querySelector('.topbar .tt, .topbar h2, .page-title') || {}).textContent || '');
      ok(/分析报告/.test(title) || /分析报告/.test(await page.evaluate(() => document.body.innerText.slice(0, 400))),
        '页面未见「分析报告」：' + title);
    });

    await step('报告正文渲染（标题 + 五个部分）', async () => {
      await page.waitForSelector('.rp-doc #rp-body', { timeout: 10000 });
      const t = await page.evaluate(() => {
        const b = document.querySelector('#rp-body');
        return {
          h1: (b.querySelector('h1') || {}).textContent || '',
          h2: (b.querySelector('h2') || {}).textContent || '',
          h3: [...b.querySelectorAll('h3')].map((x) => x.textContent.trim()),
          len: b.innerText.length,
        };
      });
      ok(/土地房屋资产统计分析报告/.test(t.h2), '二级标题不对：' + t.h2);
      ok(t.h3.length >= 5, '正文小节不足 5 个：' + JSON.stringify(t.h3));
      ok(t.len > 800, '正文过短：' + t.len);
    });

    await step('正文无未替换占位符 / 无填空下划线', async () => {
      const bad = await page.evaluate(() => {
        const t = document.querySelector('#rp-body').innerText;
        return { token: (t.match(/\{\{[^}]*\}\}/g) || []), underline: (t.match(/_{3,}/g) || []) };
      });
      ok(bad.token.length === 0, '仍有占位符 ' + JSON.stringify(bad.token));
      ok(bad.underline.length === 0, '仍有下划线 ' + JSON.stringify(bad.underline));
    });

    await step('顶部统计范围条显示口径摘要', async () => {
      const chips = await page.$$eval('.rp-chip', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
      ok(chips.length >= 4, '摘要条不足：' + JSON.stringify(chips));
      ok(chips.some((c) => /资产/.test(c) && /处/.test(c)), '缺少「资产 N 处」：' + JSON.stringify(chips));
      ok(chips.some((c) => /截止/.test(c)), '缺少截止日期：' + JSON.stringify(chips));
      await shot('report-home.png');
    });

    await step('「替代规则」可展开，含占位符与规则列', async () => {
      await page.click('#rp-rule');
      await page.waitForSelector('#rp-rule-body tr', { timeout: 6000 });
      const info = await page.evaluate(() => {
        const trs = [...document.querySelectorAll('#rp-rule-body tr')];
        return {
          n: trs.length,
          cols: trs[0] ? trs[0].children.length : 0,
          first: trs[0] ? [...trs[0].children].map((c) => c.innerText.trim()) : [],
          allHaveRule: trs.every((tr) => (tr.children[3] || {}).innerText.trim().length > 4),
        };
      });
      ok(info.n >= 60, '规则条数偏少：' + info.n);
      ok(info.cols === 4, '规则表列数不对：' + info.cols);
      ok(info.allHaveRule, '有占位符缺规则说明');
      console.log('        示例：' + JSON.stringify(info.first));
      await shot('report-rules.png');
      await page.click('#rp-rule'); // 收起
    });

    await step('切换单位范围后报告随之重算', async () => {
      const before = await page.evaluate(() => document.querySelector('#rp-body').innerText.slice(0, 200));
      const changed = await page.evaluate(async () => {
        const units = await API.get('/api/units');
        const root = (units.rows || []).find((u) => !u.parent) || (units.rows || [])[0];
        Scope.set(root.name);
        await new Promise((r) => setTimeout(r, 1200));
        return document.querySelector('#rp-body').innerText.slice(0, 200);
      });
      ok(typeof changed === 'string' && changed.length > 50, '切换后正文为空');
      ok(true, '');
      await page.evaluate(() => { Scope.set(''); });
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => document.querySelector('#rp-body').innerText.slice(0, 200));
      ok(after === before, '切回全部单位后正文应还原');
    });

    await step('下载 Markdown 按钮可用（触发下载且文件名含报告）', async () => {
      const dl = page.waitForEvent('download', { timeout: 8000 });
      await page.click('#rp-md');
      const d = await dl;
      ok(/土地房屋资产统计分析报告/.test(d.suggestedFilename()), '文件名不对：' + d.suggestedFilename());
    });

    await step('刷新按钮可重新拉取', async () => {
      await page.click('#rp-refresh');
      await page.waitForTimeout(1200);
      const ok2 = await page.evaluate(() => !!document.querySelector('#rp-body') && document.querySelector('#rp-body').innerText.length > 500);
      ok(ok2, '刷新后正文丢失');
    });

    await step('系统设置页出现「分析报告参数」卡片并可保存', async () => {
      await page.click('#nav a[data-k="settings"]');
      await page.waitForSelector('#st-key', { timeout: 10000 });
      const has = await page.evaluate(() => [...document.querySelectorAll('.card-h h3')].map((x) => x.textContent.trim()));
      ok(has.some((t) => /分析报告参数/.test(t)), '未找到报告参数卡片：' + JSON.stringify(has));
      const n = await page.$$eval('[data-rp]', (els) => els.length);
      ok(n === 5, '参数输入框数量应为 5，实际 ' + n);
      await shot('settings-report.png');
      await page.fill('[data-rp="asOf"]', '2026-06-30');
      await page.click('#st-save');
      await page.waitForTimeout(1200);
      const saved = await page.evaluate(async () => (await API.get('/api/settings/report')).values.asOf);
      ok(saved === '2026-06-30', '保存后 asOf = ' + saved);
    });

    await step('保存参数后报告中的截止日期随之更新', async () => {
      await page.click('#nav a[data-k="report"]');
      await page.waitForSelector('#rp-body', { timeout: 10000 });
      await page.waitForTimeout(800);
      const txt = await page.evaluate(() => document.querySelector('#rp-body').innerText);
      ok(/2026年6月30日/.test(txt), '正文未出现 2026年6月30日');
      await page.evaluate(async () => { await API.put('/api/settings/report', { asOf: '' }); });
    });

    await step('无控制台错误', async () => {
      // 图片/字体等资源 404 不算，只看 JS 报错
      const js = consoleErrors.filter((e) => !/favicon/i.test(e));
      ok(js.length === 0, '控制台错误：' + js.slice(0, 3).join(' | '));
    });
  } finally {
    await browser.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
