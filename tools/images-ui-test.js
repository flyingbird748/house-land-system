'use strict';
/**
 * 房产图片 UI 测试（真实 Chrome + 地图桩件）
 *   · 资产编辑界面：图片墙上架 / 改标签 / 查看大图 / 删除，满 3 张不再给出上传入口
 *   · 只读详情：图片以缩略图墙呈现且没有删除按钮
 *   · 房产预览：悬停点位的简要信息浮卡带缩略图（≤3 张、能真正加载出来）
 *
 * 运行：node tools/images-ui-test.js（需后端 http://127.0.0.1:8789）
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { STUB } = require('./tmap-stub');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PREVIEW || 'http://127.0.0.1:8789/';
const APIBASE = process.env.APIBASE || 'http://127.0.0.1:8789';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

const errs = [];
let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

async function api(method, p, body, token) {
  const res = await fetch(APIBASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = {}; try { j = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, data: j };
}

/* 必须是浏览器能解码的真实图片：只带文件头的假 JPEG 服务端会收，但 <img> 渲染不出来 */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

/**
 * 给隐藏的 <input type=file> 塞文件。
 * 注意：setInputFiles 对 display:none 的输入框不可操作（会一直等到超时），
 * 所以这里用 DataTransfer 直接构造 File 并派发 change —— 与真实选择文件的路径一致。
 */
async function uploadFile(page, name, buf, mime) {
  await page.evaluate(async ({ b64, name: fname, mime: ftype }) => {
    const input = document.querySelector('.mask input[type=file]');
    if (!input) throw new Error('找不到图片上传输入框');
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], fname, { type: ftype }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { b64: buf.toString('base64'), name, mime });
  await page.waitForTimeout(300);
}

/** 关闭最上层弹窗（点“关闭”按钮，找不到就点最后一个按钮） */
const closeTop = async (page) => {
  await page.evaluate(() => {
    const dlg = [...document.querySelectorAll('.mask')].pop();
    if (!dlg) return;
    const btns = [...dlg.querySelectorAll('.dlg-f .btn')];
    const b = btns.find((x) => x.textContent.trim() === '关闭') || btns[btns.length - 1];
    if (b) b.click();
  });
  await page.waitForTimeout(350);
};

