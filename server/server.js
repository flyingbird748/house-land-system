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
const { parseXlsx } = require('./lib/xlsx.js');
const { buildXlsx, buildCsv } = require('./lib/xlsx-writer.js');

const PORT = Number(process.env.PORT || 8789);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');

const db = store.load();
auth.ensureDefaultUsers();
auth.ensureUnitAdminDemo(); // 已存在的系统补一个单位管理员示例账号
auth.ensureUnitBound();     // 历史账号补齐所属单位（未绑定的非管理员会看不到任何数据）

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

/**
 * 当前用户可见的资产：系统管理员全部；其余为本单位 + 全部下级单位（下级只读）。
 * 未绑定单位的历史账号沿用旧行为（全部可见）。
 */
function visibleAssets(user) {
  return org.visibleAssets(user);
}

/** 无权限修改资产时的统一提示（区分「越权单位」与「下级单位只读」） */
function writeDenyMsg(me, asset) {
  if (org.isSysAdmin(me)) return '无权操作该数据';
  return org.canRead(me, asset)
    ? '下级单位数据为只读，只能查看，不能修改'
    : '无权操作其他单位的数据';
}

function applyFilters(list, q) {
  let out = list;
  const keyword = (q.get('q') || '').trim().toLowerCase();
  if (keyword) {
    out = out.filter((a) => {
      const hay = [a.name, a.sysName, a.useUnit, a.assetNo, a.location, a.titleNo, a.unit, a.category, a.useStatus, a.remark]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(keyword);
    });
  }
  const inList = (key) => {
    const raw = q.get(key);
    if (!raw) return null;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  };
  const eq = (key, field) => {
    const vals = inList(key);
    if (!vals || !vals.length) return;
    out = out.filter((a) => vals.includes(String(a[field] == null ? '' : a[field])));
  };
  eq('category', 'category');
  eq('useStatus', 'useStatus');
  eq('hasTitle', 'hasTitle');
  eq('purpose', 'purpose');

  // 单位：默认按「该单位 + 全部下级单位」匹配（unitMode=exact 时仅本单位）
  const unitVals = inList('unit');
  if (unitVals && unitVals.length) {
    const exact = q.get('unitMode') === 'exact';
    const set = new Set();
    unitVals.forEach((v) => {
      if (exact) set.add(v);
      else org.descendantNamesOfName(v).forEach((n) => set.add(n));
    });
    out = out.filter((a) => set.has(String(a.unit == null ? '' : a.unit)));
  }

  const marked = q.get('marked');
  if (marked === 'yes') out = out.filter((a) => Number.isFinite(a.lng) && Number.isFinite(a.lat));
  if (marked === 'no') out = out.filter((a) => !(Number.isFinite(a.lng) && Number.isFinite(a.lat)));

  if (q.get('idle') === 'yes') out = out.filter((a) => a.idleLong === '是' || a.idleStage === '是');
  if (q.get('rented') === 'yes') out = out.filter((a) => a.rentedOut === '是' || a.rentedOut === '出租' || a.rentedOut === '出借');
  if (q.get('leased') === 'yes') out = out.filter((a) => a.leasedIn === '是' || a.leasedIn === '借入' || a.leasedIn === '租入');
  if (q.get('overhauled') === 'yes') out = out.filter((a) => a.overhauled === '是');

  // 数值区间：只有参数真实出现且为有效数字时才生效
  const numParam = (k) => {
    const raw = q.get(k);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const range = (minKey, maxKey, field) => {
    const min = numParam(minKey);
    const max = numParam(maxKey);
    if (min !== null) out = out.filter((a) => num(a[field]) >= min);
    if (max !== null) out = out.filter((a) => num(a[field]) <= max);
  };
  range('areaMin', 'areaMax', 'area');
  range('valMin', 'valMax', 'originalValue');
  range('ageMin', 'ageMax', 'age');

  return out;
}

const SORTABLE = new Set(['name', 'rowNo', 'area', 'officeArea', 'originalValue', 'age', 'category', 'useStatus', 'unit', 'updatedAt', 'createdAt', 'actualStaff']);

function applySort(list, q) {
  const key = q.get('sort');
  if (!key || !SORTABLE.has(key)) return list;
  const dir = q.get('order') === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    const sa = va == null ? '' : String(va);
    const sb = vb == null ? '' : String(vb);
    return sa.localeCompare(sb, 'zh-CN') * dir;
  });
}

