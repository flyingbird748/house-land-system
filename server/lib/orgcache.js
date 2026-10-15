'use strict';
/**
 * 单位缓存
 *
 * 单位表数据量很小（几十到几百行），但权限判断、单位树、面包屑路径几乎每个请求都要用到，
 * 所以允许它在内存里缓存一份；资产/用户/日志一律不缓存，全部走 SQL。
 *
 * 缓存在两处刷新：
 *   1. 服务启动时 refresh()；
 *   2. 单位增删改之后由调用方 refresh()。
 */

const repo = require('./repo.js');

let units = [];
let loaded = false;

async function refresh() {
  units = await repo.units.list();
  loaded = true;
  return units;
}

/** 同步取全部单位（应先 refresh 过） */
function all() {
  return units;
}

function ready() {
  return loaded;
}

module.exports = { refresh, all, ready };
