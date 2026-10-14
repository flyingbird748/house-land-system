'use strict';
/* ============================================================
 *  report —— 土地房屋资产统计分析报告（首页）
 *
 *  报告正文由后端 /api/report 按 server/assets/report-template.md 自动汇总生成，
 *  模板里的每个填空（`____`）都已规范化为具名占位符 {{令牌}}。
 *  本页除正文外，还列出「占位符 → 本次取值 → 替代规则」对照表，方便核对口径。
 * ============================================================ */

Pages.report = {
  title: '分析报告',

  render(root) {
    clear(root);
    const self = this;
    let data = null;
    let ruleOpen = false;

    const wrap = h('<div class="rp-wrap"></div>');
    root.appendChild(wrap);

    async function load() {
      wrap.innerHTML = '<div class="empty">正在汇总生成分析报告…</div>';
      try {
        data = await API.getQ('/api/report', Scope.params());
      } catch (e) {
        wrap.innerHTML = `<div class="empty"><div class="ic">⚠</div><div>${esc(e.message)}</div></div>`;
        return;
      }
      draw();
    }

    /* ---------------- 工具条 ---------------- */

    function toolbar() {
      const bar = h(`<div class="rp-bar">
        <div class="rp-meta" id="rp-meta"></div>
        <div class="spacer"></div>
        <button class="btn sm" id="rp-rule">≡ 替代规则</button>
        <button class="btn sm" id="rp-copy">⧉ 复制全文</button>
        <button class="btn sm" id="rp-md">⇩ 下载 Markdown</button>
        <button class="btn sm" id="rp-print">⎙ 打印 / 存为 PDF</button>
        <button class="btn sm" id="rp-refresh">↻ 刷新</button>
      </div>`);

      const meta = $('#rp-meta', bar);
      const m = data.meta || {};
      meta.innerHTML = [
        `<span class="rp-chip">统计范围：<b>${esc(Scope.label())}</b></span>`,
        `<span class="rp-chip">资产 <b>${fmt.n(m.total)}</b> 处</span>`,
        `<span class="rp-chip">总面积 <b>${fmt.area(m.totalArea)}</b> ㎡</span>`,
        `<span class="rp-chip">自有 <b>${fmt.n(m.own)}</b> · 借入 <b>${fmt.n(m.borrow)}</b> · 租入 <b>${fmt.n(m.rentIn)}</b></span>`,
        `<span class="rp-chip">截止 <b>${esc(m.asOf || '')}</b></span>`,
      ].join('');

      on($('#rp-refresh', bar), 'click', () => load());
      on($('#rp-rule', bar), 'click', () => { ruleOpen = !ruleOpen; draw(); });
      on($('#rp-print', bar), 'click', () => window.print());
      on($('#rp-md', bar), 'click', () => {
        const name = `土地房屋资产统计分析报告-${(data.meta && data.meta.scopeLabel) || '全部单位'}-${(data.meta && data.meta.asOf) || ''}.md`;
        downloadText(name, data.markdown, 'text/markdown;charset=utf-8');
      });
      on($('#rp-copy', bar), 'click', () => {
        const txt = data.markdown;
        const done = () => toast('报告全文已复制到剪贴板', 'ok');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
        } else fallbackCopy(txt, done);
      });
      return bar;
    }

    function fallbackCopy(txt, done) {
      const ta = h('<textarea style="position:fixed;left:-9999px;top:0"></textarea>');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请改用「下载 Markdown」', 'err'); }
      document.body.removeChild(ta);
    }

    /** 纯前端下载：Blob + a[download] */
    function downloadText(name, text, mime) {
      const blob = new Blob(['\ufeff' + text], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = h('<a style="display:none"></a>');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 500);
    }

    /* ---------------- 规则对照表 ---------------- */

    function ruleTable() {
      const box = h(`<div class="card" style="margin-top:12px">
        <div class="card-h">
          <h3>占位符替代规则（共 ${(data.values || []).length} 项）</h3>
          <div class="spacer"></div>
          <span class="muted" style="font-size:11.5px">模板中的 <code>____</code> → 具名占位符 <code>{{令牌}}</code> → 自动汇总值</span>
        </div>
        <div class="card-b" style="padding:0">
          <div style="overflow:auto;max-height:520px">
            <table class="tbl fixed" style="width:820px">
              <colgroup>
                <col style="width:80px"><col style="width:150px"><col style="width:150px"><col style="width:440px">
              </colgroup>
              <thead>
                <tr><th>占位符</th><th>含义</th><th>本次取值</th><th>替代规则</th></tr>
              </thead>
              <tbody id="rp-rule-body"></tbody>
            </table>
          </div>
        </div>
      </div>`);
      const tb = $('#rp-rule-body', box);
      (data.values || []).forEach((v) => {
        const tr = h(`<tr>
          <td><code>${esc(v.token)}</code></td>
          <td>${esc(v.label || '')}</td>
          <td><b>${esc(v.value)}</b></td>
          <td class="rp-rule">${esc(v.rule || '')}</td>
        </tr>`);
        tb.appendChild(tr);
      });
      return box;
    }

    /* ---------------- 渲染 ---------------- */

    function draw() {
      clear(wrap);
      wrap.appendChild(toolbar());

      if (!data.total && !(data.meta && data.meta.total)) {
        // 空数据也给正文，避免整页空白
      }

      const body = h('<div class="card rp-doc"><div class="card-b" id="rp-body"></div></div>');
      $('#rp-body', body).innerHTML = data.html;
      wrap.appendChild(body);

      if (ruleOpen) wrap.appendChild(ruleTable());

      if (data.missing && data.missing.length) {
        wrap.appendChild(h(`<div class="set-note warn" style="margin-top:10px">
          以下占位符未匹配到汇总规则，已显示为「—」：${esc(data.missing.join('、'))}
        </div>`));
      }
    }

    load();
  },

  leave() { /* 报告页无外部资源需释放 */ },
};
