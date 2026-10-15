'use strict';
/**
 * MySQL 数据访问底层：连接池 / 查询 / 事务 / 字段命名映射
 *
 * 只在这里 require('mysql2')（项目唯一的第三方依赖），上层一律通过 query/exec/tx 访问数据库，
 * 这样以后要换数据库驱动时只需改本文件。
 *
 * 约定：
 *   · 数据库列名用 snake_case，业务代码里用 camelCase，映射在本文件统一完成；
 *   · DATETIME 列统一转成 ISO 字符串返回，与改造前的 JSON 版本行为一致（前端大量按字符串排序）；
 *   · 连接配置优先环境变量，其次 data/dbconfig.json（该文件不入库）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = process.env.DB_CONFIG || path.join(ROOT, 'data', 'dbconfig.json');

/** 数据库名：两个项目各自独立（house_land / estate_admin） */
const DEFAULT_DB = process.env.DB_NAME || 'house_land';

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: DEFAULT_DB,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  dateStrings: ['DATE'], // DATE 列返回 'YYYY-MM-DD'；DATETIME 交给我们自己转 ISO
  multipleStatements: false,
};

/** DATETIME 列：查询结果转成 ISO 字符串，保持与旧 JSON 存储一致 */
const DATETIME_KEYS = new Set([
  'createdAt', 'updatedAt', 'lastLoginAt', 'uploadedAt', 'ts', 'geoAt', 'updated_at',
]);

/**
 * 写入时的「空串转换」规则：
 * 数值 / 日期 / 时间列遇到空串要转成 NULL（否则 MySQL 严格模式会报类型错误）；
 * 字符串列必须保持空串，因为表结构里这些列是 NOT NULL DEFAULT ''，写 NULL 会失败。
 */
const NUMERIC_COLUMNS = new Set([
  'row_no', 'area', 'office_area', 'per_capita_area', 'actual_staff', 'approved_staff',
  'temp_staff', 'original_value', 'age', 'overhaul_amount', 'rent_income', 'lease_rent',
  'lng', 'lat', 'size', 'w', 'h', 'sort', 'disabled',
]);
const DATE_COLUMNS = new Set(['use_date', 'acquire_date']);
const DATETIME_COLUMNS = new Set([
  'created_at', 'updated_at', 'last_login_at', 'uploaded_at', 'ts', 'geo_at',
]);

/**
 * 允许写成 NULL 的文本/JSON 列（表结构里是 NULL 而非 NOT NULL DEFAULT ''）。
 * 其余文本列遇到 null 一律回写成空串，否则会撞上 NOT NULL 约束
 * （典型场景：Excel 导入时单元格为空，schema.coerce 返回 null）。
 */
const NULLABLE_TEXT_COLUMNS = new Set([
  'polygon', 'geo_address', 'geo_at', 'geo_by', 'remark',
]);

let cachedConfig = null;
let pool = null;
let driverErr = null;

/* ------------------------------ 配置 ------------------------------ */

function loadDriver() {
  if (driverErr) throw driverErr;
  try {
    return require('mysql2/promise');
  } catch (e) {
    driverErr = new Error(
      '缺少数据库驱动 mysql2。请在项目根目录执行：npm install\n' +
      `（原始错误：${e.message}）`
    );
    throw driverErr;
  }
}

function readConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  // 1) 配置文件
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
    } catch (e) {
      console.error('[mysql] 数据库配置文件解析失败，将使用默认配置：', CONFIG_PATH, e.message);
    }
  } else {
    writeDefaultConfig();
  }
  Object.assign(cfg, fileCfg);
  // 2) 环境变量优先
  if (process.env.DB_HOST) cfg.host = process.env.DB_HOST;
  if (process.env.DB_PORT) cfg.port = Number(process.env.DB_PORT);
  if (process.env.DB_USER) cfg.user = process.env.DB_USER;
  if (process.env.DB_PASSWORD !== undefined) cfg.password = process.env.DB_PASSWORD;
  if (process.env.DB_NAME) cfg.database = process.env.DB_NAME;
  return cfg;
}

/** 首次运行时生成配置文件模板，方便使用者直接改，不需要翻文档 */
function writeDefaultConfig() {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tpl = Object.assign({}, DEFAULT_CONFIG);
    delete tpl.waitForConnections;
    delete tpl.queueLimit;
    delete tpl.connectTimeout;
    delete tpl.enableKeepAlive;
    delete tpl.keepAliveInitialDelay;
    delete tpl.dateStrings;
    delete tpl.multipleStatements;
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(tpl, null, 2) + '\n',
      'utf8'
    );
    console.log(`[mysql] 已生成数据库配置模板：${CONFIG_PATH}（请填入实际的连接信息后重启服务）`);
  } catch (e) {
    // 只读环境下写不了配置文件，直接用默认配置继续
  }
}

function config() {
  if (!cachedConfig) cachedConfig = readConfig();
  return cachedConfig;
}

function getPool() {
  if (pool) return pool;
  const mysql = loadDriver();
  pool = mysql.createPool(config());
  pool.on('error', (err) => {
    // 连接级错误（网络闪断等）不应该让进程退出
    console.error('[mysql] 连接池错误：', err && err.message);
  });
  return pool;
}

/* ------------------------------ 命名映射 ------------------------------ */

const snakeCache = new Map();
const camelCache = new Map();

