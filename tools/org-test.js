'use strict';
/**
 * 单位层级（上级 / 下级）+ 用户单位对应关系 + 系统管理员 / 单位管理员 权限测试
 * 运行：node tools/org-test.js（需后端在 127.0.0.1:8789 运行）
 * 说明：自建测试单位 / 资产 / 用户，跑完自动清理。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8789';
const ADMIN_PWD = process.env.ADMIN_PWD || 'admin123';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
}

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return { status: res.status, data: await res.json() };
  return { status: res.status, text: await res.text() };
}

const q = (params) => Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

(async () => {
  console.log('== 单位层级与角色权限测试', BASE, '==');

  const lg = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PWD });
  if (lg.status !== 200) { console.error('管理员登录失败，请检查 ADMIN_PWD：', lg.data || lg.text); process.exit(1); }
  const tk = lg.data.token;

  /* ---------------- 准备测试数据 ---------------- */
  const mkUnit = async (name, parent) => {
    const r = await api('POST', '/api/units', { name, parent }, tk);
    return r.status === 200 ? r.data.unit : null;
  };
  const mkAsset = async (no, unit) => {
    const r = await api('POST', '/api/assets', { name: `层级测试-${no}`, assetNo: no, unit, category: '办公用房' }, tk);
    return r.status === 200 ? r.data.asset : null;
  };

  const U_P = await mkUnit('ORG测试·市局');
  const U_C = await mkUnit('ORG测试·一分局', U_P.id);
  const U_G = await mkUnit('ORG测试·一所', U_C.id);
  const U_O = await mkUnit('ORG测试·平级单位');
  check('创建四级测试单位（含三级层级）', !!(U_P && U_C && U_G && U_O), { U_P, U_C, U_G });

  const aP1 = await mkAsset('ORG-T-P1', U_P.name);
  const aP2 = await mkAsset('ORG-T-P2', U_P.name);
  const aC = await mkAsset('ORG-T-C1', U_C.name);
  const aG = await mkAsset('ORG-T-G1', U_G.name);
  const aO = await mkAsset('ORG-T-O1', U_O.name);
  check('创建测试资产（父2/子1/孙1/平级1）', !!(aP1 && aP2 && aC && aG && aO));

  const uaR = await api('POST', '/api/users', {
    username: 'org_ua', name: '测试单位管理员', role: 'unitadmin',
    unitId: U_P.id, password: 'test123456',
  }, tk);
  check('创建单位管理员（绑定父单位）', uaR.status === 200 && uaR.data.user.unit === U_P.name, uaR.data);
  const uaTk = uaR.data ? (await api('POST', '/api/auth/login', { username: 'org_ua', password: 'test123456' })).data.token : '';
  check('单位管理员可登录', !!uaTk);

  const otherR = await api('POST', '/api/users', {
    username: 'org_other', name: '平级单位浏览员', role: 'viewer', unitId: U_O.id, password: 'test123456',
  }, tk);
  check('创建平级单位用户', otherR.status === 200, otherR.data);

  /* ---------------- 1. 单位层级接口 ---------------- */
  let r = await api('GET', '/api/units', undefined, tk);
  const byName = {};
  (r.data.rows || []).forEach((u) => { byName[u.name] = u; });
  check('单位层级：子单位带上级', byName[U_C.name] && byName[U_C.name].parent === U_P.id && byName[U_C.name].parentName === U_P.name, byName[U_C.name]);
  check('单位层级：level 正确（父0/子1/孙2）', byName[U_P.name].level === 0 && byName[U_C.name].level === 1 && byName[U_G.name].level === 2,
    { p: byName[U_P.name].level, c: byName[U_C.name].level, g: byName[U_G.name].level });

  r = await api('PUT', '/api/units/' + U_P.id, { parent: U_G.id }, tk);
  check('禁止把上级单位设为自己的下级（防环）', r.status === 400, r.data);
  r = await api('DELETE', '/api/units/' + U_P.id, undefined, tk);
  check('禁止删除仍有下级单位的单位', r.status === 400, r.data);

  /* ---------------- 2. 系统管理员：可见全部 ---------------- */
  r = await api('GET', '/api/assets?' + q({ unit: U_P.name, pageSize: 'all' }), undefined, tk);
  check('系统管理员：按父单位查询含全部下级（4 条）', r.status === 200 && r.data.total === 4, r.data && r.data.total);
  r = await api('GET', '/api/assets?' + q({ unit: U_C.name, pageSize: 'all' }), undefined, tk);
  check('系统管理员：按子单位查询含其下级（2 条）', r.status === 200 && r.data.total === 2, r.data && r.data.total);
  r = await api('GET', '/api/assets?' + q({ unit: U_C.name, unitMode: 'exact', pageSize: 'all' }), undefined, tk);
  check('unitMode=exact 时仅本单位（1 条）', r.status === 200 && r.data.total === 1, r.data && r.data.total);

  /* ---------------- 3. 单位管理员：可见本单位 + 下级 ---------------- */
  r = await api('GET', '/api/assets?' + q({ pageSize: 'all' }), undefined, uaTk);
  const units = (r.data.rows || []).map((a) => a.unit);
  check('单位管理员：可见本单位 + 全部下级（4 条）', r.status === 200 && r.data.total === 4, r.data && r.data.total);
  check('单位管理员：看不到平级单位数据', units.indexOf(U_O.name) < 0, units);

  r = await api('GET', '/api/assets?' + q({ unit: U_O.name, pageSize: 'all' }), undefined, uaTk);
  check('单位管理员：越权查询其他单位返回 0 条', r.status === 200 && r.data.total === 0, r.data && r.data.total);

  r = await api('GET', '/api/stats?' + q({ unit: U_P.name }), undefined, uaTk);
  check('单位管理员：看板按父单位汇总含下级（4 条）', r.status === 200 && r.data.total === 4, r.data && r.data.total);

  /* ---------------- 4. 下级单位只读 ---------------- */
  r = await api('PUT', '/api/assets/' + aP1.id, { name: '层级测试-本单位改名' }, uaTk);
  check('单位管理员：可修改本单位资产', r.status === 200, r.data);

  r = await api('PUT', '/api/assets/' + aC.id, { name: '越权改名' }, uaTk);
  check('单位管理员：不能修改下级单位资产（403）', r.status === 403 && /只读/.test(r.data.error || ''), r.data);

  r = await api('DELETE', '/api/assets/' + aG.id, undefined, uaTk);
  check('单位管理员：不能删除下级单位资产（403）', r.status === 403, r.data);

  r = await api('PUT', '/api/assets/' + aC.id + '/geo', { lng: 106.55, lat: 29.58 }, uaTk);
  check('单位管理员：不能标注下级单位资产（403）', r.status === 403, r.data);

  r = await api('POST', '/api/assets', { name: '越权新增', assetNo: 'ORG-T-X1', unit: U_G.name }, uaTk);
  check('单位管理员：不能向下级单位新增资产（403）', r.status === 403, r.data);

  r = await api('POST', '/api/assets', { name: '越权新增2', assetNo: 'ORG-T-X2', unit: U_O.name }, uaTk);
  check('单位管理员：不能向其他单位新增资产（403）', r.status === 403, r.data);

  r = await api('POST', '/api/assets/batch-delete', { ids: [aP2.id, aC.id] }, uaTk);
  check('批量删除：本单位删掉、下级被跳过', r.status === 200 && r.data.removed === 1 && r.data.denied === 1, r.data);

  r = await api('GET', '/api/assets/' + aG.id, undefined, uaTk);
  check('单位管理员：可查看下级资产详情且标记只读', r.status === 200 && r.data.readonly === true, r.data && r.data.readonly);

  /* ---------------- 5. 用户 ↔ 单位对应关系 ---------------- */
  r = await api('GET', '/api/users', undefined, uaTk);
  const names = (r.data.rows || []).map((u) => u.username);
  check('单位管理员：看不到系统管理员账号', names.indexOf('admin') < 0, names);
  check('单位管理员：看不到其他单位的用户', names.indexOf('org_other') < 0, names);
  check('单位管理员：可见本人账号', names.indexOf('org_ua') >= 0, names);

  r = await api('POST', '/api/users', { username: 'org_bad1', role: 'admin', unitId: U_P.id, password: 'test123456' }, uaTk);
  check('单位管理员：不能创建系统管理员账号（403）', r.status === 403, r.data);

  r = await api('POST', '/api/users', { username: 'org_bad2', role: 'viewer', unitId: U_O.id, password: 'test123456' }, uaTk);
  check('单位管理员：不能创建其他单位的用户（403）', r.status === 403, r.data);

  r = await api('POST', '/api/users', { username: 'org_child', role: 'viewer', unitId: U_C.id, password: 'test123456' }, uaTk);
  check('单位管理员：可为下级单位创建用户（200）', r.status === 200 && r.data.user.unit === U_C.name, r.data);

  const adminId = (await api('GET', '/api/users', undefined, tk)).data.rows.find((u) => u.username === 'admin').id;
  r = await api('PUT', '/api/users/' + adminId, { name: '被篡改' }, uaTk);
  check('单位管理员：不能修改系统管理员（403）', r.status === 403, r.data);
  r = await api('DELETE', '/api/users/' + adminId, undefined, uaTk);
  check('单位管理员：不能删除系统管理员（403）', r.status === 403, r.data);

  r = await api('PUT', '/api/users/' + otherR.data.user.id, { name: '越权改名' }, uaTk);
  check('单位管理员：不能修改其他单位的用户（403）', r.status === 403, r.data);

  r = await api('POST', '/api/users', { username: 'org_nounit', role: 'viewer', password: 'test123456' }, uaTk);
  check('非系统管理员账号必须绑定单位（被拒绝）', r.status === 400 || r.status === 403, r.data);

  /* ---------------- 清理 ---------------- */
  const cleanup = [];
  for (const no of ['ORG-T-P1', 'ORG-T-P2', 'ORG-T-C1', 'ORG-T-G1', 'ORG-T-O1']) {
    const got = await api('GET', '/api/assets?' + q({ q: no, pageSize: 'all' }), undefined, tk);
    (got.data.rows || []).forEach((a) => cleanup.push(api('DELETE', '/api/assets/' + a.id, undefined, tk)));
  }
  await Promise.all(cleanup);
  for (const un of ['org_ua', 'org_other', 'org_child', 'org_bad1', 'org_bad2', 'org_nounit']) {
    const got = await api('GET', '/api/users', undefined, tk);
    const row = (got.data.rows || []).find((u) => u.username === un);
    if (row) await api('DELETE', '/api/users/' + row.id, undefined, tk);
  }
  // 先删下级再删上级
  for (const u of [U_G, U_C, U_O, U_P]) await api('DELETE', '/api/units/' + u.id, undefined, tk);

  const left = await api('GET', '/api/units', undefined, tk);
  check('清理：测试单位已删除', (left.data.rows || []).every((u) => !/^ORG测试/.test(u.name)), left.data.rows && left.data.rows.map((u) => u.name));

  console.log(`\n== 通过 ${pass} / 失败 ${fail} ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
