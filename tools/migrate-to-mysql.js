'use strict';
/**
 * 把改造前的 data/db.json（单文件 JSON）迁移到 MySQL
 *
 *   node tools/migrate-to-mysql.js                  # 迁移当前项目根目录下的 data/db.json
 *   node tools/migrate-to-mysql.js <db.json 路径>   # 指定老数据文件
 *   node tools/migrate-to-mysql.js <路径> --replace # 先清空目标表再导入（整库覆盖）
 *
 * 特点
 *   · 幂等：主键冲突时跳过（不加 --replace 时），可以反复执行补齐；
 *   · 只写数据，不建表 —— 建表请先跑 npm run db:init；
 *   · 迁移完会把 seq 序列推到现有最大值，避免新生成的主键与历史 id 撞车。
 */
const fs = require('fs');
const path = require('path');

const db = require('../server/lib/mysql.js');
const repo = require('../server/lib/repo.js');

const ROOT = path.join(__dirname, '..');

/* ------------------------------ 批量插入 ------------------------------ */

/** 日期/时间字段：ISO 字符串 -> MySQL DATETIME */
function norm(v) {
  if (v === undefined || v === '' || v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 19).replace('T', ' ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function toRow(obj, columns) {
  const row = db.pickColumns(obj, columns);
  const out = {};
  for (const c of columns) out[c] = norm(row[c]);
  return out;
}

async function insertBatch(table, columns, rows, ignore) {
  if (!rows.length) return { inserted: 0, skipped: 0 };
  const CHUNK = 200;
  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const values = [];
    for (const r of part) for (const c of columns) values.push(r[c]);
    const ph = part.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    const kw = ignore ? 'INSERT IGNORE' : 'INSERT';
    const tail = ignore ? '' : ` ON DUPLICATE KEY UPDATE \`${columns[0]}\` = VALUES(\`${columns[0]}\`)`;
    try {
      const r = await db.exec(
        `${kw} INTO \`${table}\` (${columns.map((c) => '`' + c + '`').join(',')}) VALUES ${ph}${tail}`,
        values
      );
      inserted += r.affectedRows || 0;
    } catch (e) {
      console.error(`  ! 写入 ${table} 失败（本批 ${part.length} 行）：${db.friendlyError(e)}`);
      skipped += part.length;
    }
  }
  return { inserted, skipped };
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const replace = process.argv.includes('--replace');
  const src = args[0] ? path.resolve(args[0]) : path.join(ROOT, 'data', 'db.json');

  if (!fs.existsSync(src)) {
    console.error(`找不到数据文件：${src}`);
    console.error('如果是全新安装（本就是空库），不需要迁移，直接启动服务即可。');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
  const cfg = db.config();
  console.log(`源数据：${src}`);
  console.log(`目标库：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}${replace ? '（--replace：先清空）' : ''}`);

  // 连通性与表结构检查
  const ping = await db.ping();
  if (!ping.ok) {
    console.error('\n无法连接数据库：' + ping.error);
    process.exit(1);
  }
  const tables = await db.queryRaw(
    'SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [cfg.database]
  );
  const has = new Set(tables.map((t) => t.t));
  const need = ['units', 'users', 'assets', 'images', 'logs', 'settings', 'seq'];
  const missing = need.filter((t) => !has.has(t));
  if (missing.length) {
    console.error(`\n数据表未建全（缺 ${missing.join('、')}），请先执行：npm run db:init`);
    process.exit(1);
  }

  if (replace) {
    console.log('\n清空目标表…');
    await db.exec('DELETE FROM `logs`');
    await db.exec('DELETE FROM `images`');
    await db.exec('DELETE FROM `assets`');
    await db.exec('DELETE FROM `users`');
    await db.exec('DELETE FROM `units`');
    await db.exec('DELETE FROM `settings`');
  }

  const stat = {};

  // 单位
  const units = (raw.units || []).map((u) => toRow(u, repo.ASSET_COLUMNS && ['id', 'name', 'code', 'parent', 'sort', 'created_at']));
  stat.units = await insertBatch('units', ['id', 'name', 'code', 'parent', 'sort', 'created_at'], units, !replace);
  console.log(`单位：${units.length} 条，写入 ${stat.units.inserted}`);

  // 用户
  const users = (raw.users || []).map((u) => toRow(u, ['id', 'username', 'name', 'role', 'unit', 'unit_id', 'salt', 'hash', 'disabled', 'created_at', 'last_login_at']));
  stat.users = await insertBatch('users', ['id', 'username', 'name', 'role', 'unit', 'unit_id', 'salt', 'hash', 'disabled', 'created_at', 'last_login_at'], users, !replace);
  console.log(`用户：${users.length} 条，写入 ${stat.users.inserted}`);

  // 资产（列较多，用数据层的白名单）
  const assetCols = repo.ASSET_COLUMNS.filter((c) => c !== 'sort_no');
  const assets = (raw.assets || []).map((a) => {
    const row = toRow(a, assetCols);
    // unit_id 老数据里可能没有，按单位名补一次
    if (!row.unit_id && row.unit) {
      const hit = (raw.units || []).find((u) => u.name === row.unit);
      if (hit) row.unit_id = hit.id;
    }
    return row;
  });
  stat.assets = await insertBatch('assets', assetCols, assets, !replace);
  console.log(`资产：${assets.length} 条，写入 ${stat.assets.inserted}`);

  // 图片
  const images = (raw.images || []).map((x) => toRow(x, ['id', 'asset_id', 'name', 'label', 'file', 'mime', 'size', 'w', 'h', 'uploaded_at', 'uploaded_by']));
  stat.images = await insertBatch('images', ['id', 'asset_id', 'name', 'label', 'file', 'mime', 'size', 'w', 'h', 'uploaded_at', 'uploaded_by'], images, !replace);
  console.log(`图片：${images.length} 条，写入 ${stat.images.inserted}`);

  // 日志
  const logs = (raw.logs || []).map((x) => toRow(x, ['id', 'ts', 'user', 'username', 'unit', 'action', 'target', 'detail']));
  stat.logs = await insertBatch('logs', ['id', 'ts', 'user', 'username', 'unit', 'action', 'target', 'detail'], logs, !replace);
  console.log(`日志：${logs.length} 条，写入 ${stat.logs.inserted}`);

  // 系统设置
  const settings = raw.settings || {};
  let n = 0;
  for (const k of Object.keys(settings)) {
    await repo.settings.set(k, settings[k]);
    n++;
  }
  console.log(`系统设置：${n} 项`);

  // 序列：推到现有最大值，避免新 id 与历史 id 冲突
  await db.exec(
    `INSERT INTO \`seq\` (\`kind\`, \`val\`) VALUES ('asset', ?), ('user', ?), ('unit', ?), ('log', ?), ('image', ?)
     ON DUPLICATE KEY UPDATE \`val\` = GREATEST(\`val\`, VALUES(\`val\`))`,
    [
      (raw.assets || []).length, (raw.users || []).length,
      (raw.units || []).length, (raw.logs || []).length, (raw.images || []).length,
    ]
  );
  console.log('序列已同步');

  console.log('\n迁移完成。请启动服务核对数据：node server/server.js');
  console.log('确认无误后，建议把老的 data/db.json 改名备份（如 db.json.migrated），避免误用。');
  await db.close();
}

main().catch((e) => {
  console.error('\n迁移失败：' + db.friendlyError(e));
  process.exit(1);
});
