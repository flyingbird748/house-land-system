'use strict';
/**
 * mapconfig —— 地图服务商配置（腾讯地图 / 天地图）与服务端地理编码代理。
 *
 * 设计目标：把「用哪家地图、用什么 Key」集中到系统设置里，前端地图页不再硬编码
 * 任何服务商，全部通过 /api/map/config 获取当前配置，由适配层加载对应 SDK。
 *
 * 密钥说明：地图厂商的浏览器端 Key 本身就会出现在前端脚本里（这是厂商的设计），
 * 本系统只要求「登录后可读取、仅系统管理员可修改」，避免被未授权人员篡改。
 */
const store = require('./store.js');
const repo = require('./repo.js');
const http = require('http');
const https = require('https');
const { URL } = require('url');

/** 重庆市江北区（默认视野中心） */
const DEFAULT_CENTER = { lat: 29.5889, lng: 106.5515, zoom: 12 };

const DEFAULT_MAP = () => ({
  provider: 'tmap',
  keys: { tmap: '', tianditu: '' },
  center: Object.assign({}, DEFAULT_CENTER),
});

/**
 * 服务商清单：name/label 用于设置页展示，steps 是「如何注册并获取 Key」的指引。
 * 新增服务商时只需在这里加一项，并在前端 web/src/00-geo.js 里实现对应适配器。
 */
const PROVIDERS = [
  {
    key: 'tmap',
    name: '腾讯地图',
    sdk: 'JavaScript API GL',
    keyLabel: 'Key（腾讯位置服务）',
    keyPlaceholder: '例如：ABCDE-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX',
    coord: 'GCJ-02（火星坐标）',
    consoleUrl: 'https://lbs.qq.com/dev/console/application/mine',
    docUrl: 'https://lbs.qq.com/javascript_gl/guide-start.html',
    needServices: ['JavaScript GL（地图显示）', 'WebServiceAPI（地址解析）'],
    steps: [
      { t: '注册并登录腾讯位置服务', d: '打开控制台，可用 QQ / 微信扫码登录，个人开发者即可申请。', url: 'https://lbs.qq.com/dev/console/application/mine' },
      { t: '创建应用', d: '左侧「应用管理」→「我的应用」→ 创建应用，填写应用名称（如：房屋土地信息系统系统）与类型。' },
      { t: '添加 Key 并勾选服务', d: '在应用下点「添加 Key」，勾选「JavaScript GL」用于地图显示、「WebServiceAPI」用于地址解析；「SDK」「微信小程序」等按需选择。' },
      { t: '配置域名白名单（生产必做）', d: 'Key 的「启用产品 → WebServiceAPI / JavaScript GL」里可填域名白名单，只填自己的部署域名（不带 http://）。本机调试可填 127.0.0.1 或留空。' },
      { t: '复制 Key 填入本页', d: '保存后控制台会显示一串 Key，复制粘贴到上方输入框，点「测试连接」验证。' },
    ],
    notes: [
      '未配置域名白名单的 Key 一旦泄露可能被他人盗用，正式部署务必设置白名单。',
      '本系统自带的内置预览环境可免 Key 直连腾讯地图（由运行环境代理密钥），此时 Key 留空即可；正式部署建议填入自己的 Key。',
      '免费额度足够日常使用；若批量地址解析较多，可在控制台查看配额。',
    ],
  },
  {
    key: 'tianditu',
    name: '天地图',
    sdk: 'JavaScript API 4.0',
    keyLabel: '密钥 tk（天地图）',
    keyPlaceholder: '例如：a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    coord: 'CGCS2000（≈ WGS84）',
    consoleUrl: 'https://console.tianditu.gov.cn/api/key',
    docUrl: 'http://lbs.tianditu.gov.cn/api/js4.0/examples.html',
    needServices: ['地图 API（浏览器端）', '地理编码服务 / 逆地理编码服务'],
    steps: [
      { t: '注册账号并完成实名认证', d: '打开天地图控制台注册，个人用户需实名认证（姓名 + 身份证），企业用户需营业执照，审核一般很快。', url: 'https://console.tianditu.gov.cn/api/key' },
      { t: '创建应用：类型选「浏览器端」', d: '进入「应用管理」→「创建应用」，应用类型选择「浏览器端」（用于页面地图显示），填写应用名称与简介。' },
      { t: '再建一个「服务端」应用（如需地址解析）', d: '「一键地址解析」「批量地址解析」走服务端接口，需要单独建一个「服务端」应用，并在服务类型里勾选「地理编码服务」和「逆地理编码服务」。' },
      { t: '填写域名白名单', d: '浏览器端应用需填域名白名单：本机调试填 127.0.0.1，正式部署填实际域名（不带 http://）。服务端应用填服务器出口 IP 或不填。' },
      { t: '复制密钥 tk 填入本页', d: '提交后列表里会显示「密钥（tk）」，复制填入上方输入框，点「测试连接」验证（服务端应用才能测通地理编码）。' },
    ],
    notes: [
      '天地图为国家地理信息公共服务平台，坐标系是 CGCS2000（与 WGS84 差值在厘米级）。系统内的坐标按 GCJ-02 存储，切到天地图会自动换算，点位不会整体偏移。',
      '天地图是免费服务但有日调用配额，超限会返回错误；批量解析建议分批进行。',
      '若只填了浏览器端密钥，地图可正常显示，但「地址批量解析」会因服务端权限不足而失败。',
    ],
  },
];