/** camelCase -> snake_case */
function snake(s) {
  if (snakeCache.has(s)) return snakeCache.get(s);
  const out = String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  snakeCache.set(s, out);
  return out;
}

/** snake_case -> camelCase */
function camel(s) {
  if (camelCache.has(s)) return camelCache.get(s);
  const out = String(s).replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase());
  camelCache.set(s, out);
  return out;
}

function toISO(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** 数据库行 -> 业务对象（camelCase；DATETIME 转 ISO） */
function camelizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of Object.keys(row)) {
    const ck = camel(k);
    let v = row[k];
    if (v instanceof Date) v = toISO(v);
    out[ck] = v;
  }
  return out;
}

function camelizeRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(camelizeRow);
}

/** 业务对象 -> 数据库列（只保留给定的列白名单） */
function pickColumns(obj, columns) {
  const out = {};
  for (const col of columns) {
    const ck = camel(col);
    if (!(ck in obj)) continue;
    let v = obj[ck];
    const isTyped = NUMERIC_COLUMNS.has(col) || DATE_COLUMNS.has(col) || DATETIME_COLUMNS.has(col);
    // 空串：数值 / 日期 / 时间列转成 NULL，文本列保持空串（这些列是 NOT NULL）
    if (v === '' && isTyped) v = null;
    // null / undefined：可空列照写 NULL，其余文本列回写成空串，避免撞 NOT NULL 约束
    if (v === null || v === undefined) {
      v = (isTyped || NULLABLE_TEXT_COLUMNS.has(col)) ? null : '';
    }
    if (typeof v === 'object' && v !== null && !(v instanceof Date)) v = JSON.stringify(v);
    if (v instanceof Date) v = v.toISOString().slice(0, 19).replace('T', ' ');
    else if (typeof v === 'string' && DATETIME_KEYS.has(ck) && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      v = v.slice(0, 19).replace('T', ' ');
    }
    out[col] = v;
  }
  return out;
}

/* ------------------------------ 查询 ------------------------------ */

/** 查询：返回 camelCase 后的行数组 */
async function query(sql, params) {
  const [rows] = await getPool().execute(sql, params || []);
  return camelizeRows(rows);
}

/** 查询：返回原始行（不做命名转换，用于 COUNT(*) 这类聚合） */
async function queryRaw(sql, params) {
  const [rows] = await getPool().execute(sql, params || []);
  return rows;
}

/** 写入/更新/删除：返回 { affectedRows, insertId } */
async function exec(sql, params) {
  const [res] = await getPool().execute(sql, params || []);
  return { affectedRows: res.affectedRows || 0, insertId: res.insertId || 0 };
}

/** 事务：fn(conn) 内可用 conn.query/conn.exec，异常自动回滚 */
async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn({
      query: async (sql, params) => camelizeRows((await conn.execute(sql, params || []))[0]),
      queryRaw: async (sql, params) => (await conn.execute(sql, params || []))[0],
      exec: async (sql, params) => {
        const [res] = await conn.execute(sql, params || []);
        return { affectedRows: res.affectedRows || 0, insertId: res.insertId || 0 };
      },
    });
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (e2) { /* 回滚失败不覆盖原始异常 */ }
    throw e;
  } finally {
    conn.release();
  }
}

/** 取单个值（如 SELECT COUNT(*) c FROM t 里的 c） */
async function scalar(sql, params, key) {
  const rows = await queryRaw(sql, params || []);
  if (!rows || !rows.length) return null;
  const r = rows[0];
  return key ? r[key] : r[Object.keys(r)[0]];
}

/** 连通性检查 */
async function ping() {
  try {
    const t0 = Date.now();
    await query('SELECT 1 AS ok');
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
}

/** 把驱动错误翻译成人话，直接显示在系统设置页 */
function friendlyError(e) {
  if (!e) return '未知错误';
  const code = e.code || '';
  const msg = e.message || String(e);
  if (code === 'ECONNREFUSED') return `无法连接数据库（${config().host}:${config().port}），请确认 MySQL 已启动`;
  if (code === 'ER_ACCESS_DENIED_ERROR') return '数据库账号或密码错误，请检查 data/dbconfig.json';
  if (code === 'ER_BAD_DB_ERROR') return `数据库「${config().database}」不存在，请执行 npm run db:init 初始化`;
  if (code === 'ER_NO_SUCH_TABLE') return '数据表尚未创建，请执行 npm run db:init 初始化数据库';
  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT') return '数据库连接超时，请检查网络与服务状态';
  if (code === 'ER_DUP_ENTRY') return '数据重复，违反唯一约束';
  if (code === 'ER_DATA_TOO_LONG') return '字段内容超出长度限制';
  if (code === 'ER_TRUNCATED_WRONG_VALUE') return '数据类型不匹配（例如把文本写进了数值列）';
  if (/mysql2/.test(msg) && /Cannot find module/.test(msg)) return msg;
  return msg;
}

/** 执行建表脚本（按语句分割，忽略空语句与整行注释） */
async function runScript(sqlText) {
  const stmts = sqlText
    .split(/\r?\n/)
    .filter((l) => !/^\s*(--|#|\/\*)/.test(l))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) {
    await getPool().query(s);
  }
  return stmts.length;
}

/** 关闭连接池（进程退出 / 单元测试用） */
async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = {
  config, query, queryRaw, exec, tx, scalar, ping, close, runScript,
  camel, snake, camelizeRow, camelizeRows, pickColumns, friendlyError,
  CONFIG_PATH, ROOT,
};
