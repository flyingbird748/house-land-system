'use strict';
/** 房产预览页端到端测试：点位渲染 / 悬停浮卡 / 移出隐藏 / 点击详情 / 筛选联动 */
const { chromium } = require('playwright-core');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PREVIEW = process.env.PREVIEW || 'http://127.0.0.1:2991/static-html/cb924f07fdfc463b/index.html';
const APIBASE = process.env.APIBASE || 'http://127.0.0.1:8789';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

const errs = [];

async function step(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    console.log('  ✗ ' + name + ' —— ' + e.message);
    process.exitCode = 1;
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(PREVIEW, { waitUntil: 'domcontentloaded' });
  await page.evaluate((b) => API.setBase(b), APIBASE);
  await page.waitForSelector('#lg-u');

  await step('登录', async () => {
    await page.fill('#lg-u', 'admin');
    await page.fill('#lg-p', 'admin123');
    await page.click('#lg-btn');
    await page.waitForSelector('#nav', { timeout: 15000 });
  });

  await step('菜单出现「房产预览」', async () => {
    const has = await page.evaluate(() => !!document.querySelector('#nav a[data-k="preview"]'));
    if (!has) throw new Error('导航未包含房产预览');
  });

  await step('进入房产预览页', async () => {
    await page.click('#nav a[data-k="preview"]');
    await page.waitForTimeout(1500);
    const t = await page.textContent('#pg-title');
    if (t.trim() !== '房产预览') throw new Error('标题为 ' + t);
  });

  // 若无坐标，先一键解析
  const marked0 = await page.evaluate(() => PreviewPage.assets.filter((a) => PreviewPage.isMarked(a)).length);
  console.log('  已标注点数（初始）:', marked0);
  if (marked0 === 0) {
    await step('一键地址解析生成点位', async () => {
      await page.waitForSelector('#pv-mask #pv-m-geo', { timeout: 10000 });
      await page.click('#pv-m-geo');
      await page.waitForSelector('.mask', { state: 'detached', timeout: 120000 });
      await page.waitForTimeout(3000);
      const n = await page.evaluate(() => PreviewPage.assets.filter((a) => PreviewPage.isMarked(a)).length);
      console.log('    解析后已标注:', n);
      if (!n) throw new Error('解析后仍无坐标');
    });
  }

  await page.waitForTimeout(2500);

  await step('地图初始化与点位渲染', async () => {
    const info = await page.evaluate(() => ({
      hasMap: !!PreviewPage.map,
      geoms: PreviewPage.markers ? PreviewPage.markers.getGeometries().length : -1,
      list: PreviewPage.filtered().length,
    }));
    console.log('    map:', info.hasMap, '点位:', info.geoms, '列表:', info.list);
    if (!info.hasMap) throw new Error('地图未初始化');
    if (info.geoms <= 0) throw new Error('点位为空');
    if (info.geoms !== info.list) throw new Error('点位与列表数量不一致');
  });

  await page.screenshot({ path: path.join(SHOT, '30-preview.png') });

  // ---- 悬停 ----
  let hoverPt = null;
  await step('计算首个点位的屏幕坐标', async () => {
    hoverPt = await page.evaluate(() => {
      const a = PreviewPage.filtered()[0];
      const p = PreviewPage.map.projectToContainer(new window.TMap.LatLng(a.lat, a.lng));
      const r = document.getElementById('pv-stage').getBoundingClientRect();
      return { x: Math.round(r.x + p.x), y: Math.round(r.y + p.y - 17), name: a.name, id: a.id };
    });
    console.log('    目标:', hoverPt.name, '@', hoverPt.x, hoverPt.y);
  });

  await step('鼠标移到点位上浮出简要信息', async () => {
    await page.mouse.move(hoverPt.x - 200, hoverPt.y + 160);
    await page.waitForTimeout(300);
    await page.mouse.move(hoverPt.x, hoverPt.y, { steps: 10 });
    await page.waitForTimeout(700);
    const r = await page.evaluate((hid) => {
      const tip = document.getElementById('pv-tip');
      const g = PreviewPage.markers.getGeometries().find((x) => x.id === hid) || {};
      return {
        on: tip.classList.contains('on'),
        display: tip.style.display,
        text: tip.textContent.replace(/\s+/g, ' ').trim(),
        hl: g.styleId || '-',
        hoverId: PreviewPage.hoverId,
      };
    }, hoverPt.id);
    console.log('    浮卡:', r.text.slice(0, 160));
    console.log('    高亮样式:', r.hl, 'hoverId:', r.hoverId);
    if (!r.on || r.display === 'none') throw new Error('浮卡未显示');
    if (r.hoverId !== hoverPt.id) throw new Error('hoverId 不匹配');
    if (String(r.hl).charAt(0) !== 'a') throw new Error('点位未高亮，styleId=' + r.hl);
    ['分类', '面积', '使用状态', '产权', '账面原值'].forEach((k) => {
      if (r.text.indexOf(k) < 0) throw new Error('浮卡缺少字段：' + k);
    });
    if (!r.text.includes(String(hoverPt.name).slice(0, 6))) throw new Error('浮卡未显示资产名称');
  });

  await page.screenshot({ path: path.join(SHOT, '31-preview-hover.png') });

  await step('浮卡位置在点附近且未溢出容器', async () => {
    const r = await page.evaluate(() => {
      const tip = document.getElementById('pv-tip');
      const st = document.getElementById('pv-stage').getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      return { ok: t.left >= st.left - 1 && t.right <= st.right + 1 && t.top >= st.top - 1 && t.bottom <= st.bottom + 1, t: { l: t.left, r: t.right, tp: t.top, b: t.bottom }, s: { l: st.left, r: st.right, tp: st.top, b: st.bottom } };
    });
    if (!r.ok) throw new Error('浮卡溢出容器 ' + JSON.stringify(r));
  });

  await step('浮卡小箭头对准点位、且位于点位上方', async () => {
    const r = await page.evaluate((id) => {
      const tip = document.getElementById('pv-tip');
      const t = tip.getBoundingClientRect();
      const st = document.getElementById('pv-stage').getBoundingClientRect();
      const ax = parseFloat(tip.style.getPropertyValue('--ax')) || 0;
      const a = PreviewPage.assets.find((x) => x.id === id);
      const p = PreviewPage.map.projectToContainer(new window.TMap.LatLng(a.lat, a.lng));
      const PX = st.left + p.x, PY = st.top + p.y;
      return { arrowX: t.left + ax, markerX: PX, gap: PY - t.bottom, below: tip.classList.contains('below') };
    }, hoverPt.id);
    console.log('    箭头X:', Math.round(r.arrowX), '点位X:', Math.round(r.markerX), '间隙:', Math.round(r.gap), '下方模式:', r.below);
    if (Math.abs(r.arrowX - r.markerX) > 20) throw new Error('箭头未对准点位');
    if (!r.below && (r.gap < 0 || r.gap > 60)) throw new Error('浮卡与点位间距异常: ' + r.gap);
  });

  await step('鼠标移开后浮卡隐藏', async () => {
    await page.mouse.move(hoverPt.x + 320, hoverPt.y + 220, { steps: 12 });
    await page.waitForTimeout(800);
    const r = await page.evaluate((hid) => {
      const tip = document.getElementById('pv-tip');
      const g = PreviewPage.markers.getGeometries().find((x) => x.id === hid) || {};
      return { on: tip.classList.contains('on'), display: tip.style.display, hl: g.styleId || '-' };
    }, hoverPt.id);
    if (r.on) throw new Error('浮卡仍处于显示态');
    if (String(r.hl).charAt(0) !== 's') throw new Error('高亮未复位，styleId=' + r.hl);
    if (r.display !== 'none') throw new Error('浮卡未隐藏（display=' + r.display + '）');
  });

  await step('点击点位打开资料详情', async () => {
    await page.mouse.move(hoverPt.x, hoverPt.y, { steps: 8 });
    await page.waitForTimeout(400);
    await page.mouse.click(hoverPt.x, hoverPt.y);
    await page.waitForTimeout(900);
    const dlg = await page.evaluate(() => {
      const m = document.querySelector('.mask .dlg');
      return m ? m.querySelector('h3').textContent : null;
    });
    console.log('    弹窗标题:', dlg);
    if (!dlg) throw new Error('未弹出详情');
    await page.screenshot({ path: path.join(SHOT, '32-preview-detail.png') });
    await page.click('.mask .dlg .x');
    await page.waitForTimeout(400);
  });

  await step('左侧列表悬停也能联动浮卡', async () => {
    const n = await page.evaluate(() => document.querySelectorAll('#pv-lst .it').length);
    if (!n) throw new Error('列表为空');
    await page.hover('#pv-lst .it:nth-child(2)');
    await page.waitForTimeout(600);
    const on = await page.evaluate(() => document.getElementById('pv-tip').classList.contains('on'));
    if (!on) throw new Error('列表悬停未联动浮卡');
  });

  await step('筛选联动：分类 / 使用状态', async () => {
    const before = await page.evaluate(() => PreviewPage.markers.getGeometries().length);
    // 选一个非「全部」的分类
    const cat = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#pv-cats .chip')];
      const c = chips.find((x) => x.dataset.f !== 'all');
      if (!c) return null;
      c.click();
      return c.dataset.f;
    });
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => PreviewPage.markers.getGeometries().length);
    const listN = await page.evaluate(() => PreviewPage.filtered().length);
    console.log('    分类筛选:', cat, before, '->', after, '列表', listN);
    if (cat && after !== listN) throw new Error('筛选后点位与列表不一致');
    if (cat && after > before) throw new Error('筛选后数量反而变多');
    if (cat && listN === 0) throw new Error('筛选后列表为空');
    await page.selectOption('#pv-st', { index: 1 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.click('#pv-reset');
    await page.waitForTimeout(600);
    const reset = await page.evaluate(() => PreviewPage.markers.getGeometries().length);
    if (reset !== before) throw new Error('重置后数量未恢复 ' + reset + ' vs ' + before);
  });

  await step('搜索过滤', async () => {
    await page.fill('#pv-kw', 'zzz-not-exist');
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => PreviewPage.filtered().length);
    if (n !== 0) throw new Error('搜索未过滤');
    await page.fill('#pv-kw', '');
    await page.waitForTimeout(500);
    await page.click('#pv-fit');
    await page.waitForTimeout(1200);
  });

  await page.screenshot({ path: path.join(SHOT, '33-preview-final.png') });

  await step('切换到地图标注页再切回（无残留报错）', async () => {
    await page.click('#nav a[data-k="map"]');
    await page.waitForTimeout(1500);
    await page.click('#nav a[data-k="preview"]');
    await page.waitForTimeout(2500);
    const g = await page.evaluate(() => PreviewPage.markers.getGeometries().length);
    if (g <= 0) throw new Error('切回后点位丢失');
  });

  await browser.close();
  console.log('\n控制台错误:', errs.length ? errs.slice(0, 6).join(' | ') : '（无）');
  console.log(process.exitCode ? '存在失败用例' : '全部通过');
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