const PROVIDER_KEYS = PROVIDERS.map((p) => p.key);

/** 读取并补齐默认字段（配置存在 settings 表的 map 键里） */
async function get() {
  const base = DEFAULT_MAP();
  const cur = (await repo.settings.get('map')) || {};
  const out = {
    provider: PROVIDER_KEYS.indexOf(cur.provider) >= 0 ? cur.provider : base.provider,
    keys: Object.assign({}, base.keys, cur.keys || {}),
    center: Object.assign({}, base.center, cur.center || {}),
  };
  return out;
}

/** 覆盖写入（仅系统管理员） */
async function set(patch) {
  const cur = await get();
  const next = {
    provider: PROVIDER_KEYS.indexOf(patch.provider) >= 0 ? patch.provider : cur.provider,
    keys: Object.assign({}, cur.keys, patch.keys || {}),
    center: Object.assign({}, cur.center, patch.center || {}),
  };
  const cl = Number(next.center.lat);
  const cg = Number(next.center.lng);
  const cz = Number(next.center.zoom);
  next.center = {
    lat: Number.isFinite(cl) ? Math.max(-90, Math.min(90, cl)) : DEFAULT_CENTER.lat,
    lng: Number.isFinite(cg) ? Math.max(-180, Math.min(180, cg)) : DEFAULT_CENTER.lng,
    zoom: Number.isFinite(cz) ? Math.max(1, Math.min(20, Math.round(cz))) : DEFAULT_CENTER.zoom,
  };
  await repo.settings.set('map', next);
  return next;
}

/** 设置页用：完整配置 + 服务商清单（含注册指引） */
async function adminView() {
  const c = await get();
  return {
    map: c,
    providers: PROVIDERS,
    defaultCenter: DEFAULT_CENTER,
  };
}

