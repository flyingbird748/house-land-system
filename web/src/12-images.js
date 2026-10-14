'use strict';
/* ============================================================
 *  Img —— 房产图片：上传 / 删除 / 改标签 / 缩略图 / 大图查看
 *  规则：每条资产最多 MAX_COUNT 张，单张 ≤ MAX_SIZE（前端预检 + 后端把关）
 * ============================================================ */

const Img = {
  MAX_COUNT: 3,
  MAX_SIZE: 2 * 1024 * 1024,
  LABELS: ['正面', '侧面', '室内', '其他'],
  ACCEPT: '.jpg,.jpeg,.png,.gif,.webp,image/jpeg,image/png,image/gif,image/webp',

  /** 图片直链：<img src> 无法带 Authorization 头，用短期令牌走查询串 */
  url(assetId, imageId) {
    return `${API.base}/api/assets/${encodeURIComponent(assetId)}/images/${encodeURIComponent(imageId)}/raw?token=${encodeURIComponent(Session.token || '')}`;
  },

  sizeText(n) { return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB'; },

  /**
   * 读取本地文件 → 必要时压缩 → 上传。
   * 原图 ≤ 2MB 时原样直传（不重编码，保留画质）；超出才按长边 1920 压到 JPEG，
   * 压完仍超 2MB 直接拒绝。
   */
  async upload(assetId, file, label) {
    const name = file.name || '图片';
    const okType = /^image\/(jpeg|png|gif|webp)$/i.test(file.type || '') || /\.(jpe?g|png|gif|webp)$/i.test(name);
    if (!okType) throw new Error('仅支持 JPG / PNG / GIF / WebP 格式的图片');
    if (file.size > this.MAX_SIZE * 4) throw new Error(`「${name}」过大（${this.sizeText(file.size)}），请先压缩后再上传`);

    let blob = file;
    let dim = { w: 0, h: 0 };
    if (file.size > this.MAX_SIZE) {
      const packed = await Img.downscale(file, 1920, 0.85);
      blob = packed.blob;
      dim = { w: packed.w, h: packed.h };
      if (blob.size > this.MAX_SIZE) throw new Error(`「${name}」压缩后仍有 ${this.sizeText(blob.size)}，超过单张 2MB 上限`);
    }
    const data = await Img.readDataURL(blob);
    return API.post('/api/assets/' + assetId + '/images', {
      name, label: label || '其他', data,
      w: dim.w || undefined, h: dim.h || undefined,
    });
  },

  readDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('读取本地文件失败'));
      fr.readAsDataURL(blob);
    });
  },

  /** canvas 降采样（零依赖方案）：返回新的 Blob 与尺寸 */
  downscale(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          const w0 = image.naturalWidth || 0, h0 = image.naturalHeight || 0;
          const scale = Math.min(1, maxSide / Math.max(w0, h0 || 1));
          const w = Math.max(1, Math.round(w0 * scale));
          const h = Math.max(1, Math.round(h0 * scale));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(image, 0, 0, w, h);
          URL.revokeObjectURL(url);
          const done = (b) => b ? resolve({ blob: b, w, h }) : reject(new Error('图片压缩失败'));
          if (cv.toBlob) cv.toBlob(done, 'image/jpeg', quality);
          else done(Img.dataUrlToBlob(cv.toDataURL('image/jpeg', quality)));
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法解析该图片文件')); };
      image.src = url;
    });
  },

  dataUrlToBlob(dataUrl) {
    const parts = String(dataUrl).split(',');
    const bin = atob(parts[1] || '');
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: 'image/jpeg' });
  },

  /* ---------------------- 编辑界面的图片区 ---------------------- */

  /**
   * 渲染编辑用图片墙。
   * @param {HTMLElement} box 容器
   * @param {string} assetId 资产 id（为空表示尚未保存）
   * @param {Array}  images 已上传图片
   * @param {Function} onChange 变化后回调（拿到最新列表）
   */
  gallery(box, assetId, images, onChange, opts) {
    const ro = !!(opts && opts.readonly);
    clear(box);
    const list = (images || []).slice(0, Img.MAX_COUNT);
    const canEdit = !!assetId && Session.can('write') && !ro;

    const head = h(`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="font-weight:600;font-size:12.5px">房产图片</div>
      <span class="muted" style="font-size:11.5px">最多 ${Img.MAX_COUNT} 张，单张 ≤ 2MB（正面 / 侧面 / 室内）</span>
      <div class="spacer"></div>
      <span class="muted" style="font-size:11.5px">${list.length} / ${Img.MAX_COUNT}</span>
    </div>`);
    box.appendChild(head);

    const grid = h('<div class="img-grid"></div>');
    box.appendChild(grid);

    if (!assetId) {
      grid.appendChild(h('<div class="img-add disabled">请先保存资产后再上传图片</div>'));
      return;
    }

    if (!list.length) {
      // 只读模式且无图片：给出明确说明，避免出现「空白区域」的错觉
      grid.appendChild(h(`<div class="img-add disabled">${ro ? '暂无图片' : '暂未上传图片'}</div>`));
      if (!canEdit) return;
    }

    const file = h(`<input type="file" accept="${Img.ACCEPT}" style="display:none">`);
    file.multiple = false;
    box.appendChild(file);

    const pickThenUpload = () => {
      if (list.length >= Img.MAX_COUNT) { toast(`最多只能上传 ${Img.MAX_COUNT} 张图片`, 'err'); return; }
      file.click();
    };
    on(file, 'change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      // 默认标签按顺序补位：正面 → 侧面 → 室内 → 其他
      const used = list.map((x) => x.label);
      const label = Img.LABELS.find((l) => used.indexOf(l) < 0) || '其他';
      try {
        const r = await Img.upload(assetId, f, label);
        toast('图片已上传', 'ok');
        onChange && onChange(r.images || []);
      } catch (e) { toast(e.message, 'err'); }
    });

    const addSlot = () => {
      const add = h('<div class="img-add" title="点击上传图片（≤2MB）">＋ 上传图片</div>');
      on(add, 'click', pickThenUpload);
      grid.appendChild(add);
      return add;
    };

    if (!list.length) {
      // 一张都没有时就给一个可用的上传格子，不再额外放「暂未上传图片」占位（避免两个格子）
      if (canEdit) addSlot();
      else grid.appendChild(h('<div class="img-add disabled">暂无图片</div>'));
      return;
    }

    list.forEach((img) => {
      const cell = h(`<div class="img-cell">
        <div class="img-thumb"><img src="${Img.url(assetId, img.id)}" alt="${esc(img.label || '图片')}"></div>
        <select class="sel sm img-label">${Img.LABELS.map((l) => `<option value="${esc(l)}" ${img.label === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <div class="img-meta" title="${esc(img.name || '')}">${esc(fmt.cut(img.name || '图片', 14))} · ${Img.sizeText(img.size)}</div>
        <div class="img-ops">
          <button class="btn sm img-view">查看</button>
          ${canEdit ? '<button class="btn sm danger img-del">删除</button>' : ''}
        </div>
      </div>`);
      on($('.img-thumb img', cell), 'click', () => Img.lightbox(assetId, list, img.id));
      on($('.img-view', cell), 'click', () => Img.lightbox(assetId, list, img.id));
      if (canEdit) {
        on($('.img-del', cell), 'click', async () => {
          confirmDlg(`确定删除这张「${esc(img.label || '图片')}」吗？`).then(async (yes) => {
            if (!yes) return;
            try {
              await API.del('/api/assets/' + assetId + '/images/' + img.id);
              toast('图片已删除', 'ok');
              onChange && onChange((await API.get('/api/assets/' + assetId + '/images')).images || []);
            } catch (e) { toast(e.message, 'err'); }
          });
        });
        on($('.img-label', cell), 'change', async () => {
          const v = $('.img-label', cell).value;
          try {
            await API.put('/api/assets/' + assetId + '/images/' + img.id, { label: v });
            toast('已更新图片标签', 'ok');
          } catch (e) { toast(e.message, 'err'); onChange && onChange(list); }
        });
      } else {
        $('.img-label', cell).disabled = true;
      }
      grid.appendChild(cell);
    });

    if (list.length < Img.MAX_COUNT && canEdit) addSlot();
  },

  /* ---------------------- 只读查看 / 悬停缩略图 ---------------------- */

  /** 浮卡里的缩略图条 */
  thumbRow(assetId, images) {
    const list = (images || []).slice(0, Img.MAX_COUNT);
    if (!list.length) return '';
    const picks = list.length === 1
      ? list
      : (Img.LABELS.map((l) => list.find((x) => x.label === l)).filter(Boolean).concat(list.filter((x) => Img.LABELS.indexOf(x.label) < 0))).slice(0, 3);
    // 浮卡是悬停才渲染的，这里不能用 loading=lazy，否则第一帧会是空白
    return `<div class="pv-imgs">${picks.map((im) => `<span class="pv-img"><img src="${Img.url(assetId, im.id)}" alt="${esc(im.label || '图片')}"><b>${esc(im.label || '图片')}</b></span>`).join('')}</div>`;
  },

  /** 大图查看（左右翻页） */
  lightbox(assetId, images, startId) {
    const list = (images || []).slice(0, Img.MAX_COUNT);
    let i = Math.max(0, list.findIndex((x) => x.id === startId));
    const stage = h('<div class="lb-stage"><img alt="房产图片"></div>');
    const cap = h('<div class="lb-cap"></div>');
    const body = h('<div></div>');
    body.appendChild(stage);
    body.appendChild(cap);

    const paint = () => {
      const im = list[i];
      if (!im) return;
      $('img', stage).src = Img.url(assetId, im.id);
      cap.innerHTML = `<span class="tag n">${esc(im.label || '图片')}</span>
        <span class="muted" style="margin-left:8px">${esc(im.name || '')}</span>
        <span class="muted" style="margin-left:8px">${Img.sizeText(im.size)}${im.w && im.h ? ` · ${im.w}×${im.h}` : ''}</span>
        <span class="muted" style="margin-left:8px">${i + 1} / ${list.length}</span>`;
    };
    paint();
    const buttons = [{ text: '关闭' }];
    if (list.length > 1) {
      buttons.unshift({ text: '上一张', onClick: () => { i = (i - 1 + list.length) % list.length; paint(); } });
      buttons.unshift({ text: '下一张', cls: 'pri', onClick: () => { i = (i + 1) % list.length; paint(); } });
    }
    const dlg = modal({ title: '房产图片', size: 'wide', bodyNode: body, buttons });
    return dlg;
  },
};
