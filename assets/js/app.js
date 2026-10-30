/* ============================================================
   SecNotes — 前端应用
   数据来源：data/notes.js（由 build.py 生成）
   ============================================================ */
(function () {
  'use strict';

  var DB = window.SEC_BLOG || { config: {}, notes: [], categories: [], tags: [], stats: {} };
  var NOTES = DB.notes || [];
  var BACKLINKS = DB.backlinks || {};   // slug -> [引用它的 slug]
  var BROKEN = DB.broken || {};         // slug -> [尚未创建的链接标题]

  var CONFIG = Object.assign({
    title: 'SecNotes',
    subtitle: '网络安全知识笔记',
    description: '个人网络安全学习与实战笔记库',
    author: '',
    footer: '',
    defaultTheme: 'dark',
    pageSize: 8,
    siteUrl: ''
  }, DB.config || {});

  /* ------------------------------------------------------------
     状态
     ------------------------------------------------------------ */
  /* 本地文件（file://）协议下部分浏览器禁止访问 localStorage，
     统一包一层安全读写，避免整站因异常中断 */
  var store = {
    get: function (k) {
      try { return window.localStorage.getItem(k); } catch (e) { return null; }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(k, v); } catch (e) { /* 忽略：无痕模式或 file:// 限制 */ }
    }
  };

  var state = {
    q: '',
    theme: store.get('sec-theme') || CONFIG.defaultTheme || 'dark',
    observer: null,
    shown: 0,         // 首页当前已展示的笔记条数（分页用）
    /* 目录树与归档的展开记忆：用户手动切换优先于「当前路由自动展开」 */
    openCats: {},
    openSubs: {},
    openMonths: {}
  };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* 动态加载的脚本沿用 app.js 自己的版本号，改版本只需改 index.html */
  var ASSET_V = (function () {
    var cur = document.currentScript;
    var m = cur && cur.src ? cur.src.match(/\?v=[\w.-]+/) : null;
    return m ? m[0] : '';
  })();

  /* ------------------------------------------------------------
     工具函数
     ------------------------------------------------------------ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 关键词高亮统一由 assets/js/render.js 的 SecRender.highlight 提供 */
  function hl(text, q) {
    if (window.SecRender && SecRender.highlight) return SecRender.highlight(text, q);
    return esc(text);
  }

  function searchTerms(q) {
    return q.trim().toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; });
  }

  /* 计分检索：命中标题权重最高，其次标签/分类，最后正文 */
  function matchNote(note, terms) {
    if (!terms.length) return { hit: true, score: 0 };
    var title = note.title.toLowerCase();
    var cat = (note.category || '').toLowerCase();
    var tags = (note.tags || []).join(' ').toLowerCase();
    var summary = (note.summary || '').toLowerCase();
    var body = (note.body || '').toLowerCase();
    var score = 0;

    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var s = 0;
      if (title.indexOf(t) > -1) s += 60;
      if (tags.indexOf(t) > -1) s += 30;
      if (cat.indexOf(t) > -1) s += 20;
      if (summary.indexOf(t) > -1) s += 10;
      if (body.indexOf(t) > -1) s += 4;
      if (s === 0) return { hit: false, score: 0 };
      score += s;
    }
    return { hit: true, score: score };
  }

  function fmtNum(n) { return Number(n || 0).toLocaleString('zh-CN'); }

  /* ------------------------------------------------------------
     Markdown 渲染器按需加载
     marked + highlight + render 合计约 177KB，只有文章页用得到。
     首页 / 归档 / 标签只在首次进入文章时才下载，省掉首屏这块开销。
     ------------------------------------------------------------ */
  var vendor = { state: 0, queue: [], hlLoading: false };   // 0 未开始 / 1 加载中 / 2 就绪 / -1 失败

  function loadVendor(done) {
    if (window.SecRender) { vendor.state = 2; done(); return; }
    if (vendor.state === 2 || vendor.state === -1) { done(); return; }

    vendor.queue.push(done);
    if (vendor.state === 1) return;
    vendor.state = 1;

    /* 只等「能渲染」的两件：marked 与 render.js。
       highlight 体积最大（120KB），放到首屏之后单独解析。 */
    var files = [
      'assets/vendor/marked.min.js',
      'assets/js/render.js'
    ];
    var i = 0;

    (function next() {
      if (i >= files.length) {
        if (window.SecRender && SecRender.setNoteIndex) SecRender.setNoteIndex(NOTES);
        vendor.state = window.SecRender ? 2 : -1;
        var q = vendor.queue.slice();
        vendor.queue.length = 0;
        for (var k = 0; k < q.length; k++) q[k]();
        loadHighlight();
        return;
      }
      var s = document.createElement('script');
      s.src = files[i++] + ASSET_V;
      s.onload = next;
      s.onerror = next;      // 任一失败继续走完，最终由 render 的降级分支兜底
      document.head.appendChild(s);
    })();
  }

  /* 语法高亮延后加载：代码块先以纯文本呈现，highlight 到位后再就地着色 */
  function loadHighlight() {
    if (window.hljs || vendor.hlLoading) return;
    vendor.hlLoading = true;
    var s = document.createElement('script');
    s.src = 'assets/vendor/highlight.min.js' + ASSET_V;
    s.onload = function () { vendor.hlLoading = false; applyHighlight(); };
    s.onerror = function () { vendor.hlLoading = false; };
    document.head.appendChild(s);
  }

  function applyHighlight() {
    if (!window.hljs || !hljs.highlightElement) return;
    var blocks = document.querySelectorAll('#postBody .code-block pre code');
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      if (el.dataset && el.dataset.highlighted === 'yes') continue;
      var m = (el.className || '').match(/language-([\w+#.-]+)/i);
      if (!m) continue;
      var lang = m[1].toLowerCase();
      if (!hljs.getLanguage(lang)) continue;
      try { hljs.highlightElement(el); } catch (e) { /* 单个块失败不影响其他 */ }
    }
  }

  function findNote(slug) {
    for (var i = 0; i < NOTES.length; i++) { if (NOTES[i].slug === slug) return NOTES[i]; }
    return null;
  }

  function fmtDate(d) {
    var p = String(d || '').split('-');
    return p.length === 3 ? p[0] + '-' + p[1] + '-' + p[2] : String(d || '');
  }

  function longDate(d) {
    var p = String(d || '').split('-');
    if (p.length !== 3) return String(d || '');
    return p[0] + ' 年 ' + parseInt(p[1], 10) + ' 月 ' + parseInt(p[2], 10) + ' 日';
  }

  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  function reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ------------------------------------------------------------
     路由
     ------------------------------------------------------------ */
  function parseRoute() {
    var raw = location.hash.replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean).map(function (p) {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    if (!parts.length) return { name: 'home' };
    var head = parts[0];
    if (head === 'note') return { name: 'note', slug: parts.slice(1).join('/') };
    /* 笔记库是独立视图：首页只放舞台与精选，全量列表在 #/notes。
       分类 / 标签筛选属于「库」而不是「首页」，因此都归到 notes。 */
    if (head === 'notes') return { name: 'notes' };
    if (head === 'category') return { name: 'notes', category: parts.slice(1).join('/') };
    if (head === 'tag') return { name: 'notes', tag: parts.slice(1).join('/') };
    if (head === 'archive' || head === 'tags' ) return { name: head };
    return { name: 'home' };
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  /* ------------------------------------------------------------
     库内翻页（顶栏 ‹ ›）
     只在「笔记库上下文」里维护一条访问轨迹：笔记库 / 分类 / 标签 /
     归档 / 文章。轨迹的起点就是用户进入时的页面，最多退到 #/notes，
     永远不含站点首页——这是需求里「不能返回首页」的落点。
     ------------------------------------------------------------ */
  var trail = { list: [], i: -1 };

  function isLibRoute(r) {
    return r.name === 'notes' || r.name === 'note' ||
      r.name === 'archive' || r.name === 'tags';
  }

  function recordTrail(r) {
    if (!isLibRoute(r)) { trail.list = []; trail.i = -1; return; }
    var h = location.hash || '#/';
    if (trail.list[trail.i] === h) return;
    trail.list = trail.list.slice(0, trail.i + 1);
    trail.list.push(h);
    trail.i = trail.list.length - 1;
  }

  function pagerStep(dir) {
    if (!trail.list.length) return;
    var next = trail.i + dir;
    if (next < 0) {
      /* 退到头就停在笔记库，不回到首页 */
      if (location.hash !== '#/notes') location.hash = '#/notes';
      else render();
      return;
    }
    if (next > trail.list.length - 1) return;
    trail.i = next;
    var h = trail.list[next];
    if (h === (location.hash || '#/')) render();
    else location.hash = h;
  }

  function syncPager(r) {
    var box = $('#navPager');
    if (!box) return;
    var lib = isLibRoute(r);
    box.hidden = !lib;
    if (!lib) return;
    var prev = $('#npPrev');
    var next = $('#npNext');
    if (prev) prev.disabled = trail.i <= 0 && location.hash === '#/notes';
    if (next) next.disabled = trail.i >= trail.list.length - 1;
  }

  function bindPager() {
    var prev = $('#npPrev');
    var next = $('#npNext');
    if (prev) prev.addEventListener('click', function () { pagerStep(-1); });
    if (next) next.addEventListener('click', function () { pagerStep(1); });
  }

  /* ------------------------------------------------------------
     过滤与排序
     ------------------------------------------------------------ */
  function filtered(route) {
    var terms = searchTerms(state.q);
    var list = NOTES.slice();

    if (route.category) list = list.filter(function (n) { return n.category === route.category; });
    if (route.tag) list = list.filter(function (n) { return (n.tags || []).indexOf(route.tag) > -1; });

    var matched = [];
    for (var i = 0; i < list.length; i++) {
      var r = matchNote(list[i], terms);
      if (r.hit) { matched.push({ note: list[i], score: r.score }); }
    }
    if (terms.length) {
      matched.sort(function (a, b) { return b.score - a.score; });
      return matched.map(function (m) { return m.note; });
    }
    return list.sort(function (a, b) {
      return a.date === b.date ? a.title.localeCompare(b.title, 'zh') : (a.date < b.date ? 1 : -1);
    });
  }

  /* ------------------------------------------------------------
     视图：主页
     ------------------------------------------------------------ */
  function noteCard(n, q) {
    /* 三列网格：元信息拆成顶部（分类/日期）与底部（标签/字数）两段，
       中间留给标题与摘要；卡片高度由 min-height + flex 撑齐。 */
    var tags = (n.tags || []).slice(0, 3).map(function (t) {
      return '<span>' + esc(t) + '</span>';
    }).join('');

    return '' +
      '<a class="note-card animate" href="#/note/' + encodeURIComponent(n.slug) + '">' +
        '<div class="card-top">' +
          '<span class="cat">' + esc(n.category) + '</span>' +
          '<span class="date">' + fmtDate(n.date) + '</span>' +
        '</div>' +
        '<h3>' + hl(n.title, q) + '</h3>' +
        '<p>' + hl(n.summary, q) + '</p>' +
        '<div class="card-foot">' +
          (tags ? '<div class="tags">' + tags + '</div>' : '') +
          '<span class="words">' + fmtNum(n.words) + ' 字 · ' + n.reading_time + ' 分钟</span>' +
        '</div>' +
      '</a>';
  }

  /* ------------------------------------------------------------
     视图：首页（#/）—— 设计稿第二屏：通栏统计 / 最新 3 篇 / 分类入口
     首屏舞台（.hero）是 index.html 里的静态结构，不在这里生成
     ------------------------------------------------------------ */
  function viewHome() {
    var list = filtered({});
    var cats = (DB.categories || []).map(function (c) {
      return '<a href="#/category/' + encodeURIComponent(c[0]) + '">' +
        esc(c[0]) + ' <b>' + c[1] + '</b></a>';
    }).join('');

    var cards = list.slice(0, 3).map(function (n) {
      var tags = (n.tags || []).slice(0, 3).map(function (t) {
        return '<i>' + esc(t) + '</i>';
      }).join('');
      return '<a class="card" href="#/note/' + encodeURIComponent(n.slug) + '">' +
        '<div class="meta"><span class="cat">' + esc(n.category) + '</span>' +
          '<span>' + fmtDate(n.date) + '</span></div>' +
        '<h3>' + esc(n.title) + '</h3>' +
        '<p>' + esc(n.summary) + '</p>' +
        (tags ? '<div class="tags">' + tags + '</div>' : '') +
      '</a>';
    }).join('');

    state.shown = list.length;

    /* 数字先落 0，由 playCountUp() 滚到 data-count-to。
       JS 关闭时页面本来也不渲染，所以不必留最终值兜底。 */
    var statCell = function (val, label, useNum) {
      return '<div><b data-count-to="' + val + '"' +
        (useNum ? ' data-count-fmt="num"' : '') + '>0</b><span>' + label + '</span></div>';
    };

    return (
      /* 统计条是通栏的，故意放在 .wrap 之外（与设计稿一致） */
      '<div class="stats">' +
        statCell(DB.stats.notes || 0, '篇笔记') +
        statCell((DB.categories || []).length, '个分类') +
        statCell((DB.tags || []).length, '个标签') +
        statCell(DB.stats.words || 0, '总字数', true) +
      '</div>' +
      '<div class="wrap">' +
        '<section class="section">' +
          '<div class="sec-head"><h2>最新笔记</h2><span>按更新时间排序</span>' +
            '<a href="#/archive">查看归档 →</a></div>' +
          '<div class="cards">' + cards + '</div>' +
        '</section>' +
        '<section class="section" id="hsCats">' +
          '<div class="sec-head"><h2>按分类浏览</h2>' +
            '<span>' + (DB.categories || []).length + ' 个分类</span></div>' +
          '<div class="cats">' + cats + '</div>' +
        '</section>' +
      '</div>'
    );
  }

  /* ------------------------------------------------------------
     视图：笔记库（#/notes）—— 沿用旧版：hero 卡片 + 全量卡片列表
     分类 / 标签 / 搜索（#/category/:x、#/tag/:x、state.q）都落在这个视图
     ------------------------------------------------------------ */
  function viewNotes(route) {
    var list = filtered(route);
    var q = state.q;
    var parts = [];

    if (!route.category && !route.tag && !q) {
      parts.push(
        '<section class="hero animate">' +
          '<div class="hero-inner">' +
            '<h1>' + esc(CONFIG.title) + ' · <em>' + esc(CONFIG.subtitle) + '</em></h1>' +
            '<p>' + esc(CONFIG.description || '') + '</p>' +
            '<div class="hero-actions">' +
              '<a class="btn btn-primary" href="#/archive">按时间归档</a>' +
              '<a class="btn btn-ghost" href="#/tags">按标签浏览</a>' +
            '</div>' +
          '</div>' +
        '</section>'
      );
    }

    var title = '全部笔记';
    if (route.category) title = '分类：' + esc(route.category);
    if (route.tag) title = '标签：' + esc(route.tag);
    if (q) title = '搜索结果';

    var pill = '';
    if (route.category || route.tag) {
      pill = '<span class="filter-pill">' + esc(route.category || route.tag) +
        '<button type="button" data-clear-filter title="清除筛选">×</button></span>';
    }

    parts.push(
      '<div class="list-head animate">' +
        '<h2>' + title + ' <span class="badge">' + list.length + '</span></h2>' +
        pill +
        '<span class="spacer"></span>' +
        (q ? '<span class="chip">关键词：' + esc(q) + '</span>' : '') +
      '</div>'
    );

    if (!list.length) {
      parts.push(
        '<div class="empty">' +
          '<b>没有找到匹配的笔记</b>' +
          (q ? '尝试更换关键词，或点击左侧分类浏览' : '在 notes/ 目录下新增 Markdown 文件后运行 <code>python build.py</code>') +
        '</div>'
      );
    } else {
      /* 一次渲染全部：本规模下一次 DOM 构建完全够用，分页反而多一层操作 */
      state.shown = list.length;
      parts.push('<div class="note-list" id="noteList">' +
        list.map(function (n) { return noteCard(n, q); }).join('') + '</div>');
    }

    return parts.join('');
  }

  /* ------------------------------------------------------------
     视图：归档
     ------------------------------------------------------------ */
  var CARET_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  function viewArchive() {
    if (!NOTES.length) return '<div class="empty"><b>暂无笔记</b></div>';

    /* 年 → 月 → 日 三级：年、月只做分组，具体条目点开月份才出现 */
    var sorted = NOTES.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var years = {};
    sorted.forEach(function (n) {
      var d = String(n.date);
      var y = d.slice(0, 4);
      var m = d.slice(5, 7);
      var yg = years[y] = years[y] || { count: 0, months: {} };
      yg.count++;
      (yg.months[m] = yg.months[m] || []).push(n);
    });

    var out = ['<div class="list-head animate"><h2>归档 <span class="badge">' + NOTES.length + '</span></h2></div>'];

    Object.keys(years).sort(function (a, b) { return b - a; }).forEach(function (y) {
      var yg = years[y];
      var months = Object.keys(yg.months).sort(function (a, b) { return b - a; });

      out.push(
        '<section class="archive-year animate">' +
          '<div class="year-title">' + y +
            '<span class="year-count">' + yg.count + ' 篇 · ' + months.length + ' 个月</span>' +
          '</div>'
      );

      months.forEach(function (m) {
        var key = y + '-' + m;
        var list = yg.months[m];
        var open = state.openMonths[key] === true;
        out.push(
          '<div class="arch-month' + (open ? ' is-open' : '') + '" data-month="' + key + '">' +
            '<button class="arch-month-head" type="button" data-toggle-month="' + key + '" ' +
              'aria-expanded="' + open + '" aria-controls="arch-' + key + '">' +
              '<span class="arch-caret">' + CARET_SVG + '</span>' +
              '<span class="arch-m">' + Number(m) + ' 月</span>' +
              '<span class="arch-count">' + list.length + ' 篇</span>' +
            '</button>' +
            '<div class="arch-items" id="arch-' + key + '">' +
              list.map(function (n) {
                return '<a class="arch-item" href="#/note/' + encodeURIComponent(n.slug) + '">' +
                  '<time datetime="' + escAttr(n.date) + '">' + fmtDate(n.date).slice(8) + '</time>' +
                  '<span class="t">' + esc(n.title) + '</span>' +
                  '<span class="c">' + esc(n.category) + '</span>' +
                '</a>';
              }).join('') +
            '</div>' +
          '</div>'
        );
      });

      out.push('</section>');
    });

    return out.join('');
  }

  /* ------------------------------------------------------------
     视图：标签
     ------------------------------------------------------------ */
  function viewTags() {
    var cats = DB.categories || [];
    var tags = DB.tags || [];
    var out = ['<div class="list-head animate"><h2>标签与分类</h2></div>'];

    out.push(
      '<div class="tag-section animate">' +
        '<h3>按分类浏览（' + cats.length + '）</h3>' +
        '<div class="tag-cloud-lg">' +
          cats.map(function (c) {
            return '<a href="#/category/' + encodeURIComponent(c[0]) + '">' + esc(c[0]) + ' <b>' + c[1] + '</b></a>';
          }).join('') +
        '</div>' +
      '</div>'
    );

    out.push(
      '<div class="tag-section animate">' +
        '<h3>按标签浏览（' + tags.length + '）</h3>' +
        '<div class="tag-cloud-lg">' +
          tags.map(function (t) {
            return '<a href="#/tag/' + encodeURIComponent(t[0]) + '">#' + esc(t[0]) + ' <b>' + t[1] + '</b></a>';
          }).join('') +
        '</div>' +
      '</div>'
    );

    return out.join('');
  }

  

  /* ------------------------------------------------------------
     视图：文章
     注：Markdown 渲染、HTML 净化、代码块（语言标签/复制/高亮）与
         表格后处理统一由 assets/js/render.js 的 SecRender 提供，
         与后台编辑器预览共用同一套链路，确保两处呈现完全一致。
     ------------------------------------------------------------ */
  function buildToc(headings, host) {
    var items = headings.filter(function (h) { return h.level >= 2 && h.level <= 4; });
    if (items.length < 2) { host.innerHTML = ''; return; }

    host.innerHTML = '<h5>本篇目录</h5><ul>' + items.map(function (h) {
      return '<li class="lvl-' + h.level + '"><a href="#' + escAttr(h.id) + '" data-toc="' + escAttr(h.id) + '">' +
        esc(h.text) + '</a></li>';
    }).join('') + '</ul>';

    $$('a[data-toc]', host).forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var el = document.getElementById(a.getAttribute('data-toc'));
        if (el) {
          var top = el.getBoundingClientRect().top + window.pageYOffset - 84;
          window.scrollTo({ top: top, behavior: 'smooth' });
        }
      });
    });
  }

  function spyToc(headings) {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    var links = $$('.toc a[data-toc]');
    if (!links.length) return;

    var targets = headings.filter(function (h) { return h.level >= 2 && h.level <= 4; })
      .map(function (h) { return document.getElementById(h.id); })
      .filter(Boolean);
    if (!targets.length) return;

    var current = null;
    var setActive = function (id) {
      if (current === id) return;
      current = id;
      links.forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('data-toc') === id);
      });
    };

    state.observer = new IntersectionObserver(function (entries) {
      var visible = entries.filter(function (e) { return e.isIntersecting; })
        .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });
      if (visible.length) setActive(visible[0].target.id);
    }, { rootMargin: '-84px 0px -70% 0px', threshold: [0, 1] });

    targets.forEach(function (t) { state.observer.observe(t); });
  }

  /* 反向链接：列出正文中引用了本篇的其他笔记，并附上引用处的上下文 */
  function contextSnippet(body, title) {
    var re = new RegExp('\\[\\[\\s*' + reEscape(title) + '\\s*(?:\\|[^\\]]*)?\\]\\]', 'i');
    var lines = String(body || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        var t = lines[i].trim().replace(/^[-*+>]\s*/, '');
        return esc(t.length > 96 ? t.slice(0, 96) + '…' : t);
      }
    }
    return '';
  }

  function backlinksSection(note) {
    var sources = (BACKLINKS[note.slug] || []).map(findNote).filter(Boolean);
    if (!sources.length) return '';

    return '<section class="backlinks animate">' +
      '<h3>反向链接 <span class="bl-count">' + sources.length + '</span></h3>' +
      '<div class="backlink-list">' +
        sources.map(function (s) {
          var ctx = contextSnippet(s.body, note.title);
          return '<a class="backlink" href="#/note/' + encodeURIComponent(s.slug) + '">' +
            '<span class="backlink-title">' + esc(s.title) + '</span>' +
            (ctx ? '<span class="backlink-ctx">' + ctx + '</span>' : '') +
          '</a>';
        }).join('') +
      '</div>' +
    '</section>';
  }

  /* 相关笔记：同分类计 3 分，每命中一个相同标签计 2 分 */
  function relatedNotes(note, limit) {
    var scored = [];
    NOTES.forEach(function (o) {
      if (o.slug === note.slug) return;
      var score = 0;
      var shared = [];
      if (o.category === note.category) score += 3;
      (o.tags || []).forEach(function (t) {
        if ((note.tags || []).indexOf(t) > -1) { score += 2; shared.push(t); }
      });
      if (score > 0) scored.push({ note: o, score: score, shared: shared });
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.note.date < b.note.date ? 1 : -1;
    });
    return scored.slice(0, limit || 4);
  }

  function relatedSection(note) {
    var rel = relatedNotes(note, 4);
    if (!rel.length) return '';

    return '<section class="related animate">' +
      '<h3>相关笔记</h3>' +
      '<div class="related-list">' +
        rel.map(function (r) {
          var meta = esc(r.note.category);
          if (r.shared.length) meta += ' · 共同标签 ' + esc(r.shared.slice(0, 3).join('、'));
          return '<a href="#/note/' + encodeURIComponent(r.note.slug) + '">' +
            '<span class="related-title">' + esc(r.note.title) + '</span>' +
            '<span class="related-meta">' + meta + '</span>' +
          '</a>';
        }).join('') +
      '</div>' +
    '</section>';
  }

  function viewPost(route, n) {
    if (!n) {
      return '<div class="empty"><b>笔记不存在</b>该链接可能已失效，' +
        '<a href="#/">返回首页</a></div>';
    }

    var idx = NOTES.indexOf(n);
    var newer = idx > 0 ? NOTES[idx - 1] : null;
    var older = idx > -1 && idx < NOTES.length - 1 ? NOTES[idx + 1] : null;

    var tags = (n.tags || []).map(function (t) {
      return '<a class="tag" href="#/tag/' + encodeURIComponent(t) + '">#' + esc(t) + '</a>';
    }).join('');

    var head =
      '<div class="post-header">' +
        '<div class="crumbs">' +
          '<a href="#/notes">笔记库</a><span class="sep">/</span>' +
          '<a href="#/category/' + encodeURIComponent(n.category) + '">' + esc(n.category) + '</a>' +
          '<span class="sep">/</span><span>' + esc(n.title) + '</span>' +
        '</div>' +
        '<h1>' + esc(n.title) + '</h1>' +
        '<div class="post-meta">' +
          '<span>' + longDate(n.date) + '</span>' +
          '<span class="sep">·</span>' +
          '<span>约 ' + n.reading_time + ' 分钟</span>' +
          '<span class="sep">·</span>' +
          '<span>' + fmtNum(n.words) + ' 字</span>' +
          (tags ? '<span class="sep">·</span>' + tags : '') +
        '</div>' +
      '</div>';

    var nav =
      '<div class="post-nav">' +
        (newer
          ? '<a href="#/note/' + encodeURIComponent(newer.slug) + '"><small>← 更新的一篇</small><strong>' + esc(newer.title) + '</strong></a>'
          : '<span class="placeholder"></span>') +
        (older
          ? '<a class="next" href="#/note/' + encodeURIComponent(older.slug) + '"><small>更早的一篇 →</small><strong>' + esc(older.title) + '</strong></a>'
          : '<span class="placeholder"></span>') +
      '</div>';

    return '<div class="post-wrap"><article class="post-layout">' +
      '<div><div class="animate">' + head + '</div>' +
      '<div class="post-body animate" id="postBody"></div>' +
      backlinksSection(n) +
      relatedSection(n) +
      nav + '</div>' +
      '<nav class="toc" id="toc"></nav>' +
      '</article></div>';
  }

  /* ------------------------------------------------------------
     页面转场：首页 ↔ 笔记库
     要求是「旧页淡出的同时新页淡入，两页都在屏幕上」，顺序式的
     先出后进会闪一帧黑屏。这里交给浏览器原生的 View Transitions：
     它在切换瞬间同时生成旧页与新页两张快照，再做交叉动画，
     天然没有空档；导航栏单独命名成一组，保持不动。
     不支持该 API 的浏览器直接换页（不做假动画）。
     ------------------------------------------------------------ */
  /* __NO_PAGE_ANIM__ 供自动化测试关掉转场：jsdom 里 render() 会被延后，
     断言拿到的还是旧 DOM；真实浏览器不受影响 */
  var reduceMotion = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var pageVT = false;
  var lastKind = '';

  function clearPgDir() {
    document.documentElement.removeAttribute('data-pgdir');
    /* 底色补间只在转场期间生效，平时切主题仍走液态层的圆形扩散 */
    setTimeout(function () { document.body.classList.remove('vt-bg'); }, 600);
    pageVT = false;
  }

  function startPageTransition(dir, apply) {
    var root = document.documentElement;
    root.setAttribute('data-pgdir', dir > 0 ? 'fwd' : 'back');
    /* 首页恒为深色、笔记库跟主题走：浅色主题下往返就是黑↔白，
       给 body 一段 background-color 补间，底色不会在换页瞬间跳变 */
    document.body.classList.add('vt-bg');
    pageVT = true;
    try {
      var vt = document.startViewTransition(function () {
        window.scrollTo(0, 0);
        apply();
      });
      if (vt && vt.finished && vt.finished.then) vt.finished.then(clearPgDir, clearPgDir);
      else setTimeout(clearPgDir, 600);
    } catch (e) {
      clearPgDir();
      apply();
    }
  }

  /* ------------------------------------------------------------
     数字滚动（Count Up）
     目标值写在 data-count-to，data-count-fmt="num" 时带千分位；
     两处统计都用它：首页第二屏的 .stats，笔记库侧栏的 #sideStats。
     ------------------------------------------------------------ */
  function countUpEl(el, dur) {
    var to = parseFloat(el.getAttribute('data-count-to'));
    if (!isFinite(to)) return;
    var useNum = el.getAttribute('data-count-fmt') === 'num';
    var paint = function (v) {
      el.textContent = useNum ? fmtNum(Math.round(v)) : String(Math.round(v));
    };
    /* 无障碍：系统要求减少动态，或自动化测试要求关动画时，直接落终值 */
    if (reduceMotion || window.__NO_PAGE_ANIM__) { paint(to); return; }
    var start = 0;
    var step = function (now) {
      if (!start) start = now;
      if (!el.isConnected) return;
      var p = Math.min(1, (now - start) / dur);
      /* easeOutCubic：第一帧就开始动（easeInOut 前 300ms 几乎不动，会被当成卡顿），
         尾段拉得长，所以整体仍然显得慢 */
      var e = 1 - Math.pow(1 - p, 3);
      paint(to * e);
      if (p < 1) requestAnimationFrame(step);
    };
    paint(0);
    requestAnimationFrame(step);
  }

  function playCountUp(sel, delay) {
    var nodes = document.querySelectorAll(sel);
    if (!nodes.length) return;

    var roll = function () {
      /* 先把四个数字统一归零：侧栏那组在 buildSidebar 里已经写成终值，
         不归零的话「还没轮到」的那几个会先显示终值再跳回 0，露馅。 */
      for (var j = 0; j < nodes.length; j++) nodes[j].textContent = '0';
      for (var i = 0; i < nodes.length; i++) {
        (function (el, i) {
          /* 四个数字依次起步，滚动过程才看得清 */
          setTimeout(function () { if (el.isConnected) countUpEl(el, 2200); }, delay + i * 120);
        })(nodes[i], i);
      }
    };

    if (reduceMotion || window.__NO_PAGE_ANIM__) {
      for (var k = 0; k < nodes.length; k++) countUpEl(nodes[k], 0);
      return;
    }
    /* 数字滚到眼前才有意义：首页统计条在首屏之下，等它进入视口再起步
       （否则动画在屏幕外播完，滚下去只剩一堆静态数字）。 */
    if (!window.IntersectionObserver) { roll(); return; }
    var fired = false;
    var io = new IntersectionObserver(function (entries) {
      if (fired) return;
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        fired = true;
        io.disconnect();
        roll();
        return;
      }
    }, { threshold: 0 });   /* 哪怕只露出 1px 也立刻起步，别等 1/4 可见 */
    for (var n = 0; n < nodes.length; n++) io.observe(nodes[n]);
  }

  /* ------------------------------------------------------------
     渲染入口
     ------------------------------------------------------------ */
  function render() {
    var route = parseRoute();
    var kindIsHome = route.name === 'home' && !state.q;
    var kind = kindIsHome ? 'home' : (isLibRoute(route) ? 'lib' : 'other');
    var dir = 0;
    if (lastKind === 'home' && kind === 'lib') dir = 1;
    else if (lastKind === 'lib' && kind === 'home') dir = -1;
    lastKind = kind;

    if (dir && !reduceMotion && !window.__NO_PAGE_ANIM__ && document.startViewTransition) {
      startPageTransition(dir, renderNow);
      return;
    }
    renderNow();
  }

  function renderNow() {
    var route = parseRoute();
    var app = $('#app');
    if (!app) return;

    recordTrail(route);

    /* 首页舞台只在「未筛选的首页」出现；其余路由收起。
       body.is-home 关掉后侧栏回到内页形态，body.is-notes 只给笔记库换页脚底色。 */
    var isHome = route.name === 'home' && !state.q;
    document.body.classList.toggle('is-home', isHome);
    /* 沿用旧版式的「库」内页面：笔记库 / 归档 / 标签 / 文章。
       它们共用同一条纯黑页脚，底部和新首页对齐，不会进一次文章就变回灰底。 */
    var isNotesCtx = route.name === 'notes' || route.name === 'note' ||
      route.name === 'archive' || route.name === 'tags';
    document.body.classList.toggle('is-notes', isNotesCtx);
    /* 回到首页就复位，下次再进库时侧栏数字重新滚一次 */
    if (!isNotesCtx) state.statPlayed = false;
    var heroEl = $('#homeHero');
    if (heroEl) heroEl.hidden = !isHome;
    if (window.HomeHero) window.HomeHero.setActive(isHome);

    /* 文章页依赖渲染器：未就绪时先排队，加载完成后重跑本函数；
       失败（state = -1）则继续往下走，由 viewPost 的 <pre> 分支兜底。 */
    if (route.name === 'note' && !window.SecRender && vendor.state !== -1) {
      loadVendor(render);
      return;
    }

    if (state.observer) { state.observer.disconnect(); state.observer = null; }

    var note = route.name === 'note' ? findNote(route.slug) : null;

    /* 首页出现搜索结果时，落到笔记库视图（舞台没有结果区，也不该有） */
    var isNotesView = route.name === 'notes' || (route.name === 'home' && !!state.q);

    var html;
    if (route.name === 'note') html = viewPost(route, note);
    else if (route.name === 'archive') html = viewArchive();
    else if (route.name === 'tags') html = viewTags();
    else if (isNotesView) html = viewNotes(route);
    else html = viewHome();

    app.innerHTML = html;

    /* 数字滚动：首页统计条每次进来都重播；侧栏统计每进一次「库」播一次。
       有转场时压后到淡入差不多完成，否则用户看到的是被快照定格的 0。 */
    var countDelay = pageVT ? 520 : 0;
    if (isHome) playCountUp('#app .stats b', countDelay);
    if (isNotesCtx && !state.statPlayed) {
      state.statPlayed = true;
      playCountUp('#sideStats b', countDelay);
    }

    if (route.name === 'note' && note) {
      var body = $('#postBody');
      if (body) {
        var headings = window.SecRender
          ? SecRender.render(note.body, body)
          : (body.innerHTML = '<pre>' + esc(note.body) + '</pre>', []);

        /* 正文图片默认懒加载：滚动到附近才解码，长文首屏更快 */
        var imgs = body.querySelectorAll('img');
        for (var k = 0; k < imgs.length; k++) {
          if (!imgs[k].hasAttribute('loading')) imgs[k].loading = 'lazy';
          if (!imgs[k].hasAttribute('decoding')) imgs[k].decoding = 'async';
        }
        applyHighlight();
        var toc = $('#toc');
        if (toc) { buildToc(headings, toc); spyToc(headings); }
      }
      document.title = note.title + ' · ' + CONFIG.title;
    } else {
      document.title = CONFIG.title + ' · ' + CONFIG.subtitle;
    }

    syncActive(route);
    syncPager(route);
    measureProgress();
    syncProgress();

    /* 皮肤层：路由切换后重排滑动指示块、播放入场编排 */
    if (window.LiquidUI && LiquidUI.afterRender) LiquidUI.afterRender();
  }

  function syncActive(route) {
    /* 顶栏三项：首页 / 笔记库 / 反馈。
       归档、标签、分类、标签筛选都算「在库里」，统一高亮笔记库。 */
    var homeOn = route.name === 'home' && !state.q;
    var notesOn = route.name === 'notes' || route.name === 'note' ||
      route.name === 'archive' || route.name === 'tags';
    $$('.topnav a, #drawerNav a').forEach(function (a) {
      var key = a.getAttribute('data-nav');
      var on = key === 'home' ? homeOn
        : key === 'notes' ? notesOn
        : key === 'feedback' ? false
        : key === route.name;
      a.classList.toggle('active', !!on);
    });

    $$('#categoryList a[data-category]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-category') === (route.category || ''));
    });
  }

  /* 滚动进度条：滚动事件只做「登记」，真正的读取与写入合并到一帧一次。
     每帧调用 scrollHeight 会强制同步布局，高频滚动时是主要的卡顿来源。 */
  var progressFrame = 0;
  var progressMax = 0;
  var progressLastP = -1;

  function measureProgress() {
    var h = document.documentElement;
    progressMax = Math.max(0, h.scrollHeight - h.clientHeight);
  }

  function paintProgress() {
    progressFrame = 0;
    var bar = $('#progressBar');
    var top = $('#toTop');
    if (!bar) return;

    var y = window.pageYOffset;
    var pct = 0;
    if (location.hash.indexOf('#/note/') === 0 && progressMax > 40) {
      pct = Math.min(100, Math.max(0, (y / progressMax) * 100));
    }
    if (pct !== progressLastP) {
      progressLastP = pct;
      bar.style.setProperty('--p', (pct / 100).toFixed(4));
    }
    if (top) {
      var hide = y < 420;
      if (top.hidden !== hide) top.hidden = hide;
    }
  }

  function syncProgress() {
    if (progressFrame) return;
    progressFrame = requestAnimationFrame(paintProgress);
  }

  /* ------------------------------------------------------------
     侧边栏构建
     ------------------------------------------------------------ */
  /* 目录树的数据：分类（一级）→ 二级菜单（二级）→ 笔记（三级）。
     二级菜单来自笔记 front-matter 的 subcategory 字段，由作者在管理端填写，
     这里不做任何自动归类；没填的笔记直接挂在分类下面。
     标签不再参与这棵树，改为侧栏的独立分支。 */
  function menuTree() {
    var byCat = {};
    NOTES.forEach(function (n) {
      var c = n.category || '未分类';
      (byCat[c] = byCat[c] || []).push(n);
    });

    var byDate = function (a, b) { return a.date < b.date ? 1 : -1; };
    var cats = (DB.categories || []).map(function (c) { return c[0]; })
      .filter(function (c) { return !!byCat[c]; });
    Object.keys(byCat).forEach(function (c) { if (cats.indexOf(c) < 0) cats.push(c); });

    return cats.map(function (c) {
      var subs = {};
      var loose = [];
      byCat[c].forEach(function (n) {
        var sub = String(n.subcategory || '').trim();
        if (sub) (subs[sub] = subs[sub] || []).push(n);
        else loose.push(n);
      });
      var groups = Object.keys(subs).sort(function (a, b) {
        return subs[b].length - subs[a].length || a.localeCompare(b, 'zh');
      }).map(function (sub) {
        return { sub: sub, notes: subs[sub].slice().sort(byDate) };
      });
      return { cat: c, count: byCat[c].length, groups: groups, loose: loose.sort(byDate) };
    });
  }

  function buildSidebar() {
    var catList = $('#categoryList');
    if (catList) {
      var route = parseRoute();
      var out = ['<li class="tree-root"><a class="tree-row lv0" href="#/notes" data-category="">' +
        '<span class="tree-label">全部笔记</span><span class="count">' + NOTES.length + '</span></a></li>'];

      menuTree().forEach(function (g) {
        var open = state.openCats[g.cat] !== undefined
          ? state.openCats[g.cat] : (route.category === g.cat);
        var sub = [];

        g.groups.forEach(function (grp) {
          var subOpen = state.openSubs[g.cat + '/' + grp.sub] !== undefined
            ? state.openSubs[g.cat + '/' + grp.sub] : false;
          sub.push(
            '<li class="tree-group' + (subOpen ? ' is-open' : '') + '">' +
              '<button class="tree-row lv2 tree-group-head" type="button" data-toggle-sub="' +
                escAttr(g.cat + '/' + grp.sub) + '" aria-expanded="' + subOpen + '">' +
                '<span class="tree-caret">' + CARET_SVG + '</span>' +
                '<span class="tree-label">' + esc(grp.sub) + '</span>' +
                '<span class="count">' + grp.notes.length + '</span>' +
              '</button>' +
              '<ul class="tree-sub">' +
                grp.notes.map(function (n) {
                  return '<li><a class="tree-note" title="' + escAttr(n.title) + '" href="#/note/' +
                    encodeURIComponent(n.slug) + '">' + esc(n.title) + '</a></li>';
                }).join('') +
              '</ul>' +
            '</li>'
          );
        });

        /* 没填二级菜单的笔记：跟在二级菜单后面，用一条虚线隔开，避免被误读成上一组的成员 */
        g.loose.forEach(function (n, i) {
          sub.push('<li' + (i === 0 ? ' class="is-loose-first"' : '') + '>' +
            '<a class="tree-note is-loose" title="' + escAttr(n.title) + '" href="#/note/' +
            encodeURIComponent(n.slug) + '">' + esc(n.title) + '</a></li>');
        });

        out.push(
          '<li class="tree-cat' + (open ? ' is-open' : '') + '">' +
            '<div class="tree-row lv1">' +
              '<button class="tree-toggle" type="button" data-toggle-cat="' + escAttr(g.cat) + '" ' +
                'aria-expanded="' + open + '" aria-label="展开分类 ' + escAttr(g.cat) + '">' + CARET_SVG + '</button>' +
              '<a class="tree-label" href="#/category/' + encodeURIComponent(g.cat) + '" data-category="' +
                escAttr(g.cat) + '">' + esc(g.cat) + '</a>' +
              '<span class="count">' + g.count + '</span>' +
            '</div>' +
            '<ul class="tree-sub">' + sub.join('') + '</ul>' +
          '</li>'
        );
      });

      catList.innerHTML = out.join('');
    }

    var set = function (id, val) { var el = $(id); if (el) el.textContent = val; };
    /* 侧栏四个数字同时登记滚动目标：data-count-to 是数值，文本是它的展示形态 */
    var setStat = function (id, val, fmt) {
      var el = $(id);
      if (!el) return;
      el.setAttribute('data-count-to', String(val));
      if (fmt === 'num') el.setAttribute('data-count-fmt', 'num');
      else el.removeAttribute('data-count-fmt');
      el.textContent = fmt === 'num' ? fmtNum(val) : String(val);
    };
    setStat('#statNotes', DB.stats.notes || 0);
    setStat('#statCats', (DB.categories || []).length);
    setStat('#statTags', (DB.tags || []).length);
    setStat('#statWords', DB.stats.words || 0, 'num');
    set('#builtAt', '构建于 ' + (DB.stats.builtAt || '—'));

    /* 首页统计条与侧栏同源，避免两处各写一份数字 */
    set('#hStatNotes', DB.stats.notes || 0);
    set('#hStatCats', (DB.categories || []).length);
    set('#hStatTags', (DB.tags || []).length);
    set('#hStatWords', fmtNum(DB.stats.words));

    /* 首页舞台的文案也从 config / stats 取，不写死在 HTML 里 */
    var hhTitle = $('#hhTitle');
    if (hhTitle) {
      hhTitle.innerHTML = 'A Knowledge Base and Blog <em>——By ' +
        esc(CONFIG.author || 'Deus') + '</em>';
    }
    var hhSub = $('#hhSub');
    if (hhSub) hhSub.textContent = 'Deus的知识库与博客';

    /* 品牌名固定为 Deus's Blog（顶栏视觉的一部分，不跟 config.title 走） */
    var brandEl = $('#brandTitle');
    if (brandEl) brandEl.textContent = "Deus's Blog";
    var brandSub = $('#brandSub');
    if (brandSub) brandSub.textContent = CONFIG.subtitle;
    /* config.footer 里通常已经写了 ©2026，再拼一次会出现「©2026 By Deus © 2026」；
       构建说明单独放一个 span，中间用 .dot 分隔（与设计稿一致） */
    var foot = CONFIG.footer || '';
    var hasCopy = foot.indexOf('©') > -1;
    $('#footerText').textContent = (CONFIG.author ? CONFIG.author + ' · ' : '') +
      foot + (hasCopy ? '' : ' © ' + new Date().getFullYear());
  }

  /* 目录树与归档的展开/折叠：都走事件委托，重渲染后无需重新绑定
     （#sidebar 与 #app 本身不会被替换，只有内部内容变） */
  function bindTree() {
    var side = $('#sidebar');
    if (side && !side.dataset.treeBound) {
      side.dataset.treeBound = '1';
      side.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-toggle-cat], [data-toggle-sub]') : null;
        if (!btn) return;
        e.preventDefault();
        var li = btn.closest('li');
        var on = !li.classList.contains('is-open');
        li.classList.toggle('is-open', on);
        btn.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (btn.hasAttribute('data-toggle-cat')) state.openCats[btn.getAttribute('data-toggle-cat')] = on;
        else state.openSubs[btn.getAttribute('data-toggle-sub')] = on;
        if (window.__treeScrollRepaint) window.__treeScrollRepaint();
      });
    }

    var app = $('#app');
    if (app && !app.dataset.archBound) {
      app.dataset.archBound = '1';
      app.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-toggle-month]') : null;
        if (!btn) return;
        var box = btn.closest('.arch-month');
        var on = !box.classList.contains('is-open');
        box.classList.toggle('is-open', on);
        btn.setAttribute('aria-expanded', on ? 'true' : 'false');
        state.openMonths[btn.getAttribute('data-toggle-month')] = on;
      });
    }
  }

  /* 侧栏目录的滚动提示：原生滚动条隐藏在 CSS 里，这里自绘一条 3px 指示条。
     只在真正滚动时淡入，停手 0.9s 后淡出——静止的目录不该常驻一根滚动条。 */
  function bindTreeScroll() {
    var box = $('#treeScroll');
    var bar = $('#treeScrollbar');
    if (!box || !bar) return;

    var hideTimer = 0;
    var frame = 0;

    function paint() {
      frame = 0;
      var sh = box.scrollHeight;
      var ch = box.clientHeight;
      if (sh <= ch + 2) {
        bar.style.height = '0px';
        return;
      }
      var h = Math.max(28, Math.round((ch * ch) / sh));
      var maxTop = ch - h;
      var top = ((box.scrollTop || 0) / (sh - ch)) * maxTop;
      bar.style.height = h + 'px';
      bar.style.transform = 'translateY(' + Math.round(top) + 'px)';
    }

    function schedulePaint() {
      if (frame) return;
      frame = requestAnimationFrame(paint);
    }

    function showBar() {
      box.classList.add('is-scrolling');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { box.classList.remove('is-scrolling'); }, 900);
    }

    box.addEventListener('scroll', function () {
      schedulePaint();
      showBar();
    }, { passive: true });

    window.addEventListener('resize', schedulePaint, { passive: true });
    window.__treeScrollRepaint = schedulePaint;
    paint();
  }

  /* ------------------------------------------------------------
     主题
     ------------------------------------------------------------ */
  function applyTheme(theme, instant) {
    var commit = function () {
      state.theme = theme;
      document.documentElement.setAttribute('data-theme', theme);
      var dark = $('#hljs-theme-dark');
      var light = $('#hljs-theme-light');
      if (dark) dark.disabled = theme !== 'dark';
      if (light) light.disabled = theme !== 'light';
      store.set('sec-theme', theme);
    };
    /* 有皮肤层时用圆形扩散过渡；首屏应用已存主题时必须「瞬时」，
       否则页面一打开就先播放一次切换动画。 */
    if (!instant && window.LiquidUI && LiquidUI.themeSwap) {
      LiquidUI.themeSwap(commit, $('#themeToggle'));
    } else {
      commit();
    }
  }

  /* ------------------------------------------------------------
     搜索
     ------------------------------------------------------------ */
  function bindSearch() {
    var sideInput = $('#searchInput');
    var sideClear = $('#searchClear');
    var heroInput = $('#heroSearch');

    if (sideInput) bindSearchField(sideInput, sideClear);
    if (heroInput) bindSearchField(heroInput, null, { live: false });

    if (sideClear && sideInput) {
      sideClear.addEventListener('click', function () {
        sideInput.value = '';
        state.q = '';
        syncSearchValue(sideInput);
        sideClear.hidden = true;
        render();
        sideInput.focus();
      });
    }

    /* 首页搜索框：回车提交（不刷新页面） */
    var form = $('#hhSearchForm');
    if (form && heroInput) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        state.q = heroInput.value;
        syncSearchValue(heroInput);
        /* 舞台只负责「发起搜索」，结果区在笔记库 */
        if (state.q) location.hash = '#/notes';
        else render();
      });
    }

    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        openNav(false);
        /* 首页舞台上是 hero 搜索框，内页才用侧栏那个 */
        var target = (document.body.classList.contains('is-home') && heroInput) ? heroInput : sideInput;
        if (target) target.focus();
      }
      if (e.key === 'Escape') { openNav(false); }
      if (e.key.toLowerCase() === 't' && !typing && !e.ctrlKey && !e.metaKey) {
        applyTheme(state.theme === 'dark' ? 'light' : 'dark');
      }
    });
  }

  /* 两个搜索框写同一份 state.q，输入时互相同步，切页面不丢词 */
  function syncSearchValue(src) {
    var a = $('#searchInput');
    var b = $('#heroSearch');
    if (a && a !== src) a.value = state.q;
    if (b && b !== src) b.value = state.q;
  }

  function bindSearchField(input, clear, opts) {
    if (!input) return;
    var timer = null;
    /* 舞台上的 hero 搜索框不做实时过滤：它一过滤，舞台就会整块收起、
       用户正在输入的框随即被销毁。改成「回车/点按钮才跳笔记库」。 */
    var live = !(opts && opts.live === false);

    input.addEventListener('input', function () {
      state.q = input.value;
      syncSearchValue(input);
      if (clear) clear.hidden = !input.value;
      if (!live) return;
      clearTimeout(timer);
      timer = setTimeout(function () {
        var route = parseRoute();
        if (state.q && route.name !== 'notes') location.hash = '#/notes';
        else render();
      }, 130);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        input.value = '';
        state.q = '';
        syncSearchValue(input);
        if (clear) clear.hidden = true;
        render();
        input.blur();
      }
    });
  }

  /* ------------------------------------------------------------
     移动端导航
     ------------------------------------------------------------ */
  function openNav(open) {
    document.body.classList.toggle('nav-open', !!open);
  }

  function bindNav() {
    var btn = $('#menuBtn');
    var backdrop = $('#backdrop');
    if (btn) btn.addEventListener('click', function () { openNav(!document.body.classList.contains('nav-open')); });
    if (backdrop) backdrop.addEventListener('click', function () { openNav(false); });
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.sidebar a')) openNav(false);
    });

    /* 「SecNotes」与「首页」在任何页面都必须回到首页顶部。
       换页时 hashchange 已经会 scrollTo(0,0)；这里补的正是「本来就在首页、
       hash 没变化 → 不触发 hashchange」的那一半（首页滚到底部时点它们没反应）。 */
    document.addEventListener('click', function (e) {
      var hit = e.target.closest && e.target.closest('.brand, .topnav a[data-nav="home"]');
      if (!hit) return;
      if (parseRoute().name !== 'home') return;   // 换页交给 hashchange
      if (state.q) { state.q = ''; syncSearchValue(null); render(); }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  function boot() {
    applyTheme(state.theme, true);
    buildSidebar();
    bindTree();
    bindTreeScroll();
    bindSearch();
    bindNav();
    bindPager();

    /* 注册笔记索引，双向链接 [[标题]] 才能解析为站内链接 */
    if (window.SecRender && SecRender.setNoteIndex) SecRender.setNoteIndex(NOTES);

    /* 仅在配置了站点地址（即已生成 rss.xml）时声明订阅源 */
    if (CONFIG.siteUrl) {
      var feed = document.createElement('link');
      feed.rel = 'alternate';
      feed.type = 'application/rss+xml';
      feed.title = CONFIG.title;
      feed.href = 'rss.xml';
      document.head.appendChild(feed);
    }

    var themeBtn = $('#themeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        applyTheme(state.theme === 'dark' ? 'light' : 'dark');
      });
    }

    var searchToggle = $('#searchToggle');
    if (searchToggle) {
      searchToggle.addEventListener('click', function () {
        var input = $('#searchInput');
        if (document.body.classList.contains('nav-open') || window.innerWidth > 900) {
          if (input) input.focus();
        } else {
          openNav(true);
          setTimeout(function () { if (input) input.focus(); }, 220);
        }
      });
    }

    var toTop = $('#toTop');
    if (toTop) toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

    window.addEventListener('scroll', syncProgress, { passive: true });
    window.addEventListener('resize', function () {
      measureProgress();
      syncProgress();
    }, { passive: true });

    window.addEventListener('hashchange', function () {
      var r = parseRoute();
      render();
      /* 转场进行中时由 startPageTransition 的回调负责归零，
         这里提前滚动会把「旧页快照」也拉到顶部 */
      if (!pageVT && !(r.name === 'note' && location.hash.indexOf('#', 1) > -1)) {
        window.scrollTo(0, 0);
      }
    });

    /* 管理端同步完成后会广播刷新信号，让已打开的展示端自动重载。
       但下面两条通道都只在「同 origin」成立，且各有盲区：
         · storage 事件不跨 origin，部分浏览器在 file:// 下也不派发；
         · BroadcastChannel 在 file:// 下可能直接不可用。
       所以再叠一层**轮询兜底**：直接读标记值，变了就重载。
       这是唯一在 file:// 与 http 下都可靠的通道，也是「删了却看不到变化」
       这类问题的最后一道保障。 */
    var RELOAD_KEY = 'secnotes.reloadAt';
    var POLL_MS = 3000;
    var lastReloadAt = null;
    try { lastReloadAt = localStorage.getItem(RELOAD_KEY); } catch (e) { /* 存储不可用 */ }

    window.addEventListener('storage', function (e) {
      if (e.key === RELOAD_KEY && e.newValue) window.location.reload();
    });
    if (window.BroadcastChannel) {
      try {
        var ch = new BroadcastChannel('secnotes');
        ch.addEventListener('message', function (e) {
          if (e.data && e.data.type === 'reload') window.location.reload();
        });
      } catch (err) { /* 忽略：特性不可用时退化为轮询 */ }
    }
    try {
      setInterval(function () {
        if (document.hidden) return;            // 后台标签页不检查，省电
        var v;
        try { v = localStorage.getItem(RELOAD_KEY); } catch (err) { return; }
        if (v && v !== lastReloadAt) {
          lastReloadAt = v;
          window.location.reload();
        }
      }, POLL_MS);
    } catch (err) { /* 环境不支持定时器时忽略 */ }

    /* ---- 兜底（关键）：轮询服务端的站点数据版本戳 ----
       上面两条通道与 localStorage 轮询都依赖「同 origin」，
       但 manage.html 常以 file:// 打开、展示端常以 http://127.0.0.1:8080 打开，
       两者**跨 origin** —— 实测 localStorage 与 BroadcastChannel 此时完全不通，
       于是「管理端删了、展示端没反应」。
       <script> 标签不受同源策略限制，所以改用 JSONP 去服务端取版本戳：
       只要 data/notes.js 被重建过，版本就会变，展示端随即重载。
       服务不可达时静默跳过，不影响纯静态阅读。

       注意：这条通道只对「本机预览」有意义。GitHub Pages 上并不存在
       127.0.0.1:8080 的 admin.py，若继续轮询，控制台会每 3 秒刷一次
       ERR_CONNECTION_REFUSED —— 所以先用 IS_LOCAL 收敛运行环境。 */
    var IS_LOCAL = location.protocol === 'file:' ||
      /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
    var SYNC_PORTS = [8080, 8081, 9000];
    var verBase = null, lastVer = null, verBusy = false;
    var missStreak = 0, nextTryAt = 0;

    function loadVersion(cb) {
      var s = document.createElement('script');
      s.src = (verBase || 'http://127.0.0.1:' + SYNC_PORTS[0] + '/') +
        'api/version.js?t=' + Date.now();
      s.onload = function () { cb(true); };
      s.onerror = function () { cb(false); };
      document.head.appendChild(s);
    }
    function probePort(i) {
      if (i >= SYNC_PORTS.length) {
        verBusy = false;
        verBase = null;
        /* 全部端口都不可达：指数退避，避免本机静态预览时每 3 秒刷一屏 ERR_CONNECTION_REFUSED */
        missStreak++;
        nextTryAt = Date.now() + Math.min(60000, POLL_MS * Math.pow(2, missStreak));
        return;
      }
      verBase = 'http://127.0.0.1:' + SYNC_PORTS[i] + '/';
      loadVersion(function (ok) {
        if (ok && window.SEC_SITE_VERSION) {
          lastVer = window.SEC_SITE_VERSION;
          verBusy = false;
          missStreak = 0;
          nextTryAt = 0;
        } else {
          probePort(i + 1);
        }
      });
    }
    if (IS_LOCAL) {
      try {
        setInterval(function () {
          if (document.hidden) return;
          if (verBusy) return;
          if (Date.now() < nextTryAt) return;
          verBusy = true;
          if (!verBase) { probePort(0); return; }      // 首次/服务重启后重新探测端口
          loadVersion(function (ok) {
            verBusy = false;
            if (!ok) { verBase = null; return; }       // 服务关了，下次重新探测
            var v = window.SEC_SITE_VERSION;
            if (!v) return;
            if (lastVer && v !== lastVer) {
              lastVer = v;
              window.location.reload();
            } else {
              lastVer = v;
            }
          });
        }, POLL_MS);
      } catch (err) { /* 环境不支持时忽略 */ }
    }

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute) return;
      if (t.hasAttribute('data-clear-filter')) {
        go('#/notes');
      }
    });

    if (!location.hash) location.hash = '#/';
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ===== 移动端文章目录（发布层注入）===== */
(function () {
  var btn = document.getElementById('tocBtn');
  var drawer = document.getElementById('tocDrawer');
  var closeBtn = document.getElementById('tocClose');
  var body = document.body;
  var app = document.getElementById('app');
  if (!btn || !drawer || !closeBtn || !app) return;

  function isNoteRoute() { return location.hash.indexOf('#/note/') === 0; }
  function openToc() { body.classList.add('toc-open'); drawer.setAttribute('aria-hidden', 'false'); }
  function closeToc() { body.classList.remove('toc-open'); drawer.setAttribute('aria-hidden', 'true'); }

  function fillToc() {
    var nav = document.getElementById('tocMobile');
    btn.hidden = !isNoteRoute();
    if (!isNoteRoute()) {
      if (body.classList.contains('toc-open')) closeToc();
      if (nav) nav.innerHTML = '';
      return;
    }
    if (!nav) return;
    var hs = document.querySelectorAll('#postBody h1,h2,h3,h4');
    var items = [];
    hs.forEach(function (h) {
      if (h.id) items.push({ level: parseInt(h.tagName.slice(1), 10), id: h.id, text: h.textContent });
    });
    if (items.length < 2) { nav.innerHTML = ''; return; }
    nav.innerHTML = '<h5>本篇目录</h5><ul>' + items.map(function (h) {
      return '<li class="lvl-' + h.level + '"><a href="#' + encodeURIComponent(h.id) +
        '" data-toc="' + h.id + '">' + h.text.replace(/</g, '&lt;') + '</a></li>';
    }).join('') + '</ul>';
    tocLinks = Array.prototype.slice.call(nav.querySelectorAll('a[data-toc]'));
    tocLinks.forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        closeToc();
        var el = document.getElementById(a.getAttribute('data-toc'));
        if (el) {
          var top = el.getBoundingClientRect().top + window.pageYOffset - 76;
          window.scrollTo({ top: top, behavior: 'smooth' });
        }
      });
    });
    syncActive();
  }

  var tocLinks = [];
  var tocFrame = 0;

  function syncActive() {
    tocFrame = 0;
    if (!tocLinks.length) return;
    var pos = window.pageYOffset + 110;
    var cur = null;
    tocLinks.forEach(function (a) {
      var el = document.getElementById(a.getAttribute('data-toc'));
      if (el && el.offsetTop <= pos) cur = a;
    });
    tocLinks.forEach(function (a) { a.classList.toggle('active', a === cur); });
  }

  function scheduleToc() {
    if (tocFrame) return;
    tocFrame = requestAnimationFrame(syncActive);
  }

  btn.addEventListener('click', function () {
    body.classList.contains('toc-open') ? closeToc() : openToc();
  });
  closeBtn.addEventListener('click', closeToc);
  var backdrop = document.getElementById('backdrop');
  if (backdrop) backdrop.addEventListener('click', closeToc);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeToc(); });
  window.addEventListener('scroll', scheduleToc, { passive: true });
  new MutationObserver(function () { fillToc(); }).observe(app, { childList: true, subtree: true });
  fillToc();
})();

