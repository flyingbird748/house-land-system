'use strict';
/**
 * 数据存储层：单文件 JSON + 原子写入（先写临时文件再 rename），零第三方依赖。
 * 数据量级（数百至数万条资产）下性能充足，且无需安装任何数据库。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'server.key');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const EMPTY = () => ({
  meta: { version: 1, createdAt: new Date().toISOString() },
  units: [],
  users: [],
  assets: [],
  logs: [],
  settings: {}, // 系统设置（地图服务商与密钥等），见 lib/mapconfig.js
  images: [],   // 房产图片元信息（二进制在 data/images/ 下），见 lib/images.js
  seq: { asset: 0, user: 0, log: 0, unit: 0 },
});

let db = null;
let saveTimer = null;
let dirty = false;

function load() {
  ensureDir();
  if (db) return db;
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      const base = EMPTY();
      for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
    } catch (e) {
      const bak = DB_FILE + '.corrupt-' + Date.now();
      fs.copyFileSync(DB_FILE, bak);
      console.error('[store] 数据文件损坏，已备份至', bak, '并重建空库:', e.message);
      db = EMPTY();
    }
  } else {
    db = EMPTY();
    flush();
  }
  return db;
}

function flush() {
  ensureDir();
  const tmp = DB_FILE + '.' + process.pid + '.tmp';
  const json = JSON.stringify(db, null, 1);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, DB_FILE);
  dirty = false;
}

/** 合并写入：高频操作下避免每个请求都落盘 */
function save() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirty) {
      try { flush(); } catch (e) { console.error('[store] 写入失败', e); }
    }
  }, 120);
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  flush();
}

function nextId(kind) {
  const d = load();
  d.seq[kind] = (d.seq[kind] || 0) + 1;
  return `${kind}_${Date.now().toString(36)}_${d.seq[kind].toString(36)}`;
}

/* ------------------------------ 服务端密钥 ------------------------------ */

let cachedSecret = null;
function secret() {
  if (cachedSecret) return cachedSecret;
  ensureDir();
  if (fs.existsSync(SECRET_FILE)) {
    cachedSecret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } else {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, cachedSecret, 'utf8');
  }
  if (!cachedSecret) {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, cachedSecret, 'utf8');
  }
  return cachedSecret;
}

/* ------------------------------ 操作日志 ------------------------------ */

function log(user, action, target, detail) {
  const d = load();
  d.logs.push({
    id: nextId('log'),
    ts: new Date().toISOString(),
    user: (user && (user.name || user.username)) || '系统',
    username: (user && user.username) || '',
    unit: (user && user.unit) || '', // 记录操作人所属单位，供单位管理员按范围查看
    action,
    target: target || '',
    detail: detail || '',
  });
  if (d.logs.length > 5000) d.logs.splice(0, d.logs.length - 5000);
}

function listLogs(limit = 200) {
  const d = load();
  return d.logs.slice(-limit).reverse();
}

module.exports = { load, save, saveNow, nextId, secret, log, listLogs, DATA_DIR, DB_FILE };
