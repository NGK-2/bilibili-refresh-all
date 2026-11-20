// ==UserScript==
// @name         B站首页 换一换 刷新全部可见视频（带历史）
// @namespace    bilibili-refresh-all
// @version      2.0.0
// @description  接管首页“换一换”：一次刷新屏幕上所有可见视频卡片，并支持 ← → 回退/前进到之前换过的内容
// @match        https://www.bilibili.com/
// @match        https://www.bilibili.com/?*
// @match        https://www.bilibili.com/index.html*
// @match        https://www.bilibili.com/zh-Hans*
// @match        https://www.bilibili.com/zh-Hant*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @homepageURL  https://github.com/NGK-2/bilibili-refresh-all
// @supportURL   https://github.com/NGK-2/bilibili-refresh-all/issues
// @updateURL    https://raw.githubusercontent.com/NGK-2/bilibili-refresh-all/main/bilibili-refresh-all.user.js
// @downloadURL  https://raw.githubusercontent.com/NGK-2/bilibili-refresh-all/main/bilibili-refresh-all.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 配置 ----------
  // 刷新范围：顶部原生区域全部 + 卡片顶部位于「视口底部 + EXTRA_PX」以上的下方卡片
  const EXTRA_PX = 0;
  // 最多保留多少步历史
  const MAX_HISTORY = 30;
  // 未找到原生“换一换”按钮（例如未登录）时，是否显示悬浮按钮组
  const SHOW_FALLBACK_BUTTON = true;

  const LOG = (...a) => console.log('[刷新全部]', ...a);

  // ---------- MD5（用于 WBI 签名） ----------
  const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const MD5_T = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  function md5(str) {
    const msg = new TextEncoder().encode(str);
    const len = msg.length;
    const nWords = (((len + 8) >> 6) + 1) * 16;
    const w = new Uint32Array(nWords);
    for (let i = 0; i < len; i++) w[i >> 2] |= msg[i] << ((i % 4) * 8);
    w[len >> 2] |= 0x80 << ((len % 4) * 8);
    w[nWords - 2] = len * 8;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let blk = 0; blk < nWords; blk += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + MD5_T[i] + w[blk + g]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return [a0, b0, c0, d0].map(x => {
      let h = '';
      for (let j = 0; j < 4; j++) h += ((x >>> (j * 8)) & 255).toString(16).padStart(2, '0');
      return h;
    }).join('');
  }

  // ---------- WBI 签名 ----------
  const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
    60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  let mixinKeyPromise = null;
  function getMixinKey() {
    if (!mixinKeyPromise) {
      mixinKeyPromise = fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
        .then(r => r.json())
        .then(j => {
          const name = u => u.slice(u.lastIndexOf('/') + 1).split('.')[0];
          const raw = name(j.data.wbi_img.img_url) + name(j.data.wbi_img.sub_url);
          return MIXIN_TAB.map(i => raw[i]).join('').slice(0, 32);
        })
        .catch(e => { mixinKeyPromise = null; throw e; });
    }
    return mixinKeyPromise;
  }
  async function signWbi(params) {
    const key = await getMixinKey();
    const p = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(p).sort().map(k =>
      `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`
    ).join('&');
    return `${query}&w_rid=${md5(query + key)}`;
  }

  // ---------- 拉取推荐 ----------
  let freshIdx = 50 + Math.floor(Math.random() * 50);
  async function fetchRcmd(ps) {
    freshIdx++;
    const query = await signWbi({
      web_location: 1430650,
      y_num: 5,
      fresh_type: 4,
      feed_version: 'V8',
      fresh_idx_1h: freshIdx,
      fetch_row: 1,
      fresh_idx: freshIdx,
      brush: freshIdx,
      homepage_ver: 1,
      ps,
      last_y_num: 5,
      screen: `${innerWidth}-${innerHeight}`,
    });
    const r = await fetch(`https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?${query}`, { credentials: 'include' });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`rcmd 接口返回 ${j.code}: ${j.message}`);
    return (j.data.item || []).filter(it => it.goto === 'av' && it.bvid);
  }

  // ---------- 格式化 ----------
  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }
  function fmtDur(s) {
    s = Number(s) || 0;
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    const pad = x => String(x).padStart(2, '0');
    return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000), now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function coverUrl(pic) {
    return pic.replace(/^https?:/, '') + '@672w_378h_1c_!web-home-common-cover';
  }

  // ---------- DOM ----------
  const getContainer = () => document.querySelector('.container.is-version8') ||
    document.querySelector('.recommended-container_floor-aside .container');

  // 容器中可以作为“槽位”的原生元素（轮播图等不算）
  const SLOT_SEL = '.feed-card, .bili-feed-card, .floor-single-card, .bili-video-card';

  // 原生元素 -> 当前顶替它显示的自制卡片
  const shownCard = new WeakMap();
  // 自制卡片 -> 它顶替的原生元素
  const cardOrig = new WeakMap();

  const displayed = orig => shownCard.get(orig) || orig;

  function getTemplate(container) {
    const cards = container.querySelectorAll(':scope > :not(.brr-card) .bili-video-card');
    for (const c of cards) if (c.querySelector('h3 a') && c.querySelector('picture img')) return c;
    for (const c of container.querySelectorAll('.brr-card .bili-video-card')) return c;
    return null;
  }

  function buildCard(tpl, it) {
    const card = tpl.cloneNode(true);
    const url = `https://www.bilibili.com/video/${it.bvid}`;
    card.querySelectorAll('.bili-video-card__no-interest, .bili-video-card__info--no-interest, ' +
      '.bili-watch-later--wrap, .bili-video-card__info--icon-text, .bili-video-card__info--ad')
      .forEach(e => e.remove());
    card.querySelector('.v-inline-player')?.replaceChildren();
    card.querySelectorAll('a').forEach(a => {
      if (/\/video\//.test(a.getAttribute('href') || '')) a.href = url;
    });
    const cover = coverUrl(it.pic);
    card.querySelectorAll('picture source').forEach(s => {
      const type = s.getAttribute('type') || '';
      s.srcset = cover + (type.includes('avif') ? '.avif' : type.includes('webp') ? '.webp' : '');
    });
    const img = card.querySelector('picture img');
    if (img) {
      img.src = cover;
      img.alt = it.title;
    }
    const stats = card.querySelectorAll('.bili-video-card__stats--text');
    if (stats[0]) stats[0].textContent = fmtNum(it.stat?.view);
    if (stats[1]) stats[1].textContent = fmtNum(it.stat?.danmaku);
    const dur = card.querySelector('.bili-video-card__stats__duration');
    if (dur) dur.textContent = fmtDur(it.duration);
    const h3 = card.querySelector('h3');
    if (h3) {
      h3.title = it.title;
      const a = h3.querySelector('a');
      if (a) a.textContent = it.title;
    }
    const owner = card.querySelector('.bili-video-card__info--owner');
    if (owner) {
      owner.href = `//space.bilibili.com/${it.owner?.mid ?? ''}`;
      const au = owner.querySelector('.bili-video-card__info--author');
      if (au) { au.textContent = it.owner?.name ?? ''; au.title = it.owner?.name ?? ''; }
      const dt = owner.querySelector('.bili-video-card__info--date');
      if (dt) dt.textContent = '· ' + fmtDate(it.pubdate);
      const reason = it.rcmd_reason?.content || (it.is_followed ? '已关注' : '');
      if (reason) {
        const tag = document.createElement('div');
        tag.className = 'bili-video-card__info--icon-text';
        tag.textContent = reason;
        owner.before(tag);
      }
    }
    const wrap = document.createElement('div');
    wrap.className = 'bili-feed-card';
    wrap.appendChild(card);
    return wrap;
  }

  // 去掉卡片克隆里会触发页面回调的内联事件
  function sanitize(node) {
    node.querySelectorAll('img[onload], img[onerror]').forEach(img => {
      img.removeAttribute('onload');
      img.removeAttribute('onerror');
    });
    return node;
  }

  // 在某个原生槽位上显示 card；card 为 null 则恢复显示原生元素
  // 原生元素只隐藏、不改动，避免和 Vue 冲突
  function show(orig, card) {
    const cur = shownCard.get(orig);
    if (!card) {
      cur?.remove();
      shownCard.delete(orig);
      orig.style.display = '';
      return;
    }
    sanitize(card);
    card.classList.add('brr-card');
    cardOrig.set(card, orig);
    if (cur) cur.replaceWith(card); else orig.before(card);
    orig.style.display = 'none';
    shownCard.set(orig, card);
  }

  // 清理：原生元素已被 Vue 移除的自制卡片
  function cleanup(container) {
    container.querySelectorAll(':scope > .brr-card').forEach(card => {
      const orig = cardOrig.get(card);
      if (!orig || !orig.isConnected) card.remove();
    });
  }

  function getSlots(container) {
    const limit = innerHeight + EXTRA_PX;
    return [...container.children].filter(e => {
      if (e.classList.contains('brr-card') || !e.matches(SLOT_SEL)) return false;
      if (e.classList.contains('feed-card')) return true; // 顶部原生“换一换”区域，始终接管
      const r = displayed(e).getBoundingClientRect();
      return r.height > 0 && r.top < limit;
    });
  }

  function collectBvids(el, set) {
    el.querySelectorAll('a[href*="/video/BV"]').forEach(a => {
      const m = a.href.match(/BV\w{10}/);
      if (m) set.add(m[0]);
    });
  }

  // ---------- 历史 ----------
  // 每一步历史：[{ orig, node }]，node 为当时显示内容的克隆；null 表示显示原生元素
  let history = [];
  let pos = -1;

  const snapshot = slots => slots.map(orig => {
    const card = shownCard.get(orig);
    return { orig, node: card ? card.cloneNode(true) : null };
  });

  function mergeEntry(a, b) {
    const m = new Map(a.map(x => [x.orig, x]));
    b.forEach(x => m.set(x.orig, x));
    return [...m.values()];
  }

  function applyEntry(entry) {
    entry.forEach(({ orig, node }) => {
      if (orig.isConnected) show(orig, node ? node.cloneNode(true) : null);
    });
  }

  function go(delta) {
    if (busy) return;
    const n = pos + delta;
    if (n < 0 || n >= history.length) return;
    const c = getContainer();
    if (c) cleanup(c);
    pos = n;
    applyEntry(history[pos]);
    updateNav();
  }

  // ---------- 换一换 ----------
  let busy = false;
  async function refresh() {
    if (busy) return;
    const container = getContainer();
    if (!container) return;
    cleanup(container);
    const slots = getSlots(container);
    if (!slots.length) return;
    const tpl = getTemplate(container);
    if (!tpl) { LOG('找不到卡片模板'); return; }
    busy = true;
    updateNav();
    try {
      const seen = new Set();
      slots.forEach(o => collectBvids(displayed(o), seen));
      const items = [];
      for (let tries = 0; tries < 5 && items.length < slots.length; tries++) {
        for (const it of await fetchRcmd(Math.min(30, slots.length + 4))) {
          if (!seen.has(it.bvid)) { seen.add(it.bvid); items.push(it); }
        }
      }

      // 记录换之前的状态（与当前历史合并，覆盖本次涉及的槽位）
      const before = snapshot(slots);
      if (pos < 0) { history = [before]; pos = 0; }
      else { history.splice(pos + 1); history[pos] = mergeEntry(history[pos], before); }

      slots.forEach((slot, i) => { if (items[i]) show(slot, buildCard(tpl, items[i])); });

      history.push(snapshot(slots));
      pos = history.length - 1;
      while (history.length > MAX_HISTORY) { history.shift(); pos--; }
      LOG(`已刷新 ${Math.min(items.length, slots.length)}/${slots.length} 张卡片，历史 ${pos + 1}/${history.length}`);
    } catch (e) {
      console.error('[刷新全部] 刷新失败', e);
    } finally {
      busy = false;
      updateNav();
    }
  }

  // ---------- UI ----------
  const style = document.createElement('style');
  style.textContent = `
    .brr-nav { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; align-items: stretch; box-sizing: border-box; }
    .brr-nav button { width: 100%; box-sizing: border-box; }
    .brr-nav button, .brr-float button {
      height: 32px; min-width: 32px; padding: 0 8px; border-radius: 8px; cursor: pointer; font-size: 14px;
      border: 1px solid var(--line_regular, #e3e5e7); background: var(--bg1_float, #fff); color: var(--text1, #18191c);
    }
    .brr-nav button:hover:not(:disabled), .brr-float button:hover:not(:disabled) { background: var(--graph_bg_thick, #f1f2f3); }
    .brr-nav button:disabled, .brr-float button:disabled { opacity: .35; cursor: default; }
    .brr-float { position: fixed; right: 16px; bottom: 96px; z-index: 9999; display: flex; gap: 6px; }
    .brr-busy svg { animation: brr-spin .6s linear infinite; }
    @keyframes brr-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);

  let navBox = null, backBtn = null, fwdBtn = null;

  function makeButtons(withRefresh) {
    const box = document.createElement('div');
    const mk = (text, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };
    backBtn = mk('←', '回退到上一次换一换', () => go(-1));
    fwdBtn = mk('→', '前进', () => go(1));
    box.append(backBtn);
    if (withRefresh) box.append(mk('换一换', '刷新所有可见视频', refresh));
    box.append(fwdBtn);
    return box;
  }

  function updateNav() {
    if (!backBtn) return;
    backBtn.disabled = busy || pos <= 0;
    fwdBtn.disabled = busy || pos >= history.length - 1;
    const tip = history.length ? `（${pos + 1}/${history.length}）` : '';
    backBtn.title = '回退到上一次换一换' + tip;
    fwdBtn.title = '前进' + tip;
    document.querySelectorAll('.roll-btn').forEach(b => b.classList.toggle('brr-busy', busy));
  }

  const startedAt = Date.now();
  function ensureUI() {
    if (navBox?.isConnected) return;
    const roll = document.querySelector('.feed-roll-btn .roll-btn') || document.querySelector('.roll-btn');
    if (roll) {
      document.querySelector('.brr-float')?.remove();
      navBox = makeButtons(false);
      navBox.className = 'brr-nav';
      // 和原生“换一换”按钮同宽
      if (roll.offsetWidth) navBox.style.width = roll.offsetWidth + 'px';
      roll.after(navBox);
    } else if (SHOW_FALLBACK_BUTTON && getContainer() && Date.now() - startedAt > 4000) {
      navBox = makeButtons(true);
      navBox.className = 'brr-float';
      document.body.appendChild(navBox);
    } else {
      return;
    }
    updateNav();
  }
  setInterval(ensureUI, 1000);
  ensureUI();

  // 接管原生“换一换”：捕获阶段拦截，阻止原生只刷新前几行
  document.addEventListener('click', e => {
    const t = e.target;
    if (!t.closest || t.closest('.brr-nav, .brr-float')) return;
    if (!t.closest('.roll-btn, .feed-roll-btn')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    refresh();
  }, true);

  // 方便在控制台调试
  window.__brrRefresh = refresh;
  window.__brrGo = go;
})();
