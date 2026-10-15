'use strict';
/**
 * 时间处理统一入口
 *
 * 背景（本次修复的 bug）：
 *   改造前代码到处写 `new Date().toISOString()`，而 toISOString() 返回的是 **UTC** 时间。
 *   这个值被直接切片塞进 MySQL 的 DATETIME 列（DATETIME 不带时区，MySQL 会按自己的时区
 *   把它当成「服务器本地时间」），于是东八区下每写一次就少 8 小时；读出来再 toISOString()
 *   又少 8 小时，前端不做时区转换直接显示，最终比真实时间慢 16 小时。
 *
 * 现在的约定（全项目唯一）：
 *   1. 数据库 DATETIME 列存 **服务器本地时间**，字符串格式 `YYYY-MM-DD HH:mm:ss`；
 *   2. 接口返回给前端的是 **本地时间 ISO 字符串并带时区偏移**，如 `2026-10-15T21:23:27+08:00`
 *      —— 前端既有 `slice(0,19).replace('T',' ')` 也有 `new Date(v)` 两种用法，带偏移的
 *      本地时间两种都能得到正确结果；
 *   3. DATE 列（use_date / acquire_date）只有年月日，一律按本地时区取，不用 UTC 切片，
 *      否则东八区会把「当天 00:00」变成「前一天 16:00」从而差一天。
 */

const PAD = (n, w) => String(n).padStart(w || 2, '0');

/** 本地时区的分钟偏移（东八区为 +480） */
function localOffsetMinutes(d) {
  return -(d || new Date()).getTimezoneOffset();
}

/**
 * Date / 各种字符串 -> 本地时间 ISO（带偏移），如 2026-10-15T21:23:27+08:00
 * 解析不了就原样返回。
 */
function toLocalIso(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  if (!Number.isFinite(d.getTime())) return String(v);
  const off = localOffsetMinutes(d);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    d.getFullYear() + '-' + PAD(d.getMonth() + 1) + '-' + PAD(d.getDate()) +
    'T' + PAD(d.getHours()) + ':' + PAD(d.getMinutes()) + ':' + PAD(d.getSeconds()) +
    sign + PAD(Math.floor(abs / 60)) + ':' + PAD(abs % 60)
  );
}

/**
 * Date / 各种字符串 -> MySQL DATETIME 用的本地时间字符串 `YYYY-MM-DD HH:mm:ss`
 * 入参可能是：Date、'...Z'（UTC）、'...+08:00'（本地）、'YYYY-MM-DD HH:mm:ss'、'YYYY-MM-DD'
 */
function toSqlDatetime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return null;
    return (
      v.getFullYear() + '-' + PAD(v.getMonth() + 1) + '-' + PAD(v.getDate()) + ' ' +
      PAD(v.getHours()) + ':' + PAD(v.getMinutes()) + ':' + PAD(v.getSeconds())
    );
  }
  const s = String(v).trim();
  // 已经是 DATETIME 字符串
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  // 纯日期补上 00:00:00
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 00:00:00';
  const d = new Date(s.replace(' ', 'T'));
  if (!Number.isFinite(d.getTime())) return s.slice(0, 19);
  return toSqlDatetime(d);
}

/** Date -> 本地时区的年月日 `YYYY-MM-DD`（DATE 列专用，不能用 UTC 切片） */
function toSqlDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  if (!Number.isFinite(d.getTime())) return String(v).slice(0, 10);
  return d.getFullYear() + '-' + PAD(d.getMonth() + 1) + '-' + PAD(d.getDate());
}

/** 当前时间的本地 ISO 串（写业务字段用） */
function nowIso() {
  return toLocalIso(new Date());
}

/** 当前时间的 DATETIME 串（拼 SQL 用） */
function nowSql() {
  return toSqlDatetime(new Date());
}

/** 当前本地日期 `YYYY-MM-DD`（文件名 / 批次号用） */
function todayDate() {
  return toSqlDate(new Date());
}

module.exports = {
  localOffsetMinutes,
  toLocalIso,
  toSqlDatetime,
  toSqlDate,
  nowIso,
  nowSql,
  todayDate,
};
