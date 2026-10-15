'use strict';
/**
 * 房屋土地信息系统 —— 后端服务
 * 零第三方依赖，仅使用 Node 内置模块。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const store = require('./lib/store.js');
const auth = require('./lib/auth.js');
const org = require('./lib/org.js');
const schema = require('./lib/schema.js');
const mapcfg = require('./lib/mapconfig.js');
const reportcfg = require('./lib/reportcfg.js');
const report = require('./lib/report.js');
const images = require('./lib/images.js');
const time = require('./lib/time.js');
const repo = require('./lib/repo.js');
const orgcache = require('./lib/orgcache.js');
const mysqldb = require('./lib/mysql.js');
const { parseXlsx } = require('./lib/xlsx.js');
const { buildXlsx, buildCsv } = require('./lib/xlsx-writer.js');

const PORT = Number(process.env.PORT || 8789);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');

/**
 * 启动引导。MySQL 版不再把整个库读进内存，启动时只做三件事：
 *   1. 载入（或生成）签名盐值，供登录令牌使用；
 *   2. 载入单位缓存，供权限判断与单位树使用；
 *   3. 空库时补齐默认账号。
 */
async function bootstrap() {
  await store.initSecret();
  await orgcache.refresh();
  await auth.ensureDefaultUsers();
  await auth.ensureUnitAdminDemo(); // 已存在的系统补一个单位管理员示例账号
  await auth.ensureUnitBound();     // 历史账号补齐所属单位（未绑定的非管理员会看不到任何数据）
  await orgcache.refresh();         // 账号绑定情况可能变化，再刷一次
}

/* ------------------------------ HTTP 工具 ------------------------------ */

function sendJson(res, code, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  });
  res.end(body);
}

const ok = (res, data) => sendJson(res, 200, data || { ok: true });
const fail = (res, code, msg, extra) => sendJson(res, code, Object.assign({ error: msg }, extra || {}));

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) { fail(res, 404, '文件不存在'); return; }
    res.writeHead(200, {
      'Content-Type': type || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/* ------------------------------ 查询与统计工具 ------------------------------ */

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }


/** 无权限修改资产时的统一提示（区分「越权单位」与「下级单位只读」） */
function writeDenyMsg(me, asset) {
  if (org.isSysAdmin(me)) return '无权操作该数据';
  return org.canRead(me, asset)
    ? '下级单位数据为只读，只能查看，不能修改'
    : '无权操作其他单位的数据';
}




function districtOf(a) {
  const s = String(a.location || a.name || '');
  const m = s.match(/([一-龥]{2,6}(?:区|县|市))/);
  return m ? m[1] : '未识别';
}

/* ------------------------------ 导入缓存 ------------------------------ */

const importCache = new Map();
const IMPORT_TTL = 30 * 60 * 1000;

function detectHeaderRow(rows) {
  let best = -1, bestScore = 0;
  const scan = Math.min(30, rows.length);
  for (let i = 0; i < scan; i++) {
    const score = rows[i].filter((c) => c != null && schema.matchField(c)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return bestScore >= 3 ? best : -1;
}

/** 说明行 / 小计行的首列特征词 */
const ROW_MARKERS = /^(序号|行次|编号|次序|填表说明|填写说明|说明|备注|注[:：]?|合计|总计|小计|合\s*计)/;

/** 从工作表矩阵中抽取记录 */
function extractRecords(rows, headerRowIndex, colMap) {
  const records = [];
  const skipped = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.every((v) => v === null || v === undefined || v === '')) continue;

    const first = r[0] == null ? '' : String(r[0]).trim();
    if (first && ROW_MARKERS.test(first)) {
      skipped.push({ row: i + 1, reason: '说明行/序号行', sample: first.slice(0, 20) });
      continue;
    }

    const obj = {};
    colMap.forEach((k, ci) => { if (k) obj[k] = schema.coerce(k, r[ci]); });
    if (!obj.name && !obj.sysName && !obj.assetNo) {
      skipped.push({ row: i + 1, reason: '资产名称/编号均为空', sample: String(r[1] || '').slice(0, 20) });
      continue;
    }
    obj._row = i + 1;
    records.push(obj);
  }
  return { records, skipped };
}

/* ------------------------------ 资产读写 ------------------------------ */

function sanitizeAsset(input, base) {
  const out = base || {};
  for (const f of schema.FIELDS) {
    if (f.key === 'lng' || f.key === 'lat') continue; // 坐标由地图模块单独维护
    if (!(f.key in input)) continue;
    out[f.key] = schema.coerce(f.key, input[f.key]);
  }
  if (Number.isFinite(input.lng)) out.lng = Number(input.lng);
  if (Number.isFinite(input.lat)) out.lat = Number(input.lat);
  if (Array.isArray(input.polygon)) out.polygon = input.polygon.slice(0, 200);
  if (input.geoAddress !== undefined) out.geoAddress = String(input.geoAddress || '').slice(0, 200) || null;
  return out;
}

async function findById(id) { return repo.assets.byId(id); }

/* ------------------------------ 路由 ------------------------------ */

const routes = [];
const route = (method, re, handler) => routes.push({ method, re, handler });

async function requireAuth(req, res) {
  const user = await auth.userFromRequest(req);
  if (!user) { fail(res, 401, '未登录或登录已过期'); return null; }
  return user;
}

async function requirePerm(req, res, perm) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (!auth.can(user, perm)) { fail(res, 403, `当前角色无「${perm}」权限`); return null; }
  return user;
}

/* ---- 健康检查 ---- */
route('GET', /^\/api\/health$/, async (req, res) => {
  const [assets, users] = await Promise.all([repo.assets.count(), repo.users.count()]);
  ok(res, { ok: true, time: time.nowIso(), assets, users });
});

/* ---- 登录 / 登出 / 当前用户 ---- */
route('POST', /^\/api\/auth\/login$/, async (req, res) => {
  let body;
  try { body = JSON.parse((await readBody(req, 8192)).toString('utf8')); }
  catch (e) { return fail(res, 400, '请求格式错误'); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = await repo.users.byUsername(username);
  if (!user || user.disabled) return fail(res, 401, '用户名或密码错误');
  if (auth.hashPassword(password, user.salt) !== user.hash) return fail(res, 401, '用户名或密码错误');
  await repo.users.touchLogin(user.id);
  await store.log(user, '登录', '系统', `IP ${(req.socket.remoteAddress || '').replace('::ffff:', '')}`);
  ok(res, { token: auth.createToken(user), user: auth.publicUser(user), ttl: auth.TOKEN_TTL });
});

route('GET', /^\/api\/auth\/me$/, async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const row = await repo.users.byId(user.id);
  ok(res, { user: auth.publicUser(row || user) });
});

