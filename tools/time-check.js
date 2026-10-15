'use strict';
/**
 * 日志时间正确性验收
 *
 * 登录后立刻读操作日志，核对「接口返回的时间」与「本机当前时间」是否一致
 * （允许 2 分钟误差，覆盖请求往返耗时）。同时检查历史数据的修正结果。
 *
 *   node tools/time-check.js            # 默认 8789
 *   BASE=http://127.0.0.1:8787 node tools/time-check.js
 */

const http = require('http');

const BASE = process.env.BASE || 'http://127.0.0.1:8789';
const USER = process.env.USER_NAME || 'admin';
const PWD = process.env.USER_PWD || 'admin123';

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}

function request(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': data.length } : {},
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 非 JSON */ }
        resolve({ code: res.statusCode, json, buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 本地时间格式化，用于和返回串比对 */
function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

(async () => {
  console.log('\n本机当前时间: ' + fmtLocal(new Date()) +
    '  （时区偏移 UTC' + (new Date().getTimezoneOffset() <= 0 ? '+' : '-') +
    Math.abs(new Date().getTimezoneOffset() / 60) + '）');
  console.log('目标服务: ' + BASE + '\n');

  const lg = await request('POST', '/api/auth/login', { username: USER, password: PWD });
  if (lg.code !== 200 || !lg.json || !lg.json.token) {
    console.log('登录失败，无法验收：HTTP ' + lg.code + ' ' + (lg.buf || '').toString().slice(0, 200));
    process.exit(1);
  }
  const token = lg.json.token;

  console.log('[1] 新写入的日志时间');
  const logs = await request('GET', '/api/logs', null, token);
  const rows = (logs.json && (logs.json.rows || logs.json.logs)) || [];
  check('日志接口可读', logs.code === 200 && rows.length > 0, rows.length + ' 条');
  const top = rows[0];
  if (!top) { console.log('  （无日志可校验）'); process.exit(1); }

  console.log('  最新一条：ts=' + top.ts + '  action=' + top.action);
  const shown = String(top.ts).slice(0, 19).replace('T', ' ');
  const now = new Date();
  const got = new Date(String(top.ts).replace(' ', 'T'));
  const diffMin = Math.abs(now.getTime() - got.getTime()) / 60000;
  check('前端显示值 = 本机当前时间', shown === fmtLocal(got).slice(0, 19) &&
    diffMin < 2, '显示 "' + shown + '"，实际 "' + fmtLocal(now) + '"，偏差 ' + diffMin.toFixed(1) + ' 分钟');
  check('返回串带时区偏移', /[+-]\d{2}:\d{2}$/.test(String(top.ts)) || /Z$/.test(String(top.ts)),
    'ts=' + top.ts);
  check('相对时间判断正确（<2 分钟视为刚刚）', diffMin < 2, diffMin.toFixed(1) + ' 分钟前');

  console.log('\n[2] 历史日志（应为过去时间，不能是未来）');
  const last = rows[rows.length - 1];
  const lastT = new Date(String(last.ts).replace(' ', 'T')).getTime();
  check('最早一条早于当前时间', lastT < Date.now(), 'ts=' + last.ts);
  // 历史数据不应超过今天
  const todayStr = fmtLocal(new Date()).slice(0, 10);
  check('最早一条不晚于今天', String(last.ts).slice(0, 10) <= todayStr,
    String(last.ts).slice(0, 10) + ' <= ' + todayStr);

  console.log('\n[3] 其它时间字段');
  const me = await request('GET', '/api/auth/me', null, token);
  const lla = me.json && me.json.user && me.json.user.lastLoginAt;
  if (lla) {
    const d = Math.abs(Date.now() - new Date(String(lla).replace(' ', 'T')).getTime()) / 60000;
    check('最后登录时间正确', d < 2, lla + '（' + d.toFixed(1) + ' 分钟前）');
  }
  const list = await request('GET', '/api/assets?pageSize=3', null, token);
  const a = list.json && list.json.rows && list.json.rows[0];
  if (a && a.updatedAt) {
    const s = String(a.updatedAt).slice(0, 19).replace('T', ' ');
    check('资产更新时间可解析', Number.isFinite(new Date(String(a.updatedAt).replace(' ', 'T')).getTime()),
      'updatedAt=' + a.updatedAt + ' 显示 "' + s + '"');
  } else {
    console.log('  （当前无资产，跳过）');
  }

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验收脚本异常：' + (e && e.message));
  process.exit(1);
});