function groupBy(list, field, limit) {
  const map = new Map();
  for (const a of list) {
    const k = (a[field] == null || a[field] === '') ? '未填写' : String(a[field]);
    let g = map.get(k);
    if (!g) { g = { name: k, count: 0, area: 0, value: 0 }; map.set(k, g); }
    g.count += 1;
    g.area += num(a.area);
    g.value += num(a.originalValue);
  }
  for (const g of map.values()) { g.area = Math.round(g.area * 100) / 100; g.value = Math.round(g.value * 100) / 100; }
  const arr = [...map.values()].sort((x, y) => y.count - x.count || y.area - x.area);
  return limit ? arr.slice(0, limit) : arr;
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

function findById(id) { return db.assets.find((a) => a.id === id); }

/* ------------------------------ 路由 ------------------------------ */

const routes = [];
const route = (method, re, handler) => routes.push({ method, re, handler });

function requireAuth(req, res) {
  const user = auth.userFromRequest(req);
  if (!user) { fail(res, 401, '未登录或登录已过期'); return null; }
  return user;
}

function requirePerm(req, res, perm) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!auth.can(user, perm)) { fail(res, 403, `当前角色无「${perm}」权限`); return null; }
  return user;
}

/* ---- 健康检查 ---- */
route('GET', /^\/api\/health$/, (req, res) => {
  ok(res, { ok: true, time: new Date().toISOString(), assets: db.assets.length, users: db.users.length });
});