route('POST', /^\/api\/auth\/logout$/, async (req, res) => {
  const user = await auth.userFromRequest(req);
  if (user) await store.log(user, '退出', '系统', '');
  ok(res, { ok: true });
});

route('POST', /^\/api\/auth\/change-password$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  let body;
  try { body = JSON.parse((await readBody(req, 8192)).toString('utf8')); }
  catch (e) { return fail(res, 400, '请求格式错误'); }
  const u = await repo.users.byId(me.id);
  if (!u) return fail(res, 404, '用户不存在');
  if (auth.hashPassword(String(body.oldPassword || ''), u.salt) !== u.hash) return fail(res, 400, '原密码不正确');
  const np = String(body.newPassword || '');
  if (np.length < 6) return fail(res, 400, '新密码至少 6 位');
  const s = auth.salt();
  await repo.users.update(me.id, { salt: s, hash: auth.hashPassword(np, s) });
  await store.log(u, '修改密码', u.username, '');
  ok(res, { ok: true });
});

/* ---- 用户管理（用户 ↔ 单位对应关系） ---- */

/** 解析请求里的所属单位：优先 unitId，其次单位名称；都没有则不绑定（仅系统管理员可用） */
function resolveUserUnit(b) {
  if (b && b.unitId) {
    const u = org.unitById(String(b.unitId));
    if (u) return { id: u.id, name: u.name };
  }
  const name = String((b && b.unit) || '').trim();
  if (!name) return null;
  const u = org.unitByName(name);
  return { id: u ? u.id : '', name };
}

/** 校验操作者是否有权把用户分配到该单位 */
function checkAssignUnit(me, target) {
  if (org.isSysAdmin(me)) return null;
  if (!org.unitOfUser(me)) return null; // 未绑定单位的历史账号：沿用宽松行为
  if (!target) return '非系统管理员账号必须绑定所属单位';
  if (!org.canReadUnit(me, target.name)) return '只能把用户分配到本单位或其下级单位';
  return null;
}

route('GET', /^\/api\/users$/, async (req, res) => {
  const me = await requirePerm(req, res, 'user');
  if (!me) return;
  // 单位管理员只看得到本单位及下级单位的用户；系统管理员看全部
  const all = await repo.users.list();
  const rows = all.filter((u) => org.manageableUser(me, u) || u.id === me.id);
  ok(res, {
    rows: rows.map(auth.publicUser),
    roles: auth.ROLES,
    systemOnlyRoles: auth.SYSTEM_ONLY_ROLES,
    scopeUnit: (org.unitOfUser(me) || {}).name || '',
  });
});

route('POST', /^\/api\/users$/, async (req, res) => {
  const me = await requirePerm(req, res, 'user');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const username = String(b.username || '').trim();
  if (!username) return fail(res, 400, '用户名不能为空');
  if (await repo.users.existsUsername(username)) return fail(res, 400, '用户名已存在');
  if (!auth.ROLES[b.role]) return fail(res, 400, '角色不合法');
  if (auth.SYSTEM_ONLY_ROLES.includes(b.role) && !org.isSysAdmin(me)) {
    return fail(res, 403, '只有系统管理员可以创建系统管理员账号');
  }
  const target = resolveUserUnit(b);
  const deny = checkAssignUnit(me, target);
  if (deny) return fail(res, 403, deny);
  // 系统管理员可酌情建「不绑定单位」的账号（视为全量可见）；其余角色必须绑定单位
  if (!org.isSysAdmin(me)) {
    if (b.role !== 'admin' && !target) return fail(res, 400, '非系统管理员账号必须指定所属单位');
    if (b.role !== 'admin' && target && !org.unitByName(target.name)) return fail(res, 400, '所属单位无效，请从单位列表中选择');
  }
  const s = auth.salt();
  const u = {
    id: await store.nextId('user'), username, name: String(b.name || username), role: b.role,
    unit: target ? target.name : '', unitId: target ? target.id : '',
    salt: s, hash: auth.hashPassword(String(b.password || '123456'), s),
    createdAt: time.nowIso(), lastLoginAt: null, disabled: false,
  };
  await repo.users.create(u);
  await store.log(me, '新增用户', username, `角色 ${auth.ROLES[b.role].label}${u.unit ? ' · ' + u.unit : ''}`);
  ok(res, { user: auth.publicUser(u) });
});

route('PUT', /^\/api\/users\/([^/]+)$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'user');
  if (!me) return;
  const u = await repo.users.byId(m[1]);
  if (!u) return fail(res, 404, '用户不存在');
  if (!org.manageableUser(me, u)) return fail(res, 403, '无权管理该用户（仅系统管理员可管理系统管理员，其余只能管理本单位及下级单位的用户）');
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }

  if (b.role !== undefined) {
    if (!auth.ROLES[b.role]) return fail(res, 400, '角色不合法');
    if (auth.SYSTEM_ONLY_ROLES.includes(b.role) && !org.isSysAdmin(me)) {
      return fail(res, 403, '只有系统管理员可以设置系统管理员角色');
    }
    u.role = b.role;
  }
  if (b.unit !== undefined || b.unitId !== undefined) {
    const target = resolveUserUnit(b);
    const deny = checkAssignUnit(me, target);
    if (deny) return fail(res, 403, deny);
    u.unit = target ? target.name : '';
    u.unitId = target ? target.id : '';
  }
  const patch = {};
  if (b.role !== undefined) patch.role = u.role;
  if (b.unit !== undefined || b.unitId !== undefined) { patch.unit = u.unit; patch.unitId = u.unitId; }
  if (b.name !== undefined) patch.name = String(b.name);
  if (b.disabled !== undefined) patch.disabled = !!b.disabled;
  if (b.password) { patch.salt = auth.salt(); patch.hash = auth.hashPassword(String(b.password), patch.salt); }

  if (!org.isSysAdmin(me)) {
    const role = patch.role === undefined ? u.role : patch.role;
    const unit = patch.unit === undefined ? u.unit : patch.unit;
    if (role !== 'admin' && !unit) return fail(res, 400, '非系统管理员账号必须指定所属单位');
    if (role !== 'admin' && unit && !org.unitByName(unit)) return fail(res, 400, '所属单位无效，请从单位列表中选择');
  }

  Object.assign(u, patch);
  await repo.users.update(m[1], patch);

  await store.log(me, '修改用户', u.username, `角色 ${(auth.ROLES[u.role] || {}).label || u.role}${u.unit ? ' · ' + u.unit : ''}`);
  ok(res, { user: auth.publicUser(u) });
});

route('DELETE', /^\/api\/users\/([^/]+)$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'user');
  if (!me) return;
  const removed = await repo.users.byId(m[1]);
  if (!removed) return fail(res, 404, '用户不存在');
  if (removed.id === me.id) return fail(res, 400, '不能删除当前登录账号');
  if (!org.manageableUser(me, removed)) return fail(res, 403, '无权删除该用户');
  await repo.users.remove(m[1]);
  await store.log(me, '删除用户', removed.username, '');
  ok(res, { ok: true });
});

