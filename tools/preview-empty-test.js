'use strict';
/** 房产预览页「零标注」路径：空状态提示 → 一键地址解析 → 点位出现 → 悬停浮卡 */
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(PREVIEW, { waitUntil: 'domcontentloaded' });
  await page.evaluate((b) => API.setBase(b), APIBASE);
  await page.waitForSelector('#lg-u');
  await page.fill('#lg-u', 'admin');
  await page.fill('#lg-p', 'admin123');
  await page.click('#lg-btn');
  await page.waitForSelector('#nav', { timeout: 15000 });
  await page.click('#nav a[data-k="preview"]');
  await page.waitForTimeout(4000);

  const marked0 = await page.evaluate(() => PreviewPage.assets.filter((a) => PreviewPage.isMarked(a)).length);

  if (marked0 === 0) {
    await step('零标注时显示空状态卡片', async () => {
      const r = await page.evaluate(() => {
        const m = document.getElementById('pv-mask');
        return { shown: m.style.display !== 'none', text: m.textContent.replace(/\s+/g, ' ').trim(), geoms: PreviewPage.markers.getGeometries().length };
      });
      console.log('    ', r.text);
      if (!r.shown) throw new Error('空状态未显示');
      if (r.geoms !== 0) throw new Error('不应有点位');
    });

    await page.screenshot({ path: path.join(SHOT, '34-preview-empty.png') });

    await step('一键地址解析可完成并生成点位', async () => {
      await page.click('#pv-m-geo');
      await page.waitForSelector('.mask .dlg-f .btn.pri', { timeout: 10000 });
      await page.click('.mask .dlg-f .btn.pri');
      await page.waitForSelector('#bg-t', { timeout: 20000 }); // 进度弹窗出现
      await page.waitForSelector('#bg-t', { state: 'detached', timeout: 240000 }); // 解析完成
      await page.waitForTimeout(3500);
      const r = await page.evaluate(() => ({
        marked: PreviewPage.assets.filter((a) => PreviewPage.isMarked(a)).length,
        geoms: PreviewPage.markers.getGeometries().length,
        mask: document.getElementById('pv-mask').style.display,
        named: PreviewPage.filtered()[0] ? PreviewPage.filtered()[0].name : null,
      }));
      console.log('    已标注:', r.marked, '点位:', r.geoms, '空状态:', r.mask, '示例:', r.named);
      if (!r.marked) throw new Error('解析后仍无坐标');
      if (r.geoms !== r.marked) throw new Error('点位与标注数不一致');
      if (r.mask !== 'none') throw new Error('空状态未隐藏');
    });
  } else {
    console.log('  - 已有 ' + marked0 + ' 个点位，跳过空状态与一键解析步骤');
  }

  await step('全览后悬停点位浮出简要信息', async () => {
    await page.click('#pv-fit');
    await page.waitForTimeout(1800);
    const pt = await page.evaluate(() => {
      const a = PreviewPage.filtered()[0];
      const p = PreviewPage.map.projectToContainer(new window.TMap.LatLng(a.lat, a.lng));
      const r = document.getElementById('pv-stage').getBoundingClientRect();
      return { x: Math.round(r.x + p.x), y: Math.round(r.y + p.y - 17), id: a.id };
    });
    await page.mouse.move(pt.x - 240, pt.y + 140);
    await page.waitForTimeout(300);
    await page.mouse.move(pt.x, pt.y, { steps: 6 });
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const tip = document.getElementById('pv-tip');
      return { on: tip.classList.contains('on'), text: tip.textContent.replace(/\s+/g, ' ').trim() };
    });
    if (!r.on) throw new Error('浮卡未显示');
    ['分类', '面积', '使用状态', '产权', '账面原值'].forEach((k) => {
      if (r.text.indexOf(k) < 0) throw new Error('缺字段 ' + k);
    });
    console.log('    浮卡:', r.text.slice(0, 120));
  });

  await page.screenshot({ path: path.join(SHOT, '35-preview-geocoded.png') });

  // 多样本悬停：逐个点位验证浮卡弹出，且浮卡内容与「实际命中」的资产一致
  await step('遍历前 8 个点位验证悬停数据一致', async () => {
    const list = await page.evaluate(() => PreviewPage.filtered().slice(0, 8).map((a) => a.id));
    let ok = 0;
    for (const id of list) {
      const pt = await page.evaluate((aid) => {
        const a = PreviewPage.assets.find((x) => x.id === aid);
        const p = PreviewPage.map.projectToContainer(new window.TMap.LatLng(a.lat, a.lng));
        const r = document.getElementById('pv-stage').getBoundingClientRect();
        return { x: Math.round(r.x + p.x), y: Math.round(r.y + p.y - 17) };
      }, id);
      await page.mouse.move(pt.x - 200, pt.y + 120);
      await page.waitForTimeout(220);
      await page.mouse.move(pt.x, pt.y, { steps: 5 });
      await page.waitForTimeout(420);
      const r = await page.evaluate(() => {
        const tip = document.getElementById('pv-tip');
        const hit = PreviewPage.assets.find((x) => x.id === PreviewPage.hoverId);
        return { on: tip.classList.contains('on'), hoverId: PreviewPage.hoverId, text: tip.textContent, hitName: hit ? hit.name : null };
      });
      if (r.on && r.hitName && r.text.indexOf(String(r.hitName).slice(0, 8)) >= 0) ok++;
      else console.log('      未命中：目标', id, '实际', r.hoverId, r.on);
    }
    console.log('    命中 ' + ok + '/' + list.length);
    if (ok < list.length) throw new Error('部分点位悬停未命中');
  });

  await step('共址点位会提示「同一位置另有 N 处」', async () => {
    // 找一个与其他点位共址的资产
    const target = await page.evaluate(() => {
      const pts = PreviewPage.projPoints();
      for (const p of pts) {
        const n = pts.filter((q) => q.a.id !== p.a.id && Math.abs(q.x - p.x) <= 4 && Math.abs(q.y - p.y) <= 4).length;
        if (n > 0) return { id: p.a.id, near: n, name: p.a.name };
      }
      return null;
    });
    if (!target) { console.log('    （本数据无共址点位，跳过）'); return; }
    const pt = await page.evaluate((aid) => {
      const p = PreviewPage.projPoints().find((q) => q.a.id === aid);
      const r = document.getElementById('pv-stage').getBoundingClientRect();
      return { x: Math.round(r.x + p.x), y: Math.round(r.y + p.y - 17) };
    }, target.id);
    await page.mouse.move(pt.x - 180, pt.y + 110);
    await page.waitForTimeout(220);
    await page.mouse.move(pt.x, pt.y, { steps: 5 });
    await page.waitForTimeout(500);
    const text = await page.evaluate(() => document.getElementById('pv-tip').textContent.replace(/\s+/g, ' '));
    console.log('    共址点位:', target.name, '近邻', target.near, '|', text.slice(-46));
    if (text.indexOf('该位置另有') < 0) throw new Error('共址提示未出现');
  });

  await browser.close();
  console.log('\n控制台错误:', errs.length ? errs.slice(0, 6).join(' | ') : '（无）');
  console.log(process.exitCode ? '存在失败用例' : '全部通过');
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
