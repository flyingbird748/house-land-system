'use strict';
/* ============================================================
 *  form —— 资产新增 / 编辑 / 详情
 * ============================================================ */

const AssetForm = {
  create(done) { this.open(null, done); },
  edit(asset, done) { this.open(asset, done); },

  open(asset, done) {
    const isNew = !asset;
    // 下级单位只读：编辑入口只对本单位（或系统管理员）开放
    if (!isNew && !Session.canWriteAsset(asset)) { this.view(asset); return; }
    const opts = Session.options || { fields: [], groups: [] };
    const fields = opts.fields;
    const groups = opts.groups;

    const body = h('<div></div>');
    const tabs = h('<div class="tabs"></div>');
    const panes = h('<div style="padding:16px 18px"></div>');
    body.appendChild(tabs);
    body.appendChild(panes);

    groups.forEach((g, gi) => {
      const gf = fields.filter((f) => f.group === g.key);
      if (!gf.length) return;
      const tb = h(`<div class="tb ${gi === 0 ? 'on' : ''}" data-g="${g.key}">${esc(g.label)}</div>`);
      tabs.appendChild(tb);
      const pane = h(`<div class="pane" data-g="${g.key}" style="${gi === 0 ? '' : 'display:none'}"></div>`);
      pane.appendChild(h(`<div class="sec-title">${esc(g.label)}</div>`));
      const grid = h('<div class="form-grid"></div>');

      gf.forEach((f) => {
        const isGeo = f.key === 'lng' || f.key === 'lat';
        // 新建时「所属单位」默认取左侧单位树当前选中的单位；选中只读的下级单位时回退到本单位
        const newUnit = Session.canWriteUnit(Scope.unit) ? Scope.unit : (Session.myUnit() || '');
        const val = asset ? asset[f.key] : (f.key === 'unit' ? newUnit : '');
        const cls = (f.type === 'textarea' || f.key === 'location') ? 'col-2' : '';
        const box = h(`<div class="field ${cls}"><label>${esc(f.label)}${f.required ? ' <span style="color:var(--danger)">*</span>' : ''}${f.unit ? ` <span class="unit">(${esc(f.unit)})</span>` : ''}</label></div>`);

        let input;
        if (f.type === 'enum') {
          input = h('<select class="sel"></select>');
          input.appendChild(h('<option value="">— 请选择 —</option>'));
          const list = (f.options || []).slice();
          if (val && list.indexOf(String(val)) < 0) list.push(String(val));
          list.forEach((o) => input.appendChild(h(`<option value="${esc(o)}" ${String(val) === String(o) ? 'selected' : ''}>${esc(o)}</option>`)));
        } else if (f.type === 'textarea') {
          input = h('<textarea class="ta"></textarea>');
          input.value = val == null ? '' : val;
        } else if (f.type === 'date') {
          input = h('<input class="inp" type="date">');
          input.value = val ? String(val).slice(0, 10) : '';
        } else if (f.type === 'number') {
          input = h(`<input class="inp" type="number" step="${f.key === 'lng' || f.key === 'lat' ? '0.000001' : 'any'}" ${isGeo ? 'placeholder="由地图标注写入"' : ''}>`);
          input.value = val == null ? '' : val;
        } else {
          input = h('<input class="inp">');
          input.value = val == null ? '' : val;
        }
        input.dataset.k = f.key;
        input.classList.add('fd');
        box.appendChild(input);
        grid.appendChild(box);
      });

      pane.appendChild(grid);

      if (g.key === 'geo') {
        const has = asset && Number.isFinite(asset.lng) && Number.isFinite(asset.lat);
        const extra = h(`<div style="margin-top:6px;padding:12px;border:1px dashed var(--line);border-radius:6px;background:var(--panel-2)">
          <div style="font-size:12.5px;margin-bottom:8px">
            当前标注状态：${has
              ? `<span class="tag g">已标注</span> <span class="muted">${asset.lng}, ${asset.lat}</span> ${asset.geoAddress ? '· ' + esc(asset.geoAddress) : ''}${asset.geoBy ? ' · 由 ' + esc(asset.geoBy) + ' 于 ' + esc(fmt.rel(asset.geoAt)) : ''}`
              : '<span class="tag n">未标注</span>'}
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" id="f-goto-map" ${isNew ? 'disabled' : ''}>在地图上标注</button>
            <button class="btn" id="f-clear-geo" ${has ? '' : 'disabled'}>清除坐标</button>
          </div>
          <div class="muted" style="font-size:11.5px;margin-top:7px">提示：坐标采用 GCJ-02（火星坐标），由腾讯地图拾取，请勿手工填写其它坐标系数值。</div>
        </div>`);
        pane.appendChild(extra);
      }

      panes.appendChild(pane);
    });

    $$('.tb', tabs).forEach((t) => on(t, 'click', () => {
      $$('.tb', tabs).forEach((x) => x.classList.toggle('on', x === t));
      $$('.pane', panes).forEach((p) => { p.style.display = p.dataset.g === t.dataset.g ? '' : 'none'; });
    }));

    // 房产图片：在编辑界面上传（最多 3 张 / 单张 ≤ 2MB），详见 Img 模块
    const imgBox = h('<div class="img-box"></div>');
    body.appendChild(imgBox);
    if (isNew) {
      Img.gallery(imgBox, '', [], null); // 未保存的资产还没有 id，提示先保存
    } else {
      Img.gallery(imgBox, asset.id, [], null); // 先出骨架，图片异步到位后重画
      const refresh = (imgs) => Img.gallery(imgBox, asset.id, imgs, refresh);
      API.get('/api/assets/' + asset.id + '/images')
        .then((r) => refresh(r.images || []))
        .catch(() => {});
    }

    const errBox = h('<div style="color:var(--danger);font-size:12px;min-height:16px"></div>');

    const collect = () => {
      const out = {};
      $$('.fd', body).forEach((i) => {
        const k = i.dataset.k;
        let v = i.value;
        if (v === '') { out[k] = null; return; }
        const f = fields.find((x) => x.key === k);
        if (f && f.type === 'number') v = Number(v);
        out[k] = v;
      });
      return out;
    };

    const buttons = [];
    buttons.push({ text: '取消' });
    if (!isNew && Session.can('geo')) {
      buttons.push({
        text: '保存并去地图标注', onClick: async (close) => {
          const id = await save(close, false);
          if (id) { location.hash = '#/map'; setTimeout(() => MapPage.focus(id), 260); }
        },
      });
    }
    if (Session.can('write')) {
      buttons.push({ text: isNew ? '创建' : '保存', cls: 'pri', onClick: (close) => save(close, true) });
    }

    // 所属单位下拉：只能选到有写权限的单位（系统管理员不受限）
    const unitInput = $$('.fd', body).find((i) => i.dataset.k === 'unit');
    if (unitInput && !Session.canWriteUnit(unitInput.value || '')) {
      unitInput.disabled = true;
      unitInput.title = '当前单位不可修改（下级单位只读）';
    }

    const dlg = modal({
      title: isNew ? '新增房屋土地资产' : `编辑：${asset.name || asset.id}`,
      size: 'full',
      bodyNode: body,
      buttons,
      maskClose: false,
    });
    $('.dlg-b', dlg.mask).appendChild(errBox);

    on($('#f-goto-map', body), 'click', () => {
      if (isNew) return;
      dlg.close();
      location.hash = '#/map';
      setTimeout(() => MapPage.focus(asset.id), 260);
    });
    on($('#f-clear-geo', body), 'click', async () => {
      try {
        await API.put('/api/assets/' + asset.id + '/geo', { lng: null, lat: null });
        toast('已清除坐标', 'ok');
        dlg.close();
        done && done();
      } catch (e) { toast(e.message, 'err'); }
    });

    async function save(close, closeAfter) {
      errBox.textContent = '';
      const data = collect();
      if (data.name === null || data.name === undefined || !String(data.name).trim()) {
        errBox.textContent = '资产名称不能为空';
        $$('.tb', tabs)[0].click();
        return null;
      }
      try {
        const r = isNew ? await API.post('/api/assets', data) : await API.put('/api/assets/' + asset.id, data);
        toast(isNew ? '已创建资产' : '已保存修改', 'ok');
        if (closeAfter) close();
        done && done();
        return r.asset.id;
      } catch (e) {
        errBox.textContent = e.message;
        return null;
      }
    }
  },

  /** 只读详情（onClose 可选：弹窗关闭后的回调） */
  view(asset, onClose) {
    const opts = Session.options || { fields: [], groups: [] };
    const body = h('<div></div>');

    // 房产图片：详情里以只读缩略图墙呈现（点开看大图）
    const imgBox = h('<div class="img-box"></div>');
    body.appendChild(imgBox);
    Img.gallery(imgBox, asset.id, [], null, { readonly: true });
    API.get('/api/assets/' + asset.id + '/images')
      .then((r) => Img.gallery(imgBox, asset.id, r.images || [], null, { readonly: true }))
      .catch(() => {});

    opts.groups.forEach((g) => {
      const gf = opts.fields.filter((f) => f.group === g.key && (asset[f.key] !== null && asset[f.key] !== undefined && asset[f.key] !== ''));
      if (!gf.length) return;
      body.appendChild(h(`<div class="sec-title">${esc(g.label)}</div>`));
      const grid = h('<div class="form-grid" style="margin-bottom:16px"></div>');
      gf.forEach((f) => {
        let v = asset[f.key];
        if (f.type === 'number') v = fmt.n(v);
        else if (f.key === 'originalValue' || f.key === 'rentIncome' || f.key === 'leaseRent' || f.key === 'overhaulAmount') v = fmt.moneyPlain(v) + ' 元';
        grid.appendChild(h(`<div><div class="muted" style="font-size:11.5px">${esc(f.label)}</div>
          <div style="font-size:13px;margin-top:2px;line-height:1.5">${esc(v)}</div></div>`));
      });
      body.appendChild(grid);
    });
    if (Number.isFinite(asset.lng) && Number.isFinite(asset.lat)) {
      body.appendChild(h(`<div class="sec-title">地图标注</div>
        <div style="font-size:13px">坐标 ${asset.lng}, ${asset.lat}（GCJ-02）${asset.geoAddress ? ' · ' + esc(asset.geoAddress) : ''}</div>`));
    }
    body.appendChild(h(`<div class="muted" style="font-size:11.5px;margin-top:14px">
      创建：${esc(asset.createdBy || '-')} ${esc(asset.createdAt ? asset.createdAt.slice(0, 16).replace('T', ' ') : '')} ｜
      最后修改：${esc(asset.updatedBy || '-')} ${esc(asset.updatedAt ? asset.updatedAt.slice(0, 16).replace('T', ' ') : '')}
    </div>`));

    const writable = Session.can('write') && Session.canWriteAsset(asset);
    modal({
      title: asset.name || '资产详情',
      size: 'wide',
      bodyNode: body,
      onClose,
      buttons: [
        { text: '关闭' },
        Session.can('geo') ? { text: '在地图上查看', onClick: (c) => { c(); location.hash = '#/map'; setTimeout(() => MapPage.focus(asset.id), 260); } } : null,
        writable ? { text: '编辑', cls: 'pri', onClick: (c) => { c(); AssetForm.edit(asset); } } : null,
      ].filter(Boolean),
    });
  },
};