(async () => {
  const T = (await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).data.token;
  const first = (await api('GET', '/api/assets?pageSize=1', undefined, T)).data.rows[0];
  const aid = first.id;
  const origin = (await api('GET', '/api/assets/' + aid + '/images', undefined, T)).data.images || [];
  console.log(`  目标资产：${first.name}（原有图片 ${origin.length} 张）\n`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(STUB);

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate((b) => API.setBase(b), APIBASE);
    await page.fill('#lg-u', 'admin');
    await page.fill('#lg-p', 'admin123');
    await page.click('#lg-btn');
    await page.waitForSelector('#nav', { timeout: 15000 });

    /* ---------- ① 编辑界面上传 ---------- */
    await step('台账 → 打开编辑界面，能看到「房产图片」区域', async () => {
      await page.click('#nav a[data-k="assets"]');
      await page.waitForSelector('#content table.tbl tbody tr', { timeout: 10000 });
      await page.evaluate((id) => AssetForm.edit(ListState.rows.find((a) => a.id === id)), aid);
      await page.waitForSelector('.mask .img-box', { timeout: 8000 });
      const txt = await page.textContent('.mask .img-box');
      ok(/房产图片/.test(txt), '未显示图片区标题');
      ok(/最多 3 张/.test(txt) && /2MB/.test(txt), '未说明数量与大小限制：' + txt.slice(0, 90));
    });

    await step('上传第 1 张（PNG，标签自动落到「正面」）', async () => {
      await page.click('.mask .img-add');
      await uploadFile(page, '正面.png', PNG_1PX, 'image/png');
      await page.waitForFunction(() => document.querySelectorAll('.mask .img-cell').length >= 1, null, { timeout: 15000 });
      const label = await page.inputValue('.mask .img-cell .img-label');
      ok(label === '正面', '默认标签应为正面，实际：' + label);
      const src = await page.getAttribute('.mask .img-cell img', 'src');
      ok(/\/images\/[^/]+\/raw\?token=/.test(src), '缩略图地址不是带令牌的直链：' + src);
    });

    await step('再上传 2 张后进位到「侧面 / 室内」，且不再出现上传入口', async () => {
      await page.click('.mask .img-add');
      await uploadFile(page, '侧面.png', PNG_1PX, 'image/png');
      await page.waitForFunction(() => document.querySelectorAll('.mask .img-cell').length >= 2, null, { timeout: 15000 });
      await page.click('.mask .img-add');
      await uploadFile(page, '室内.png', PNG_1PX, 'image/png');
      await page.waitForFunction(() => document.querySelectorAll('.mask .img-cell').length >= 3, null, { timeout: 15000 });
      const labels = await page.$$eval('.mask .img-cell .img-label', (els) => els.map((e) => e.value));
      ok(labels.join(',') === '正面,侧面,室内', '标签递推不正确：' + labels.join(','));
      ok(await page.$('.mask .img-add') === null, '满 3 张后仍显示上传入口');
      ok(/3 \/ 3/.test(await page.textContent('.mask .img-box')), '计数未到 3 / 3');
    });

    await page.screenshot({ path: path.join(SHOT, 'images-form.png') });

    await step('查看大图（轻 LOT查看器）', async () => {
      await page.click('.mask .img-cell .img-view');
      await page.waitForSelector('.mask .lb-stage img', { timeout: 8000 });
      const st = await page.evaluate(() => {
        const img = document.querySelector('.mask .lb-stage img');
        return { src: img.getAttribute('src') || '', loaded: img.complete && img.naturalWidth > 0 };
      });
      ok(/\/raw\?token=/.test(st.src), '大图地址异常：' + st.src);
      ok(st.loaded, '大图未真正加载');
      await page.screenshot({ path: path.join(SHOT, 'images-lightbox.png') });
      await closeTop(page);
    });

    await step('改标签生效', async () => {
      await page.selectOption('.mask .img-cell .img-label', '室内');
      await page.waitForTimeout(700);
      const v = await page.inputValue('.mask .img-cell .img-label');
      ok(v === '室内', '标签未改成功：' + v);
    });

    await step('删除一张后可再次上传（名额释放）', async () => {
      await page.click('.mask .img-cell .img-del');
      await page.waitForSelector('.mask .dlg-f .btn.pri', { timeout: 8000 });
      await page.evaluate(() => {
        const dlg = [...document.querySelectorAll('.mask')].pop();
        const btns = [...dlg.querySelectorAll('.dlg-f .btn')];
        (btns.find((b) => b.textContent.trim() === '确定') || btns[0]).click();
      });
      await page.waitForFunction(() => document.querySelectorAll('.mask .img-cell').length === 2, null, { timeout: 12000 });
      ok(await page.$('.mask .img-add') !== null, '删除后未恢复上传入口');
      ok(/2 \/ 3/.test(await page.textContent('.mask .img-box')), '计数未回到 2 / 3');
    });

    await step('补回一张，满足后续浮卡测试需要', async () => {
      await page.click('.mask .img-add');
      await uploadFile(page, '补充.png', PNG_1PX, 'image/png');
      await page.waitForFunction(() => document.querySelectorAll('.mask .img-cell').length === 3, null, { timeout: 15000 });
    });

    await closeTop(page);

    /* ---------- ② 只读详情里的图片墙 ---------- */
    await step('只读详情：显示图片墙且没有删除按钮', async () => {
      await page.click('#nav a[data-k="assets"]');
      await page.waitForSelector('#content table.tbl tbody tr', { timeout: 10000 });
      await page.evaluate((id) => AssetForm.view(ListState.rows.find((a) => a.id === id)), aid);
      await page.waitForSelector('.mask .img-cell', { timeout: 8000 });
      ok((await page.$$('.mask .img-cell .img-del')).length === 0, '只读详情里出现了删除按钮');
      ok(await page.evaluate(() => document.querySelector('.mask .img-label').disabled), '只读详情里标签下拉未禁用');
      await page.screenshot({ path: path.join(SHOT, 'images-view.png') });
    });
    await closeTop(page);

    /* ---------- ③ 预览页浮卡缩略图 ---------- */
    await step('房产预览：悬停点位的简要信息里带缩略图', async () => {
      await page.click('#nav a[data-k="preview"]');
      await page.waitForTimeout(1800);
      const has = await page.evaluate((id) => !!PreviewPage.imgMap && !!PreviewPage.imgMap[id], aid);
      ok(has, '预览页未取到该资产的图片索引');
      await page.evaluate((id) => PreviewPage.markers.emit('hover', { geometry: { id } }), aid);
      await page.waitForTimeout(400);
      // 等图片真正就位（网络是本机，但避免把渲染时序写死）
      await page.waitForFunction(() => {
        const imgs = [...document.querySelectorAll('#pv-tip .pv-img img')];
        return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      }, null, { timeout: 8000 }).catch(() => {});
      const info = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('#pv-tip .pv-img img')];
        return {
          n: imgs.length,
          loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
          labels: [...document.querySelectorAll('#pv-tip .pv-img b')].map((b) => b.textContent),
          visible: !!document.querySelector('#pv-tip') && document.querySelector('#pv-tip').style.display !== 'none',
        };
      });
      ok(info.visible, '浮卡未显示');
      ok(info.n > 0, '浮卡里没有缩略图');
      ok(info.n <= 3, '浮卡缩略图超过 3 张：' + info.n);
      if (info.loaded !== info.n) {
        const diag = await page.evaluate(async () => {
          const i = document.querySelector('#pv-tip .pv-img img');
          if (!i) return 'DOM 里已无图片节点';
          const src = i.getAttribute('src') || '';
          try { const r = await fetch(src); return `${r.status} ${r.headers.get('content-type')}｜${src.slice(0, 150)}`; }
          catch (e) { return 'fetch 异常 ' + e.message + '｜' + src.slice(0, 150); }
        });
        ok(false, `缩略图未全部加载：${info.loaded}/${info.n}｜${diag}`);
      }
      ok(info.labels.length === info.n, '缩略图标签缺失');
      await page.screenshot({ path: path.join(SHOT, 'images-tooltip.png') });
    });

    await step('没有图片的资产浮卡不出现空的图片位', async () => {
      const other = await page.evaluate((id) => {
        const a = PreviewPage.filtered().find((x) => x.id !== id && !(PreviewPage.imgMap[x.id] || []).length);
        return a ? a.id : null;
      }, aid);
      if (!other) return;
      await page.evaluate((id) => PreviewPage.markers.emit('hover', { geometry: { id } }), other);
      await page.waitForTimeout(400);
      const n = await page.evaluate(() => document.querySelectorAll('#pv-tip .pv-img img').length);
      ok(n === 0, '无图资产仍渲染了图片位：' + n);
    });

    await step('无控制台报错', async () => {
      const real = errs.filter((e) => !/favicon|net::ERR_|Failed to load resource/.test(e));
      ok(real.length === 0, real.slice(0, 3).join(' | '));
    });
  } finally {
    const now = (await api('GET', '/api/assets/' + aid + '/images', undefined, T)).data.images || [];
    const keep = new Set(origin.map((x) => x.id));
    for (const im of now) if (!keep.has(im.id)) await api('DELETE', `/api/assets/${aid}/images/${im.id}`, undefined, T);
    const left = (await api('GET', '/api/assets/' + aid + '/images', undefined, T)).data.images || [];
    console.log(`\n  已恢复：该资产剩 ${left.length} 张（原本 ${origin.length} 张）`);
    await browser.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(1); });
