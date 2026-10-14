'use strict';
/* ============================================================
 *  settings —— 系统设置（地图服务商与密钥、默认视野）
 *  仅系统管理员可见。服务商清单与「如何注册获取 Key」的指引由后端
 *  /api/settings/map 下发（server/lib/mapconfig.js），新增服务商无需改前端。
 * ============================================================ */

Pages.settings = {
  title: '系统设置',
    render(root) {
      clear(root);
      if (!Session.isSysAdmin()) {
        root.appendChild(h('<div class="empty"><div class="ic">⛔</div><div>仅系统管理员可访问系统设置</div></div>'));
        return;
      }
      const self = this;
      const wrap = h('<div class="set-wrap"></div>');
      root.appendChild(wrap);

    let data = null;          // /api/settings/map 返回
    let cur = null;           // 当前编辑中的配置
    let dirty = false;
    let rep = null;           // /api/settings/report 返回
    let repDirty = false;

    /* ---------------- 载入 ---------------- */

    async function load() {
      wrap.innerHTML = '<div class="empty">加载中…</div>';
      try {
        data = await API.get('/api/settings/map');
        cur = JSON.parse(JSON.stringify(data.map));
        dirty = false;
        rep = await API.get('/api/settings/report').catch(() => null);
        repDirty = false;
        render();
      } catch (e) {
        wrap.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
    }

    function providerOf(key) {
      return (data.providers || []).find((p) => p.key === key) || (data.providers || [])[0] || {};
    }

    /* ---------------- 渲染 ---------------- */

    function render() {
      clear(wrap);
      wrap.appendChild(statusCard());
      wrap.appendChild(pickerCard());
      wrap.appendChild(keyCard());
      wrap.appendChild(viewCard());
      (data.providers || []).forEach((p) => wrap.appendChild(guideCard(p)));
      if (rep) wrap.appendChild(reportCard());
      wrap.appendChild(footerBar());
    }

    /** 顶部：当前生效状态 */
    function statusCard() {
      const p = providerOf(cur.provider);
      const hasKey = !!String((cur.keys || {})[cur.provider] || '').trim();
      return h(`<div class="card">
        <div class="card-h"><h3>地图服务</h3><div class="spacer"></div>
          <span class="tag ${hasKey ? 'g' : 'n'}">${hasKey ? '密钥已配置' : '未配置密钥'}</span>
        </div>
        <div class="card-b">
          <div class="set-note">
            当前生效：<b>${esc(p.name || cur.provider)}</b>（${esc(p.sdk || '')}）·
            坐标系 <b>${esc(p.coord || '-')}</b> ·
            默认视野 <span class="mono">${cur.center.lat}, ${cur.center.lng}</span>（缩放 ${cur.center.zoom}）
          </div>
          <div class="muted" style="font-size:11.5px;line-height:1.8;margin-top:6px">
            切换服务商或密钥后，<b>重新进入「地图标注 / 房产预览」</b>即可生效；
            系统内坐标统一按 GCJ-02 存储，使用天地图时会自动换算为 CGCS2000，点位不会整体偏移。
          </div>
        </div>
      </div>`);
    }

    /** 服务商选择 */
    function pickerCard() {
      const card = h(`<div class="card">
        <div class="card-h"><h3>选择地图服务商</h3></div>
        <div class="card-b"><div class="set-grid" id="st-grid"></div></div>
      </div>`);
      const grid = $('#st-grid', card);
      (data.providers || []).forEach((p) => {
        // 注意：变量名不要用 on —— 会遮蔽全局的事件绑定函数
        const active = p.key === cur.provider;
        const hasKey = !!String((cur.keys || {})[p.key] || '').trim();
        const it = h(`<div class="set-prov ${active ? 'on' : ''}" data-p="${esc(p.key)}">
          <div class="hd"><span class="nm">${esc(p.name)}</span>${active ? '<span class="tag b">生效中</span>' : ''}${hasKey ? '<span class="tag g">已填密钥</span>' : '<span class="tag n">未填</span>'}</div>
          <div class="sub">${esc(p.sdk || '')}</div>
          <div class="sub">坐标系：${esc(p.coord || '-')}</div>
          <div class="sub">需要：${esc((p.needServices || []).join('、'))}</div>
        </div>`);
        on(it, 'click', () => { if (cur.provider !== p.key) { cur.provider = p.key; dirty = true; render(); } });
        grid.appendChild(it);
      });
      return card;
    }

    /** 密钥配置 + 连通性测试 */
    function keyCard() {
      const p = providerOf(cur.provider);
      const key = String((cur.keys || {})[cur.provider] || '');
      const card = h(`<div class="card">
        <div class="card-h"><h3>密钥配置 · ${esc(p.name || '')}</h3></div>
        <div class="card-b">
          <div class="field">
            <label>${esc(p.keyLabel || '密钥')}</label>
            <input class="inp mono" id="st-key" placeholder="${esc(p.keyPlaceholder || '')}" value="${esc(key)}" spellcheck="false">
            <div class="muted" style="font-size:11.5px;margin-top:6px">
              ${p.needKey !== false ? '该服务商必须填写密钥才能加载地图。' : '留空时：内置预览环境会自动使用免密钥代理；正式部署建议填写自己的 Key。'}
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
            <button class="btn sm" id="st-test">测试连接</button>
            <a class="btn sm" id="st-console" href="${esc(p.consoleUrl || '#')}" target="_blank" rel="noreferrer">打开控制台申请密钥</a>
            <a class="btn sm" id="st-doc" href="${esc(p.docUrl || '#')}" target="_blank" rel="noreferrer">开发文档</a>
            <span class="muted" id="st-test-r" style="font-size:11.5px"></span>
          </div>
        </div>
      </div>`);

      on($('#st-key', card), 'input', function () {
        cur.keys[cur.provider] = this.value.trim();
        dirty = true;
        $('#st-test-r', card).textContent = '';
        if (self._sync) self._sync();
      });

      on($('#st-test', card), 'click', async () => {
        const box = $('#st-test-r', card);
        box.textContent = '正在测试…';
        try {
          const v = String(cur.keys[cur.provider] || '').trim();
          if (!v) {
            // 未填时测「已保存的」那一份，帮助确认服务端是否已配好
            const r = await API.post('/api/settings/map/test', { provider: cur.provider });
            box.innerHTML = `<span style="color:${r.ok ? 'var(--ok)' : 'var(--warn)'}">${esc(r.msg)}</span>`;
            return;
          }
          const r = await API.post('/api/settings/map/test', { provider: cur.provider, key: v });
          box.innerHTML = `<span style="color:${r.ok ? 'var(--ok)' : 'var(--danger)'}">${esc(r.msg)}</span>`;
        } catch (e) {
          box.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
        }
      });
      return card;
    }

    /** 默认视野 */
    function viewCard() {
      const d = data.defaultCenter || { lat: 29.5889, lng: 106.5515, zoom: 12 };
      const card = h(`<div class="card">
        <div class="card-h"><h3>默认视野</h3><div class="spacer"></div>
          <button class="btn sm" id="st-view-reset">恢复默认</button>
        </div>
        <div class="card-b">
          <div class="set-row">
            <div class="field" style="flex:1"><label>中心纬度</label><input class="inp mono" id="st-lat" value="${cur.center.lat}"></div>
            <div class="field" style="flex:1"><label>中心经度</label><input class="inp mono" id="st-lng" value="${cur.center.lng}"></div>
            <div class="field" style="flex:1"><label>缩放级别</label><input class="inp mono" id="st-zoom" value="${cur.center.zoom}"></div>
          </div>
          <div class="muted" style="font-size:11.5px;margin-top:6px">
            打开地图且没有已标注点位时，会定位到这里。默认：重庆市江北区（${d.lat}, ${d.lng}，缩放 ${d.zoom}）。
          </div>
        </div>
      </div>`);
      const bind = (id, k, isInt) => on($('#' + id, card), 'change', function () {
        const n = Number(this.value);
        if (!Number.isFinite(n)) { this.value = cur.center[k]; return; }
        cur.center[k] = isInt ? Math.round(n) : n;
        dirty = true;
        if (self._sync) self._sync();
      });
      bind('st-lat', 'lat', false);
      bind('st-lng', 'lng', false);
      bind('st-zoom', 'zoom', true);
      on($('#st-view-reset', card), 'click', () => {
        cur.center = Object.assign({}, data.defaultCenter || { lat: 29.5889, lng: 106.5515, zoom: 12 });
        dirty = true;
        render();
        toast('已恢复默认视野（记得点「保存」）', 'ok');
      });
      return card;
    }

    /** 分析报告参数（台账中没有的口径数据，留空时报告自动推算） */
    function reportCard() {
      const card = h(`<div class="card">
        <div class="card-h"><h3>分析报告参数</h3><div class="spacer"></div>
          <span class="muted" style="font-size:11.5px">留空时由报告引擎自动推算</span>
        </div>
        <div class="card-b">
          <div class="set-note">
            报告里的「编制干部职工人数 / 现有干部职工人数 / 内设科室数 / 税务所数」在资产台账中并不存在，
            需按人事口径维护；<b>留空</b>时报告会按各自的兜底规则自动推算（见首页「分析报告 → 替代规则」）。
          </div>
          <div class="set-row" style="flex-wrap:wrap;gap:10px 14px;margin-top:10px" id="rp-row"></div>
        </div>
      </div>`);
      const row = $('#rp-row', card);
      (rep.params || []).forEach((p) => {
        const v = rep.values[p.key];
        const f = h(`<div class="field" style="min-width:200px;flex:1">
          <label>${esc(p.label)}${p.unit ? '（' + esc(p.unit) + '）' : ''}</label>
          <input class="inp mono" data-rp="${esc(p.key)}" value="${v === '' || v === undefined || v === null ? '' : esc(String(v))}"
            placeholder="留空自动推算" ${p.key === 'asOf' ? '' : 'inputmode="numeric"'}>
          <div class="muted" style="font-size:11px;line-height:1.7;margin-top:5px">
            ${esc(p.hint || '')}<br>兜底：${esc(p.fallback || '')}
          </div>
        </div>`);
        // 用 input 而非 change：自动填充/粘贴只触发 input，change 要等失焦且不一定触发
        on($('[data-rp]', f), 'input', function () {
          rep.values[p.key] = this.value.trim();
          repDirty = true;
          if (self._sync) self._sync();
        });
        row.appendChild(f);
      });
      return card;
    }

    /** 注册获取 Key 的详细指引 */
    function guideCard(p) {
      const expanded = p.key === cur.provider;
      const steps = (p.steps || []).map((s, i) => `
        <div class="set-step">
          <div class="n">${i + 1}</div>
          <div class="b">
            <div class="t">${esc(s.t)}</div>
            <div class="d">${esc(s.d)}</div>
            ${s.url ? `<a class="lnk" href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url)}</a>` : ''}
          </div>
        </div>`).join('');
      const notes = (p.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
      const card = h(`<div class="card">
        <div class="card-h">
          <h3>如何获取 ${esc(p.name)} 的密钥</h3>
          <div class="spacer"></div>
          <button class="btn sm" data-tg="${esc(p.key)}">${expanded ? '收起' : '展开'}</button>
        </div>
        <div class="card-b" id="gd-${esc(p.key)}" style="${expanded ? '' : 'display:none'}">
          <div class="set-note">以下步骤在天地图 / 腾讯位置服务官网完成，申请到的密钥粘贴到上方「密钥配置」里即可。</div>
          <div class="set-steps">${steps}</div>
          ${notes ? `<div class="set-note warn" style="margin-top:10px"><b>注意事项</b><ul style="margin:6px 0 0 18px;padding:0">${notes}</ul></div>` : ''}
        </div>
      </div>`);
      on($('[data-tg]', card), 'click', function () {
        const box = $('#gd-' + p.key, card);
        const shown = box.style.display !== 'none';
        box.style.display = shown ? 'none' : '';
        this.textContent = shown ? '展开' : '收起';
      });
      return card;
    }

    /** 底部保存栏 */
    function footerBar() {
      const bar = h(`<div class="set-foot">
        <span class="muted" id="st-hint" style="font-size:11.5px"></span>
        <div class="spacer"></div>
        <button class="btn sm" id="st-reload">放弃修改</button>
        <button class="btn pri sm" id="st-save">保存设置</button>
      </div>`);
      const hint = $('#st-hint', bar);
      const sync = () => {
        const d2 = dirty || repDirty;
        hint.innerHTML = d2 ? '<span style="color:var(--warn)">有未保存的修改</span>' : '已是最新';
      };
      self._sync = sync;
      sync();
      on($('#st-save', bar), 'click', async () => {
        try {
          const r = await API.put('/api/settings/map', { provider: cur.provider, keys: cur.keys, center: cur.center });
          cur = JSON.parse(JSON.stringify(r.map));
          data.map = r.map;
          dirty = false;
          await Geo.config(true); // 让地图页立即拿到新配置
          if (rep && repDirty) {
            const patch = {};
            (rep.params || []).forEach((p) => { patch[p.key] = rep.values[p.key]; });
            const r2 = await API.put('/api/settings/report', patch);
            rep.values = r2.values;
            repDirty = false;
          }
          toast('已保存，重新进入地图页面即可生效', 'ok');
          render();
        } catch (e) { toast(e.message, 'err'); }
      });
      on($('#st-reload', bar), 'click', () => { self.render(root); });
      return bar;
    }

    load();
  },
};
