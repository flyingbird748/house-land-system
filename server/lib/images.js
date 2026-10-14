'use strict';
/**
 * 房产图片管理
 *   · 每条资产最多 3 张（正面 / 侧面 / 室内 …）
 *   · 单张不超过 2MB，仅允许 jpg / png / gif / webp
 *   · 二进制落盘在 data/images/<assetId>/ 下，db.json 只存元信息
 *     （零第三方依赖，服务端不做图片解码，避免依赖与内存开销）
 */
const fs = require('fs');
const path = require('path');
const store = require('./store.js');

const MAX_COUNT = 3;
const MAX_SIZE = 2 * 1024 * 1024;
const LABELS = ['正面', '侧面', '室内', '其他'];

const IMG_DIR = path.join(store.DATA_DIR, 'images');
const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const EXT = { jpg: '.jpg', png: '.png', gif: '.gif', webp: '.webp' };

/** 资产 id 只允许 id 字符集，杜绝路径穿越 */
const ID_RE = /^[A-Za-z0-9_]+$/;

function ensureDir() { if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true }); }

function list() {
  const db = store.load();
  if (!Array.isArray(db.images)) db.images = [];
  return db.images;
}

/** 某条资产的图片（按上传时间排序） */
function ofAsset(assetId) {
  return list()
    .filter((x) => x.assetId === assetId)
    .sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt)));
}

function findOne(assetId, imageId) {
  return list().find((x) => x.assetId === assetId && x.id === imageId) || null;
}

/** 供接口返回的图片信息（不含磁盘路径） */
function view(img) {
  return {
    id: img.id, assetId: img.assetId, name: img.name, label: img.label || '',
    mime: img.mime, size: img.size, w: img.w || 0, h: img.h || 0,
    uploadedAt: img.uploadedAt, uploadedBy: img.uploadedBy || '',
  };
}

/** 按文件头判断真实类型 —— 不能信客户端传来的 mime */
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (buf.length >= 6) {
    const head = buf.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function dirOf(assetId) {
  if (!assetId || !ID_RE.test(assetId)) throw new Error('资产 ID 不合法');
  return path.join(IMG_DIR, assetId);
}

function fileOf(assetId, img) {
  const dir = dirOf(assetId);
  const name = String(img.file || '');
  if (!name || !/^[A-Za-z0-9_]+\.(jpg|png|gif|webp)$/.test(name)) throw new Error('图片文件名不合法');
  return path.join(dir, name);
}

/**
 * 保存一张图片。
 * @param {string} assetId
 * @param {{name:string,label:string,data:string,w:number,h:number}} input data 为 base64（可带 dataURL 前缀）
 * @param {object} user
 */
function add(assetId, input, user) {
  const exist = ofAsset(assetId);
  if (exist.length >= MAX_COUNT) throw new Error(`每条资产最多 ${MAX_COUNT} 张图片，请先删除后再上传`);

  const raw = String((input && input.data) || '');
  const b64 = raw.indexOf(',') >= 0 ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!b64) throw new Error('图片内容为空');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('图片内容为空或格式错误');
  if (buf.length > MAX_SIZE) throw new Error(`单张图片不能超过 ${MAX_SIZE / 1024 / 1024}MB（当前 ${(buf.length / 1024 / 1024).toFixed(2)}MB）`);

  const kind = sniff(buf);
  if (!kind) throw new Error('仅支持 JPG / PNG / GIF / WebP 格式的图片');

  const now = new Date().toISOString();
  const id = store.nextId('image');
  const dir = dirOf(assetId);
  ensureDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const rec = {
    id,
    assetId,
    name: String((input && input.name) || '图片').slice(0, 120),
    label: LABELS.indexOf(input && input.label) >= 0 ? input.label : '其他',
    file: id + EXT[kind],
    mime: MIME[kind],
    size: buf.length,
    w: Number.isFinite(Number(input && input.w)) ? Math.round(Number(input.w)) : 0,
    h: Number.isFinite(Number(input && input.h)) ? Math.round(Number(input.h)) : 0,
    uploadedAt: now,
    uploadedBy: (user && (user.name || user.username)) || '',
  };

  fs.writeFileSync(path.join(dir, rec.file), buf);
  list().push(rec);
  store.save();
  return view(rec);
}

function setLabel(assetId, imageId, label) {
  const rec = findOne(assetId, imageId);
  if (!rec) return null;
  rec.label = LABELS.indexOf(label) >= 0 ? label : '其他';
  store.save();
  return view(rec);
}

function remove(assetId, imageId) {
  const all = list();
  const idx = all.findIndex((x) => x.assetId === assetId && x.id === imageId);
  if (idx < 0) return false;
  const [rec] = all.splice(idx, 1);
  try { fs.unlinkSync(fileOf(assetId, rec)); } catch (e) { /* 文件已缺失时忽略 */ }
  store.save();
  return true;
}

/** 删除资产时连带清理其图片目录 */
function removeAsset(assetId) {
  const all = list();
  for (let i = all.length - 1; i >= 0; i--) if (all[i].assetId === assetId) all.splice(i, 1);
  try { fs.rmSync(dirOf(assetId), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

function readFile(assetId, imageId) {
  const rec = findOne(assetId, imageId);
  if (!rec) return null;
  const file = fileOf(assetId, rec);
  if (!fs.existsSync(file)) return null;
  return { buf: fs.readFileSync(file), mime: rec.mime, name: rec.name };
}

/** 一次取多条资产的图片（供地图/预览页批量渲染缩略图） */
function groupBy(assetIds) {
  const set = new Set(assetIds);
  const map = {};
  list().filter((x) => set.has(x.assetId)).forEach((x) => {
    (map[x.assetId] = map[x.assetId] || []).push(view(x));
  });
  Object.keys(map).forEach((k) => map[k].sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt))));
  return map;
}

module.exports = {
  MAX_COUNT, MAX_SIZE, LABELS, IMG_DIR,
  list, ofAsset, findOne, view, add, setLabel, remove, removeAsset, readFile, groupBy, sniff,
};