/* ===== 移动端文章目录（发布层注入）===== */
(function () {
  var btn = document.getElementById('tocBtn');
  var drawer = document.getElementById('tocDrawer');
  var closeBtn = document.getElementById('tocClose');
  var body = document.body;
  var app = document.getElementById('app');
  if (!btn || !drawer || !closeBtn || !app) return;

  function isNoteRoute() { return location.hash.indexOf('#/note/') === 0; }
  function openToc() { body.classList.add('toc-open'); drawer.setAttribute('aria-hidden', 'false'); }
  function closeToc() { body.classList.remove('toc-open'); drawer.setAttribute('aria-hidden', 'true'); }

  function fillToc() {
    var nav = document.getElementById('tocMobile');
    btn.hidden = !isNoteRoute();
    if (!isNoteRoute()) {
      if (body.classList.contains('toc-open')) closeToc();
      if (nav) nav.innerHTML = '';
      return;
    }
    if (!nav) return;
    var hs = document.querySelectorAll('#postBody h1,h2,h3,h4');
    var items = [];
    hs.forEach(function (h) {
      if (h.id) items.push({ level: parseInt(h.tagName.slice(1), 10), id: h.id, text: h.textContent });
    });
    if (items.length < 2) { nav.innerHTML = ''; return; }
    nav.innerHTML = '<h5>目录</h5><ul>' + items.map(function (h) {
      return '<li class="lvl-' + h.level + '"><a href="#' + encodeURIComponent(h.id) +
        '" data-toc="' + h.id + '">' + h.text.replace(/</g, '&lt;') + '</a></li>';
    }).join('') + '</ul>';
    nav.querySelectorAll('a[data-toc]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        closeToc();
        var el = document.getElementById(a.getAttribute('data-toc'));
        if (el) {
          var top = el.getBoundingClientRect().top + window.pageYOffset - 76;
          window.scrollTo({ top: top, behavior: 'smooth' });
        }
      });
    });
    syncActive();
  }

  function syncActive() {
    var nav = document.getElementById('tocMobile');
    if (!nav) return;
    var links = nav.querySelectorAll('a[data-toc]');
    if (!links.length) return;
    var pos = window.pageYOffset + 110;
    var cur = null;
    links.forEach(function (a) {
      var el = document.getElementById(a.getAttribute('data-toc'));
      if (el && el.offsetTop <= pos) cur = a;
    });
    links.forEach(function (a) { a.classList.toggle('active', a === cur); });
  }

  btn.addEventListener('click', function () {
    body.classList.contains('toc-open') ? closeToc() : openToc();
  });
  closeBtn.addEventListener('click', closeToc);
  var backdrop = document.getElementById('backdrop');
  if (backdrop) backdrop.addEventListener('click', closeToc);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeToc(); });
  window.addEventListener('scroll', syncActive, { passive: true });
  new MutationObserver(function () { fillToc(); }).observe(app, { childList: true, subtree: true });
  fillToc();
})();
