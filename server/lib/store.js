'use strict';
/**
 * 存储层（MySQL 版）
 *
 * 改造前这里是「单文件 JSON + 防抖落盘」；改造后数据存在 MySQL，
 * 本模块只保留几件与存储相关、且需要跨模块复用的小事：
 *   · 服务端签名盐值（secret）：存 settings 表，进程启动时载入内存缓存
 *   · 业务主键生成（nextId）：走 seq 表的原子自增
 *   · 操作日志（log / listLogs）
 *   · 图片二进制目录（图片文件仍落盘，库里只存元信息）
 *
 * 注意：数据的增删改查一律走 lib/repo.js —— 全量 SQL 化之后，
 * 内存里不再保存全量数据，也就没有「整个库的对象」可拿了。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repo = require('./repo.js');
const time = require('./time.js');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

function ensureDir(dir) {
  const d = dir || DATA_DIR;
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ------------------------------ 服务端签名盐值 ------------------------------ */

let cachedSecret = null;

/** 启动时调用一次，之后 HMAC 签名直接用缓存，避免每次鉴权都查库 */
async function initSecret() {
  if (cachedSecret) return cachedSecret;
  let s = await repo.settings.get('secret');
  if (!s || typeof s !== 'string' || s.length < 16) {
    s = crypto.randomBytes(32).toString('hex');
    await repo.settings.set('secret', s);
  }
  cachedSecret = s;
  return s;
}

/** 同步取盐值（供高频签名使用；正常应由 initSecret() 先填好缓存） */
function secret() {
  if (!cachedSecret) {
    // 理论上不会发生：服务启动时会先 initSecret()。
    // 兜底生成临时值，保证不崩，代价是需要重新登录。
    cachedSecret = crypto.randomBytes(32).toString('hex');
  }
  return cachedSecret;
}

/* ------------------------------ 业务主键 ------------------------------ */

async function nextId(kind) {
  const n = await repo.seq.next(kind);
  return `${kind}_${Date.now().toString(36)}_${n.toString(36)}`;
}

/* ------------------------------ 操作日志 ------------------------------ */

async function log(user, action, target, detail) {
  await repo.logs.add({
    id: await nextId('log'),
    ts: time.nowIso(),
    user: (user && (user.name || user.username)) || '系统',
    username: (user && user.username) || '',
    unit: (user && user.unit) || '', // 记录操作人所属单位，供单位管理员按范围查看
    action,
    target: target || '',
    detail: detail || '',
  });
  // 只保留最近 5000 条（与旧版一致）；裁剪失败不影响主流程
  try { await repo.logs.trim(5000); } catch (e) { /* ignore */ }
}

/**
 * @param {number} limit
 * @param {Set<string>|null} unitNames 非系统管理员只看本单位记录
 */
async function listLogs(limit = 200, unitNames = null) {
  return repo.logs.list(limit, unitNames ? [...unitNames] : null);
}

/* ------------------------------ 图片目录 ------------------------------ */

function imageDir(assetId) {
  const dir = path.join(IMAGES_DIR, String(assetId));
  ensureDir(dir);
  return dir;
}

module.exports = {
  DATA_DIR,
  IMAGES_DIR,
  imageDir,
  ensureDir,
  initSecret,
  secret,
  nextId,
  log,
  listLogs,
};
