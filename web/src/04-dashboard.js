'use strict';
/* ============================================================
 *  dashboard —— 数据看板
 * ============================================================ */

Pages.dashboard = {
  title: '数据看板',
  render(root) {
    const wrap = h('<div></div>');
    const shimmer = h('<div class="empty">正在加载统计数据…</div>');
    wrap.appendChild(shimmer);
    root.appendChild(wrap);

    const refresh = h('<button class="btn sm">↻ 刷新</button>');
    on(refresh, 'click', () => load());

    async function load() {
      clear(wrap);
      wrap.appendChild(h('<div class="empty">正在加载统计数据…</div>'));
      let s;
      try {
        s = await API.getQ('/api/stats', Scope.params());
      } catch (e) {
        clear(wrap);
        wrap.appendChild(h(`<div class="empty"><div class="ic">⚠</div><div>${esc(e.message)}</div></div>`));
        return;
      }
      clear(wrap);
      wrap.appendChild(refresh);

      /* ---- 核心指标 ---- */
      const kpis = h('<div class="kpis"></div>');
      kpis.appendChild(kpiCard('资产总数', fmt.n(s.total) + ' <span style="font-size:13px;font-weight:400;color:#8b93a7">处</span>',
        `覆盖 ${s.byUnit.length} 个单位 · 办公面积 ${fmt.area(s.totalOfficeArea)} ㎡`));
      kpis.appendChild(kpiCard('产权面积合计', fmt.area(s.totalArea) + ' <span style="font-size:13px;font-weight:400;color:#8b93a7">㎡</span>',
        `其中办公用房 ${fmt.area(s.totalOfficeArea)} ㎡ · 已登记在岗人数 ${fmt.n(s.totalStaff)} 人`));
      kpis.appendChild(kpiCard('资产原值合计', `<span style="font-size:19px">${fmt.money(s.totalValue)}</span>`,
        `均单处 ${s.total ? fmt.money(s.totalValue / s.total) : '-'}`));
      const gp = s.geoMarked + s.geoUnmarked ? fmt.pct(s.geoMarked, s.total) : '0%';
      kpis.appendChild(kpiCard('地图标注进度', gp,
        `已标注 ${s.geoMarked} 处 · 待标注 ${s.geoUnmarked} 处`, '⊕'));
      wrap.appendChild(kpis);

      /* ---- 二级指标 ---- */
      const mini = h('<div class="mini-kpis"></div>');
      mini.appendChild(miniStat('有产权', fmt.n(s.titled), 'var(--ok)'));
      mini.appendChild(miniStat('无产权', fmt.n(s.untitled), 'var(--warn)'));
      mini.appendChild(miniStat('闲置资产', fmt.n(s.idleCount), 'var(--danger)'));
      mini.appendChild(miniStat('出租出借', fmt.n(s.rentCount), 'var(--brand)'));
      mini.appendChild(miniStat('租入借入', fmt.n(s.leaseCount), 'var(--info)'));
      mini.appendChild(miniStat('年出租收益', fmt.money(s.rentIncome), 'var(--ok)'));
      wrap.appendChild(mini);

      /* ---- 分类 / 状态 ---- */
      const grid1 = h('<div class="chart-grid"></div>');

      const catItems = s.byCategory.map((x, i) => ({ name: x.name, value: x.count, area: x.area, value2: x.value, color: colorOf(CAT_COLOR, x.name, i) }));
      const c1 = h('<div></div>');
      c1.appendChild(chartDonut(catItems, { centerValue: s.total, centerLabel: '处资产' }));
      c1.appendChild(chartLegend(catItems, (it) => `${fmt.area(it.area)}㎡`));
      grid1.appendChild(cardBox('资产分类分布', c1));

      const stItems = s.byUseStatus.map((x, i) => ({ name: x.name, value: x.count, area: x.area, color: colorOf(STATUS_COLOR, x.name, i) }));
      const c2 = h('<div></div>');
      c2.appendChild(chartDonut(stItems, { centerValue: s.total, centerLabel: '处资产' }));
      c2.appendChild(chartLegend(stItems, (it) => `${fmt.area(it.area)}㎡`));
      grid1.appendChild(cardBox('使用状态分布', c2));

      const unitItems = s.byUseUnit.slice(0, 12).map((x, i) => ({ name: x.name, value: x.count, area: x.area, color: PALETTE[i % PALETTE.length] }));
      grid1.appendChild(cardBox('使用单位分布（前 12）', chartBars(unitItems, { textFn: (it) => `${it.value} 处` })));

      const purposeItems = s.byPurpose.map((x, i) => ({ name: x.name, value: x.count, area: x.area, color: PALETTE[(i + 3) % PALETTE.length] }));
      grid1.appendChild(cardBox('资产用途分布', chartBars(purposeItems, { textFn: (it) => `${fmt.area(it.area)}㎡` })));

      wrap.appendChild(grid1);
      wrap.appendChild(h('<div style="height:12px"></div>'));

      /* ---- 房龄 / 区域 / 产权形式 ---- */
      const grid2 = h('<div class="chart-grid c3"></div>');
      const ageItems = s.byAge.map((x, i) => ({ name: x.name, value: x.count, color: ['#12a670', '#3b9ae1', '#2159d6', '#d98700', '#d92d20'][i] }));
      grid2.appendChild(cardBox('房龄分布', chartColumns(ageItems, { height: 210 })));

      const distItems = s.byDistrict.slice(0, 8).map((x, i) => ({ name: x.name, value: x.count, area: x.area, color: PALETTE[(i + 5) % PALETTE.length] }));
      grid2.appendChild(cardBox('区域分布', chartBars(distItems, { textFn: (it) => `${fmt.area(it.area)}㎡` })));

      const tfItems = s.byTitleForm.slice(0, 8).map((x, i) => ({ name: x.name, value: x.count, color: PALETTE[(i + 1) % PALETTE.length] }));
      grid2.appendChild(cardBox('产权形式分布', chartBars(tfItems, { textFn: (it) => `${it.value} 处` })));
      wrap.appendChild(grid2);

      wrap.appendChild(h('<div style="height:12px"></div>'));

      /* ---- 明细 ---- */
      const grid3 = h('<div class="chart-grid"></div>');

      // 分类×产权交叉表
      const tbl = h(`<table class="tbl"><thead><tr>
        <th>资产分类</th><th class="right">数量</th><th class="right">面积(㎡)</th>
        <th class="right">原值</th><th class="right">占比</th><th style="width:130px">面积占比</th>
      </tr></thead><tbody></tbody></table>`);
      const tb = $('tbody', tbl);
      const maxArea = Math.max(1, ...s.byCategory.map((x) => x.area));
      s.byCategory.forEach((x, i) => {
        tb.appendChild(h(`<tr>
          <td><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorOf(CAT_COLOR, x.name, i)};margin-right:6px"></span>${esc(x.name)}</td>
          <td class="right mono">${fmt.n(x.count)}</td>
          <td class="right mono">${fmt.area(x.area)}</td>
          <td class="right mono">${fmt.money(x.value)}</td>
          <td class="right mono">${fmt.pct(x.count, s.total)}</td>
          <td>${progressBar(x.area, maxArea, colorOf(CAT_COLOR, x.name, i)).outerHTML}</td>
        </tr>`));
      });
      grid3.appendChild(h('<div class="card"><div class="card-h"><h3>分类汇总</h3></div><div class="card-b tight"><div class="tbl-wrap"></div></div></div>'));
      $('.tbl-wrap', grid3.lastChild).appendChild(tbl);

      // 最近更新
      const rc = h('<div class="card"><div class="card-h"><h3>最近更新</h3></div><div class="card-b tight"></div></div>');
      const ul = h('<table class="tbl"><tbody></tbody></table>');
      const ub = $('tbody', ul);
      (s.recent || []).forEach((r) => {
        ub.appendChild(h(`<tr>
          <td><div class="ellip" style="max-width:260px">${esc(r.name || '未命名')}</div>
              <div class="muted" style="font-size:11.5px">${esc(r.unit || '')}</div></td>
          <td class="right nowrap muted" style="width:150px">${esc(fmt.rel(r.updatedAt))}
              <div style="font-size:11.5px">${esc(r.updatedBy || '')}</div></td>
        </tr>`));
      });
      if (!(s.recent || []).length) ub.appendChild(h('<tr><td class="muted">暂无记录</td></tr>'));
      $('.card-b', rc).appendChild(ul);
      grid3.appendChild(rc);

      wrap.appendChild(grid3);
    }

    load();
  },
};