/* ---- 登录 / 登出 / 当前用户 ---- */
route('POST', /^\/api\/auth\/login$/, async (req, res) => {
  let body;
  try { body = JSON.parse((await readBody(req, 8192)).toString('utf8')); }
  catch (e) { return fail(res, 400, '请求格式错误'); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = db.users.find((u) => u.username === username);
  if (!user || user.disabled) return fail(res, 401, '用户名或密码错误');
  if (auth.hashPassword(password, user.salt) !== user.hash) return fail(res, 401, '用户名或密码错误');
  user.lastLoginAt = new Date().toISOString();
  store.log(user, '登录', '系统', `IP ${(req.socket.remoteAddress || '').replace('::ffff:', '')}`);
  store.save();
  ok(res, { token: auth.createToken(user), user: auth.publicUser(user), ttl: auth.TOKEN_TTL });
});

route('GET', /^\/api\/auth\/me$/, (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  ok(res, { user: auth.publicUser(db.users.find((u) => u.id === user.id)) });
});

route('POST', /^\/api\/auth\/logout$/, (req, res) => {
  const user = auth.userFromRequest(req);
  if (user) store.log(user, '退出', '系统', '');
  ok(res, { ok: true });
});

route('POST', /^\/api\/auth\/change-password$/, async (req, res) => {
  const me = requireAuth(req, res);
  if (!me) return;
  let body;
  try { body = JSON.parse((await readBody(req, 8192)).toString('utf8')); }
  catch (e) { return fail(res, 400, '请求格式错误'); }
  const u = db.users.find((x) => x.id === me.id);
  if (auth.hashPassword(String(body.oldPassword || ''), u.salt) !== u.hash) return fail(res, 400, '原密码不正确');
  const np = String(body.newPassword || '');
  if (np.length < 6) return fail(res, 400, '新密码至少 6 位');
  u.salt = auth.salt();
  u.hash = auth.hashPassword(np, u.salt);
  store.log(u, '修改密码', u.username, '');
  store.saveNow();
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

route('GET', /^\/api\/users$/, (req, res) => {
  const me = requirePerm(req, res, 'user');
  if (!me) return;
  // 单位管理员只看得到本单位及下级单位的用户；系统管理员看全部
  const rows = db.users.filter((u) => org.manageableUser(me, u) || u.id === me.id);
  ok(res, {
    rows: rows.map(auth.publicUser),
    roles: auth.ROLES,
    systemOnlyRoles: auth.SYSTEM_ONLY_ROLES,
    scopeUnit: (org.unitOfUser(me) || {}).name || '',
  });
});

route('POST', /^\/api\/users$/, async (req, res) => {
  const me = requirePerm(req, res, 'user');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const username = String(b.username || '').trim();
  if (!username) return fail(res, 400, '用户名不能为空');
  if (db.users.some((u) => u.username === username)) return fail(res, 400, '用户名已存在');
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
    id: store.nextId('user'), username, name: String(b.name || username), role: b.role,
    unit: target ? target.name : '', unitId: target ? target.id : '',
    salt: s, hash: auth.hashPassword(String(b.password || '123456'), s),
    createdAt: new Date().toISOString(), lastLoginAt: null, disabled: false,
  };
  db.users.push(u);
  store.log(me, '新增用户', username, `角色 ${auth.ROLES[b.role].label}${u.unit ? ' · ' + u.unit : ''}`);
  store.saveNow();
  ok(res, { user: auth.publicUser(u) });
});

route('PUT', /^\/api\/users\/([^/]+)$/, async (req, res, m) => {
  const me = requirePerm(req, res, 'user');
  if (!me) return;
  const u = db.users.find((x) => x.id === m[1]);
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
  if (b.name !== undefined) u.name = String(b.name);
  if (b.disabled !== undefined) u.disabled = !!b.disabled;
  if (b.password) { u.salt = auth.salt(); u.hash = auth.hashPassword(String(b.password), u.salt); }

  if (!org.isSysAdmin(me)) {
    if (u.role !== 'admin' && !u.unit) return fail(res, 400, '非系统管理员账号必须指定所属单位');
    if (u.role !== 'admin' && u.unit && !org.unitByName(u.unit)) return fail(res, 400, '所属单位无效，请从单位列表中选择');
  }

  store.log(me, '修改用户', u.username, `角色 ${(auth.ROLES[u.role] || {}).label || u.role}${u.unit ? ' · ' + u.unit : ''}`);
  store.saveNow();
  ok(res, { user: auth.publicUser(u) });
});

route('DELETE', /^\/api\/users\/([^/]+)$/, (req, res, m) => {
  const me = requirePerm(req, res, 'user');
  if (!me) return;
  const idx = db.users.findIndex((x) => x.id === m[1]);
  if (idx < 0) return fail(res, 404, '用户不存在');
  if (db.users[idx].id === me.id) return fail(res, 400, '不能删除当前登录账号');
  if (!org.manageableUser(me, db.users[idx])) return fail(res, 403, '无权删除该用户');
  const [removed] = db.users.splice(idx, 1);
  store.log(me, '删除用户', removed.username, '');
  store.saveNow();
  ok(res, { ok: true });
});

/* ---- 单位管理（层级：上级 / 下级） ---- */

/** 统一的单位行（含层级信息） */
function unitRows(me) {
  const rows = org.treeRows(null);
  const assetCount = {};
  for (const a of db.assets) {
    const k = String(a.unit || '');
    assetCount[k] = (assetCount[k] || 0) + 1;
  }
  rows.forEach((r) => { r.assetCount = assetCount[r.name] || 0; });
  return rows;
}

route('GET', /^\/api\/units$/, (req, res) => {
  const me = requireAuth(req, res);
  if (!me) return;
  ok(res, {
    rows: unitRows(me),
    // 当前用户可切换查看的单位（空数组 = 不限，系统管理员 / 未绑定单位）
    visible: org.visibleUnitNames(me) ? [...org.visibleUnitNames(me)] : null,
  });
});

route('POST', /^\/api\/units$/, async (req, res) => {
  const me = requirePerm(req, res, 'unit'); // 单位层级仅系统管理员可维护
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, '单位名称不能为空');
  if (db.units.some((u) => u.name === name)) return fail(res, 400, '该单位已存在');
  const parentId = String(b.parent || '');
  if (parentId && !org.unitById(parentId)) return fail(res, 400, '上级单位不存在');
  const u = {
    id: store.nextId('unit'), name, code: String(b.code || ''),
    parent: parentId, sort: db.units.length + 1,
  };
  db.units.push(u);
  store.log(me, '新增单位', name, parentId ? `上级：${org.unitById(parentId).name}` : '顶级单位');
  store.saveNow();
  ok(res, { unit: u });
});

route('PUT', /^\/api\/units\/([^/]+)$/, async (req, res, m) => {
  const me = requirePerm(req, res, 'unit');
  if (!me) return;
  const u = org.unitById(m[1]);
  if (!u) return fail(res, 404, '单位不存在');
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  if (b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) return fail(res, 400, '单位名称不能为空');
    if (db.units.some((x) => x.name === name && x.id !== u.id)) return fail(res, 400, '该单位已存在');
    const old = u.name;
    // 改名需同步历史数据中的单位名
    if (name !== old) {
      db.assets.forEach((a) => { if (a.unit === old) a.unit = name; });
      db.users.forEach((x) => { if (x.unit === old) { x.unit = name; x.unitId = u.id; } });
    }
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
  store.log(me, '修改单位', u.name, u.parent ? `上级：${(org.unitById(u.parent) || {}).name || ''}` : '顶级单位');
  store.saveNow();
  ok(res, { unit: u });
});

route('DELETE', /^\/api\/units\/([^/]+)$/, (req, res, m) => {
  const me = requirePerm(req, res, 'unit');
  if (!me) return;
  const idx = db.units.findIndex((u) => u.id === m[1]);
  if (idx < 0) return fail(res, 404, '单位不存在');
  const kids = org.childrenOf(db.units[idx].id);
  if (kids.length) return fail(res, 400, `该单位下仍有 ${kids.length} 个下级单位，请先调整或删除下级单位`);
  const used = db.assets.filter((a) => a.unit === db.units[idx].name).length;
  if (used) return fail(res, 400, `该单位下仍有 ${used} 条资产，不能删除`);
  const [removed] = db.units.splice(idx, 1);
  // 清理失效的单位引用
  db.users.forEach((x) => { if (x.unitId === removed.id) { x.unitId = ''; x.unit = ''; } });
  store.log(me, '删除单位', removed.name, '');
  store.saveNow();
  ok(res, { ok: true });
});

/* ---- 资产列表 / 详情 ---- */
route('GET', /^\/api\/assets$/, (req, res) => {
  const me = requireAuth(req, res);
  if (!me) return;
  const u = new URL(req.url, 'http://localhost');
  const q = u.searchParams;
  const filtered = applySort(applyFilters(visibleAssets(me), q), q);
  const total = filtered.length;
  const all = q.get('pageSize') === 'all';
  let rows = filtered;
  let page = 1, pageSize = 20;
  if (!all) {
    const p = Number(q.get('page'));
    const s = Number(q.get('pageSize'));
    page = Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
    pageSize = Number.isFinite(s) && s >= 1 ? Math.min(500, Math.floor(s)) : 20;
    rows = filtered.slice((page - 1) * pageSize, page * pageSize);
  }
  ok(res, { total, rows, page, pageSize: all ? total : pageSize });
});

route('GET', /^\/api\/assets\/([^/]+)$/, (req, res, m) => {
  const me = requireAuth(req, res);
  if (!me) return;
  const a = findById(m[1]);
  if (!a) return fail(res, 404, '资产不存在');
  if (!org.canRead(me, a)) return fail(res, 403, '无权访问该单位数据');
  ok(res, { asset: a, readonly: !org.canWrite(me, a) });
});

route('POST', /^\/api\/assets$/, async (req, res) => {
  const me = requirePerm(req, res, 'write');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, '资产名称不能为空');
  const assetNo = String(b.assetNo || '').trim();
  if (assetNo && db.assets.some((a) => a.assetNo === assetNo)) return fail(res, 400, `资产编号 ${assetNo} 已存在`);
  const now = new Date().toISOString();
  const a = { id: store.nextId('asset'), createdAt: now, updatedAt: now, createdBy: me.name, updatedBy: me.name };
  sanitizeAsset(b, a);
  const myUnit = org.unitOfUser(me);
  if (myUnit && !a.unit) a.unit = myUnit.name;
  // 只能往自己有写权限的单位新增（系统管理员不受限）
  if (!org.canWriteUnit(me, a.unit)) {
    return fail(res, 403, org.canReadUnit(me, a.unit)
      ? '下级单位为只读，不能在该单位下新增资产'
      : `不能为其他单位（${a.unit || '未填写'}）新增资产`);
  }
  db.assets.push(a);
  store.log(me, '新增资产', name, a.unit || '');
  store.save();
  ok(res, { asset: a });
});

