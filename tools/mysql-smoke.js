'use strict';
/**
 * MySQL 版端到端自检：覆盖登录鉴权、单位、用户、资产增删改查、
 * 列表筛选/排序/分页、统计、报告、日志、图片接口。
 *
 * 用法（先启动服务）：node tools/mysql-smoke.js
 */
const http = require('http');

const BASE = process.env.BASE || 'http://127.0.0.1:8789';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // 初始密码，见 README

let token = '';
let pass = 0;
let fail = 0;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': data.length } : {},
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 非 JSON（如图片二进制） */ }
        resolve({ code: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
}

async function main() {
  console.log(`自检目标：${BASE}\n`);

  console.log('[1] 健康检查');
  let r = await api('GET', '/api/health');
  check('health 200', r.code === 200, 'HTTP ' + r.code);
  check('返回资产/用户数', r.json && typeof r.json.assets === 'number', JSON.stringify(r.json));

  console.log('\n[2] 登录鉴权');
  r = await api('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
  check('登录成功', r.code === 200 && r.json && r.json.token, JSON.stringify(r.json).slice(0, 120));
  token = (r.json && r.json.token) || '';
  r = await api('GET', '/api/auth/me');
  check('携带令牌可取当前用户', r.code === 200 && r.json.user && r.json.user.role === 'admin');
  const savedToken = token;
  token = '';
  r = await api('GET', '/api/auth/me');
  check('无令牌访问被拒绝 401', r.code === 401);
  token = savedToken;

  console.log('\n[3] 单位管理');
  const unitName = '自检单位-' + Date.now().toString(36);
  r = await api('POST', '/api/units', { name: unitName, code: 'AUTO' });
  check('新增单位', r.code === 200 && r.json.unit && r.json.unit.id, JSON.stringify(r.json).slice(0, 120));
  const unitId = r.json.unit && r.json.unit.id;
  r = await api('POST', '/api/units', { name: unitName });
  check('重名单位被拒绝', r.code === 400);
  r = await api('GET', '/api/units');
  check('单位列表含新单位', r.json.rows.some((x) => x.name === unitName));
  check('单位列表带资产条数', typeof (r.json.rows.find((x) => x.name === unitName) || {}).assetCount === 'number');

  console.log('\n[4] 用户管理');
  const uname = 'u' + Date.now().toString(36);
  r = await api('POST', '/api/users', { username: uname, name: '自检用户', role: 'unitadmin', unitId, password: 'test12345' });
  check('新增用户', r.code === 200 && r.json.user, JSON.stringify(r.json).slice(0, 120));
  const uid = r.json.user && r.json.user.id;
  r = await api('POST', '/api/users', { username: uname, role: 'viewer', unitId, password: 'test12345' });
  check('重名用户被拒绝', r.code === 400);
  r = await api('GET', '/api/users');
  check('用户列表含新用户', r.json.rows.some((x) => x.username === uname));
  r = await api('PUT', '/api/users/' + uid, { name: '改名后' });
  check('修改用户', r.code === 200 && r.json.user.name === '改名后');

  console.log('\n[5] 资产增删改查');
  const no1 = 'AUTO-' + Date.now().toString(36);
  r = await api('POST', '/api/assets', {
    name: '自检资产甲', unit: unitName, assetNo: no1, category: '办公用房',
    area: 1234.56, originalValue: 9876543.21, actualStaff: 30, age: 12, lng: 106.55, lat: 29.56,
  });
  check('新增资产', r.code === 200 && r.json.asset && r.json.asset.id, JSON.stringify(r.json).slice(0, 160));
  const aid = r.json.asset && r.json.asset.id;
  r = await api('POST', '/api/assets', { name: '自检资产乙', unit: unitName, assetNo: no1 });
  check('资产编号重复被拒绝', r.code === 400);
  r = await api('GET', '/api/assets/' + aid);
  check('资产详情（数值列正确）', r.json.asset && Number(r.json.asset.area) === 1234.56,
    r.json.asset ? String(r.json.asset.area) : '');
  r = await api('PUT', '/api/assets/' + aid, { area: 2000, remark: '改过了' });
  check('修改资产', r.code === 200 && Number(r.json.asset.area) === 2000);
  check('修改记录变更字段数', r.json.changed >= 1);

  console.log('\n[6] 列表筛选 / 排序 / 分页');
  r = await api('GET', '/api/assets?page=1&pageSize=10');
  check('分页返回 total/rows', r.code === 200 && typeof r.json.total === 'number' && Array.isArray(r.json.rows));
  check('总数 >= 1', r.json.total >= 1, 'total=' + (r.json || {}).total);
  r = await api('GET', '/api/assets?category=办公用房');
  check('按分类筛选', r.json.rows.every((x) => x.category === '办公用房'));
  r = await api('GET', '/api/assets?q=' + encodeURIComponent('自检资产甲'));
  check('关键词搜索命中', r.json.total >= 1 && r.json.rows.some((x) => x.name === '自检资产甲'));
  r = await api('GET', '/api/assets?sort=area&order=desc');
  check('按面积倒序', r.json.rows.length ? Number(r.json.rows[0].area) >= Number(r.json.rows[r.json.rows.length - 1].area) : true);
  r = await api('GET', '/api/assets?areaMin=1000&areaMax=3000');
  check('面积区间筛选', r.json.rows.every((x) => Number(x.area) >= 1000 && Number(x.area) <= 3000));
  r = await api('GET', '/api/assets?marked=yes');
  check('已标注筛选', Array.isArray(r.json.rows));
  r = await api('GET', '/api/assets?unit=' + encodeURIComponent(unitName));
  check('按单位筛选', r.json.rows.every((x) => x.unit === unitName));

  console.log('\n[7] 统计看板与报告');
  r = await api('GET', '/api/stats');
  check('统计接口', r.code === 200 && typeof r.json.total === 'number');
  check('分组统计 byCategory', Array.isArray(r.json.byCategory) && r.json.byCategory.length >= 1);
  check('年龄分桶 byAge', Array.isArray(r.json.byAge) && r.json.byAge.length === 5);
  check('最近更新 recent', Array.isArray(r.json.recent));
  r = await api('GET', '/api/report');
  check('报告生成', r.code === 200 && r.json.html && r.json.html.length > 200);
  check('报告无未替换占位符', r.json.html && !/\{\{[^{}]+\}\}/.test(r.json.html));

  console.log('\n[8] 图片上传与管理');
  r = await api('GET', '/api/assets/' + aid + '/images');
  check('资产图片列表（空）', r.code === 200 && Array.isArray(r.json.images));

  // 1×1 的最小合法 PNG
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await api('POST', '/api/assets/' + aid + '/images', { name: '正面照.png', label: '正面', data: PNG, w: 1, h: 1 });
  check('上传图片', r.code === 200 && r.json.image && r.json.image.id, JSON.stringify(r.json).slice(0, 120));
  const imgId = r.json.image && r.json.image.id;

  r = await api('GET', '/api/assets/' + aid + '/images');
  check('图片列表有 1 张', r.json.images && r.json.images.length === 1);
  check('图片元信息完整', r.json.images[0].label === '正面' && r.json.images[0].size > 0);

  r = await api('GET', '/api/assets/' + aid + '/images/' + imgId + '/raw');
  check('读取图片二进制', r.code === 200 && r.raw && r.raw.length > 0, 'HTTP ' + r.code + ' ' + JSON.stringify(r.json));

  r = await api('PUT', '/api/assets/' + aid + '/images/' + imgId, { label: '室内' });
  check('修改图片标签', r.code === 200 && r.json.image && r.json.image.label === '室内', 'HTTP ' + r.code + ' ' + JSON.stringify(r.json).slice(0, 200));

  r = await api('GET', '/api/images');
  check('批量图片接口返回映射', r.code === 200 && r.json.map && r.json.map[aid]);

  r = await api('DELETE', '/api/assets/' + aid + '/images/' + imgId);
  check('删除图片', r.code === 200, 'HTTP ' + r.code + ' ' + JSON.stringify(r.json).slice(0, 200));
  r = await api('GET', '/api/assets/' + aid + '/images');
  check('删除后列表为空', r.json.images.length === 0);

  console.log('\n[9] 操作日志');
  r = await api('GET', '/api/logs');
  check('日志列表', r.code === 200 && Array.isArray(r.json.rows));
  check('日志含本次新增资产记录', r.json.rows.some((x) => x.action === '新增资产'));
  check('日志按时间倒序', r.json.rows.length < 2 || r.json.rows[0].ts >= r.json.rows[r.json.rows.length - 1].ts);

  console.log('\n[10] 系统设置');
  r = await api('GET', '/api/settings/report');
  check('报告参数读取', r.code === 200 && r.json.params);
  r = await api('PUT', '/api/settings/report', { actualStaff: 88 });
  check('报告参数保存', r.code === 200 && Number(r.json.values.actualStaff) === 88);
  r = await api('GET', '/api/settings/report');
  check('报告参数回落库', Number(r.json.values.actualStaff) === 88);
  r = await api('GET', '/api/map/config');
  check('地图配置读取', r.code === 200 && r.json.map);

  console.log('\n[11] 数据清理');
  r = await api('DELETE', '/api/assets/' + aid);
  check('删除资产', r.code === 200);
  r = await api('DELETE', '/api/users/' + uid);
  check('删除用户', r.code === 200);
  r = await api('DELETE', '/api/units/' + unitId);
  check('删除单位', r.code === 200);

  console.log(`\n===== 结果：通过 ${pass} 项，失败 ${fail} 项 =====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('自检异常：', e && e.message);
  process.exit(1);
});
