'use strict';
/**
 * 修正历史 DATETIME 数据的时区偏移
 *
 * 背景：改造前代码写 `new Date().toISOString()`（UTC）后直接切片入库，而 MySQL 的
 * DATETIME 不带时区、会被当作服务器本地时间，于是东八区下每条时间都比真实时间少 8 小时。
 * 现在写入侧已改为「本地时间」，但库里已有的旧数据仍带着这个偏差，需要一次性补回来。
 *
 * 修正量 = 当前本地时区偏移（东八区 +480 分钟），即把库里被当成 UTC 的值重新解释成本地时间。
 *
 * 用法：
 *   node tools/fix-datetime.js          执行修正
 *   node tools/fix-datetime.js --dry-run 只看会改什么，不写库
 *
 * 幂等：修完后在 settings 表写 `_datetime_tz_fixed` 标记，重复执行会直接跳过。
 */

const db = require('../server/lib/mysql.js');
const time = require('../server/lib/time.js');

const DRY = process.argv.includes('--dry-run');

/** 需要修正的 DATETIME 列 */
const TARGETS = [
  ['units', 'created_at'],
  ['users', 'created_at'],
  ['users', 'last_login_at'],
  ['assets', 'created_at'],
  ['assets', 'updated_at'],
  ['assets', 'geo_at'],
  ['images', 'uploaded_at'],
  ['logs', 'ts'],
  ['settings', 'updated_at'],
];

const MARK_KEY = '_datetime_tz_fixed';

async function columnExists(table, column) {
  const rows = await db.query(
    'SELECT COUNT(*) c FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  return Number(rows[0] && rows[0].c) > 0;
}

async function countNonNull(table, column) {
  const rows = await db.query(
    `SELECT COUNT(*) c FROM \`${table}\` WHERE \`${column}\` IS NOT NULL`
  );
  return Number(rows[0] && rows[0].c);
}

(async () => {
  const cfg = db.config();
  const offsetMin = time.localOffsetMinutes();
  const hours = (offsetMin / 60).toFixed(offsetMin % 60 === 0 ? 0 : 2);
  console.log(`\n数据库: ${cfg.database} @ ${cfg.host}:${cfg.port}`);
  console.log(`本地时区偏移: UTC${offsetMin >= 0 ? '+' : ''}${hours} 小时（${offsetMin} 分钟）`);
  console.log(`模式: ${DRY ? '预演（不写库）' : '执行修正'}\n`);

  // 幂等检查
  try {
    const mark = await db.query(
      'SELECT `v` FROM `settings` WHERE `k` = ?', [MARK_KEY]
    );
    if (mark.length) {
      console.log('本库已于 ' + mark[0].v + ' 修正过时间偏移，无需重复执行。');
      console.log('（若确需重跑，先执行：DELETE FROM settings WHERE k = \'' + MARK_KEY + '\';）');
      await db.close().catch(() => {});
      return;
    }
  } catch (e) {
    // settings 表不存在等，忽略，直接往下走
  }

  if (offsetMin === 0) {
    console.log('当前时区偏移为 0，无需修正。');
    await db.close().catch(() => {});
    return;
  }

  let total = 0;
  const plan = [];
  for (const [table, column] of TARGETS) {
    if (!(await columnExists(table, column))) {
      console.log(`  - ${table}.${column}：列不存在，跳过`);
      continue;
    }
    const n = await countNonNull(table, column);
    if (!n) {
      console.log(`  - ${table}.${column}：无数据，跳过`);
      continue;
    }
    plan.push([table, column, n]);
    total += n;
  }

  if (!total) {
    console.log('\n没有需要修正的数据。');
    await db.close().catch(() => {});
    return;
  }

  console.log('将要修正：');
  for (const [t, c, n] of plan) console.log(`  ${t}.${c}  ${n} 行  (+${hours}h)`);
  console.log(`  合计 ${total} 行\n`);

  if (DRY) {
    console.log('预演结束，未修改任何数据。去掉 --dry-run 即执行。');
    await db.close().catch(() => {});
    return;
  }

  for (const [table, column, n] of plan) {
    const r = await db.exec(
      `UPDATE \`${table}\` SET \`${column}\` = DATE_ADD(\`${column}\`, INTERVAL ? MINUTE) ` +
        'WHERE `' + column + '` IS NOT NULL',
      [offsetMin]
    );
    console.log(`  ✓ ${table}.${column} 已修正 ${n} 行（受影响 ${r.affectedRows}）`);
  }

  // 写幂等标记
  try {
    await db.exec(
      'INSERT INTO `settings` (`k`, `v`, `updated_at`) VALUES (?, ?, NOW()) ' +
        'ON DUPLICATE KEY UPDATE `v` = VALUES(`v`), `updated_at` = NOW()',
      [MARK_KEY, new Date().toISOString()]
    );
  } catch (e) {
    console.log('  （未能写入修正标记：' + e.message + '，请自行记录已执行过本脚本）');
  }

  console.log('\n完成。建议重启服务后用最新一条操作日志核对时间是否正确。');
  await db.close().catch(() => {});
  process.exit(0);
})().catch(async (e) => {
  console.error('\n[失败] ' + (e && e.message));
  console.error(db.friendlyError ? db.friendlyError(e) : '');
  process.exit(1);
});
