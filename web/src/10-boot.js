'use strict';
/* ============================================================
 *  boot —— 入口
 * ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  boot();
});

window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) || String(e.reason || '');
  if (msg && msg !== 'NO_CONFIG') toast(msg, 'err', 4000);
});