/* ---- 单位管理（层级：上级 / 下级） ---- */

/** 统一的单位行（含层级信息）；资产条数由数据层 GROUP BY 得出 */
async function unitRows(me) {
  const rows = org.treeRows(null);
  const assetCount = await repo.units.assetCounts();
  rows.forEach((r) => { r.assetCount = assetCount[r.name] || 0; });
  return rows;
}

route('GET', /^\/api\/units$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  ok(res, {
    rows: await unitRows(me),
    // 当前用户可切换查看的单位（空数组 = 不限，系统管理员 / 未绑定单位）
    visible: org.visibleUnitNames(me) ? [...org.visibleUnitNames(me)] : null,
  });
});

route('POST', /^\/api\/units$/, async (req, res) => {
  const me = await requirePerm(req, res, 'unit'); // 单位层级仅系统管理员可维护
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, '单位名称不能为空');
  if (await repo.units.existsName(name)) return fail(res, 400, '该单位已存在');
  const parentId = String(b.parent || '');
  if (parentId && !org.unitById(parentId)) return fail(res, 400, '上级单位不存在');
  const u = {
    id: await store.nextId('unit'), name, code: String(b.code || ''),
    parent: parentId, sort: (await repo.units.count()) + 1,
  };
  await repo.units.create(u);
  await orgcache.refresh(); // 单位缓存变了，权限树要跟着变
  await store.log(me, '新增单位', name, parentId ? `上级：${org.unitById(parentId).name}` : '顶级单位');
  ok(res, { unit: u });
});

route('PUT', /^\/api\/units\/([^/]+)$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'unit');
  if (!me) return;
  const u = org.unitById(m[1]);
  if (!u) return fail(res, 404, '单位不存在');
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  if (b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) return fail(res, 400, '单位名称不能为空');
    if (await repo.units.existsName(name, u.id)) return fail(res, 400, '该单位已存在');
    const old = u.name;
    // 改名需同步历史数据中的单位名（资产与用户，同一事务）
    if (name !== old) await repo.units.renameCascade(old, name, u.id);
    u.name = name;
  }
  if (b.code !== undefined) u.code = String(b.code || '');
  if (b.sort !== undefined) u.sort = Number(b.sort) || 0;
  if (b.parent !== undefined) {
    const pid = String(b.parent || '');
    if (pid === u.id) return fail(res, 400, '上级单位不能是自己');
    if (pid && !org.unitById(pid)) return fail(res, 400, '上级单位不存在');
    if (pid && org.isDescendant(u, pid)) return fail(res, 400, '不能把上级单位设为自己的下级单位');
    u.parent = pid;
  }
  await repo.units.update(m[1], { name: u.name, code: u.code, sort: u.sort, parent: u.parent });
  await orgcache.refresh();
  await store.log(me, '修改单位', u.name, u.parent ? `上级：${(org.unitById(u.parent) || {}).name || ''}` : '顶级单位');
  ok(res, { unit: u });
});

route('DELETE', /^\/api\/units\/([^/]+)$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'unit');
  if (!me) return;
  const removed = await repo.units.byId(m[1]);
  if (!removed) return fail(res, 404, '单位不存在');
  const kids = org.childrenOf(removed.id);
  if (kids.length) return fail(res, 400, `该单位下仍有 ${kids.length} 个下级单位，请先调整或删除下级单位`);
  const counts = await repo.units.assetCounts();
  const used = counts[removed.name] || 0;
  if (used) return fail(res, 400, `该单位下仍有 ${used} 条资产，不能删除`);
  await repo.units.remove(m[1]);
  // 清理失效的单位引用
  await repo.units.clearRefs(removed.id);
  await orgcache.refresh();
  await store.log(me, '删除单位', removed.name, '');
  ok(res, { ok: true });
});

/* ---- 资产列表 / 详情 ---- */
route('GET', /^\/api\/assets$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  const u = new URL(req.url, 'http://localhost');
  const q = u.searchParams;
  // 筛选 / 排序 / 分页全部交给数据库完成
  const r = await repo.assets.search(q, org.unitScope(me));
  ok(res, r);
});

route('GET', /^\/api\/assets\/([^/]+)$/, async (req, res, m) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  const a = await findById(m[1]);
  if (!a) return fail(res, 404, '资产不存在');
  if (!org.canRead(me, a)) return fail(res, 403, '无权访问该单位数据');
  ok(res, { asset: a, readonly: !org.canWrite(me, a) });
});

route('POST', /^\/api\/assets$/, async (req, res) => {
  const me = await requirePerm(req, res, 'write');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, '资产名称不能为空');
  const assetNo = String(b.assetNo || '').trim();
  if (assetNo && await repo.assets.existsAssetNo(assetNo)) return fail(res, 400, `资产编号 ${assetNo} 已存在`);
  const now = time.nowIso();
  const a = { id: await store.nextId('asset'), createdAt: now, updatedAt: now, createdBy: me.name, updatedBy: me.name };
  sanitizeAsset(b, a);
  const myUnit = org.unitOfUser(me);
  if (myUnit && !a.unit) a.unit = myUnit.name;
  // 只能往自己有写权限的单位新增（系统管理员不受限）
  if (!org.canWriteUnit(me, a.unit)) {
    return fail(res, 403, org.canReadUnit(me, a.unit)
      ? '下级单位为只读，不能在该单位下新增资产'
      : `不能为其他单位（${a.unit || '未填写'}）新增资产`);
  }
  await repo.assets.create(a);
  await store.log(me, '新增资产', name, a.unit || '');
  ok(res, { asset: a });
});

route('PUT', /^\/api\/assets\/([^/]+)$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'write');
  if (!me) return;
  const a = await findById(m[1]);
  if (!a) return fail(res, 404, '资产不存在');
  if (!org.canWrite(me, a)) return fail(res, 403, writeDenyMsg(me, a));
  let b; try { b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  // 不允许把资产改挂到其他单位（含下级单位：下级只读）
  if (b.unit !== undefined && String(b.unit || '') !== String(a.unit || '') && !org.canWriteUnit(me, b.unit)) {
    return fail(res, 403, org.canReadUnit(me, b.unit)
      ? '不能将资产改挂到只读的下级单位'
      : `不能将资产改挂到其他单位（${b.unit || '未填写'}）`);
  }
  if (b.assetNo && String(b.assetNo) !== a.assetNo && await repo.assets.existsAssetNo(String(b.assetNo))) {
    return fail(res, 400, `资产编号 ${b.assetNo} 已存在`);
  }
  const before = {};
  for (const f of schema.FIELDS) before[f.key] = a[f.key];
  sanitizeAsset(b, a);
  a.updatedAt = time.nowIso();
  a.updatedBy = me.name;
  const changed = schema.FIELDS.filter((f) => JSON.stringify(before[f.key]) !== JSON.stringify(a[f.key])).map((f) => f.label);
  await repo.assets.update(m[1], a);
  await store.log(me, '修改资产', a.name || a.id, changed.length ? `修改字段：${changed.slice(0, 8).join('、')}${changed.length > 8 ? ' 等' : ''}` : '无字段变化');
  ok(res, { asset: a, changed: changed.length });
});

