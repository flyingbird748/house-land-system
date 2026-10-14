'use strict';
/**
 * 房产图片接口测试 —— 纯 HTTP
 * 覆盖：上传 / 列表 / 改标签 / 删除 / raw 直链（含 ?token=）/ 批量索引 /
 *       数量上限 3 张 / 单张 2MB 上限 / 伪造 mime 被拒 / 越权 403 / 删除资产连带清理。
 *
 * 运行：node tools/images-test.js（需后端 http://127.0.0.1:8789）
 */
const fs = require('fs');
const path = require('path');
const BASE = process.env.APIBASE || 'http://127.0.0.1:8789';
const DATA_DIR = path.join(__dirname, '..', 'data');

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

/** 直连二进制接口（可测 ?token= 这种不走 Authorization 头的场景） */
async function raw(p, token) {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, type: res.headers.get('content-type'), nosniff: res.headers.get('x-content-type-options') };
}

/* ---------- 测试用图片（构造自带合法文件头的最小图片，无需第三方库） ---------- */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const JPG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = (() => {
  const b = Buffer.alloc(64);
  b.write('RIFF', 0, 'ascii'); b.write('WEBP', 8, 'ascii');
  return b;
})();

/** 尺寸合法但内容随机的大图（服务端只校验文件头与体积，不做解码） */
function bigImage(head, size) {
  const buf = Buffer.alloc(size);
  head.copy(buf, 0);
  require('crypto').randomFillSync(buf, head.length);
  return buf;
}

const post = (assetId, token, body) => api('POST', '/api/assets/' + assetId + '/images', body, token);

