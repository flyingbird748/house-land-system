'use strict';
/**
 * 系统设置（地图服务）接口测试 —— 纯 HTTP
 * 覆盖：读写权限、配置持久化、/api/map/config 联动、连通性测试、地理编码代理参数校验。
 *
 * 运行：node tools/settings-test.js（需后端 http://127.0.0.1:8789）
 */
const BASE = process.env.APIBASE || 'http://127.0.0.1:8789';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ' —— ' + JSON.stringify(extra))); }
}

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = {};
  try { j = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, data: j };
}

(async () => {
  const T = (await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).data.token;
  const V = (await api('POST', '/api/auth/login', { username: 'viewer', password: 'viewer123' })).data.token;
  check('管理员登录', !!T);

  /* ---- 读取权限 ---- */
  let r = await api('GET', '/api/settings/map', undefined, V);
  check('普通用户读取设置被拒（403）', r.status === 403, r.status);
  r = await api('PUT', '/api/settings/map', { provider: 'tianditu' }, V);
  check('普通用户修改设置被拒（403）', r.status === 403, r.status);
  r = await api('POST', '/api/settings/map/test', { provider: 'tmap', key: 'x' }, V);
  check('普通用户测试密钥被拒（403）', r.status === 403, r.status);
  r = await api('GET', '/api/map/config', undefined, V);
  check('普通用户可读地图配置（前端需要）', r.status === 200 && !!r.data.map, r.status);

  /* ---- 服务商清单与指引 ---- */
  r = await api('GET', '/api/settings/map', undefined, T);
  const list = r.data.providers || [];
  check('服务商至少两家（腾讯 / 天地图）', list.length >= 2, list.map((p) => p.key));
  check('每家都有注册步骤指引', list.every((p) => (p.steps || []).length >= 3), list.map((p) => (p.steps || []).length));
  check('每家都有控制台地址', list.every((p) => /^https?:\/\//.test(p.consoleUrl || '')), list.map((p) => p.consoleUrl));
  check('每家都说明了坐标系', list.every((p) => !!p.coord && !!p.needServices), list.map((p) => p.coord));
  const tdt = list.find((p) => p.key === 'tianditu');
  check('天地图指引含「服务端应用」说明', JSON.stringify(tdt.steps).includes('服务端'), tdt.steps.map((s) => s.t));

  /* ---- 保存与联动 ---- */
  const origin = r.data.map;
  r = await api('PUT', '/api/settings/map', { provider: 'tianditu', keys: { tianditu: 'TEST-TK-0001' }, center: { lat: 30.1, lng: 107.2, zoom: 10 } }, T);
  check('保存成功', r.status === 200 && r.data.map.provider === 'tianditu', r.data);
  check('密钥已写入', r.data.map.keys.tianditu === 'TEST-TK-0001', r.data.map.keys);
  check('默认视野已写入', r.data.map.center.lat === 30.1 && r.data.map.center.zoom === 10, r.data.map.center);

  r = await api('GET', '/api/map/config', undefined, T);
  check('地图配置随之切换为天地图', r.data.map.provider === 'tianditu' && r.data.map.key === 'TEST-TK-0001', r.data.map);
  check('地图配置带有服务商名称与坐标系', !!r.data.map.providerName && !!r.data.map.coord, r.data.map);

  /* ---- 非法值兜底 ---- */
  r = await api('PUT', '/api/settings/map', { provider: '不存在的地图' }, T);
  check('非法服务商被忽略（沿用原值）', r.status === 200 && r.data.map.provider === 'tianditu', r.data.map.provider);
  r = await api('PUT', '/api/settings/map', { center: { lat: 999, lng: -999, zoom: 99 } }, T);
  check('越界视野被夹紧', r.data.map.center.lat <= 90 && r.data.map.center.lng >= -180 && r.data.map.center.zoom <= 20, r.data.map.center);

  /* ---- 连通性测试不落库 ---- */
  r = await api('POST', '/api/settings/map/test', { provider: 'tianditu', key: '' }, T);
  check('空密钥返回明确提示', r.status === 200 && r.data.ok === false && /未填写/.test(r.data.msg), r.data);
  r = await api('POST', '/api/settings/map/test', { provider: 'tianditu', key: 'BAD-KEY' }, T);
  check('错误密钥返回失败原因', r.status === 200 && typeof r.data.msg === 'string' && r.data.msg.length > 0, r.data);
  const after = await api('GET', '/api/settings/map', undefined, T);
  check('测试不会改写已保存的密钥', after.data.map.keys.tianditu === 'TEST-TK-0001', after.data.map.keys);

  /* ---- 地理编码代理 ---- */
  r = await api('GET', '/api/geo/geocode', undefined, T);
  check('缺少 address 返回 400', r.status === 400, r.status);
  r = await api('GET', '/api/geo/reverse?lng=&lat=', undefined, T);
  check('缺少坐标返回 400', r.status === 400, r.status);
  r = await api('GET', '/api/geo/geocode?address=' + encodeURIComponent('重庆市江北区'), undefined, T);
  check('无效密钥时地理编码返回 502 且不崩溃', r.status === 502 || r.status === 200, r.status);
  r = await api('GET', '/api/geo/geocode?address=x', undefined, V);
  check('普通用户可调用地理编码（登录即可）', r.status === 502 || r.status === 200, r.status);

  /* ---- 日志与还原 ---- */
  const logs = await api('GET', '/api/logs', undefined, T);
  check('修改设置已记入操作日志', (logs.data.rows || []).some((x) => x.action === '修改系统设置'), (logs.data.rows || []).slice(0, 3).map((x) => x.action));

  await api('PUT', '/api/settings/map', { provider: origin.provider, keys: origin.keys, center: origin.center }, T);
  const fin = await api('GET', '/api/map/config', undefined, T);
  check('还原为原始配置', fin.data.map.provider === origin.provider, fin.data.map);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