route('DELETE', /^\/api\/assets\/([^/]+)$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'delete');
  if (!me) return;
  const removed = await repo.assets.byId(m[1]);
  if (!removed) return fail(res, 404, '资产不存在');
  if (!org.canWrite(me, removed)) return fail(res, 403, writeDenyMsg(me, removed));
  await repo.assets.remove(m[1]);
  if (removed) await images.removeAsset(removed.id); // 连带清理图片
  await store.log(me, '删除资产', removed.name || removed.id, '');
  ok(res, { ok: true });
});

route('POST', /^\/api\/assets\/batch-delete$/, async (req, res) => {
  const me = await requirePerm(req, res, 'delete');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const ids = new Set((b.ids || []).map(String));
  let removed = 0, denied = 0;
  // 先按权限挑出可删除的 id，再一次性交给数据库删除
  const candidates = await repo.assets.byIds([...ids]);
  const removable = [];
  for (const a of candidates) {
    if (!org.canWrite(me, a)) { denied++; continue; }
    removable.push(a.id);
    removed++;
  }
  for (const id of removable) await images.removeAsset(id); // 连带清理图片
  if (removable.length) await repo.assets.removeIds(removable);
  await store.log(me, '批量删除', `${removed} 条`, denied ? `${denied} 条因单位权限被跳过` : '');
  ok(res, { removed, denied });
});

/* ---- 房产图片（每条资产最多 3 张，单张 ≤ 2MB） ---- */

/** 取资产并按可见/可写权限校验，返回 { asset } 或 { error, code } */
async function assetForImage(me, id, needWrite) {
  const a = await findById(id);
  if (!a) return { error: '资产不存在', code: 404 };
  if (!org.canRead(me, a)) return { error: '无权访问该单位数据', code: 403 };
  if (needWrite && !org.canWrite(me, a)) return { error: writeDenyMsg(me, a), code: 403 };
  return { asset: a };
}

route('GET', /^\/api\/assets\/([^/]+)\/images$/, async (req, res, m) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  const r = await assetForImage(me, m[1], false);
  if (r.error) return fail(res, r.code, r.error);
  ok(res, {
    assetId: r.asset.id,
    images: (await images.ofAsset(r.asset.id)).map(images.view),
    max: images.MAX_COUNT, maxSize: images.MAX_SIZE, labels: images.LABELS,
  });
});

route('POST', /^\/api\/assets\/([^/]+)\/images$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'write');
  if (!me) return;
  const r = await assetForImage(me, m[1], true);
  if (r.error) return fail(res, r.code, r.error);
  let b; try { b = JSON.parse((await readBody(req, 8 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  try {
    const img = await images.add(r.asset.id, b, me);
    await store.log(me, '上传房产图片', r.asset.name || r.asset.id, `${img.label}｜${Math.round(img.size / 1024)}KB`);
    ok(res, { image: img, images: (await images.ofAsset(r.asset.id)).map(images.view) });
  } catch (e) { fail(res, 400, e.message); }
});

route('PUT', /^\/api\/assets\/([^/]+)\/images\/([^/]+)$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'write');
  if (!me) return;
  const r = await assetForImage(me, m[1], true);
  if (r.error) return fail(res, r.code, r.error);
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const img = await images.setLabel(r.asset.id, m[2], b && b.label);
  if (!img) return fail(res, 404, '图片不存在');
  ok(res, { image: img });
});

route('DELETE', /^\/api\/assets\/([^/]+)\/images\/([^/]+)$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'write');
  if (!me) return;
  const r = await assetForImage(me, m[1], true);
  if (r.error) return fail(res, r.code, r.error);
  if (!(await images.remove(r.asset.id, m[2]))) return fail(res, 404, '图片不存在');
  await store.log(me, '删除房产图片', r.asset.name || r.asset.id, '');
  ok(res, { ok: true });
});

/** 图片二进制：<img src> 无法带 Authorization 头，允许用 ?token= 携带令牌 */
route('GET', /^\/api\/assets\/([^/]+)\/images\/([^/]+)\/raw$/, async (req, res, m) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  const r = await assetForImage(me, m[1], false);
  if (r.error) return fail(res, r.code, r.error);
  const f = await images.readFile(r.asset.id, m[2]);
  if (!f) return fail(res, 404, '图片不存在');
  res.writeHead(200, {
    'Content-Type': f.mime,
    'Content-Length': f.buf.length,
    'Cache-Control': 'private, max-age=600',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(f.buf);
});

/** 批量取多条资产的图片（地图/预览页一次拉齐，避免逐条请求） */
route('GET', /^\/api\/images$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  const u = new URL(req.url, 'http://localhost');
  const ids = String(u.searchParams.get('ids') || '');
  const want = ids ? ids.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const mine = await repo.assets.listIds(u.searchParams, org.unitScope(me));
  const allow = want ? want.filter((id) => mine.indexOf(id) >= 0) : mine;
  ok(res, { map: await images.groupBy(allow), max: images.MAX_COUNT, maxSize: images.MAX_SIZE });
});

/* ---- 地图标注 ---- */
route('PUT', /^\/api\/assets\/([^/]+)\/geo$/, async (req, res, m) => {
  const me = await requirePerm(req, res, 'geo');
  if (!me) return;
  const a = await findById(m[1]);
  if (!a) return fail(res, 404, '资产不存在');
  if (!org.canWrite(me, a)) return fail(res, 403, writeDenyMsg(me, a));
  let b; try { b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  if (b.lng === null || b.lat === null) {
    a.lng = null; a.lat = null; a.polygon = null;
    a.geoAt = null; a.geoBy = null;
  } else {
    const lng = Number(b.lng), lat = Number(b.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return fail(res, 400, '坐标不合法');
    if (lng < 73 || lng > 136 || lat < 3 || lat > 54) return fail(res, 400, '坐标超出中国境内范围');
    a.lng = Math.round(lng * 1e6) / 1e6;
    a.lat = Math.round(lat * 1e6) / 1e6;
    a.polygon = Array.isArray(b.polygon) ? b.polygon.filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat)).slice(0, 200) : null;
    if (b.address) a.geoAddress = String(b.address).slice(0, 200);
    a.geoAt = time.nowIso();
    a.geoBy = me.name;
  }
  a.updatedAt = time.nowIso();
  a.updatedBy = me.name;
  await repo.assets.update(m[1], a);
  await store.log(me, a.lng ? '地图标注' : '清除标注', a.name || a.id, a.lng ? `${a.lng},${a.lat}` : '');
  ok(res, { asset: a });
});

