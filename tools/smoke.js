'use strict';
/** 接口冒烟测试：node tools/smoke.js */
const BASE = process.env.BASE || 'http://127.0.0.1:8789';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
}

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return { status: res.status, data: await res.json() };
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

(async () => {
  console.log('== 冒烟测试', BASE, '==');

  // 1. 健康检查
  let r = await api('GET', '/api/health');
  check('健康检查', r.status === 200 && r.data.ok, r.data);

  // 2. 未登录访问应 401
  r = await api('GET', '/api/assets');
  check('未登录访问被拒绝', r.status === 401, r.status);

  // 3. 错误密码
  r = await api('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
  check('错误密码被拒绝', r.status === 401, r.status);

  // 4. 登录
  r = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  check('管理员登录', r.status === 200 && !!r.data.token, r.data);
  const token = r.data && r.data.token;

  r = await api('POST', '/api/auth/login', { username: 'viewer', password: 'viewer123' });
  check('只读账号登录', r.status === 200 && r.data.user.role === 'viewer', r.data && r.data.user);
  const vToken = r.data && r.data.token;

  // 5. 当前用户
  r = await api('GET', '/api/auth/me', undefined, token);
  check('获取当前用户', r.status === 200 && r.data.user.role === 'admin', r.data);

  // 6. 列表
  r = await api('GET', '/api/assets?page=1&pageSize=5', undefined, token);
  check('分页列表', r.status === 200 && r.data.rows.length === 5 && r.data.total === 55, { n: r.data.rows && r.data.rows.length, t: r.data.total });

  r = await api('GET', '/api/assets?q=' + encodeURIComponent('周转房') + '&pageSize=all', undefined, token);
  check('关键字搜索', r.status === 200 && r.data.total > 0 && r.data.total < 55, r.data.total);

  r = await api('GET', '/api/assets?category=' + encodeURIComponent('车库') + '&pageSize=all', undefined, token);
  check('分类筛选', r.status === 200 && r.data.rows.every((a) => a.category === '车库') && r.data.total > 0, r.data.total);

  r = await api('GET', '/api/assets?sort=area&order=desc&pageSize=3', undefined, token);
  check('按面积降序排序', r.status === 200 && r.data.rows[0].area >= r.data.rows[2].area, r.data.rows.map((a) => a.area));

  // 标注筛选：已标注 + 未标注 = 总数（不假设库里有/没有坐标）
  const noR = await api('GET', '/api/assets?marked=no&pageSize=all', undefined, token);
  const yesR = await api('GET', '/api/assets?marked=yes&pageSize=all', undefined, token);
  const totalR = await api('GET', '/api/assets?pageSize=1', undefined, token);
  const markedYes0 = yesR.data.total;
  check('未标注筛选', noR.status === 200 && noR.data.total + markedYes0 === totalR.data.total, `未标注 ${noR.data.total} + 已标注 ${markedYes0} = ${totalR.data.total}`);

  // 7. 统计
  r = await api('GET', '/api/stats', undefined, token);
  const s = r.data || {};
  check('统计-总数', s.total === 55, s.total);
  check('统计-面积合计', s.totalArea > 30000, s.totalArea);
  check('统计-原值合计', s.totalValue > 1e8, s.totalValue);
  check('统计-分类分组', Array.isArray(s.byCategory) && s.byCategory.length >= 3, s.byCategory);
  check('统计-使用状态分组', Array.isArray(s.byUseStatus) && s.byUseStatus.length >= 3, s.byUseStatus && s.byUseStatus.length);
  check('统计-房龄分布', Array.isArray(s.byAge) && s.byAge.reduce((a, b) => a + b.count, 0) > 40, s.byAge);

  // 8. 选项
  r = await api('GET', '/api/options', undefined, token);
  check('字段选项', r.status === 200 && r.data.fields.length > 30 && r.data.groups.length === 6, r.data.fields && r.data.fields.length);

  // 9. 新建
  r = await api('POST', '/api/assets', {
    unit: '国家税务总局重庆市江北区税务局', name: '冒烟测试资产', assetNo: 'SMOKE001', category: '办公用房',
    useStatus: '自用', area: 123.45, originalValue: 888888, location: '重庆市江北区测试路1号',
  }, token);
  check('新建资产', r.status === 200 && !!r.data.asset.id, r.data);
  const newId = r.data.asset && r.data.asset.id;

  // 10. 重复编号应拒绝
  r = await api('POST', '/api/assets', { name: '重复编号测试', assetNo: '465465133' }, token);
  check('资产编号重复被拒绝', r.status === 400, r.status);

  // 11. 编辑
  r = await api('PUT', '/api/assets/' + newId, { name: '冒烟测试资产-已改名', area: 200 }, token);
  check('编辑资产', r.status === 200 && r.data.asset.name === '冒烟测试资产-已改名' && r.data.asset.area === 200, r.data.asset && r.data.asset.name);

  // 12. 地图标注
  r = await api('PUT', '/api/assets/' + newId + '/geo', { lng: 106.5515, lat: 29.5889, address: '重庆市江北区' }, token);
  check('保存地图标注', r.status === 200 && r.data.asset.lng === 106.5515, r.data.asset && r.data.asset.lng);

  r = await api('PUT', '/api/assets/' + newId + '/geo', { lng: 1, lat: 1 }, token);
  check('境外坐标被拒绝', r.status === 400, r.status);
  await api('PUT', '/api/assets/' + newId + '/geo', { lng: 106.5515, lat: 29.5889 }, token);

  r = await api('GET', '/api/assets?marked=yes&pageSize=all', undefined, token);
  check('已标注筛选', r.status === 200 && r.data.total === markedYes0 + 1, `${markedYes0} -> ${r.data.total}`);

  // 13. 只读账号权限
  r = await api('POST', '/api/assets', { name: '只读账号尝试新增' }, vToken);
  check('只读账号不能新增', r.status === 403, r.status);
  r = await api('GET', '/api/users', undefined, vToken);
  check('只读账号不能看用户', r.status === 403, r.status);

  // 14. 用户管理
  r = await api('GET', '/api/users', undefined, token);
  // 用户数随内置账号（含单位管理员示例账号）变化，用下界断言
  check('用户列表', r.status === 200 && r.data.rows.length >= 3, r.data.rows && r.data.rows.length);
  check('存在单位管理员角色', (r.data.rows || []).some((u) => u.role === 'unitadmin'), (r.data.rows || []).map((u) => u.role));
  r = await api('POST', '/api/users', { username: 'smoketest', name: '冒烟账号', role: 'editor', password: 'test123' }, token);
  check('新增用户', r.status === 200, r.data);
  const uid = r.data.user && r.data.user.id;
  r = await api('DELETE', '/api/users/' + uid, undefined, token);
  check('删除用户', r.status === 200, r.data);

  // 15. 导出
  r = await api('GET', '/api/export?format=xlsx&pageSize=all', undefined, token);
  check('导出 xlsx', r.status === 200 && r.buf && r.buf.length > 3000 && r.buf.slice(0, 2).toString() === 'PK', r.buf && r.buf.length);
  const xlsxBuf = r.buf;

  r = await api('GET', '/api/export?format=csv&pageSize=all', undefined, token);
  check('导出 csv', r.status === 200 && r.buf && r.buf.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), r.buf && r.buf.length);

  // 16. 导入（用刚导出的文件，验证解析器能读回自己写的文件）
  r = await api('POST', '/api/import/preview', {
    fileName: 'smoke.xlsx',
    content: xlsxBuf.toString('base64'),
  }, token);
  check('导入预览', r.status === 200 && r.data.total === 56, { status: r.status, total: r.data.total, headerRow: r.data.headerRowIndex });
  const impToken = r.data.token;

  if (impToken) {
    r = await api('POST', '/api/import/commit', { token: impToken, mode: 'upsert' }, token);
    check('导入提交（upsert 不重复新增）', r.status === 200 && r.data.created === 0 && r.data.updated === 56, r.data);
  }

  // 17. 清理测试数据
  r = await api('DELETE', '/api/assets/' + newId, undefined, token);
  check('删除资产', r.status === 200, r.data);
  r = await api('GET', '/api/assets?pageSize=all', undefined, token);
  check('删除后总数恢复', r.status === 200 && r.data.total === 55, r.data.total);

  // 18. 日志
  r = await api('GET', '/api/logs', undefined, token);
  check('操作日志', r.status === 200 && r.data.rows.length > 5, r.data.rows && r.data.rows.length);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