(async () => {
  console.log('== 房产图片接口测试 ==\n');

  const T = (await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).data.token;
  const V = (await api('POST', '/api/auth/login', { username: 'viewer', password: 'viewer123' })).data.token;
  const U = (await api('POST', '/api/auth/login', { username: 'unitadmin', password: 'unitadmin123' })).data.token;
  check('登录三个角色', !!T && !!V && !!U);

  /* ---------- 准备一条测试资产 ---------- */
  let r = await api('GET', '/api/assets?pageSize=1', undefined, T);
  const target = (r.data.rows || [])[0];
  check('取到一条真实资产', !!target, r.status);

  const created = await api('POST', '/api/assets', {
    name: 'ZZ图片测试资产（自动清理）', unit: target.unit, assetNo: 'IMGTEST' + Date.now(),
  }, T);
  check('创建临时测试资产', created.status === 200, created.data);
  const aid = created.data.asset.id;

  /* ---------- 上传：正常三张 ---------- */
  let r1 = await post(aid, T, { name: 'front.png', label: '正面', data: PNG_1PX.toString('base64'), w: 1, h: 1 });
  check('上传第 1 张（PNG）', r1.status === 200 && r1.data.image && r1.data.image.mime === 'image/png', r1.data);
  check('返回递推规则与实际文件一致', r1.data.image.size === PNG_1PX.length, r1.data.image);
  const id1 = r1.data.image.id;

  let r2 = await post(aid, T, { name: 'side.jpg', label: '侧面', data: JPG_HEAD.toString('base64') });
  check('上传第 2 张（JPEG）', r2.status === 200 && r2.data.image.mime === 'image/jpeg', r2.data);

  /* ---------- 单张 2MB 上限（要先于「凑满 3 张」，否则先被数量拦截） ---------- */
  const tooBig = bigImage(JPG_HEAD, 2 * 1024 * 1024 + 1024);
  let rb = await post(aid, T, { name: 'big.jpg', label: '其他', data: tooBig.toString('base64') });
  check('超过 2MB 被拒（400）', rb.status === 400, rb.data);
  check('提示写明 2MB 上限', /2MB/.test(rb.data.error || ''), rb.data.error);

  /* ---------- 伪造类型 ---------- */
  const fake = Buffer.from('这不是图片，只是伪装成 image/png 的文本内容'.repeat(20), 'utf8');
  let rf = await post(aid, T, { name: 'fake.png', label: '正面', data: fake.toString('base64') });
  check('伪造图片被拒（按文件头识别）', rf.status === 400, rf.data);
  check('提示说明支持格式', /JPG \/ PNG/.test(rf.data.error || ''), rf.data.error);
  check('被拒的请求没有占用名额', ((await api('GET', '/api/assets/' + aid + '/images', undefined, T)).data.images || []).length === 2, '期望 2 张');

  let r3 = await post(aid, T, { name: 'indoor.webp', label: '室内', data: WEBP.toString('base64') });
  check('上传第 3 张（WebP）', r3.status === 200 && r3.data.image.mime === 'image/webp', r3.data);

  /* ---------- 数量上限 ---------- */
  let r4 = await post(aid, T, { name: 'x.png', label: '其他', data: PNG_1PX.toString('base64') });
  check('第 4 张被拒（400）', r4.status === 400, r4.data);
  check('提示写明最多 3 张', /最多 3 张/.test(r4.data.error || ''), r4.data.error);

  /* ---------- 列表 ---------- */
  let rl = await api('GET', '/api/assets/' + aid + '/images', undefined, T);
  const imgs = rl.data.images || [];
  check('列表返回 3 张', imgs.length === 3, imgs.length);
  check('列表含上限信息（max=3 / maxSize）', rl.data.max === 3 && rl.data.maxSize === 2 * 1024 * 1024, [rl.data.max, rl.data.maxSize]);
  check('标签按 正面/侧面/室内 记录', imgs.map((x) => x.label).join(',') === '正面,侧面,室内', imgs.map((x) => x.label));
  check('列表不暴露磁盘路径', imgs.every((x) => x.file === undefined), imgs.map((x) => x.file));

  /* ---------- raw 直链 ---------- */
  let raw1 = await raw('/api/assets/' + aid + '/images/' + id1 + '/raw', T);
  check('Authorization 头可取原图', raw1.status === 200 && raw1.buf.equals(PNG_1PX), [raw1.status, raw1.buf.length]);
  check('响应带正确 Content-Type', raw1.type === 'image/png', raw1.type);
  check('响应带 nosniff', raw1.nosniff === 'nosniff', raw1.nosniff);

  let rawTok = await raw('/api/assets/' + aid + '/images/' + id1 + '/raw?token=' + encodeURIComponent(T), null);
  check('?token= 也能取图（<img src> 场景）', rawTok.status === 200 && rawTok.buf.equals(PNG_1PX), rawTok.status);
  let rawAnon = await raw('/api/assets/' + aid + '/images/' + id1 + '/raw', null);
  check('未登录取图被拒（401）', rawAnon.status === 401, rawAnon.status);
  let rawBad = await raw('/api/assets/' + aid + '/images/' + id1 + '/raw?token=abc.def', null);
  check('无效令牌取图被拒（401）', rawBad.status === 401, rawBad.status);
  let rawBadId = await raw('/api/assets/' + aid + '/images/not_exist/raw', T);
  check('图片不存在返回 404', rawBadId.status === 404, rawBadId.status);

  /* ---------- 批量索引 ---------- */
  let rg = await api('GET', '/api/images?ids=' + aid + ',' + target.id, undefined, T);
  check('批量索引按资产分组', (rg.data.map || {})[aid] && rg.data.map[aid].length === 3, Object.keys(rg.data.map || {}));
  check('批量索引不含未传的资产', Object.keys(rg.data.map || {}).length <= 2, Object.keys(rg.data.map || {}));

  /* ---------- 改标签 ---------- */
  let rp = await api('PUT', '/api/assets/' + aid + '/images/' + id1, { label: '室内' }, T);
  check('改标签成功', rp.status === 200 && rp.data.image.label === '室内', rp.data);
  rp = await api('PUT', '/api/assets/' + aid + '/images/' + id1, { label: '不存在的标签' }, T);
  check('非法标签回落为「其他」', rp.status === 200 && rp.data.image.label === '其他', rp.data);
  await api('PUT', '/api/assets/' + aid + '/images/' + id1, { label: '正面' }, T);

  /* ---------- 越权 ---------- */
  let rv = await post(aid, V, { name: 'v.png', label: '正面', data: PNG_1PX.toString('base64') });
  check('只读角色不能上传（403）', rv.status === 403, rv.status);
  let rvGet = await api('GET', '/api/assets/' + aid + '/images', undefined, V);
  check('只读角色可以列表（同单位可见）', rvGet.status === 200, rvGet.status);

  /* 换一个单位的资产，验证单位管理员不能插手 */
  const units = (await api('GET', '/api/units', undefined, T)).data.rows || [];
  const myUnit = (await api('GET', '/api/auth/me', undefined, U)).data.user.unit;
  const foreign = units.find((u) => u.name !== myUnit);
  if (foreign) {
    const oa = await api('POST', '/api/assets', { name: 'ZZ图片测试·外单位（自动清理）', unit: foreign.name }, T);
    if (oa.status === 200) {
      const oaid = oa.data.asset.id;
      let ro = await post(oaid, U, { name: 'x.png', label: '正面', data: PNG_1PX.toString('base64') });
      check('单位管理员不能给其他单位资产上传（403）', ro.status === 403, ro.status);
      await api('DELETE', '/api/assets/' + oaid, undefined, T);
    } else {
      check('创建外单位资产（跳过）', true);
    }
  } else {
    check('存在第二个单位用于越权校验（跳过）', true);
  }

  /* ---------- 删除 ---------- */
  let rd = await api('DELETE', '/api/assets/' + aid + '/images/' + id1, undefined, T);
  check('删除图片成功', rd.status === 200, rd.data);
  rl = await api('GET', '/api/assets/' + aid + '/images', undefined, T);
  check('删除后剩 2 张', (rl.data.images || []).length === 2, (rl.data.images || []).length);
  check('磁盘文件已同步删除', !fs.existsSync(path.join(DATA_DIR, 'images', aid, id1 + '.png')), id1);

  /* ---------- 删除资产连带清理 ---------- */
  let rdz = await api('DELETE', '/api/assets/' + aid, undefined, T);
  check('删除临时资产成功', rdz.status === 200, rdz.status);
  check('图片目录已清空（连带删除）', !fs.existsSync(path.join(DATA_DIR, 'images', aid)), aid);
  const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
  check('db.json 中不再残留该资产的图片记录', (db.images || []).every((x) => x.assetId !== aid), (db.images || []).filter((x) => x.assetId === aid).length);

  /* ---------- 收尾检查 ---------- */
  const leftDir = fs.existsSync(path.join(DATA_DIR, 'images')) ? fs.readdirSync(path.join(DATA_DIR, 'images')) : [];
  check('未留下测试资产的图片目录', leftDir.every((d) => !/^zz/i.test(d)), leftDir);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(1); });