route('POST', /^\/api\/assets\/geo\/batch$/, async (req, res) => {
  const me = await requirePerm(req, res, 'geo');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 4 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const items = Array.isArray(b.items) ? b.items : [];
  let done = 0;
  const now = time.nowIso();
  for (const it of items) {
    const a = await findById(String(it.id));
    if (!a) continue;
    if (!org.canWrite(me, a)) continue;
    if (!Number.isFinite(Number(it.lng)) || !Number.isFinite(Number(it.lat))) continue;
    a.lng = Math.round(Number(it.lng) * 1e6) / 1e6;
    a.lat = Math.round(Number(it.lat) * 1e6) / 1e6;
    if (it.address) a.geoAddress = String(it.address).slice(0, 200);
    a.geoAt = now; a.geoBy = me.name; a.updatedAt = now; a.updatedBy = me.name;
    await repo.assets.update(a.id, a);
    done++;
  }
  await store.log(me, '批量地理编码', `${done} 条`, '');
  ok(res, { updated: done });
});

/* ---- 统计看板 ---- */
route('GET', /^\/api\/stats$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  // 支持按当前单位（unit）等条件统计，供左侧单位树切换后刷新看板
  const u = new URL(req.url, 'http://localhost');
  const q = u.searchParams;
  const scope = org.unitScope(me);

  // 主指标：一条聚合 SQL 出结果；分组统计走 GROUP BY
  const base = await repo.assets.stats(q, scope);
  const [byCategory, byUseStatus, byUnit, byPurpose] = await Promise.all([
    repo.assets.groupBy('category', q, scope),
    repo.assets.groupBy('useStatus', q, scope),
    repo.assets.groupBy('unit', q, scope),
    repo.assets.groupBy('purpose', q, scope),
  ]);
  const [byUseUnit, byTitleForm] = await Promise.all([
    repo.assets.groupBy('useUnit', q, scope, 12),
    repo.assets.groupBy('titleType', q, scope, 10),
  ]);

  // 区县只能靠正则从地址里提取，数据库做不到，因此只取 location 一列在内存里归类
  const districtMap = new Map();
  const drows = await repo.assets.districtRows(q, scope);
  for (const r of drows) {
    const d = districtOf({ location: r.location, name: r.name });
    let g = districtMap.get(d);
    if (!g) { g = { name: d, count: 0, area: 0 }; districtMap.set(d, g); }
    g.count += 1;
    g.area += Number(r.area || 0);
  }
  const byDistrict = [...districtMap.values()]
    .map((g) => ({ name: g.name, count: g.count, area: Math.round(g.area * 100) / 100 }))
    .sort((a, b) => b.count - a.count);

  const recent = await repo.assets.recent(q, scope, 8);

  ok(res, Object.assign({}, base, {
    byCategory, byUseStatus, byUnit, byUseUnit, byPurpose, byTitleForm, byDistrict, recent,
  }));
});

/* ---- 分析报告：按模板自动汇总生成 ---- */
route('GET', /^\/api\/report$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  const u = new URL(req.url, 'http://localhost');
  const list = await repo.assets.listAll(u.searchParams, org.unitScope(me));
  const unitNames = [];
  list.forEach((a) => { const n = String(a.unit || ''); if (n && unitNames.indexOf(n) < 0) unitNames.push(n); });
  const scopeLabel = String(u.searchParams.get('unit') || '').trim()
    || (unitNames.length === 1 ? unitNames[0] : (unitNames.length ? '多个单位' : '全部单位'));
  const r = await report.build(list, { unitNames, scopeLabel, params: {} });
  ok(res, r);
});

/* ---- 系统设置：分析报告参数 ---- */
route('GET', /^\/api\/settings\/report$/, async (req, res) => {
  const me = await requireSysAdmin(req, res);
  if (!me) return;
  ok(res, await reportcfg.view());
});

route('PUT', /^\/api\/settings\/report$/, async (req, res) => {
  const me = await requireSysAdmin(req, res);
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const before = await reportcfg.get();
  const next = await reportcfg.set(b || {});
  const changed = reportcfg.PARAMS
    .filter((p) => String(next[p.key]) !== String(before[p.key]))
    .map((p) => `${p.label}：${before[p.key] === '' ? '（空）' : before[p.key]} → ${next[p.key] === '' ? '（空）' : next[p.key]}`);
  await store.log(me, '修改系统设置', '分析报告参数', changed.join('；') || '无变化');
  ok(res, { values: next });
});

/* ---- 枚举选项（含数据中已出现的值） ---- */
route('GET', /^\/api\/options$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  // 枚举候选值：已出现过的值用 DISTINCT 查，不再把资产读进内存扫描
  const scope = org.unitScope(me);
  const dyn = async (field) => {
    const vals = await repo.assets.distinct(field, scope);
    return vals.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  };
  const fields = [];
  for (const f of schema.FIELDS) {
    const extra = f.type === 'enum' ? await dyn(f.key) : [];
    const opts = [...new Set([...(f.options || []), ...extra])];
    fields.push({ key: f.key, label: f.label, type: f.type, group: f.group, unit: f.unit || '', options: opts });
  }
  const vis = org.visibleUnitNames(me);
  const meRow = await repo.users.byId(me.id);
  const myUnit = org.unitOfUser(me);
  const unitList = await repo.units.list();
  ok(res, {
    fields,
    groups: schema.GROUPS,
    units: unitList.filter((u) => !vis || vis.has(u.name)).map((u) => u.name),
    unitTree: org.treeRows(vis),
    roles: auth.ROLES,
    systemOnlyRoles: auth.SYSTEM_ONLY_ROLES,
    me: Object.assign(auth.publicUser(meRow || me), {
      unitPath: myUnit ? org.pathOf(myUnit) : '',
      canWriteUnits: org.writableUnitNames(me) ? [...org.writableUnitNames(me)] : null,
      canReadUnits: vis ? [...vis] : null,
    }),
  });
});

/* ------------------------------ 系统设置：地图服务 ------------------------------ */

/** 仅系统管理员可修改系统设置 */
async function requireSysAdmin(req, res) {
  const me = await requireAuth(req, res);
  if (!me) return null;
  if (!org.isSysAdmin(me)) { fail(res, 403, '仅系统管理员可修改系统设置'); return null; }
  return me;
}

/** 前端地图加载用：当前服务商 + Key + 默认视野（所有登录用户可读） */
route('GET', /^\/api\/map\/config$/, async (req, res) => {
  if (!(await requireAuth(req, res))) return;
  ok(res, { map: await mapcfg.publicConfig() });
});