/** 前端地图加载用：当前服务商 + 该服务商的 Key + 默认视野 */
async function publicConfig() {
  const c = await get();
  const p = PROVIDERS.find((x) => x.key === c.provider) || PROVIDERS[0];
  const key = (c.keys[c.provider] || '').trim();
  return {
    provider: c.provider,
    providerName: p.name,
    providerSdk: p.sdk,
    coord: p.coord,
    key,
    hasKey: !!key,
    center: c.center,
  };
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return k.slice(0, 2) + '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

/* ------------------------------ 服务端请求 ------------------------------ */

/**
 * 服务端 GET JSON（内置 http/https，不依赖 fetch —— Android 内置 Node
 * 运行时（nodejs-mobile）是精简构建，不保证带 undici/fetch）。
 */
function httpJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('非法的 URL：' + url)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout: timeoutMs || 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 连通性测试：用一次地理编码请求验证 Key 是否可用 */
async function testKey(provider, key) {
  const k = String(key || '').trim();
  if (!k) {
    return provider === 'tmap'
      ? { ok: false, msg: '未填写 Key：将尝试使用运行环境的免密钥代理（仅内置预览环境有效）' }
      : { ok: false, msg: '未填写密钥 tk，无法验证' };
  }
  try {
    if (provider === 'tianditu') {
      const url = 'https://api.tianditu.gov.cn/geocoder?ds=' + encodeURIComponent(JSON.stringify({ keyWord: '重庆市江北区' })) + '&tk=' + encodeURIComponent(k);
      const r = await httpJson(url, 8000);
      const j = r.json || {};
      if (r.status !== 200) return { ok: false, msg: 'HTTP ' + r.status + '，天地图未返回正常结果' };
      if (j.status === '0' && j.location) return { ok: true, msg: '地理编码正常：重庆市江北区 → ' + j.location.lon + ', ' + j.location.lat };
      return { ok: false, msg: '天地图返回：' + (j.msg || j.status || r.text.slice(0, 120)) + '（若为「无权限」，请确认该密钥是「服务端」应用且已勾选地理编码服务）' };
    }
    const url = 'https://apis.map.qq.com/ws/geocoder/v1/?address=' + encodeURIComponent('重庆市江北区') + '&key=' + encodeURIComponent(k);
    const r = await httpJson(url, 8000);
    const j = r.json || {};
    if (r.status !== 200) return { ok: false, msg: 'HTTP ' + r.status + '，腾讯位置服务未返回正常结果' };
    if (j.status === 0 && j.result) return { ok: true, msg: '地理编码正常：重庆市江北区 → ' + j.result.location.lng + ', ' + j.result.location.lat };
    return { ok: false, msg: '腾讯位置服务返回：' + (j.message || j.status || '未知错误') + '（请确认已勾选 WebServiceAPI）' };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '请求超时，请检查服务器能否访问地图服务' : (e.message || String(e));
    return { ok: false, msg: '连接失败：' + msg };
  }
}

/** 地理编码（地址 → 坐标）；返回 { lng, lat } 或 null */
async function geocode(address) {
  const c = await get();
  const key = (c.keys[c.provider] || '').trim();
  const addr = String(address || '').trim();
  if (!addr || !key) return null;
  try {
    if (c.provider === 'tianditu') {
      const url = 'https://api.tianditu.gov.cn/geocoder?ds=' + encodeURIComponent(JSON.stringify({ keyWord: addr })) + '&tk=' + encodeURIComponent(key);
      const r = await httpJson(url, 8000);
      const j = r.json || {};
      if (j.status === '0' && j.location) {
        const lng = Number(j.location.lon);
        const lat = Number(j.location.lat);
        if (Number.isFinite(lng) && Number.isFinite(lat)) return { lng, lat, raw: j.location };
      }
      return null;
    }
    const url = 'https://apis.map.qq.com/ws/geocoder/v1/?address=' + encodeURIComponent(addr) + '&key=' + encodeURIComponent(key);
    const r = await httpJson(url, 8000);
    const j = r.json || {};
    if (j.status === 0 && j.result && j.result.location) {
      const lng = Number(j.result.location.lng);
      const lat = Number(j.result.location.lat);
      if (Number.isFinite(lng) && Number.isFinite(lat)) return { lng, lat, raw: j.result };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 地点搜索（关键词 → 候选地点列表）。
 * 返回 { ok, msg, items:[{ title, address, lng, lat }] }，坐标为服务商原生坐标系
 * （腾讯 WebService = GCJ-02，天地图 = CGCS2000），由前端适配层统一换算成 GCJ-02 后再用。
 */
async function search(keyword, limit) {
  const c = await get();
  const key = (c.keys[c.provider] || '').trim();
  const kw = String(keyword || '').trim();
  const n = Math.max(1, Math.min(20, Number(limit) || 10));
  if (!kw) return { ok: false, msg: '缺少搜索关键词', items: [] };
  if (!key) return { ok: false, msg: '未配置地图服务密钥，无法搜索地点', items: [] };

  try {
    if (c.provider === 'tianditu') {
      // 天地图搜索服务 v2：queryType=12 普通搜索，mapBound 限定中国范围
      const postStr = JSON.stringify({
        keyWord: kw, level: 12, mapBound: '73,3,136,54', queryType: 12, count: n, start: 0,
      });
      const url = 'https://api.tianditu.gov.cn/v2/search?postStr=' + encodeURIComponent(postStr)
        + '&type=query&tk=' + encodeURIComponent(key);
      const r = await httpJson(url, 8000);
      const j = r.json || {};
      const raw = [].concat(j.pois || [], j.areaData || []);
      const items = raw.map((p) => {
        if (!p) return null;
        let lng = NaN, lat = NaN;
        if (typeof p.lonlat === 'string') {
          const ab = p.lonlat.split(/[,\s]+/);
          lng = Number(ab[0]); lat = Number(ab[1]);
        } else if (p.point) { lng = Number(p.point.lon); lat = Number(p.point.lat); }
        else { lng = Number(p.lon); lat = Number(p.lat); }
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
        return { title: String(p.name || kw), address: String(p.address || ''), lng, lat };
      }).filter(Boolean).slice(0, n);
      if (items.length) return { ok: true, items };
      return { ok: false, msg: '天地图未返回搜索结果：' + (j.msg || j.status || '无匹配地点'), items: [] };
    }

    // 腾讯位置服务：关键词输入提示（WebServiceAPI）
    const url = 'https://apis.map.qq.com/ws/place/v1/suggestion/?keyword=' + encodeURIComponent(kw)
      + '&page_size=' + n + '&key=' + encodeURIComponent(key);
    const r = await httpJson(url, 8000);
    const j = r.json || {};
    const items = (j.data || []).map((d) => {
      const loc = d && d.location;
      const lng = Number(loc && loc.lng);
      const lat = Number(loc && loc.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      return {
        title: String(d.title || d.name || kw),
        address: String(d.address || (d.ad_info && d.ad_info.district) || ''),
        lng, lat,
      };
    }).filter(Boolean).slice(0, n);
    if (items.length) return { ok: true, items };
    return { ok: false, msg: '腾讯位置服务未返回搜索结果：' + (j.message || j.status || '无匹配地点'), items: [] };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '请求超时，请检查服务器能否访问地图服务' : (e.message || String(e));
    return { ok: false, msg: '地点搜索失败：' + msg, items: [] };
  }
}

/** 逆地理编码（坐标 → 地址）；返回字符串或 '' */
async function reverse(lng, lat) {
  const c = await get();
  const key = (c.keys[c.provider] || '').trim();
  if (!key || !Number.isFinite(lng) || !Number.isFinite(lat)) return '';
  try {
    if (c.provider === 'tianditu') {
      const url = 'https://api.tianditu.gov.cn/geocoder?postStr='
        + encodeURIComponent(JSON.stringify({ lon: Number(lng.toFixed(6)), lat: Number(lat.toFixed(6)), ver: 1 }))
        + '&type=geocode&tk=' + encodeURIComponent(key);
      const r = await httpJson(url, 8000);
      const j = r.json || {};
      const res = j.result || {};
      return String(res.formatted_address || (res.addressComponent && res.addressComponent.address) || '');
    }
    const url = 'https://apis.map.qq.com/ws/geocoder/v1/?location=' + encodeURIComponent(lat + ',' + lng) + '&key=' + encodeURIComponent(key);
    const r = await httpJson(url, 8000);
    const j = r.json || {};
    if (j.status === 0 && j.result) {
      return String(j.result.address || (j.result.formatted_addresses && j.result.formatted_addresses.recommend) || '');
    }
    return '';
  } catch (e) {
    return '';
  }
}

module.exports = {
  PROVIDERS, PROVIDER_KEYS, DEFAULT_CENTER,
  get, set, adminView, publicConfig, maskKey,
  testKey, geocode, reverse, search,
};
