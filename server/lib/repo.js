'use strict';
/**
 * 数据仓储层：所有 SQL 集中在这里，业务代码不再直接碰数据库。
 *
 * 设计原则
 *   · 入参一律是业务对象（camelCase），出参也是 camelCase，列名映射由 mysql.js 完成；
 *   · 所有动态值都走占位符 ?，杜绝拼接 SQL；
 *   · 排序字段走白名单，防止 order by 注入；
 *   · 单位表数据量小（几十条），允许整体缓存；资产表一律走 SQL 分页/聚合，不进内存。
 */

const db = require('./mysql.js');
const time = require('./time.js');
const schema = require('./schema.js');

/* ------------------------------ 列清单 ------------------------------ */

/** assets 表全部列（snake_case），写入时按此白名单取值 */
const ASSET_COLUMNS = [
  'id', 'unit_id', 'created_at', 'updated_at', 'created_by', 'updated_by',
  'row_no', 'unit', 'name', 'sys_name', 'use_unit', 'use_status', 'asset_no',
  'category', 'purpose', 'structure', 'location',
  'has_title', 'title_type', 'title_no', 'multi_share_title', 'multi_share_title_no',
  'split_title', 'split_title_no',
  'area', 'office_area', 'per_capita_area', 'actual_staff', 'approved_staff', 'temp_staff',
  'original_value', 'use_date', 'acquire_date', 'age', 'overhauled', 'overhaul_date', 'overhaul_amount',
  'idle_long', 'idle_stage', 'rented_out', 'rent_term', 'rent_income',
  'leased_in', 'lease_term', 'lease_rent', 'remark',
  'lng', 'lat', 'polygon', 'geo_address', 'geo_at', 'geo_by',
];

const UNIT_COLUMNS = ['id', 'name', 'code', 'parent', 'sort', 'created_at'];
const USER_COLUMNS = ['id', 'username', 'name', 'role', 'unit', 'unit_id', 'salt', 'hash', 'disabled', 'created_at', 'last_login_at'];
const IMAGE_COLUMNS = ['id', 'asset_id', 'name', 'label', 'file', 'mime', 'size', 'w', 'h', 'uploaded_at', 'uploaded_by'];
const LOG_COLUMNS = ['id', 'ts', 'user', 'username', 'unit', 'action', 'target', 'detail'];

/** 排序字段白名单：业务字段 -> 数据库列 */
const SORT_COLUMNS = {
  name: 'name', rowNo: 'row_no', area: 'area', officeArea: 'office_area',
  originalValue: 'original_value', age: 'age', category: 'category',
  useStatus: 'use_status', unit: 'unit', updatedAt: 'updated_at',
  createdAt: 'created_at', actualStaff: 'actual_staff', sortNo: 'sort_no',
};

const AGG_FIELDS = {
  category: 'category', useStatus: 'use_status', unit: 'unit',
  useUnit: 'use_unit', purpose: 'purpose', titleType: 'title_type',
};

/* ------------------------------ 通用工具 ------------------------------ */

/** 当前时间的 DATETIME 串（服务器本地时间，见 time.js 的约定） */
function nowSql() {
  return time.nowSql();
}

/** 把可见单位名集合转成 SQL 条件；null 表示不限制 */
function scopeClause(names, alias) {
  const a = alias ? `\`${alias}\`.` : '';
  if (!names) return { sql: '', params: [] };
  if (Array.isArray(names) && names.length === 0) {
    return { sql: ' AND 1 = 0', params: [] }; // 未绑定单位的非管理员：看不见任何数据
  }
  const list = [...names];
  return { sql: ` AND ${a}\`unit\` IN (${list.map(() => '?').join(',')})`, params: list };
}

/**
 * 把前端查询参数翻译成 WHERE 条件
 * @param {URLSearchParams} q
 * @param {Set<string>|null} unitScope 可见单位名集合；null = 不限制
 */