/** 设置页读取（完整配置 + 服务商注册指引），仅系统管理员 */
route('GET', /^\/api\/settings\/map$/, async (req, res) => {
  const me = await requireSysAdmin(req, res);
  if (!me) return;
  ok(res, await mapcfg.adminView());
});

route('PUT', /^\/api\/settings\/map$/, async (req, res) => {
  const me = await requireSysAdmin(req, res);
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const before = await mapcfg.get();
  const next = await mapcfg.set({
    provider: b.provider,
    keys: b.keys,
    center: b.center,
  });
  const changed = [];
  if (next.provider !== before.provider) {
    changed.push(`服务商 ${(mapcfg.PROVIDERS.find((p) => p.key === before.provider) || {}).name || before.provider} → ${(mapcfg.PROVIDERS.find((p) => p.key === next.provider) || {}).name || next.provider}`);
  }
  if (JSON.stringify(next.keys) !== JSON.stringify(before.keys)) changed.push('密钥已更新');
  if (JSON.stringify(next.center) !== JSON.stringify(before.center)) changed.push('默认视野已更新');
  await store.log(me, '修改系统设置', '地图服务', changed.join('；') || '无变化');
  ok(res, { map: next });
});

/** 连通性测试：用一次地理编码验证 Key 是否可用（不落库，便于先试后存） */
route('POST', /^\/api\/settings\/map\/test$/, async (req, res) => {
  const me = await requireSysAdmin(req, res);
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const provider = String(b.provider || mapcfg.get().provider);
  const key = String(b.key == null ? (mapcfg.get().keys[provider] || '') : b.key);
  const r = await mapcfg.testKey(provider, key);
  ok(res, r);
});

/* ---- 地理编码（服务端代理：天地图 / 腾讯 WebService） ---- */
route('GET', /^\/api\/geo\/geocode$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  const q = new URL(req.url, 'http://localhost').searchParams;
  const address = String(q.get('address') || '').trim();
  if (!address) return fail(res, 400, '缺少 address 参数');
  const r = await mapcfg.geocode(address);
  if (!r) return fail(res, 502, '地理编码未返回结果，请检查系统设置里的地图服务与密钥');
  ok(res, r);
});

/** 地点搜索（关键词 → 候选地点列表，供地图标注页定位使用） */
route('GET', /^\/api\/geo\/search$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  const q = new URL(req.url, 'http://localhost').searchParams;
  const keyword = String(q.get('keyword') || '').trim();
  if (!keyword) return fail(res, 400, '缺少 keyword 参数');
  const limit = Number(q.get('limit') || 10);
  const r = await mapcfg.search(keyword, limit);
  if (!r.ok) return fail(res, 502, r.msg || '地点搜索未返回结果，请检查系统设置里的地图服务与密钥');
  ok(res, { items: r.items });
});

route('GET', /^\/api\/geo\/reverse$/, async (req, res) => {
  const me = await requireAuth(req, res);
  if (!me) return;
  const q = new URL(req.url, 'http://localhost').searchParams;
  // 注意：Number('') === 0，不能只判 isFinite，必须先确认参数非空
  const lngRaw = q.get('lng');
  const latRaw = q.get('lat');
  const lng = Number(lngRaw);
  const lat = Number(latRaw);
  if (!lngRaw || !latRaw || !Number.isFinite(lng) || !Number.isFinite(lat)) return fail(res, 400, '缺少或无效的 lng / lat 参数');
  const addr = await mapcfg.reverse(lng, lat);
  ok(res, { address: addr || '' });
});

/* ---- 操作日志 ---- */
route('GET', /^\/api\/logs$/, async (req, res) => {
  const me = await requirePerm(req, res, 'user');
  if (!me) return;
  // 系统管理员看全部；单位管理员只看本单位及下级单位用户的操作记录
  const names = org.visibleUnitNames(me);
  const rows = await store.listLogs(300, names);
  ok(res, { rows });
});

/* ---- Excel 导入：预览 ---- */
route('POST', /^\/api\/import\/preview$/, async (req, res) => {
  const me = await requirePerm(req, res, 'import');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  if (!b.content) return fail(res, 400, '缺少文件内容');
  let buf;
  try { buf = Buffer.from(String(b.content).replace(/^data:[^;]*;base64,/, ''), 'base64'); }
  catch (e) { return fail(res, 400, '文件内容解析失败'); }

  let parsed;
  try { parsed = parseXlsx(buf); }
  catch (e) { return fail(res, 400, '无法解析该 Excel 文件：' + e.message); }

  const sheetName = b.sheet && parsed.sheets[b.sheet] ? b.sheet : parsed.sheetNames[0];
  const rows = parsed.sheets[sheetName] || [];
  const headerRowIndex = Number.isInteger(b.headerRow) && b.headerRow >= 0 ? b.headerRow : detectHeaderRow(rows);
  if (headerRowIndex < 0) return fail(res, 400, '未能识别表头行，请确认表格首行包含字段名');

  const headers = rows[headerRowIndex].map((h) => (h == null ? '' : String(h)));
  const colMap = schema.buildHeaderMap(headers);
  const { records, skipped } = extractRecords(rows, headerRowIndex, colMap);

  // 校验
  const seen = new Map();
  const issues = [];
  records.forEach((r, i) => {
    if (!r.name) issues.push({ row: r._row, level: 'warn', msg: '资产名称为空（将用系统内名称或编号兜底）' });
    const no = String(r.assetNo || '').trim();
    if (no) {
      if (seen.has(no)) issues.push({ row: r._row, level: 'error', msg: `资产编号 ${no} 与第 ${seen.get(no)} 行重复` });
      else seen.set(no, r._row);
    }
    if (!Number.isFinite(r.area) && !Number.isFinite(r.originalValue)) {
      issues.push({ row: r._row, level: 'info', msg: '面积与原值均为空，请核对' });
    }
  });

  const token = 'imp_' + crypto.randomBytes(12).toString('hex');
  importCache.set(token, {
    ts: Date.now(), sheetName, headerRowIndex, colMap, records, rows, user: me.username,
    fileName: String(b.fileName || ''),
  });
  if (importCache.size > 40) {
    const oldest = [...importCache.entries()].sort((a, b2) => a[1].ts - b[1].ts)[0];
    if (oldest) importCache.delete(oldest[0]);
  }

  ok(res, {
    token,
    fileName: b.fileName || '',
    sheetNames: parsed.sheetNames,
    sheetName,
    headerRowIndex,
    mapping: headers.map((h, i) => ({ col: i, header: h, key: colMap[i], label: (schema.FIELD_MAP.get(colMap[i]) || {}).label || null })),
    unmatched: headers.map((h, i) => (h && !colMap[i] ? i : -1)).filter((i) => i >= 0),
    preview: records.slice(0, 12),
    total: records.length,
    skipped,
    issues: issues.slice(0, 200),
    issueCount: issues.length,
  });
});

