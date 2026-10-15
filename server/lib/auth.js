'use strict';
/**
 * 认证与授权：盐值 SHA-256 存密码 + HMAC-SHA256 签名令牌，零第三方依赖。
 */
const crypto = require('crypto');
const { URL } = require('url');
const store = require('./store.js');
const repo = require('./repo.js');

const TOKEN_TTL = 12 * 60 * 60 * 1000; // 12 小时

/**
 * 角色分两类主体：
 *   · 系统管理员（admin）：全局可见可改，可管理用户与单位层级。
 *   · 单位管理员（unitadmin）：本单位可改、下级单位只读，可管理本单位及下级的用户。
 * editor / viewer 为保留的普通用户角色，同样按「绑定单位 + 下级只读」规则受控。
 */
const ROLES = {
  admin: { label: '系统管理员', kind: 'system', can: ['read', 'write', 'delete', 'import', 'export', 'user', 'unit', 'geo'] },
  unitadmin: { label: '单位管理员', kind: 'unit', can: ['read', 'write', 'delete', 'import', 'export', 'user', 'geo'] },
  editor: { label: '数据录入员', kind: 'unit', can: ['read', 'write', 'import', 'export', 'geo'] },
  viewer: { label: '只读浏览员', kind: 'unit', can: ['read', 'export'] },
};

/** 系统管理员专属角色：非系统管理员不得授予 */
const SYSTEM_ONLY_ROLES = ['admin'];

function salt() { return crypto.randomBytes(12).toString('hex'); }

function hashPassword(password, s) {
  return crypto.createHash('sha256').update(`${s}:${password}`).digest('hex');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payloadStr) {
  return crypto.createHmac('sha256', store.secret()).update(payloadStr).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createToken(user) {
  const payload = JSON.stringify({ uid: user.id, role: user.role, exp: Date.now() + TOKEN_TTL });
  return `v1.${b64url(payload)}.${sign(payload)}`;
}

async function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  let payloadStr;
  try {
    payloadStr = Buffer.from(parts[1], 'base64').toString('utf8');
  } catch (e) { return null; }
  const expect = sign(payloadStr);
  const a = Buffer.from(expect);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(payloadStr); } catch (e) { return null; }
  if (!payload || payload.exp < Date.now()) return null;
  const user = await repo.users.byId(payload.uid);
  if (!user || user.disabled) return null;
  return {
    id: user.id, username: user.username, name: user.name, role: user.role,
    unit: user.unit || '', unitId: user.unitId || '',
  };
}

async function userFromRequest(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return verifyToken(m[1].trim());
  // <img src> 之类的静态加载无法携带 Authorization 头，图片地址允许用 ?token= 带短期令牌
  if (req.url) {
    try {
      const t = new URL(req.url, 'http://localhost').searchParams.get('token');
      if (t) return verifyToken(t.trim());
    } catch (e) { /* 路径非法（如 //）时忽略即可 */ }
  }
  return null;
}

function can(user, perm) {
  if (!user) return false;
  const r = ROLES[user.role];
  return !!r && r.can.includes(perm);
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    unit: u.unit || '', unitId: u.unitId || '',
    roleLabel: (ROLES[u.role] || {}).label || u.role,
    roleKind: (ROLES[u.role] || {}).kind || 'unit',
    lastLoginAt: u.lastLoginAt || null,
  };
}

/** 首次启动时创建默认账号 */
async function ensureDefaultUsers() {
  const n = await repo.users.count();
  if (n > 0) return false;
  const u0 = (await repo.units.list())[0] || {};
  const mk = async (username, name, role, password, unit, unitId) => {
    const s = salt();
    await repo.users.create({
      id: await store.nextId('user'), username, name, role,
      unit: unit || '', unitId: unitId || '',
      salt: s, hash: hashPassword(password, s),
      createdAt: new Date().toISOString(), lastLoginAt: null, disabled: false,
    });
  };
  await mk('admin', '系统管理员', 'admin', 'admin123');
  await mk('unitadmin', '单位管理员', 'unitadmin', 'unitadmin123', u0.name || '', u0.id || '');
  return true;
}

/**
 * 迁移：把历史遗留的「非系统管理员但未绑定单位」账号绑定到首个单位。
 * 未绑定单位的非管理员在新模型下会看不到任何数据（安全兜底），
 * 所以启动时自动补齐，避免出现「登录成功但页面全空」的困惑。
 */
async function ensureUnitBound() {
  const units = await repo.units.list();
  if (!units.length) return 0;
  const unit = units.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0))[0];
  const all = await repo.users.list();
  let n = 0;
  for (const u of all) {
    if (u.unitId && units.some((x) => x.id === u.unitId)) continue;
    if (u.unit && units.some((x) => x.name === u.unit)) {
      const hit = units.find((x) => x.name === u.unit);
      await repo.users.update(u.id, { unit: hit.name, unitId: hit.id });
      n++;
      continue;
    }
    await repo.users.update(u.id, { unit: unit.name, unitId: unit.id });
    n++;
  }
  return n;
}

/**
 * 迁移：为已有系统补一个「单位管理员」示例账号（绑定首个单位）。
 * 已存在同名账号时不做任何修改。
 */
async function ensureUnitAdminDemo() {
  const units = await repo.units.list();
  if (!units.length) return false;
  const all = await repo.users.list();
  if (all.some((u) => u.role === 'unitadmin')) return false;
  const unit = units[0];
  const s = salt();
  await repo.users.create({
    id: await store.nextId('user'), username: 'unitadmin', name: '单位管理员',
    role: 'unitadmin', unit: unit.name, unitId: unit.id,
    salt: s, hash: hashPassword('unitadmin123', s),
    createdAt: new Date().toISOString(), lastLoginAt: null, disabled: false,
  });
  return true;
}

module.exports = {
  ROLES, SYSTEM_ONLY_ROLES, TOKEN_TTL, salt, hashPassword, createToken, verifyToken,
  userFromRequest, can, publicUser, ensureDefaultUsers, ensureUnitAdminDemo, ensureUnitBound,
};
