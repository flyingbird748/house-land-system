'use strict';
/**
 * 单位层级 + 两类管理员的界面回归（真实 Chrome）：
 *   系统管理员：完整层级树、单位管理页可维护上级/下级
 *   单位管理员：以本单位为根的下级树、下级单位只读（台账操作列变为「查看」）
 * 测试数据（下级单位 + 1 条资产）自建自清。
 *
 * 运行：node tools/org-ui-test.js（需后端 http://127.0.0.1:8789）
 */
const { chromium } = require('playwright-core');
const path = require('path');
const { STUB } = require('./tmap-stub');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PREVIEW || 'http://127.0.0.1:8789/';
const APIBASE = process.env.APIBASE || 'http://127.0.0.1:8789';
const SHOT = path.join(__dirname, '..', 'data', 'shots');

const CHILD = '第一税务所';
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
  let j = {};
  try { j = await res.json(); } catch (e) { /* 非 JSON */ }
  if (res.status >= 400) throw new Error(`${method} ${p} → ${j.error || res.status}`);
  return j;
}

(async () => {
  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const T = login.token;

  let childId = null;
  let assetId = null;
  let rootName = '';
  let childCreated = false;
  let childPrevParent = null;
  let assetCreated = false;
  try {
    // 准备：以「单位管理员实际所属单位」为根，建一个下级单位 + 1 条资产
    // 注意：不能假设只有一个顶级单位（真实系统里可以有「市局 → 区局」多级）
    const units0 = await api('GET', '/api/units', undefined, T);
    const users0 = await api('GET', '/api/users', undefined, T);
    const ua0 = (users0.rows || []).find((u) => u.role === 'unitadmin');
    let root = ua0 ? (units0.rows || []).find((u) => u.id === ua0.unitId || u.name === ua0.unit) : null;
    if (!root) root = (units0.rows || []).find((u) => !u.parent) || (units0.rows || [])[0];
    rootName = root.name;
    const exist = (units0.rows || []).find((u) => u.name === CHILD);
    if (exist) {
      childId = exist.id;
      if ((exist.parent || '') !== root.id) {
        // 已存在但不在本单位下：临时挂过来，跑完恢复原上级
        childPrevParent = exist.parent || '';
        await api('PUT', '/api/units/' + exist.id, { parent: root.id }, T);
      }
    } else {
      childId = (await api('POST', '/api/units', { name: CHILD, parent: root.id }, T)).unit.id;
      childCreated = true;
    }
    const got = await api('GET', '/api/assets?' + encodeURIComponent('q') + '=ORG-TREE-1&pageSize=all', undefined, T);
    if ((got.rows || []).length) assetId = got.rows[0].id;
    else {
      assetId = (await api('POST', '/api/assets', {
        name: '第一税务所办公用房', assetNo: 'ORG-TREE-1', unit: CHILD, category: '办公用房',
      }, T)).asset.id;
      assetCreated = true;
    }

    const totalRoot = (await api('GET', `/api/assets?unit=${encodeURIComponent(rootName)}&pageSize=all`, undefined, T)).total;
    console.log(`  准备数据：上级「${rootName}」(${totalRoot} 条，含下级) / 下级「${CHILD}」(1 条)`);

    // 确保存在单位管理员示例账号
    const users = await api('GET', '/api/users', undefined, T);
    const ua = (users.rows || []).find((u) => u.role === 'unitadmin');
    ok(ua, '缺少单位管理员账号（应在服务启动时自动创建）');

    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(STUB);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate((b) => API.setBase(b), APIBASE);

    const signIn = async (user, pwd) => {
      await page.evaluate(() => { Session.clear(); Scope.reset(); location.hash = '#/dashboard'; boot(); });
      await page.waitForSelector('#lg-u', { timeout: 15000 });
      await page.fill('#lg-u', user);
      await page.fill('#lg-p', pwd);
      await page.click('#lg-btn');
      await page.waitForSelector('#nav', { timeout: 15000 });
      await page.waitForTimeout(700);
    };

    /* ---------------- 系统管理员 ---------------- */
    await step('系统管理员：单位管理页展示上级 / 下级层级', async () => {
      await signIn('admin', 'admin123');
      await page.click('#nav a[data-k="units"]');
      await page.waitForTimeout(900);
      const rows = await page.evaluate(() => [...document.querySelectorAll('.tbl-wrap tbody tr')].map((tr) => {
        const td = tr.querySelectorAll('td');
        return { name: (td[1] || {}).textContent.trim(), parent: (td[2] || {}).textContent.trim(), kid: (td[5] || {}).textContent.trim() };
      }));
      const kid = rows.find((r) => r.name.indexOf(CHILD) >= 0);
      ok(kid, '未找到下级单位行：' + JSON.stringify(rows.slice(0, 6)));
      ok(kid.parent.indexOf(rootName) >= 0, '上级单位列不正确：' + kid.parent);
      const parent = rows.find((r) => r.name.indexOf(rootName) >= 0);
      ok(parent && Number(parent.kid) >= totalRoot, '含下级计数不正确：' + JSON.stringify(parent));
    });

    await step('系统管理员：左侧树显示层级（父 / 子缩进）', async () => {
      const r = await page.evaluate((c) => {
        const nodes = [...document.querySelectorAll('#utree .ut-node')];
        const kid = nodes.find((n) => n.dataset.u === c);
        const root = nodes.find((n) => n.dataset.u === '');
        return {
          hasAll: !!root,
          kidPad: kid ? parseInt(getComputedStyle(kid).paddingLeft, 10) : -1,
          kidCount: kid ? Number(kid.querySelector('.ut-ct').textContent) : -1,
        };
      }, CHILD);
      ok(r.hasAll, '缺少「全部单位」根节点');
      ok(r.kidPad > 0, '下级单位未缩进：' + r.kidPad);
      ok(r.kidCount === 1, '下级单位条数 ' + r.kidCount);
    });

    await page.screenshot({ path: path.join(SHOT, 'org-tree-admin.png') });

    /* ---------------- 单位管理员 ---------------- */
    await step('单位管理员：登录即锁定在本单位，树只含本单位与下级', async () => {
      await signIn(ua.username, 'unitadmin123');
      const r = await page.evaluate(() => ({
        scope: Scope.unit,
        nodes: [...document.querySelectorAll('#utree .ut-node')].map((n) => n.dataset.u),
        hasAll: !!document.querySelector('#utree .ut-node[data-u=""]'),
      }));
      ok(r.scope === rootName, '未锁定到本单位：' + r.scope);
      ok(!r.hasAll, '不应出现「全部单位」节点');
      ok(r.nodes.length === 2 && r.nodes.indexOf(CHILD) >= 0, '树节点 ' + JSON.stringify(r.nodes));
    });

    await step('单位管理员：下级单位节点标记「只读」，本单位不标记', async () => {
      const r = await page.evaluate((c) => {
        const get = (u) => document.querySelector(`#utree .ut-node[data-u="${CSS.escape(u)}"]`);
        return {
          kidRo: !!get(c).querySelector('.ut-ro'),
          rootRo: !!get(Scope.units[0]).querySelector('.ut-ro'),
        };
      }, CHILD);
      ok(r.kidRo, '下级单位未标记只读');
      ok(!r.rootRo, '本单位被误标为只读');
    });

    await step('单位管理员：默认看到本单位 + 下级全部数据', async () => {
      await page.click('#nav a[data-k="assets"]');
      await page.waitForTimeout(1000);
      const n = await page.evaluate(() => ({ total: ListState.total, units: [...new Set(ListState.rows.map((x) => x.unit))] }));
      ok(n.total === totalRoot, '台账条数 ' + n.total + '（应为 ' + totalRoot + '）');
    });

    await step('单位管理员：切换到下级单位 → 仅显示下级数据且操作列变为「查看」', async () => {
      await page.click(`#utree .ut-node[data-u="${CHILD}"]`);
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => ({
        scope: Scope.unit,
        total: ListState.total,
        acts: [...document.querySelectorAll('.tbl-wrap tbody tr td.act')].map((td) => td.textContent.trim()),
        crumb: (document.getElementById('pg-crumb') || {}).textContent || '',
      }));
      ok(r.scope === CHILD, 'Scope ' + r.scope);
      ok(r.total === 1, '下级条数 ' + r.total);
      ok(r.acts.length === 1 && /查看/.test(r.acts[0]) && !/编辑|删除/.test(r.acts[0]), '操作列：' + JSON.stringify(r.acts));
      ok(/下级单位/.test(r.crumb), '面包屑未提示只读：' + r.crumb);
    });

    await page.screenshot({ path: path.join(SHOT, 'org-child-readonly.png') });

    await step('单位管理员：切回本单位恢复可编辑', async () => {
      const rootName2 = await page.evaluate(() => Scope.units[0]);
      await page.click(`#utree .ut-node[data-u="${rootName2}"]`);
      await page.waitForTimeout(1200);
      const acts = await page.evaluate(() => [...document.querySelectorAll('.tbl-wrap tbody tr td.act')].map((td) => td.textContent.trim()));
      // 本单位数据恢复「编辑」；含下级时下级那一行仍为只读
      const ro = acts.filter((a) => /查看/.test(a)).length;
      const ed = acts.filter((a) => /编辑/.test(a)).length;
      ok(acts.length > 1 && ro === 1 && ed === acts.length - 1, `只读 ${ro} / 可编辑 ${ed} / 共 ${acts.length}`);
    });

    await step('单位管理员：用户管理页看不到系统管理员，且不能授予系统管理员角色', async () => {
      await page.click('#nav a[data-k="users"]');
      await page.waitForTimeout(900);
      const names = await page.evaluate(() => [...document.querySelectorAll('.tbl-wrap tbody tr td.mono')].map((td) => td.textContent.trim()));
      ok(names.indexOf('admin') < 0, '看到了系统管理员：' + JSON.stringify(names));
      await page.click('.card-h .acts button');
      await page.waitForSelector('#eu-r', { timeout: 8000 });
      const roles = await page.evaluate(() => [...document.querySelectorAll('#eu-r option')].map((o) => o.value));
      ok(roles.length > 0 && roles.indexOf('admin') < 0, '角色下拉含系统管理员：' + JSON.stringify(roles));
      const unitOpts = await page.evaluate(() => [...document.querySelectorAll('#eu-t option')].map((o) => o.textContent));
      ok(unitOpts.some((t) => t.indexOf(CHILD) >= 0), '单位下拉缺少下级单位：' + JSON.stringify(unitOpts));
      await page.click('.dlg-f .btn:not(.pri)'); // 取消
      await page.waitForTimeout(300);
    });

    await step('单位管理员：导航中不出现「单位管理」', async () => {
      const items = await page.evaluate(() => [...document.querySelectorAll('#nav a')].map((a) => a.dataset.k));
      ok(items.indexOf('units') < 0, '导航项：' + JSON.stringify(items));
    });

    await step('无控制台报错', async () => {
      const real = errs.filter((e) => !/favicon|net::ERR_/.test(e));
      ok(real.length === 0, real.slice(0, 3).join(' | '));
    });

    await browser.close();
  } finally {
    // 只清理本次新建的数据；若复用了已存在的单位/资产，则恢复其原状
    if (assetId && assetCreated) { try { await api('DELETE', '/api/assets/' + assetId, undefined, T); } catch (e) { console.log('  清理资产失败：' + e.message); } }
    if (childId) {
      if (childCreated) {
        try { await api('DELETE', '/api/units/' + childId, undefined, T); } catch (e) { console.log('  清理单位失败：' + e.message); }
      } else if (childPrevParent !== null) {
        try { await api('PUT', '/api/units/' + childId, { parent: childPrevParent }, T); } catch (e) { console.log('  恢复单位上级失败：' + e.message); }
      }
    }
    console.log('  清理完成');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