/* ---- Excel 导入：确认写入 ---- */
route('POST', /^\/api\/import\/commit$/, async (req, res) => {
  const me = await requirePerm(req, res, 'import');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const cache = importCache.get(String(b.token || ''));
  if (!cache) return fail(res, 400, '导入会话已过期，请重新上传文件');
  if (Date.now() - cache.ts > IMPORT_TTL) { importCache.delete(b.token); return fail(res, 400, '导入会话已过期，请重新上传文件'); }

  // 允许前端在确认前修正字段映射
  let records = cache.records;
  if (Array.isArray(b.mapping)) {
    const colMap = b.mapping.map((k) => (k ? String(k) : null));
    records = extractRecords(cache.rows, cache.headerRowIndex, colMap).records;
  }

  const mode = ['upsert', 'insert', 'replace'].includes(b.mode) ? b.mode : 'upsert';
  const defaultUnit = String(b.unit || '').trim();
  const now = time.nowIso();

  // 导入目标单位必须在本人的可写范围内（系统管理员不限）
  if (defaultUnit && !org.canWriteUnit(me, defaultUnit)) {
    return fail(res, 403, org.canReadUnit(me, defaultUnit)
      ? '下级单位为只读，不能向下级单位导入数据'
      : `不能向其他单位（${defaultUnit}）导入数据`);
  }
  if (defaultUnit && !(await repo.units.existsName(defaultUnit))) {
    if (!org.isSysAdmin(me)) return fail(res, 400, `单位「${defaultUnit}」尚未登记，请联系系统管理员在单位管理中登记`);
    await repo.units.create({
      id: await store.nextId('unit'), name: defaultUnit, code: '', parent: '',
      sort: (await repo.units.count()) + 1,
    });
    await orgcache.refresh();
  }

  const q = new URLSearchParams();

  if (mode === 'replace') {
    const before = await repo.assets.count();
    const writable = org.writableUnitNames(me);
    const gone = await repo.assets.listAll(q, writable);
    for (const a of gone) await images.removeAsset(a.id); // 连带清理被清空资产的图片
    await repo.assets.removeByUnits(writable ? [...writable] : null);
    await store.log(me, '清空数据', '导入前清空', `原有 ${before} 条`);
  }

  // 先把本批次涉及的资产编号一次性查出来，避免逐条查库
  const nos = records.map((r) => String(r.assetNo || '').trim()).filter(Boolean);
  const byNo = new Map();
  for (const a of await repo.assets.byAssetNos(nos)) byNo.set(String(a.assetNo), a);

  let created = 0, updated = 0, skipped = 0;
  for (const r of records) {
    const rec = Object.assign({}, r);
    delete rec._row;
    if (defaultUnit && !rec.unit) rec.unit = defaultUnit;
    const myUnit = org.unitOfUser(me);
    if (myUnit && !rec.unit) rec.unit = myUnit.name;
    if (!rec.name) rec.name = rec.sysName || rec.assetNo || '未命名资产';
    // 越权单位（含只读的下级单位）的记录一律跳过
    if (!org.canWriteUnit(me, rec.unit)) { skipped++; continue; }

    const no = String(rec.assetNo || '').trim();
    const exist = no ? byNo.get(no) : null;
    if (exist) {
      if (mode === 'insert') { skipped++; continue; }
      if (!org.canWrite(me, exist)) { skipped++; continue; }
      const next = Object.assign({}, exist);
      sanitizeAsset(rec, next);
      next.updatedAt = now;
      next.updatedBy = me.name;
      await repo.assets.update(exist.id, next);
      updated++;
    } else {
      const a = { id: await store.nextId('asset'), createdAt: now, updatedAt: now, createdBy: me.name, updatedBy: me.name };
      sanitizeAsset(rec, a);
      await repo.assets.create(a);
      if (a.assetNo) byNo.set(String(a.assetNo), a);
      created++;
    }
  }

  importCache.delete(b.token);
  await store.log(me, '导入数据', cache.fileName || 'Excel', `新增 ${created} 条，更新 ${updated} 条，跳过 ${skipped} 条`);
  ok(res, { created, updated, skipped, total: await repo.assets.count() });
});

/* ---- 导出 ---- */
route('GET', /^\/api\/export$/, async (req, res) => {
  const me = await requirePerm(req, res, 'export');
  if (!me) return;
  const u = new URL(req.url, 'http://localhost');
  const q = u.searchParams;
  const format = q.get('format') === 'csv' ? 'csv' : 'xlsx';
  const ids = q.get('ids');
  const scope = org.unitScope(me);
  let rows;
  if (ids) {
    // 勾选导出：按 id 取，但仍要用可见范围再筛一遍，避免越权导出
    const picked = await repo.assets.byIds(ids.split(',').filter(Boolean));
    rows = scope ? picked.filter((a) => scope.has(String(a.unit || ''))) : picked;
  } else {
    rows = await repo.assets.listAll(q, scope);
  }
  const exportFields = schema.FIELDS.filter((f) => f.key !== 'rowNo');
  const header = exportFields.map((f) => f.label);
  const data = [header, ...rows.map((a) => exportFields.map((f) => (a[f.key] == null ? '' : a[f.key])))];

  const stamp = time.todayDate();
  if (format === 'csv') {
    const buf = buildCsv(data);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="assets-${stamp}.csv"`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  } else {
    const buf = buildXlsx({
      name: '房屋土地台账',
      rows: data,
      colWidths: exportFields.map((f) => f.width || 120),
    });
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="assets-${stamp}.xlsx"`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  }
  await store.log(me, '导出数据', format, `${rows.length} 条`);
});

/* ---- 导入模板 ---- */

/** 内置模板文件（由 tools/build-template.js 按源台账格式生成，随系统一起分发） */
const TEMPLATE_FILE = path.join(__dirname, 'assets', 'import-template.xlsx');
const TEMPLATE_NAME = '房屋土地导入模板.xlsx';

/** 模板缺失时的兜底：按数据字典生成（表头 1-4 行合并 + 序号行 + 说明行） */
function fallbackTemplate() {
  const fields = schema.FIELDS.filter((f) => f.group !== 'geo');
  return buildXlsx({
    name: '汇总',
    rows: [
      fields.map((f) => ({ v: f.label, s: 0 })),
      fields.map(() => ({ v: '', s: 0 })),
      fields.map(() => ({ v: '', s: 0 })),
      fields.map(() => ({ v: '', s: 0 })),
      fields.map((f, i) => ({ v: i + 1, s: 1 })),
      fields.map((f) => ({ v: f.type === 'date' ? '日期格式 YYYY-MM-DD' : '', s: 2 })),
      fields.map(() => ({ v: '', s: 3 })),
    ],
    colWidths: fields.map((f) => Math.min(40, Math.max(9, (f.width || 110) / 7))),
    colWidthUnit: 'char',
    rowHeights: [19.5, 19.5, 19.5, 19.5, 19.5, 111.95],
    styles: [
      { font: { bold: true, size: 11, color: 'FF1F3864' }, fill: 'FFD9E1F2', border: true, align: { h: 'center', v: 'center', wrap: true } },
      { font: { bold: true, size: 10, color: 'FF7F6000' }, fill: 'FFFFF2CC', border: true, align: { h: 'center', v: 'center', wrap: true } },
      { font: { size: 10, color: 'FF7F6000' }, fill: 'FFFFF9E6', border: true, align: { h: 'left', v: 'top', wrap: true } },
      { font: { size: 11 }, border: true, align: { h: 'left', v: 'center', wrap: true } },
    ],
    freeze: { row: 6, col: 2 },
  });
}

