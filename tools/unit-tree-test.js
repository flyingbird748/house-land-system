'use strict';
/**
 * 左侧单位树端到端：树渲染 / 点选切换 / 各模块只显示该单位数据 / 刷新后保持 / 非管理员锁定。
 * 测试数据（单位 + 2 条资产）在脚本内自建自清。
 *
 * 运行：node tools/unit-tree-test.js   （需后端 http://127.0.0.1:8789 已启动）
 */
const { chromium } = require('playwright-core');
const path = require('path');
const { STUB } = require('./tmap-stub');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PREVIEW || 'http://127.0.0.1:8789/';
const APIBASE = process.env.APIBASE || 'http://127.0.0.1:8789';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

const UNIT_A = '测试单位A（江北分局）';
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

/* ---------------- 后端直连（准备/清理数据） ---------------- */
async function api(method, p, body, token) {
  const res = await fetch(APIBASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json();
  if (res.status >= 400) throw new Error(`${method} ${p} → ${j.error || res.status}`);
  return j;
}

(async () => {
  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const T = login.token;

  // 准备：新增单位 + 2 条已标注资产
  let unitId = null;
  const created = [];
  try {
    const before = await api('GET', '/api/units', undefined, T);
    const exist = (before.rows || []).find((u) => u.name === UNIT_A);
    if (exist) unitId = exist.id;
    else unitId = (await api('POST', '/api/units', { name: UNIT_A }, T)).unit.id;

    const base = await api('GET', '/api/stats', undefined, T);
    const n0 = base.total;

    for (let i = 1; i <= 2; i++) {
      const a = await api('POST', '/api/assets', {
        name: `${UNIT_A}-资产${i}`,
        unit: UNIT_A,
        category: '办公用房',
        useStatus: '自用',
        area: 100 * i,
        originalValue: 1000000 * i,
        assetNo: `TEST-A-${i}`,
        location: '重庆市江北区建新东路 1 号',
      }, T);
      created.push(a.asset ? a.asset.id : a.id);
      await api('PUT', `/api/assets/${a.asset ? a.asset.id : a.id}/geo`, { lng: 106.5515 + i * 0.001, lat: 29.5889 + i * 0.001 }, T);
    }
    console.log(`  准备数据：单位「${UNIT_A}」+ ${created.length} 条资产（原总数 ${n0}）`);

    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(STUB);
    await page.addInitScript((u) => { try { localStorage.removeItem('scopeUnit:'); } catch (e) { /* ignore */ } }, UNIT_A);

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate((b) => API.setBase(b), APIBASE);

    const signIn = async (user, pwd) => {
      await page.evaluate(() => { Session.clear(); Scope.reset(); location.hash = '#/dashboard'; boot(); });
      await page.waitForSelector('#lg-u', { timeout: 15000 });
      await page.fill('#lg-u', user);
      await page.fill('#lg-p', pwd);
      await page.click('#lg-btn');
      await page.waitForSelector('#nav', { timeout: 15000 });
      await page.waitForTimeout(600);
    };

    await step('登录并渲染单位树', async () => {
      await signIn('admin', 'admin123');
      const tree = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('#utree .ut-node')];
        return nodes.map((n) => ({ u: n.dataset.u, on: n.classList.contains('on'), t: n.textContent.trim() }));
      });
      ok(tree.length >= 3, '树节点数 ' + tree.length);
      ok(tree[0].u === '' && /全部单位/.test(tree[0].t), '缺少根节点：' + JSON.stringify(tree[0]));
      ok(tree.some((x) => x.u === UNIT_A), '未包含测试单位');
      ok(tree[0].on, '默认未选中「全部单位」');
    });

    await step('根节点显示总数、子节点显示各单位条数', async () => {
      const c = await page.evaluate((u) => {
        const root = document.querySelector('#utree .ut-node[data-u=""] .ut-ct');
        const kid = document.querySelector(`#utree .ut-node[data-u="${CSS.escape(u)}"] .ut-ct`);
        return { root: root && Number(root.textContent), kid: kid && Number(kid.textContent) };
      }, UNIT_A);
      ok(c.root === n0 + 2, '根节点总数 ' + c.root);
      ok(c.kid === 2, '测试单位条数 ' + c.kid);
    });

    await step('折叠 / 展开子节点', async () => {
      await page.click('#ut-arw');
      await page.waitForTimeout(200);
      const hidden = await page.evaluate(() => {
        const k = document.querySelector('#utree .ut-kids');
        return getComputedStyle(k).display === 'none';
      });
      ok(hidden, '未折叠');
      await page.click('#ut-arw');
      await page.waitForTimeout(200);
      const shown = await page.evaluate(() => getComputedStyle(document.querySelector('#utree .ut-kids')).display !== 'none');
      ok(shown, '未展开');
    });

    const clickUnit = async (u) => {
      await page.click(`#utree .ut-node[data-u="${u === '' ? '' : u}"]`);
      await page.waitForTimeout(700);
    };

    await step('点选单位 → 资产台账只显示该单位', async () => {
      await page.click('#nav a[data-k="assets"]');
      await page.waitForTimeout(900);
      await clickUnit(UNIT_A);
      const r = await page.evaluate(() => ({
        rows: document.querySelectorAll('.tbl-wrap tbody tr').length,
        units: [...new Set(ListState.rows.map((x) => x.unit))],
        crumb: (document.getElementById('pg-crumb') || {}).textContent || '',
      }));
      ok(r.rows === 2, '行数 ' + r.rows);
      ok(r.units.length === 1 && r.units[0] === UNIT_A, '行内含其他单位：' + JSON.stringify(r.units));
      ok(r.crumb.indexOf(UNIT_A) >= 0, '顶栏未显示当前单位：' + r.crumb);
    });

    await step('点选单位 → 数据看板统计只统计该单位', async () => {
      await page.click('#nav a[data-k="dashboard"]');
      await page.waitForTimeout(1200);
      const v = await page.evaluate(() => {
        const el = document.querySelector('.kpis .kpi .vl');
        return el ? el.textContent.trim() : '';
      });
      ok(/^2/.test(v), '资产总数为 ' + v);
    });

    await step('点选单位 → 房产预览只显示该单位点位', async () => {
      await page.click('#nav a[data-k="preview"]');
      await page.waitForTimeout(1400);
      const r = await page.evaluate(() => ({
        scope: Scope.unit,
        assets: PreviewPage.assets.length,
        pts: PreviewPage.filtered().length,
      }));
      ok(r.scope === UNIT_A, 'Scope 未生效：' + r.scope);
      ok(r.assets === 2, '预览数据 ' + r.assets);
      ok(r.pts === 2, '点位 ' + r.pts);
    });

    await step('点选单位 → 地图标注只加载该单位', async () => {
      await page.click('#nav a[data-k="map"]');
      await page.waitForTimeout(1400);
      const n = await page.evaluate(() => MapPage.assets.length);
      ok(n === 2, '地图资产 ' + n);
    });

    await step('刷新页面后仍保持所选单位', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.evaluate((b) => API.setBase(b), APIBASE);
      await page.waitForSelector('#nav', { timeout: 15000 });
      await page.waitForTimeout(1000);
      const r = await page.evaluate(() => ({ scope: Scope.unit, on: [...document.querySelectorAll('#utree .ut-node.on')].map((n) => n.dataset.u) }));
      ok(r.scope === UNIT_A, '刷新后 Scope=' + r.scope);
      ok(r.on.length === 1 && r.on[0] === UNIT_A, '树高亮 ' + JSON.stringify(r.on));
    });

    await step('切回「全部单位」恢复全量数据', async () => {
      await clickUnit('');
      await page.waitForTimeout(900);
      const n = await page.evaluate(() => MapPage.assets.length);
      ok(n === n0 + 2, '全量条数 ' + n);
    });

    await step('非管理员（绑定所属单位）只能看本单位且无法切换', async () => {
      const users = await api('GET', '/api/users', undefined, T);
      const viewer = (users.rows || users).find((u) => u.username === 'viewer');
      const origin = { unit: viewer.unit || '', unitId: viewer.unitId || '' };
      // 注意：后端按 unitId 优先解析，必须显式清掉旧的 unitId，否则会沿用原单位
      await api('PUT', '/api/users/' + viewer.id, { unit: UNIT_A, unitId: unitId }, T);
      try {
        await signIn('viewer', 'viewer123');
        const r0 = await page.evaluate(() => ({
          scope: Scope.unit,
          nodes: [...document.querySelectorAll('#utree .ut-node')].map((n) => n.dataset.u),
          hasAll: !!document.querySelector('#utree .ut-node[data-u=""]'),
        }));
        ok(r0.scope === UNIT_A, '未锁定到所属单位：' + r0.scope);
        ok(r0.nodes.filter((u) => u !== '').length === 1, '单位树出现其他单位：' + JSON.stringify(r0.nodes));
        ok(!r0.hasAll, '非管理员不应出现「全部单位」节点');
        // 即使绕过界面直接切换，也应被可见范围拦下
        const after = await page.evaluate(() => { Scope.set(''); return Scope.unit; });
        ok(after === UNIT_A, '非管理员切到了全部单位：' + after);
        await page.click('#nav a[data-k="assets"]');
        await page.waitForTimeout(900);
        const rows = await page.evaluate(() => [...new Set(ListState.rows.map((x) => x.unit))]);
        ok(rows.length === 1 && rows[0] === UNIT_A, '看到其他单位数据：' + JSON.stringify(rows));
      } finally {
        await api('PUT', '/api/users/' + viewer.id, origin, T);
      }
    });

    await page.evaluate(() => { Session.clear(); Scope.reset(); });
    await page.screenshot({ path: path.join(SHOT, 'unit-tree.png') });

    await step('无控制台报错', async () => {
      const real = errs.filter((e) => !/favicon|net::ERR_/.test(e));
      ok(real.length === 0, real.slice(0, 3).join(' | '));
    });

    await browser.close();
  } finally {
    // 清理测试数据
    for (const id of created) {
      try { await api('DELETE', '/api/assets/' + id, undefined, T); } catch (e) { console.log('  清理资产失败：' + e.message); }
    }
    if (unitId) {
      try { await api('DELETE', '/api/units/' + unitId, undefined, T); } catch (e) { console.log('  清理单位失败：' + e.message); }
    }
    const after = await api('GET', '/api/stats', undefined, T);
    console.log(`  清理完成，剩余资产 ${after.total} 条`);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})();