route('PUT', /^\/api\/assets\/([^/]+)$/, async (req, res, m) => {
  const me = requirePerm(req, res, 'write');
  if (!me) return;
  const a = findById(m[1]);
  if (!a) return fail(res, 404, '资产不存在');
  if (!org.canWrite(me, a)) return fail(res, 403, writeDenyMsg(me, a));
  let b; try { b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  // 不允许把资产改挂到其他单位（含下级单位：下级只读）
  if (b.unit !== undefined && String(b.unit || '') !== String(a.unit || '') && !org.canWriteUnit(me, b.unit)) {
    return fail(res, 403, org.canReadUnit(me, b.unit)
      ? '不能将资产改挂到只读的下级单位'
      : `不能将资产改挂到其他单位（${b.unit || '未填写'}）`);
  }
  if (b.assetNo && String(b.assetNo) !== a.assetNo && db.assets.some((x) => x.assetNo === String(b.assetNo))) {
    return fail(res, 400, `资产编号 ${b.assetNo} 已存在`);
  }
  const before = {};
  for (const f of schema.FIELDS) before[f.key] = a[f.key];
  sanitizeAsset(b, a);
  a.updatedAt = new Date().toISOString();
  a.updatedBy = me.name;
  const changed = schema.FIELDS.filter((f) => JSON.stringify(before[f.key]) !== JSON.stringify(a[f.key])).map((f) => f.label);
  store.log(me, '修改资产', a.name || a.id, changed.length ? `修改字段：${changed.slice(0, 8).join('、')}${changed.length > 8 ? ' 等' : ''}` : '无字段变化');
  store.save();
  ok(res, { asset: a, changed: changed.length });
});

route('DELETE', /^\/api\/assets\/([^/]+)$/, (req, res, m) => {
  const me = requirePerm(req, res, 'delete');
  if (!me) return;
  const idx = db.assets.findIndex((a) => a.id === m[1]);
  if (idx < 0) return fail(res, 404, '资产不存在');
  if (!org.canWrite(me, db.assets[idx])) return fail(res, 403, writeDenyMsg(me, db.assets[idx]));
  const [removed] = db.assets.splice(idx, 1);
  if (removed) images.removeAsset(removed.id); // 连带清理图片
  store.log(me, '删除资产', removed.name || removed.id, '');
  store.saveNow(); // 删除要立即使之持久化（含连带清理的图片记录），不进防抖队列
  ok(res, { ok: true });
});

route('POST', /^\/api\/assets\/batch-delete$/, async (req, res) => {
  const me = requirePerm(req, res, 'delete');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 1 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const ids = new Set((b.ids || []).map(String));
  let removed = 0, denied = 0;
  db.assets = db.assets.filter((a) => {
    if (!ids.has(a.id)) return true;
    if (!org.canWrite(me, a)) { denied++; return true; }
    removed++;
    images.removeAsset(a.id); // 连带清理图片
    return false;
  });
  store.log(me, '批量删除', `${removed} 条`, denied ? `${denied} 条因单位权限被跳过` : '');
  store.saveNow(); // 同上：连带清理图片，必须立即落盘
  ok(res, { removed, denied });
});

/* ---- 房产图片（每条资产最多 3 张，单张 ≤ 2MB） ---- */

/** 取资产并按可见/可写权限校验，返回 { asset, user } 或 null（已自行写回响应） */
function assetForImage(me, id, needWrite) {
  const a = findById(id);
  if (!a) return { error: '资产不存在', code: 404 };
  if (!org.canRead(me, a)) return { error: '无权访问该单位数据', code: 403 };
  if (needWrite && !org.canWrite(me, a)) return { error: writeDenyMsg(me, a), code: 403 };
  return { asset: a };
}

route('GET', /^\/api\/assets\/([^/]+)\/images$/, (req, res, m) => {
  const me = requireAuth(req, res);
  if (!me) return;
  const r = assetForImage(me, m[1], false);
  if (r.error) return fail(res, r.code, r.error);
  ok(res, {
    assetId: r.asset.id,
    images: images.ofAsset(r.asset.id).map(images.view),
    max: images.MAX_COUNT, maxSize: images.MAX_SIZE, labels: images.LABELS,
  });
});

route('POST', /^\/api\/assets\/([^/]+)\/images$/, async (req, res, m) => {
  const me = requirePerm(req, res, 'write');
  if (!me) return;
  const r = assetForImage(me, m[1], true);
  if (r.error) return fail(res, r.code, r.error);
  let b; try { b = JSON.parse((await readBody(req, 8 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  try {
    const img = images.add(r.asset.id, b, me);
    store.log(me, '上传房产图片', r.asset.name || r.asset.id, `${img.label}｜${Math.round(img.size / 1024)}KB`);
    store.save();
    ok(res, { image: img, images: images.ofAsset(r.asset.id).map(images.view) });
  } catch (e) { fail(res, 400, e.message); }
});

route('PUT', /^\/api\/assets\/([^/]+)\/images\/([^/]+)$/, async (req, res, m) => {
  const me = requirePerm(req, res, 'write');
  if (!me) return;
  const r = assetForImage(me, m[1], true);
  if (r.error) return fail(res, r.code, r.error);
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const img = images.setLabel(r.asset.id, m[2], b && b.label);
  if (!img) return fail(res, 404, '图片不存在');
  store.save();
  ok(res, { image: img });
});

route('DELETE', /^\/api\/assets\/([^/]+)\/images\/([^/]+)$/, (req, res, m) => {
  const me = requirePerm(req, res, 'write');
  if (!me) return;
  const r = assetForImage(me, m[1], true);
  if (r.error) return fail(res, r.code, r.error);
  if (!images.remove(r.asset.id, m[2])) return fail(res, 404, '图片不存在');
  store.log(me, '删除房产图片', r.asset.name || r.asset.id, '');
  store.save();
  ok(res, { ok: true });
});

/** 图片二进制：<img src> 无法带 Authorization 头，允许用 ?token= 携带令牌 */
route('GET', /^\/api\/assets\/([^/]+)\/images\/([^/]+)\/raw$/, (req, res, m) => {
  const me = requireAuth(req, res);
  if (!me) return;
  const r = assetForImage(me, m[1], false);
  if (r.error) return fail(res, r.code, r.error);
  const f = images.readFile(r.asset.id, m[2]);
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
route('GET', /^\/api\/images$/, (req, res) => {
  const me = requireAuth(req, res);
  if (!me) return;
  const ids = String(new URL(req.url, 'http://localhost').searchParams.get('ids') || '');
  const want = ids ? ids.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const mine = visibleAssets(me).map((a) => a.id);
  const allow = want ? want.filter((id) => mine.indexOf(id) >= 0) : mine;
  ok(res, { map: images.groupBy(allow), max: images.MAX_COUNT, maxSize: images.MAX_SIZE });
});

/* ---- 地图标注 ---- */
route('PUT', /^\/api\/assets\/([^/]+)\/geo$/, async (req, res, m) => {
  const me = requirePerm(req, res, 'geo');
  if (!me) return;
  const a = findById(m[1]);
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
    a.geoAt = new Date().toISOString();
    a.geoBy = me.name;
  }
  a.updatedAt = new Date().toISOString();
  a.updatedBy = me.name;
  store.log(me, a.lng ? '地图标注' : '清除标注', a.name || a.id, a.lng ? `${a.lng},${a.lat}` : '');
  store.save();
  ok(res, { asset: a });
});

route('POST', /^\/api\/assets\/geo\/batch$/, async (req, res) => {
  const me = requirePerm(req, res, 'geo');
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 4 << 20)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const items = Array.isArray(b.items) ? b.items : [];
  let done = 0;
  const now = new Date().toISOString();
  for (const it of items) {
    const a = findById(String(it.id));
    if (!a) continue;
    if (!org.canWrite(me, a)) continue;
    if (!Number.isFinite(Number(it.lng)) || !Number.isFinite(Number(it.lat))) continue;
    a.lng = Math.round(Number(it.lng) * 1e6) / 1e6;
    a.lat = Math.round(Number(it.lat) * 1e6) / 1e6;
    if (it.address) a.geoAddress = String(it.address).slice(0, 200);
    a.geoAt = now; a.geoBy = me.name; a.updatedAt = now; a.updatedBy = me.name;
    done++;
  }
  store.log(me, '批量地理编码', `${done} 条`, '');
  store.save();
  ok(res, { updated: done });
});

/* ---- 统计看板 ---- */
route('GET', /^\/api\/stats$/, (req, res) => {
  const me = requireAuth(req, res);
  if (!me) return;
  // 支持按当前单位（unit）等条件统计，供左侧单位树切换后刷新看板
  const u = new URL(req.url, 'http://localhost');
  const list = applyFilters(visibleAssets(me), u.searchParams);
  const marked = list.filter((a) => Number.isFinite(a.lng) && Number.isFinite(a.lat));
  const districtMap = new Map();
  for (const a of list) {
    const d = districtOf(a);
    let g = districtMap.get(d);
    if (!g) { g = { name: d, count: 0, area: 0 }; districtMap.set(d, g); }
    g.count++; g.area += num(a.area);
  }
  const ageBuckets = [
    { name: '5年以内', min: 0, max: 5 },
    { name: '6-10年', min: 6, max: 10 },
    { name: '11-20年', min: 11, max: 20 },
    { name: '21-30年', min: 21, max: 30 },
    { name: '30年以上', min: 31, max: 9999 },
  ].map((b) => ({
    name: b.name,
    count: list.filter((a) => num(a.age) >= b.min && num(a.age) <= b.max).length,
  }));

  const rentIncome = list.reduce((s, a) => s + num(a.rentIncome), 0);
  const leaseRent = list.reduce((s, a) => s + num(a.leaseRent), 0);

  ok(res, {
    total: list.length,
    totalArea: Math.round(list.reduce((s, a) => s + num(a.area), 0) * 100) / 100,
    totalOfficeArea: Math.round(list.reduce((s, a) => s + num(a.officeArea), 0) * 100) / 100,
    totalValue: Math.round(list.reduce((s, a) => s + num(a.originalValue), 0) * 100) / 100,
    totalStaff: list.reduce((s, a) => s + num(a.actualStaff), 0),
    titled: list.filter((a) => a.hasTitle === '有产权').length,
    untitled: list.filter((a) => a.hasTitle === '无产权').length,
    idleCount: list.filter((a) => a.idleLong === '是' || a.idleStage === '是').length,
    rentCount: list.filter((a) => ['是', '出租', '出借'].includes(a.rentedOut)).length,
    leaseCount: list.filter((a) => ['是', '租入', '借入'].includes(a.leasedIn)).length,
    rentIncome: Math.round(rentIncome * 100) / 100,
    leaseRent: Math.round(leaseRent * 100) / 100,
    overhauled: list.filter((a) => a.overhauled === '是').length,
    geoMarked: marked.length,
    geoUnmarked: list.length - marked.length,
    byCategory: groupBy(list, 'category'),
    byUseStatus: groupBy(list, 'useStatus'),
    byUnit: groupBy(list, 'unit'),
    byUseUnit: groupBy(list, 'useUnit', 12),
    byPurpose: groupBy(list, 'purpose'),
    byTitleForm: groupBy(list, 'titleType', 10),
    byDistrict: [...districtMap.values()].sort((a, b) => b.count - a.count),
    byAge: ageBuckets,
    recent: list.slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 8)
      .map((a) => ({ id: a.id, name: a.name, unit: a.unit, updatedAt: a.updatedAt, updatedBy: a.updatedBy })),
  });
});

/* ---- 分析报告：按模板自动汇总生成 ---- */
route('GET', /^\/api\/report$/, (req, res) => {
  const me = requireAuth(req, res);
  if (!me) return;
  const u = new URL(req.url, 'http://localhost');
  const list = applyFilters(visibleAssets(me), u.searchParams);
  const unitNames = [];
  list.forEach((a) => { const n = String(a.unit || ''); if (n && unitNames.indexOf(n) < 0) unitNames.push(n); });
  const scopeLabel = String(u.searchParams.get('unit') || '').trim()
    || (unitNames.length === 1 ? unitNames[0] : (unitNames.length ? '多个单位' : '全部单位'));
  const r = report.build(list, { unitNames, scopeLabel, params: {} });
  ok(res, r);
});

/* ---- 系统设置：分析报告参数 ---- */
route('GET', /^\/api\/settings\/report$/, (req, res) => {
  const me = requireSysAdmin(req, res);
  if (!me) return;
  ok(res, reportcfg.view());
});

route('PUT', /^\/api\/settings\/report$/, async (req, res) => {
  const me = requireSysAdmin(req, res);
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const before = reportcfg.get();
  const next = reportcfg.set(b || {});
  const changed = reportcfg.PARAMS
    .filter((p) => String(next[p.key]) !== String(before[p.key]))
    .map((p) => `${p.label}：${before[p.key] === '' ? '（空）' : before[p.key]} → ${next[p.key] === '' ? '（空）' : next[p.key]}`);
  store.log(me, '修改系统设置', '分析报告参数', changed.join('；') || '无变化');
  ok(res, { values: next });
});

/* ---- 枚举选项（含数据中已出现的值） ---- */
route('GET', /^\/api\/options$/, (req, res) => {
  const me = requireAuth(req, res);
  if (!me) return;
  const dyn = (field) => {
    const s = new Set();
    for (const a of visibleAssets(me)) if (a[field]) s.add(String(a[field]));
    return [...s].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  };
  const fields = schema.FIELDS.map((f) => {
    const opts = [...new Set([...(f.options || []), ...(f.type === 'enum' ? dyn(f.key) : [])])];
    return { key: f.key, label: f.label, type: f.type, group: f.group, unit: f.unit || '', options: opts };
  });
  const vis = org.visibleUnitNames(me);
  const meRow = db.users.find((u) => u.id === me.id);
  const myUnit = org.unitOfUser(me);
  ok(res, {
    fields,
    groups: schema.GROUPS,
    units: db.units.filter((u) => !vis || vis.has(u.name)).map((u) => u.name),
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
function requireSysAdmin(req, res) {
  const me = requireAuth(req, res);
  if (!me) return null;
  if (!org.isSysAdmin(me)) { fail(res, 403, '仅系统管理员可修改系统设置'); return null; }
  return me;
}

/** 前端地图加载用：当前服务商 + Key + 默认视野（所有登录用户可读） */
route('GET', /^\/api\/map\/config$/, (req, res) => {
  if (!requireAuth(req, res)) return;
  ok(res, { map: mapcfg.publicConfig() });
});

/** 设置页读取（完整配置 + 服务商注册指引），仅系统管理员 */
route('GET', /^\/api\/settings\/map$/, (req, res) => {
  const me = requireSysAdmin(req, res);
  if (!me) return;
  ok(res, mapcfg.adminView());
});

route('PUT', /^\/api\/settings\/map$/, async (req, res) => {
  const me = requireSysAdmin(req, res);
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const before = mapcfg.get();
  const next = mapcfg.set({
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
  store.log(me, '修改系统设置', '地图服务', changed.join('；') || '无变化');
  ok(res, { map: next });
});

/** 连通性测试：用一次地理编码验证 Key 是否可用（不落库，便于先试后存） */
route('POST', /^\/api\/settings\/map\/test$/, async (req, res) => {
  const me = requireSysAdmin(req, res);
  if (!me) return;
  let b; try { b = JSON.parse((await readBody(req, 8192)).toString('utf8')); } catch (e) { return fail(res, 400, '请求格式错误'); }
  const provider = String(b.provider || mapcfg.get().provider);
  const key = String(b.key == null ? (mapcfg.get().keys[provider] || '') : b.key);
  const r = await mapcfg.testKey(provider, key);
  ok(res, r);
});

/* ---- 地理编码（服务端代理：天地图 / 腾讯 WebService） ---- */
route('GET', /^\/api\/geo\/geocode$/, async (req, res) => {
  const me = requireAuth(req, res);
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
  const me = requireAuth(req, res);
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
  const me = requireAuth(req, res);
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
route('GET', /^\/api\/logs$/, (req, res) => {
  const me = requirePerm(req, res, 'user');
  if (!me) return;
  // 系统管理员看全部；单位管理员只看本单位及下级单位用户的操作记录
  const names = org.visibleUnitNames(me);
  const rows = names ? store.listLogs(300).filter((r) => names.has(r.unit || '')) : store.listLogs(300);
  ok(res, { rows });
});

/* ---- Excel 导入：预览 ---- */
route('POST', /^\/api\/import\/preview$/, async (req, res) => {
  const me = requirePerm(req, res, 'import');
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
  const me = requirePerm(req, res, 'import');
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
  const now = new Date().toISOString();

  // 导入目标单位必须在本人的可写范围内（系统管理员不限）
  if (defaultUnit && !org.canWriteUnit(me, defaultUnit)) {
    return fail(res, 403, org.canReadUnit(me, defaultUnit)
      ? '下级单位为只读，不能向下级单位导入数据'
      : `不能向其他单位（${defaultUnit}）导入数据`);
  }
  if (defaultUnit && !db.units.some((u) => u.name === defaultUnit)) {
    if (!org.isSysAdmin(me)) return fail(res, 400, `单位「${defaultUnit}」尚未登记，请联系系统管理员在单位管理中登记`);
    db.units.push({ id: store.nextId('unit'), name: defaultUnit, code: '', parent: '', sort: db.units.length + 1 });
  }

  if (mode === 'replace') {
    const before = db.assets.length;
    const writable = org.writableUnitNames(me);
    const gone = writable ? db.assets.filter((a) => writable.has(String(a.unit || ''))) : db.assets.slice();
    db.assets = writable ? db.assets.filter((a) => !writable.has(String(a.unit || ''))) : [];
    gone.forEach((a) => images.removeAsset(a.id)); // 连带清理被清空资产的图片
    store.log(me, '清空数据', '导入前清空', `原有 ${before} 条`);
  }

  const byNo = new Map();
  for (const a of db.assets) if (a.assetNo) byNo.set(String(a.assetNo), a);

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
      sanitizeAsset(rec, exist);
      exist.updatedAt = now;
      exist.updatedBy = me.name;
      updated++;
    } else {
      const a = { id: store.nextId('asset'), createdAt: now, updatedAt: now, createdBy: me.name, updatedBy: me.name };
      sanitizeAsset(rec, a);
      db.assets.push(a);
      if (a.assetNo) byNo.set(String(a.assetNo), a);
      created++;
    }
  }

  importCache.delete(b.token);
  store.log(me, '导入数据', cache.fileName || 'Excel', `新增 ${created} 条，更新 ${updated} 条，跳过 ${skipped} 条`);
  store.saveNow();
  ok(res, { created, updated, skipped, total: db.assets.length });
});

/* ---- 导出 ---- */
route('GET', /^\/api\/export$/, (req, res) => {
  const me = requirePerm(req, res, 'export');
  if (!me) return;
  const u = new URL(req.url, 'http://localhost');
  const q = u.searchParams;
  const format = q.get('format') === 'csv' ? 'csv' : 'xlsx';
  let rows = applySort(applyFilters(visibleAssets(me), q), q);
  const ids = q.get('ids');
  if (ids) {
    const set = new Set(ids.split(',').filter(Boolean));
    rows = rows.filter((a) => set.has(a.id));
  }
  const exportFields = schema.FIELDS.filter((f) => f.key !== 'rowNo');
  const header = exportFields.map((f) => f.label);
  const data = [header, ...rows.map((a) => exportFields.map((f) => (a[f.key] == null ? '' : a[f.key])))];

  const stamp = new Date().toISOString().slice(0, 10);
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
  store.log(me, '导出数据', format, `${rows.length} 条`);
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

route('GET', /^\/api\/import\/template$/, (req, res) => {
  const me = requirePerm(req, res, 'import');
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
route('GET', /^\/api\/import\/template\/info$/, (req, res) => {
  const me = requirePerm(req, res, 'import');
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

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  房屋土地信息系统 已启动');
  console.log(`  服务地址: http://${HOST}:${PORT}`);
  console.log(`  数据文件: ${store.DB_FILE}`);
  const mc = mapcfg.get();
  const mp = (mapcfg.PROVIDERS.find((p) => p.key === mc.provider) || {}).name || mc.provider;
  console.log(`  初始账号: admin / admin123（系统管理员；登录后请先修改密码）`);
  console.log(`  地图服务: ${mp}${mc.keys[mc.provider] ? '（已配置密钥）' : '（未配置密钥，请在「系统设置 → 地图服务」填写）'}`);
  const db0 = store.load();
  if (!db0.units.length) {
    console.log('  当前为空库：请先在「系统设置 → 单位管理」建立单位，再录入资产与用户。');
  }
  console.log('');
});

module.exports = { server };