/** 读取内置模板；不存在则现场生成并落盘，保证系统始终可用 */
function readTemplate() {
  try {
    if (fs.existsSync(TEMPLATE_FILE)) {
      const buf = fs.readFileSync(TEMPLATE_FILE);
      if (buf.length > 1000) return { buf, builtin: true };
    }
  } catch (e) { /* 忽略，走兜底 */ }
  const buf = fallbackTemplate();
  try {
    fs.mkdirSync(path.dirname(TEMPLATE_FILE), { recursive: true });
    fs.writeFileSync(TEMPLATE_FILE, buf);
  } catch (e) { /* 只读环境忽略 */ }
  return { buf, builtin: false };
}

route('GET', /^\/api\/import\/template$/, async (req, res) => {
  const me = await requirePerm(req, res, 'import');
  if (!me) return;
  const { buf } = readTemplate();
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="import-template.xlsx"; filename*=UTF-8''${encodeURIComponent(TEMPLATE_NAME)}`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
});

/** 模板结构说明，供导入页展示（表头行、序号行、说明行、列数、字段匹配情况） */
route('GET', /^\/api\/import\/template\/info$/, async (req, res) => {
  const me = await requirePerm(req, res, 'import');
  if (!me) return;
  const { buf, builtin } = readTemplate();
  let info = { builtin, sheets: [], cols: 0, headerRow: 1, seqRow: 5, noteRow: 6, dataRow: 7, matched: 0, unmatched: [] };
  try {
    const p = parseXlsx(buf);
    const rows = p.sheets[p.sheetNames[0]] || [];
    const hi = detectHeaderRow(rows);
    const headers = (rows[hi] || []).map((h) => (h == null ? '' : String(h)));
    let cols = 0;
    for (let i = 0; i < headers.length; i++) if (headers[i].trim()) cols = i + 1;
    const map = schema.buildHeaderMap(headers.slice(0, cols));
    info = {
      builtin,
      file: path.basename(TEMPLATE_FILE),
      size: buf.length,
      sheets: p.sheetNames,
      cols,
      headerRow: hi + 1,
      headerToRow: hi + 4,
      seqRow: hi + 5,
      noteRow: hi + 6,
      dataRow: hi + 7,
      matched: map.filter(Boolean).length,
      unmatched: headers.slice(0, cols).map((h, i) => (map[i] ? null : h)).filter(Boolean),
      fields: map.map((k, i) => ({ col: i, header: headers[i], key: k, label: (schema.FIELD_MAP.get(k) || {}).label || null })),
    };
  } catch (e) {
    info.error = e.message;
  }
  ok(res, info);
});

/* ------------------------------ 静态资源 ------------------------------ */

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel.startsWith('/api/')) { fail(res, 404, '接口不存在'); return; }
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(WEB_DIR)) { fail(res, 403, '禁止访问'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(idx)) return sendFile(res, idx, MIME['.html']);
    return fail(res, 404, '前端尚未构建，请执行 node tools/build.js');
  }
  sendFile(res, file, MIME[path.extname(file).toLowerCase()]);
}

/* ------------------------------ 启动 ------------------------------ */

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    });
    res.end();
    return;
  }

  // 畸形 URL（如 '//'）不能让整个进程退出
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    pathname = String(req.url || '/').split('?')[0] || '/';
  }
  if (pathname === '' || pathname === '//') pathname = '/';

  if (!pathname.startsWith('/api/')) {
    serveStatic(req, res, pathname);
    return;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    try {
      await r.handler(req, res, m);
    } catch (e) {
      console.error('[api]', req.method, pathname, e);
      if (!res.headersSent) fail(res, 500, '服务器内部错误：' + e.message);
    }
    return;
  }
  fail(res, 404, '接口不存在');
});

function startServer() {
  server.listen(PORT, HOST, async () => {
  console.log('');
  console.log('  房屋土地信息系统 已启动');
  console.log(`  服务地址: http://${HOST}:${PORT}`);
  console.log(`  数据库: ${mysqldb.config().database} @ ${mysqldb.config().host}:${mysqldb.config().port}`);
  const mc = await mapcfg.get();
  const mp = (mapcfg.PROVIDERS.find((p) => p.key === mc.provider) || {}).name || mc.provider;
  console.log(`  初始账号: admin / admin123（系统管理员；登录后请先修改密码）`);
  console.log(`  地图服务: ${mp}${mc.keys[mc.provider] ? '（已配置密钥）' : '（未配置密钥，请在「系统设置 → 地图服务」填写）'}`);
  try {
    const [unitCount, assetCount, userCount] = await Promise.all([
      repo.units.count(), repo.assets.count(), repo.users.count(),
    ]);
    if (!unitCount) console.log('  当前为空库：请先在「系统设置 → 单位管理」建立单位，再录入资产与用户。');
    else console.log(`  当前数据：${unitCount} 个单位、${userCount} 个用户、${assetCount} 条资产`);
  } catch (e) {
    console.log('  （数据统计读取失败：' + (e && e.message) + '）');
  }
  console.log('');
});
}

module.exports = { server };


/* ------------------------------ 启动 ------------------------------ */

/**
 * 先连数据库、建好单位缓存与默认账号，再开始监听端口。
 * 数据库连不上时给出可操作的提示，而不是抛一段驱动异常了事。
 */
bootstrap()
  .then(() => {
    const c = mysqldb.config();
    console.log(`[数据库] 已连接 ${c.user}@${c.host}:${c.port}/${c.database}`);
    startServer();
  })
  .catch((e) => {
    console.error('\n[启动失败] 数据库不可用：' + mysqldb.friendlyError(e));
    console.error('  请依次检查：');
    console.error('    1. MySQL 服务是否已启动（端口 ' + mysqldb.config().port + '）；');
    console.error('    2. data/dbconfig.json 里的 host / port / user / password / database 是否正确；');
    console.error('    3. 首次使用是否执行过 npm run db:init 建立数据库与数据表；');
    console.error('    4. 驱动是否安装：npm install\n');
    process.exit(1);
  });
