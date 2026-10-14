'use strict';
/**
 * org —— 单位层级（上级 / 下级）与「用户 ↔ 单位」的数据可见范围。
 *
 * 规则：
 *   · 系统管理员（role=admin）：可见并可修改全部单位数据。
 *   · 其它角色（含单位管理员）：绑定所属单位后，
 *       - 可见：本单位 + 全部下级单位（只读下级）
 *       - 可修改：仅限本单位
 *   · 未绑定单位的非管理员：可见范围为空（安全兜底 —— 宁可看不到，
 *     也不能退化成「可见全部」）。启动时 auth.ensureUnitBound() 会自动补齐历史账号。
 *
 * 单位层级用 units.parent（父单位 id，顶级为 ''），资产 / 用户用「单位名称」关联。
 */
const store = require('./store.js');

const MAX_DEPTH = 32;

function db() { return store.load(); }

function isSysAdmin(user) { return !!user && user.role === 'admin'; }

function unitById(id) {
  if (!id) return null;
  return db().units.find((u) => u.id === id) || null;
}

function unitByName(name) {
  if (!name) return null;
  return db().units.find((u) => u.name === name) || null;
}

function childrenOf(id) {
  const pid = id || '';
  return db().units.filter((u) => (u.parent || '') === pid);
}

/** 全部后代单位（不含自身），带环路保护 */
function descendantUnits(unit) {
  if (!unit) return [];
  const out = [];
  const seen = new Set([unit.id]);
  const walk = (u, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const c of childrenOf(u.id)) {
      if (seen.has(c.id)) continue; // 数据异常形成环时直接跳出
      seen.add(c.id);
      out.push(c);
      walk(c, depth + 1);
    }
  };
  walk(unit, 1);
  return out;
}

/** 单位自身 + 全部后代的名称（用于「本单位及下级」过滤） */
function subtreeNames(unit) {
  if (!unit) return [];
  return [unit.name].concat(descendantUnits(unit).map((u) => u.name));
}

function namesOfName(name) {
  const u = unitByName(name);
  return u ? subtreeNames(u) : [name];
}

function descendantNamesOfName(name) {
  const u = unitByName(name);
  return u ? subtreeNames(u) : [name];
}

/** 用户所属单位（优先 unitId，兼容只存名称的历史数据） */
function unitOfUser(user) {
  if (!user) return null;
  const byId = user.unitId ? unitById(user.unitId) : null;
  if (byId) return byId;
  return user.unit ? unitByName(String(user.unit)) : null;
}

/** 可见单位名集合；null 表示不受限（仅系统管理员） */
function visibleUnitNames(user) {
  if (!user) return new Set();
  if (isSysAdmin(user)) return null;
  const u = unitOfUser(user);
  if (!u) return new Set(); // 未绑定单位 → 看不到任何单位数据（安全兜底）
  return new Set(subtreeNames(u));
}

/** 可修改单位名集合（仅本单位）；null 表示不受限（仅系统管理员） */
function writableUnitNames(user) {
  if (!user) return new Set();
  if (isSysAdmin(user)) return null;
  const u = unitOfUser(user);
  if (!u) return new Set();
  return new Set([u.name]);
}

const unitKey = (asset) => String((asset && asset.unit) || '');

function canRead(user, asset) {
  if (!user) return false;
  const names = visibleUnitNames(user);
  if (!names) return true;
  return names.has(unitKey(asset));
}

function canWrite(user, asset) {
  if (!user) return false;
  const names = writableUnitNames(user);
  if (!names) return true;
  return names.has(unitKey(asset));
}

function canReadUnit(user, unitName) {
  if (!user) return false;
  const names = visibleUnitNames(user);
  if (!names) return true;
  return names.has(String(unitName || ''));
}

function canWriteUnit(user, unitName) {
  if (!user) return false;
  const names = writableUnitNames(user);
  if (!names) return true;
  return names.has(String(unitName || ''));
}

/** 可见资产列表（系统管理员全部；其余为本单位 + 下级） */
function visibleAssets(user) {
  if (!user) return [];
  const names = visibleUnitNames(user);
  if (!names) return db().assets;
  return db().assets.filter((a) => names.has(unitKey(a)));
}

/** 单位全路径，如「市局 / 第一分局」 */
function pathOf(unit) {
  const names = [];
  let cur = unit;
  let guard = 0;
  const seen = new Set();
  while (cur && guard++ < MAX_DEPTH) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parent ? unitById(cur.parent) : null;
  }
  return names.join(' / ');
}

/** 层级（顶级为 0） */
function levelOf(unit) {
  let n = 0;
  let cur = unit;
  let guard = 0;
  const seen = new Set();
  while (cur && cur.parent && guard++ < MAX_DEPTH) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    const p = unitById(cur.parent);
    if (!p) break;
    cur = p;
    n++;
  }
  return n;
}

/** maybeChildId 是否为 unit 的后代（用于阻止把上级改成自己的下级） */
function isDescendant(unit, maybeChildId) {
  if (!unit || !maybeChildId) return false;
  if (unit.id === maybeChildId) return true;
  return descendantUnits(unit).some((u) => u.id === maybeChildId);
}

/**
 * 单位层级行（供前端树形展示 / 下拉使用）
 * @param {Set<string>|null} nameFilter 只保留该集合内的名称（null = 全部）
 */
function treeRows(nameFilter) {
  const units = db().units.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  const keep = nameFilter ? (u) => nameFilter.has(u.name) : () => true;
  // 若某单位的父级被过滤掉（例如按可见范围裁剪），则提升为顶级，避免树断裂
  const allowed = new Set(units.filter(keep).map((u) => u.id));
  return units.filter(keep).map((u) => {
    const parent = u.parent ? unitById(u.parent) : null;
    const hasParent = parent && allowed.has(parent.id);
    return {
      id: u.id,
      name: u.name,
      code: u.code || '',
      sort: u.sort || 0,
      parent: hasParent ? u.parent : '',
      parentName: hasParent ? parent.name : '',
      path: pathOf(u),
      level: levelOf(u),
      childCount: childrenOf(u.id).length,
    };
  });
}

/** 用户管理：目标用户是否在当前操作者的管辖范围内 */
function manageableUser(me, target) {
  if (!me || !target) return false;
  if (isSysAdmin(me)) return true;
  if (target.role === 'admin') return false; // 非系统管理员不能操作系统管理员
  const names = visibleUnitNames(me);
  if (!names) return true;
  return names.has(String(target.unit || ''));
}

module.exports = {
  MAX_DEPTH, isSysAdmin,
  unitById, unitByName, childrenOf, descendantUnits, subtreeNames,
  namesOfName, descendantNamesOfName, unitOfUser,
  visibleUnitNames, writableUnitNames,
  canRead, canWrite, canReadUnit, canWriteUnit, visibleAssets,
  pathOf, levelOf, isDescendant, treeRows, manageableUser,
};