function buildWhere(q, unitScope) {
  const where = [];
  const params = [];

  // 可见范围
  if (unitScope) {
    if (unitScope.size === 0) {
      where.push('1 = 0');
    } else {
      where.push(`\`unit\` IN (${[...unitScope].map(() => '?').join(',')})`);
      params.push(...unitScope);
    }
  }

  // 关键词：跨多个文本列
  const keyword = String(q.get('q') || '').trim();
  if (keyword) {
    const kw = `%${keyword}%`;
    where.push(`(\`name\` LIKE ? OR \`sys_name\` LIKE ? OR \`use_unit\` LIKE ? OR \`asset_no\` LIKE ?
      OR \`location\` LIKE ? OR \`title_no\` LIKE ? OR \`unit\` LIKE ? OR \`category\` LIKE ?
      OR \`use_status\` LIKE ? OR \`remark\` LIKE ?)`);
    params.push(kw, kw, kw, kw, kw, kw, kw, kw, kw, kw);
  }

  // 多选相等过滤
  const inList = (key) => {
    const raw = q.get(key);
    if (!raw) return null;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  };
  const eq = (paramKey, column) => {
    const vals = inList(paramKey);
    if (!vals || !vals.length) return;
    where.push(`\`${column}\` IN (${vals.map(() => '?').join(',')})`);
    params.push(...vals);
  };
  eq('category', 'category');
  eq('useStatus', 'use_status');
  eq('hasTitle', 'has_title');
  eq('purpose', 'purpose');

  // 单位过滤（含下级单位，unitMode=exact 时只匹配本单位）
  const unitVals = inList('unit');
  if (unitVals && unitVals.length) {
    where.push(`\`unit\` IN (${unitVals.map(() => '?').join(',')})`);
    params.push(...unitVals);
  }

  const marked = q.get('marked');
  if (marked === 'yes') where.push('(`lng` IS NOT NULL AND `lat` IS NOT NULL)');
  if (marked === 'no') where.push('(`lng` IS NULL OR `lat` IS NULL)');

  if (q.get('idle') === 'yes') where.push("(`idle_long` = '是' OR `idle_stage` = '是')");
  if (q.get('rented') === 'yes') where.push("(`rented_out` IN ('是','出租','出借'))");
  if (q.get('leased') === 'yes') where.push("(`leased_in` IN ('是','租入','借入'))");
  if (q.get('overhauled') === 'yes') where.push("`overhauled` = '是'");

  // 数值区间
  const numParam = (k) => {
    const raw = q.get(k);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const range = (minKey, maxKey, column) => {
    const min = numParam(minKey);
    const max = numParam(maxKey);
    if (min !== null) { where.push(`\`${column}\` >= ?`); params.push(min); }
    if (max !== null) { where.push(`\`${column}\` <= ?`); params.push(max); }
  };
  range('areaMin', 'areaMax', 'area');
  range('valMin', 'valMax', 'original_value');
  range('ageMin', 'ageMax', 'age');

  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

function buildOrder(q) {
  const key = q.get('sort');
  const col = SORT_COLUMNS[key];
  if (!col) return ' ORDER BY `sort_no` ASC';
  const dir = q.get('order') === 'asc' ? 'ASC' : 'DESC';
  return ` ORDER BY \`${col}\` ${dir}, \`sort_no\` ASC`;
}

/* ------------------------------ 单位 ------------------------------ */

const units = {
  async list() {
    return db.query(`SELECT * FROM \`units\` ORDER BY \`sort\` ASC, \`name\` ASC`);
  },
  async byId(id) {
    const rows = await db.query('SELECT * FROM `units` WHERE `id` = ?', [id]);
    return rows[0] || null;
  },
  async byName(name) {
    const rows = await db.query('SELECT * FROM `units` WHERE `name` = ?', [name]);
    return rows[0] || null;
  },
  async existsName(name, excludeId) {
    const sql = excludeId
      ? 'SELECT COUNT(*) c FROM `units` WHERE `name` = ? AND `id` <> ?'
      : 'SELECT COUNT(*) c FROM `units` WHERE `name` = ?';
    const params = excludeId ? [name, excludeId] : [name];
    return (await db.scalar(sql, params, 'c')) > 0;
  },
  async count() {
    return db.scalar('SELECT COUNT(*) c FROM `units`', [], 'c');
  },
  async create(u) {
    const row = db.pickColumns(u, UNIT_COLUMNS);
    row.created_at = row.created_at || nowSql();
    const cols = Object.keys(row);
    await db.exec(
      `INSERT INTO \`units\` (${cols.map((c) => '`' + c + '`').join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map((c) => row[c])
    );
    return u;
  },
  async update(id, patch) {
    const row = db.pickColumns(patch, UNIT_COLUMNS.filter((c) => c !== 'id'));
    const cols = Object.keys(row).filter((c) => c in row);
    if (!cols.length) return 0;
    const r = await db.exec(
      `UPDATE \`units\` SET ${cols.map((c) => '`' + c + '` = ?').join(',')} WHERE \`id\` = ?`,
      [...cols.map((c) => row[c]), id]
    );
    return r.affectedRows;
  },
  async remove(id) {
    const r = await db.exec('DELETE FROM `units` WHERE `id` = ?', [id]);
    return r.affectedRows;
  },
  /** 各单位的资产条数（单位管理页显示用） */
  async assetCounts() {
    const rows = await db.queryRaw(
      'SELECT `unit`, COUNT(*) c FROM `assets` GROUP BY `unit`'
    );
    const map = {};
    for (const r of rows) map[String(r.unit || '')] = Number(r.c);
    return map;
  },
  /** 单位改名：同步资产与用户里的单位名（事务） */
  async renameCascade(oldName, newName, unitId) {
    return db.tx(async (c) => {
      await c.exec('UPDATE `assets` SET `unit` = ?, `unit_id` = ? WHERE `unit` = ?', [newName, unitId || '', oldName]);
      await c.exec('UPDATE `users` SET `unit` = ?, `unit_id` = ? WHERE `unit` = ?', [newName, unitId || '', oldName]);
    });
  },
  /** 删除单位后清理用户的失效引用 */
  async clearRefs(unitId) {
    return db.exec('UPDATE `users` SET `unit` = \'\', `unit_id` = \'\' WHERE `unit_id` = ?', [unitId]);
  },
};

/* ------------------------------ 用户 ------------------------------ */

const users = {
  async list() {
    return db.query('SELECT * FROM `users` ORDER BY `created_at` ASC, `id` ASC');
  },
  async byId(id) {
    const rows = await db.query('SELECT * FROM `users` WHERE `id` = ?', [id]);
    return rows[0] || null;
  },
  async byUsername(username) {
    const rows = await db.query('SELECT * FROM `users` WHERE `username` = ?', [username]);
    return rows[0] || null;
  },
  async existsUsername(username) {
    return (await db.scalar('SELECT COUNT(*) c FROM `users` WHERE `username` = ?', [username], 'c')) > 0;
  },
  async count() {
    return db.scalar('SELECT COUNT(*) c FROM `users`', [], 'c');
  },
  async create(u) {
    const row = db.pickColumns(u, USER_COLUMNS);
    row.created_at = row.created_at || nowSql();
    const cols = Object.keys(row);
    await db.exec(
      `INSERT INTO \`users\` (${cols.map((c) => '`' + c + '`').join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map((c) => row[c])
    );
    return u;
  },
  async update(id, patch) {
    const row = db.pickColumns(patch, USER_COLUMNS.filter((c) => c !== 'id'));
    const cols = Object.keys(row);
    if (!cols.length) return 0;
    const r = await db.exec(
      `UPDATE \`users\` SET ${cols.map((c) => '`' + c + '` = ?').join(',')} WHERE \`id\` = ?`,
      [...cols.map((c) => row[c]), id]
    );
    return r.affectedRows;
  },
  async remove(id) {
    const r = await db.exec('DELETE FROM `users` WHERE `id` = ?', [id]);
    return r.affectedRows;
  },
  async touchLogin(id) {
    return db.exec('UPDATE `users` SET `last_login_at` = ? WHERE `id` = ?', [nowSql(), id]);
  },
};

/* ------------------------------ 资产 ------------------------------ */

const assets = {
  async byId(id) {
    const rows = await db.query('SELECT * FROM `assets` WHERE `id` = ?', [id]);
    return rows[0] || null;
  },
  async existsAssetNo(assetNo, excludeId) {
    const sql = excludeId
      ? 'SELECT COUNT(*) c FROM `assets` WHERE `asset_no` = ? AND `id` <> ?'
      : 'SELECT COUNT(*) c FROM `assets` WHERE `asset_no` = ?';
    const params = excludeId ? [assetNo, excludeId] : [assetNo];
    return (await db.scalar(sql, params, 'c')) > 0;
  },
  async count() {
    return db.scalar('SELECT COUNT(*) c FROM `assets`', [], 'c');
  },

  /**
   * 列表：筛选 + 排序 + 分页全部在 SQL 里完成
   * @returns {Promise<{total:number, rows:Array, page:number, pageSize:number}>}
   */
  async search(q, unitScope) {
    const w = buildWhere(q, unitScope);
    const total = await db.scalar(`SELECT COUNT(*) c FROM \`assets\`${w.sql}`, w.params, 'c');

    const all = q.get('pageSize') === 'all';
    let page = 1;
    let pageSize = 20;
    let limitSql = '';
    const limitParams = [];
    if (!all) {
      const p = Number(q.get('page'));
      const s = Number(q.get('pageSize'));
      page = Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
      pageSize = Number.isFinite(s) && s >= 1 ? Math.min(500, Math.floor(s)) : 20;
      limitSql = ' LIMIT ? OFFSET ?';
      limitParams.push(pageSize, (page - 1) * pageSize);
    }

    const rows = await db.query(
      `SELECT * FROM \`assets\`${w.sql}${buildOrder(q)}${limitSql}`,
      [...w.params, ...limitParams]
    );
    return { total: Number(total) || 0, rows, page, pageSize: all ? Number(total) || 0 : pageSize };
  },

  /** 不分页取全部（导出、报告、统计用） */
  async listAll(q, unitScope) {
    const w = buildWhere(q, unitScope);
    return db.query(`SELECT * FROM \`assets\`${w.sql} ORDER BY \`sort_no\` ASC`, w.params);
  },

  /** 按 id 批量取（导出勾选行） */
  async byIds(ids) {
    if (!ids || !ids.length) return [];
    return db.query(
      `SELECT * FROM \`assets\` WHERE \`id\` IN (${ids.map(() => '?').join(',')}) ORDER BY \`sort_no\` ASC`,
      ids
    );
  },

  /** 只要 id 列表（批量取图片时用，避免把整行读出来） */
  async listIds(q, unitScope) {
    const w = buildWhere(q, unitScope);
    const rows = await db.queryRaw(`SELECT \`id\` FROM \`assets\`${w.sql} ORDER BY \`sort_no\` ASC`, w.params);
    return rows.map((r) => r.id);
  },

  async create(a) {
    const row = db.pickColumns(a, ASSET_COLUMNS);
    row.created_at = row.created_at ? String(row.created_at).slice(0, 19).replace('T', ' ') : nowSql();
    row.updated_at = row.updated_at ? String(row.updated_at).slice(0, 19).replace('T', ' ') : row.created_at;
    const cols = Object.keys(row);
    await db.exec(
      `INSERT INTO \`assets\` (${cols.map((c) => '`' + c + '`').join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map((c) => row[c])
    );
    return a;
  },

  async update(id, patch) {
    const row = db.pickColumns(patch, ASSET_COLUMNS.filter((c) => c !== 'id' && c !== 'sort_no'));
    const cols = Object.keys(row);
    if (!cols.length) return 0;
    const r = await db.exec(
      `UPDATE \`assets\` SET ${cols.map((c) => '`' + c + '` = ?').join(',')} WHERE \`id\` = ?`,
      [...cols.map((c) => row[c]), id]
    );
    return r.affectedRows;
  },

  async remove(id) {
    const r = await db.exec('DELETE FROM `assets` WHERE `id` = ?', [id]);
    return r.affectedRows;
  },

  /** 批量删除（权限过滤由调用方完成，这里只删给定 id） */
  async removeIds(ids) {
    if (!ids || !ids.length) return 0;
    const r = await db.exec(
      `DELETE FROM \`assets\` WHERE \`id\` IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    return r.affectedRows;
  },

  /** 删除某可见范围内的全部资产（导入时「清空后导入」用） */
  async removeByUnits(unitNames) {
    if (!unitNames) {
      const r = await db.exec('DELETE FROM `assets`');
      return r.affectedRows;
    }
    if (!unitNames.length) return 0;
    const r = await db.exec(
      `DELETE FROM \`assets\` WHERE \`unit\` IN (${unitNames.map(() => '?').join(',')})`,
      [...unitNames]
    );
    return r.affectedRows;
  },

  /** 按资产编号取一批（导入 upsert 用） */
  async byAssetNos(nos) {
    if (!nos || !nos.length) return [];
    return db.query(
      `SELECT * FROM \`assets\` WHERE \`asset_no\` IN (${nos.map(() => '?').join(',')})`,
      nos
    );
  },

  /** 统计看板：一次性聚合出所有主指标 */
  async stats(q, unitScope) {
    const w = buildWhere(q, unitScope);
    const row = await db.queryRaw(
      `SELECT
         COUNT(*) total,
         COALESCE(SUM(\`area\`), 0) total_area,
         COALESCE(SUM(\`office_area\`), 0) total_office_area,
         COALESCE(SUM(\`original_value\`), 0) total_value,
         COALESCE(SUM(\`actual_staff\`), 0) total_staff,
         COALESCE(SUM(\`rent_income\`), 0) rent_income,
         COALESCE(SUM(\`lease_rent\`), 0) lease_rent,
         SUM(CASE WHEN \`has_title\` = '有产权' THEN 1 ELSE 0 END) titled,
         SUM(CASE WHEN \`has_title\` = '无产权' THEN 1 ELSE 0 END) untitled,
         SUM(CASE WHEN \`idle_long\` = '是' OR \`idle_stage\` = '是' THEN 1 ELSE 0 END) idle_count,
         SUM(CASE WHEN \`rented_out\` IN ('是','出租','出借') THEN 1 ELSE 0 END) rent_count,
         SUM(CASE WHEN \`leased_in\` IN ('是','租入','借入') THEN 1 ELSE 0 END) lease_count,
         SUM(CASE WHEN \`overhauled\` = '是' THEN 1 ELSE 0 END) overhauled,
         SUM(CASE WHEN \`lng\` IS NOT NULL AND \`lat\` IS NOT NULL THEN 1 ELSE 0 END) geo_marked,
         SUM(CASE WHEN \`age\` >= 0 AND \`age\` <= 5 THEN 1 ELSE 0 END) age_0_5,
         SUM(CASE WHEN \`age\` >= 6 AND \`age\` <= 10 THEN 1 ELSE 0 END) age_6_10,
         SUM(CASE WHEN \`age\` >= 11 AND \`age\` <= 20 THEN 1 ELSE 0 END) age_11_20,
         SUM(CASE WHEN \`age\` >= 21 AND \`age\` <= 30 THEN 1 ELSE 0 END) age_21_30,
         SUM(CASE WHEN \`age\` >= 31 THEN 1 ELSE 0 END) age_31_plus
       FROM \`assets\`${w.sql}`,
      w.params
    );
    const r = row[0] || {};
    const n = (v) => Number(v) || 0;
    const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

    const total = n(r.total);
    return {
      total,
      totalArea: round2(r.total_area),
      totalOfficeArea: round2(r.total_office_area),
      totalValue: round2(r.total_value),
      totalStaff: n(r.total_staff),
      titled: n(r.titled),
      untitled: n(r.untitled),
      idleCount: n(r.idle_count),
      rentCount: n(r.rent_count),
      leaseCount: n(r.lease_count),
      rentIncome: round2(r.rent_income),
      leaseRent: round2(r.lease_rent),
      overhauled: n(r.overhauled),
      geoMarked: n(r.geo_marked),
      geoUnmarked: total - n(r.geo_marked),
      byAge: [
        { name: '5年以内', count: n(r.age_0_5) },
        { name: '6-10年', count: n(r.age_6_10) },
        { name: '11-20年', count: n(r.age_11_20) },
        { name: '21-30年', count: n(r.age_21_30) },
        { name: '30年以上', count: n(r.age_31_plus) },
      ],
    };
  },

  /** 分组统计：SELECT 字段, COUNT(*), SUM(面积), SUM(原值) ... GROUP BY 字段 */
  async groupBy(field, q, unitScope, limit) {
    const col = AGG_FIELDS[field];
    if (!col) return [];
    const w = buildWhere(q, unitScope);
    const rows = await db.queryRaw(
      `SELECT COALESCE(NULLIF(\`${col}\`, ''), '未填写') g, COUNT(*) c,
              COALESCE(SUM(\`area\`), 0) a, COALESCE(SUM(\`original_value\`), 0) v
       FROM \`assets\`${w.sql}
       GROUP BY g
       ORDER BY c DESC, a DESC
       ${limit ? 'LIMIT ?' : ''}`,
      limit ? [...w.params, limit] : w.params
    );
    return rows.map((r) => ({
      name: String(r.g),
      count: Number(r.c) || 0,
      area: Math.round(Number(r.a || 0) * 100) / 100,
      value: Math.round(Number(r.v || 0) * 100) / 100,
    }));
  },

  /** 取某字段的全部取值（枚举选项里的「数据中已出现的值」） */
  async distinct(field, unitScope) {
    const col = db.snake(field);
    const s = scopeClause(unitScope);
    const rows = await db.queryRaw(
      `SELECT DISTINCT \`${col}\` v FROM \`assets\` WHERE \`${col}\` IS NOT NULL AND \`${col}\` <> ''${s.sql.replace(/^ AND /, ' AND ')} ORDER BY v`,
      s.params
    );
    return rows.map((r) => String(r.v));
  },

  /** 最近更新的若干条（看板「最近更新」） */
  async recent(q, unitScope, limit) {
    const w = buildWhere(q, unitScope);
    return db.query(
      `SELECT \`id\`, \`name\`, \`unit\`, \`updated_at\`, \`updated_by\` FROM \`assets\`${w.sql}
       ORDER BY \`updated_at\` DESC LIMIT ?`,
      [...w.params, limit || 8]
    );
  },

  /** 区县分布：地址里正则提取区县，只能在 JS 里做，故只取 location 一列 */
  async districtRows(q, unitScope) {
    const w = buildWhere(q, unitScope);
    return db.queryRaw(
      `SELECT \`location\`, \`name\`, \`area\` FROM \`assets\`${w.sql}`,
      w.params
    );
  },
};

/* ------------------------------ 图片 ------------------------------ */

const images = {
  async ofAsset(assetId) {
    return db.query('SELECT * FROM `images` WHERE `asset_id` = ? ORDER BY `uploaded_at` ASC, `id` ASC', [assetId]);
  },
  async byId(assetId, imageId) {
    const rows = await db.query('SELECT * FROM `images` WHERE `asset_id` = ? AND `id` = ?', [assetId, imageId]);
    return rows[0] || null;
  },
  async add(rec) {
    const row = db.pickColumns(rec, IMAGE_COLUMNS);
    row.uploaded_at = row.uploaded_at ? String(row.uploaded_at).slice(0, 19).replace('T', ' ') : nowSql();
    const cols = Object.keys(row);
    await db.exec(
      `INSERT INTO \`images\` (${cols.map((c) => '`' + c + '`').join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map((c) => row[c])
    );
    return rec;
  },
  async setLabel(assetId, imageId, label) {
    const r = await db.exec('UPDATE `images` SET `label` = ? WHERE `asset_id` = ? AND `id` = ?', [label, assetId, imageId]);
    return r.affectedRows;
  },
  async remove(assetId, imageId) {
    const r = await db.exec('DELETE FROM `images` WHERE `asset_id` = ? AND `id` = ?', [assetId, imageId]);
    return r.affectedRows;
  },
  async removeByAsset(assetId) {
    const r = await db.exec('DELETE FROM `images` WHERE `asset_id` = ?', [assetId]);
    return r.affectedRows;
  },
  /** 批量取多条资产的图片（地图/预览页一次拉齐） */
  async groupByAssetIds(assetIds) {
    if (!assetIds || !assetIds.length) return {};
    const rows = await db.query(
      `SELECT * FROM \`images\` WHERE \`asset_id\` IN (${assetIds.map(() => '?').join(',')}) ORDER BY \`uploaded_at\` ASC, \`id\` ASC`,
      assetIds
    );
    const map = {};
    for (const r of rows) {
      if (!map[r.assetId]) map[r.assetId] = [];
      map[r.assetId].push(r);
    }
    return map;
  },
};

/* ------------------------------ 日志 ------------------------------ */

const logs = {
  async add(rec) {
    const row = db.pickColumns(rec, LOG_COLUMNS);
    row.ts = row.ts ? String(row.ts).slice(0, 19).replace('T', ' ') : nowSql();
    const cols = Object.keys(row);
    await db.exec(
      `INSERT INTO \`logs\` (${cols.map((c) => '`' + c + '`').join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map((c) => row[c])
    );
  },
  /** 取最近 limit 条（倒序）；传 unitNames 时只取这些单位的操作记录 */
  async list(limit, unitNames) {
    const n = Math.min(2000, Math.max(1, Number(limit) || 200));
    if (unitNames) {
      if (unitNames.length === 0) return [];
      return db.query(
        `SELECT * FROM \`logs\` WHERE \`unit\` IN (${unitNames.map(() => '?').join(',')})
         ORDER BY \`ts\` DESC, \`id\` DESC LIMIT ?`,
        [...unitNames, n]
      );
    }
    return db.query('SELECT * FROM `logs` ORDER BY `ts` DESC, `id` DESC LIMIT ?', [n]);
  },
  async trim(keep) {
    const n = Number(keep) || 5000;
    const total = await db.scalar('SELECT COUNT(*) c FROM `logs`', [], 'c');
    if (total <= n) return 0;
    // 保留最近 n 条：按时间倒序取第 n 条的时间戳，删掉更早的
    const rows = await db.queryRaw('SELECT `ts` FROM `logs` ORDER BY `ts` DESC LIMIT 1 OFFSET ?', [n]);
    if (!rows.length) return 0;
    const r = await db.exec('DELETE FROM `logs` WHERE `ts` < ?', [rows[0].ts]);
    return r.affectedRows;
  },
};

/* ------------------------------ 系统设置（KV） ------------------------------ */

const settings = {
  async get(k, fallback) {
    const rows = await db.query('SELECT `v` FROM `settings` WHERE `k` = ?', [k]);
    if (!rows.length) return fallback === undefined ? null : fallback;
    const raw = rows[0].v;
    if (raw == null || raw === '') return fallback === undefined ? null : fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback === undefined ? null : fallback;
    }
  },
  async set(k, v) {
    await db.exec(
      'INSERT INTO `settings` (`k`, `v`, `updated_at`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `v` = VALUES(`v`), `updated_at` = VALUES(`updated_at`)',
      [k, JSON.stringify(v === undefined ? null : v), nowSql()]
    );
    return v;
  },
};

/* ------------------------------ 序列（业务主键） ------------------------------ */

const seq = {
  /** 取下一个序号：UPDATE + LAST_INSERT_ID，避免锁表 */
  async next(kind) {
    await db.exec('INSERT IGNORE INTO `seq` (`kind`, `val`) VALUES (?, 0)', [kind]);
    await db.exec('UPDATE `seq` SET `val` = LAST_INSERT_ID(`val` + 1) WHERE `kind` = ?', [kind]);
    const rows = await db.queryRaw('SELECT LAST_INSERT_ID() v');
    return Number(rows[0].v) || 1;
  },
};

module.exports = {
  units, users, assets, images, logs, settings, seq,
  buildWhere, buildOrder, scopeClause,
  ASSET_COLUMNS, SORT_COLUMNS, nowSql,
};
