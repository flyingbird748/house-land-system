'use strict';
/**
 * 初始化数据库：建库 + 建表（幂等，可反复执行）
 *
 *   node tools/init-db.js              # 用 data/dbconfig.json 里的连接信息
 *   DB_HOST=1.2.3.4 DB_USER=root node tools/init-db.js
 *
 * 只做「建库建表」，不写任何业务数据；老数据迁移请用 tools/migrate-to-mysql.js。
 */
const fs = require('fs');
const path = require('path');

const dbcfg = require('../server/lib/mysql.js');

const ROOT = path.join(__dirname, '..');
const SCHEMA = path.join(ROOT, 'tools', 'sql', 'schema.sql');

async function main() {
  const cfg = dbcfg.config();
  console.log(`目标：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (e) {
    console.error('\n缺少数据库驱动，请先执行：npm install\n');
    process.exit(1);
  }

  // 先不指定库连接：库可能还不存在
  let conn;
  try {
    conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      charset: cfg.charset || 'utf8mb4',
      multipleStatements: true,
      connectTimeout: cfg.connectTimeout || 10000,
    });
  } catch (e) {
    console.error('\n连接失败：' + dbcfg.friendlyError(e));
    process.exit(1);
  }

  const [ver] = await conn.query('SELECT VERSION() v');
  console.log('MySQL 版本：' + (ver[0] && ver[0].v));

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
  );
  console.log(`数据库 \`${cfg.database}\` 就绪`);
  await conn.query(`USE \`${cfg.database}\``);

  const sql = fs.readFileSync(SCHEMA, 'utf8');
  // 去掉建库与切库语句（这两步上面已经做了，且库名以配置为准）
  const stmts = sql
    .split(/\r?\n/)
    .filter((l) => !/^\s*(--|#|\/\*)/.test(l))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !/^(CREATE DATABASE|USE)\b/i.test(s));

  let n = 0;
  for (const st of stmts) {
    try {
      await conn.query(st);
      n++;
    } catch (e) {
      console.error('\n建表语句执行失败：\n' + st.slice(0, 200) + '\n');
      console.error(dbcfg.friendlyError(e));
      process.exit(1);
    }
  }
  console.log(`建表完成：共执行 ${n} 条语句`);

  const [tables] = await conn.query(
    'SELECT TABLE_NAME t, TABLE_ROWS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [cfg.database]
  );
  console.log('\n数据表：');
  for (const t of tables) console.log(`  ${t.t.padEnd(14)} ${t.r} 行`);

  await conn.end();
  console.log('\n初始化完成。现在可以启动服务：node server/server.js');
}

main().catch((e) => {
  console.error('\n初始化失败：' + dbcfg.friendlyError(e));
  process.exit(1);
});
