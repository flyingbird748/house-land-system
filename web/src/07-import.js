'use strict';
/* ============================================================
 *  import —— Excel 导入向导（上传 → 字段映射 → 预览 → 写入）
 * ============================================================ */

const ImportState = {
  token: '', fileName: '', sheetName: '', headerRowIndex: 0,
  mapping: [], cols: [], preview: [], total: 0, skipped: [], issues: [], issueCount: 0,
  sheets: [],
};

Pages.import = {
    title: 'Excel 导入',
  render(root) {
    if (guard(root, 'import')) return;
    const wrap = h('<div></div>');
    root.appendChild(wrap);

    /* ---- 步骤一：上传 ---- */
    const step1 = h(`
      <div class="card">
        <div class="card-h"><h3>① 选择 Excel 台账文件</h3><div class="spacer"></div>
          <button class="btn sm" id="tpl">下载内置导入模板</button>
        </div>
        <div class="card-b">
          <div class="tpl-box" id="tpl-info">
            <div class="tt">导入模板（内置）</div>
            <div class="ts muted">正在读取模板结构…</div>
          </div>
          <div class="drop" id="drop">
            <div class="ic">⇪</div>
            <div class="t">点击选择，或把 .xlsx 文件拖到这里</div>
            <div class="s">严格兼容《房屋土地统计表》格式，自动识别表头行与字段，支持合并单元格、日期、公式结果值</div>
          </div>
          <input type="file" id="file" accept=".xlsx,.xlsm" style="display:none">
          <div class="muted" style="margin-top:12px;font-size:12px;line-height:1.8">
            · 模板第 1-4 行为表头（合并单元格），第 5 行序号、第 6 行填表说明，<b>数据请从第 7 行开始</b>；<br>
            · 表头行可以不在第一行，系统会自动寻找字段最多的一行；<br>
            · 「资产编号」相同的记录会被识别为同一条资产（用于更新而非重复新增）；<br>
            · 首列为「序号 / 行次 / 填表说明 / 合计」等非数据行会自动跳过。
          </div>
        </div>
      </div>`);
    wrap.appendChild(step1);

    // 展示内置模板的结构信息
    API.get('/api/import/template/info').then((info) => {
      const box = $('#tpl-info', step1);
      if (!box || !info) return;
      const items = [
        ['列数', info.cols + ' 列'],
        ['表头', `第 ${info.headerRow}-${info.headerToRow} 行（合并）`],
        ['序号行', `第 ${info.seqRow} 行`],
        ['填表说明行', `第 ${info.noteRow} 行`],
        ['数据起始行', `第 ${info.dataRow} 行`],
        ['字段匹配', `${info.matched} / ${info.cols}`],
      ];
      box.innerHTML = '<div class="tt">导入模板（内置'
        + (info.builtin ? '' : '·兜底生成') + '）</div>'
        + '<div class="ts">' + items.map(([k, v]) => `<span class="ti"><b>${esc(k)}</b>${esc(v)}</span>`).join('') + '</div>'
        + '<div class="ts muted" style="margin-top:6px">'
        + esc(info.sheets && info.sheets.length > 1 ? '工作表：' + info.sheets.join('、') + '（第二个表为逐列填写说明）' : '工作表：' + ((info.sheets || [])[0] || ''))
        + esc(info.size ? ` · ${(info.size / 1024).toFixed(1)} KB` : '')
        + '</div>';
    }).catch(() => {});

    const box2 = h('<div id="imp-2"></div>');
    wrap.appendChild(box2);
    const box3 = h('<div id="imp-3"></div>');
    wrap.appendChild(box3);

    on($('#tpl', step1), 'click', async () => {
      try {
        await downloadAuth('/api/import/template', '房屋土地导入模板.xlsx');
        toast('模板已下载', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    const fileInput = $('#file', step1);
    const drop = $('#drop', step1);
    on(drop, 'click', () => fileInput.click());
    on(fileInput, 'change', () => { if (fileInput.files[0]) upload(fileInput.files[0]); });
    ['dragenter', 'dragover'].forEach((ev) => on(drop, ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => on(drop, ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    on(drop, 'drop', (e) => { const f = e.dataTransfer.files[0]; if (f) upload(f); });

    async function upload(file) {
      if (!/\.xlsx$/i.test(file.name) && !/\.xlsm$/i.test(file.name)) {
        toast('请上传 .xlsx 格式的 Excel 文件', 'err');
        return;
      }
      drop.innerHTML = '<div class="ic">◌</div><div class="t">正在解析 ' + esc(file.name) + ' …</div>';
      const buf = await file.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      const b64 = btoa(bin);
      try {
        const r = await API.post('/api/import/preview', { fileName: file.name, content: b64 });
        Object.assign(ImportState, r, { fileName: file.name });
        ImportState.mapping = r.mapping.map((m) => m.key);
        ImportState.cols = r.mapping;
        renderStep2();
        renderStep3();
        toast(`解析完成，识别到 ${r.total} 条记录`, 'ok');
      } catch (e) {
        drop.innerHTML = '<div class="ic">⚠</div><div class="t">解析失败</div><div class="s">' + esc(e.message) + '</div>';
      }
    }

    /* ---- 步骤二：字段映射与预览 ---- */
    function renderStep2() {
      clear(box2);
      if (!ImportState.token) return;
      const fields = (Session.options || {}).fields || [];
      const opt = (k) => `<option value="">— 不导入 —</option>` + fields.map((f) =>
        `<option value="${f.key}" ${k === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('');

      const card = h(`<div class="card" style="margin-top:12px">
        <div class="card-h"><h3>② 字段匹配与数据预览</h3><div class="spacer"></div>
          <span class="muted" style="font-size:12px">${esc(ImportState.fileName)} ｜ 工作表 <b>${esc(ImportState.sheetName)}</b> ｜ 表头第 ${ImportState.headerRowIndex + 1} 行 ｜ 识别 <b>${ImportState.total}</b> 条</span>
        </div>
        <div class="card-b">
          <div class="tabs">
            <div class="tb on" data-t="map">字段匹配（${ImportState.mapping.filter(Boolean).length} 列）</div>
            <div class="tb" data-t="pv">数据预览</div>
            <div class="tb" data-t="is">异常提示${ImportState.issueCount ? `（${ImportState.issueCount}）` : ''}</div>
            <div class="tb" data-t="sk">跳过行（${ImportState.skipped.length}）</div>
          </div>
          <div id="tp-map"></div>
          <div id="tp-pv" style="display:none"></div>
          <div id="tp-is" style="display:none"></div>
          <div id="tp-sk" style="display:none"></div>
        </div>
      </div>`);
      box2.appendChild(card);

      $$('.tb', card).forEach((t) => on(t, 'click', () => {
        $$('.tb', card).forEach((x) => x.classList.toggle('on', x === t));
        ['map', 'pv', 'is', 'sk'].forEach((k) => { $('#tp-' + k, card).style.display = t.dataset.t === k ? '' : 'none'; });
      }));

      // 字段匹配
      const mt = h(`<table class="map-tbl"><thead><tr><th style="width:52px">列</th><th style="width:230px">Excel 表头</th><th style="width:230px">导入到字段</th><th>示例值</th></tr></thead><tbody></tbody></table>`);
      const mb = $('tbody', mt);
      const sample = ImportState.preview[0] || {};
      ImportState.mapping.forEach((k, i) => {
        const tr = h(`<tr>
          <td class="muted">${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}</td>
          <td>${esc(hdrText(i))}${ImportState.cols[i] && ImportState.cols[i].key ? '' : ' <span class="tag n">未匹配</span>'}</td>
          <td><select class="sel" data-i="${i}">${opt(k)}</select></td>
          <td class="muted ellip" style="max-width:280px">${esc(sampleText(i))}</td>
        </tr>`);
        mb.appendChild(tr);
      });
      $('#tp-map', card).appendChild(mt);
      $$('select[data-i]', mt).forEach((s) => on(s, 'change', () => {
        ImportState.mapping[Number(s.dataset.i)] = s.value;
        $$('.tb', card)[0].textContent = `字段匹配（${ImportState.mapping.filter(Boolean).length} 列）`;
      }));

      // 数据预览
      const pv = h('<div style="overflow:auto;max-height:420px"></div>');
      const pt = h('<table class="pv-tbl"><thead></thead><tbody></tbody></table>');
      const keys = ImportState.mapping.filter(Boolean);
      $('thead', pt).appendChild(h('<tr>' + keys.map((k) => `<th>${esc(labelOf(k))}</th>`).join('') + '</tr>'));
      const pbody = $('tbody', pt);
      ImportState.preview.forEach((r) => {
        pbody.appendChild(h('<tr>' + keys.map((k) => `<td>${esc(r[k] == null ? '' : r[k])}</td>`).join('') + '</tr>'));
      });
      pv.appendChild(pt);
      $('#tp-pv', card).appendChild(pv);
      $('#tp-pv', card).appendChild(h(`<div class="muted" style="margin-top:8px;font-size:12px">仅显示前 ${ImportState.preview.length} 行，共 ${ImportState.total} 条将被处理。</div>`));

      // 异常
      const isb = $('#tp-is', card);
      if (!ImportState.issueCount) isb.appendChild(h('<div class="empty">未发现明显问题 ✓</div>'));
      else {
        const t2 = h('<table class="map-tbl"><thead><tr><th style="width:70px">行号</th><th style="width:70px">级别</th><th>说明</th></tr></thead><tbody></tbody></table>');
        const b2 = $('tbody', t2);
        ImportState.issues.slice(0, 200).forEach((x) => {
          b2.appendChild(h(`<tr><td class="muted">${x.row}</td>
            <td><span class="tag ${x.level === 'error' ? 'r' : x.level === 'warn' ? 'o' : 'n'}">${x.level === 'error' ? '错误' : x.level === 'warn' ? '提醒' : '提示'}</span></td>
            <td>${esc(x.msg)}</td></tr>`));
        });
        isb.appendChild(h('<div style="max-height:340px;overflow:auto"></div>')).appendChild(t2);
      }

      // 跳过行
      const skb = $('#tp-sk', card);
      if (!ImportState.skipped.length) skb.appendChild(h('<div class="empty">没有跳过的行</div>'));
      else {
        const t3 = h('<table class="map-tbl"><thead><tr><th style="width:70px">行号</th><th style="width:170px">原因</th><th>首列内容</th></tr></thead><tbody></tbody></table>');
        const b3 = $('tbody', t3);
        ImportState.skipped.forEach((x) => b3.appendChild(h(`<tr><td class="muted">${x.row}</td><td>${esc(x.reason)}</td><td class="muted">${esc(x.sample)}</td></tr>`)));
        skb.appendChild(h('<div style="max-height:340px;overflow:auto"></div>')).appendChild(t3);
      }
    }

    function hdrText(i) {
      const c = ImportState.cols && ImportState.cols[i];
      if (c && c.header) return c.header;
      return '（空表头）';
    }
    function sampleText(i) {
      const k = ImportState.mapping[i];
      const r = ImportState.preview[0];
      if (!k || !r) return '';
      return String(r[k] == null ? '' : r[k]).slice(0, 40);
    }
    function labelOf(k) {
      const f = ((Session.options || {}).fields || []).find((x) => x.key === k);
      return f ? f.label : k;
    }

    /* ---- 步骤三：确认导入 ---- */
    function renderStep3() {
      clear(box3);
      if (!ImportState.token) return;
      // 只能向有写权限的单位导入（下级单位只读）
      const units = ((Session.options || {}).units || []).filter((u) => Session.canWriteUnit(u));
      const defUnit = Session.canWriteUnit(Scope.unit) ? Scope.unit : (Session.myUnit() || '');
      const card = h(`<div class="card" style="margin-top:12px">
        <div class="card-h"><h3>③ 确认导入</h3></div>
        <div class="card-b">
          <div class="grid" style="grid-template-columns:1fr 1fr">
            <div class="field" style="margin:0">
              <label>导入模式</label>
              <select class="sel" id="im-mode">
                <option value="upsert">新增并更新（按资产编号去重，推荐）</option>
                <option value="insert">仅新增（编号已存在的跳过）</option>
                <option value="replace">清空当前数据后全部导入</option>
              </select>
            </div>
            <div class="field" style="margin:0">
              <label>默认所属单位（Excel 中未填写单位时套用）</label>
              <input class="inp" id="im-unit" list="im-units" value="${esc(defUnit)}" placeholder="留空则不设置">
              <datalist id="im-units">${units.map((u) => `<option value="${esc(u)}"></option>`).join('')}</datalist>
            </div>
          </div>
          <div class="muted" style="font-size:12px;margin-top:10px;line-height:1.7">
            去重依据：<b>资产编号</b>。编号为空的记录始终按新增处理。<br>
            「清空后导入」会删除当前${Session.user && Session.user.unit ? `单位（${esc(Session.user.unit)}）下` : '全部'}的资产数据，请谨慎操作。
          </div>
          <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
            <button class="btn pri lg" id="im-go">开始导入 ${ImportState.total} 条</button>
            <button class="btn" id="im-cancel">取消</button>
            <span id="im-res" style="font-size:12.5px"></span>
          </div>
        </div>
      </div>`);
      box3.appendChild(card);

      on($('#im-cancel', card), 'click', () => {
        ImportState.token = '';
        clear(box2); clear(box3);
        drop.innerHTML = '<div class="ic">⇪</div><div class="t">点击选择，或把 .xlsx 文件拖到这里</div><div class="s">自动识别表头行与字段，支持合并单元格、日期、公式结果值</div>';
      });

      on($('#im-go', card), 'click', async () => {
        const btn = $('#im-go', card);
        const res = $('#im-res', card);
        const mode = $('#im-mode', card).value;
        const unit = $('#im-unit', card).value.trim();
        if (mode === 'replace') {
          if (!await confirmDlg('「清空后导入」将删除现有数据后再导入，<b>此操作不可恢复</b>。确定继续吗？')) return;
        }
        btn.disabled = true;
        btn.textContent = '导入中…';
        res.className = 'muted';
        res.textContent = '正在写入数据库…';
        try {
          const r = await API.post('/api/import/commit', {
            token: ImportState.token, mode, unit, mapping: ImportState.mapping,
          });
          res.className = '';
          res.innerHTML = `<span style="color:var(--ok)">导入完成：新增 <b>${r.created}</b> 条，更新 <b>${r.updated}</b> 条，跳过 <b>${r.skipped}</b> 条。当前共 ${r.total} 条。</span>`;
          toast('导入完成', 'ok');
          btn.textContent = '已完成';
          await Session.loadOptions(true);
          $('#im-cancel', card).textContent = '导入其它文件';
        } catch (e) {
          res.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
          btn.disabled = false;
          btn.textContent = '重试导入';
        }
      });
    }
  },
};
