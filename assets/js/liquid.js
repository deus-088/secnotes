/* ============================================================================
   SecNotes · Liquid Glass 行为层
   ----------------------------------------------------------------------------
   只做「交互物理」，不负责渲染内容：内容仍由 app.js / render.js 生成，
   本文件在渲染完成后挂接材质反馈与手势。

   与 WWDC「Designing Fluid Interfaces」的对应关系：
     · 按下即反馈        → :active 在 pointerdown 阶段就产生形变（CSS）
     · 直接操纵 1:1      → 抽屉位移 = 手指位移，保留抓取偏移
     · 可中途打断        → 每次 pointerdown 读取当前 transform 作为起点，不播完旧动画
     · 弹簧而非时长      → 释放后由 CSS linear() 弹簧曲线接管（阻尼比/响应时间）
     · 速度移交          → 释放速度直接进入动量投射公式，参与吸附点判定
     · 橡胶边界          → 越过开合边界按 Apple rubberband 公式阻尼
     · 动效可关闭        → prefers-reduced-motion 下全部手势与入场动画直接落位

   GitHub Pages 约束：
     · 纯原生，无构建、无模块、无外部依赖；file:// 与 https:// 均可运行
     · 不使用 import / export，避免 Pages 上没有打包器时的模块解析问题
   ========================================================================== */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;

  var mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var mqMobile = window.matchMedia('(max-width: 900px)');

  function reduced() { return mqMotion.matches; }
  function isMobile() { return mqMobile.matches; }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* Apple rubberband：越界距离按 1 - 1/(d*k/D + 1) 收敛，永远到不了硬边界 */
  function rubber(distance, dimension, constant) {
    var k = constant == null ? 0.55 : constant;
    var d = Math.abs(distance);
    var mapped = (1 - 1 / ((d * k) / dimension + 1)) * dimension;
    return distance < 0 ? -mapped : mapped;
  }

  /* 动量投射：decelerationRate 0.998 对应普通滚动的衰减手感 */
  function project(velocity, rate) {
    var r = rate == null ? 0.998 : rate;
    return (velocity / 1000) * r / (1 - r);
  }

  function raf(fn) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        fn();
      });
    };
  }

  /* ---------------------------------------------------------------- 滑动指示块 */
  function makeGlider(host, itemSelector) {
    if (!host) return { move: function () {} };

    var tag = host.tagName === 'UL' ? 'li' : 'span';
    var g = doc.createElement(tag);
    g.className = 'glider';
    g.setAttribute('aria-hidden', 'true');
    host.insertBefore(g, host.firstChild);

    var lastKey = '';

    return {
      move: function () {
        /* 侧栏分类列表由 app.js 在启动后整体写入 innerHTML，
           首次插入的指示块会被覆盖掉，这里按需补回。 */
        if (!g.isConnected) host.insertBefore(g, host.firstChild);

        var a = host.querySelector(itemSelector + '.active');
        if (!a || !a.offsetWidth || a.offsetParent === null) {
          g.style.opacity = '0';
          lastKey = '';
          return;
        }
        var key = a.offsetLeft + ':' + a.offsetTop + ':' + a.offsetWidth + ':' + a.offsetHeight;
        if (key === lastKey) return;     // 位置没变就不触发过渡
        lastKey = key;
        g.style.transform = 'translate3d(' + a.offsetLeft + 'px,' + a.offsetTop + 'px,0)';
        g.style.width = a.offsetWidth + 'px';
        g.style.height = a.offsetHeight + 'px';
        g.style.opacity = '1';
      }
    };
  }

  /* ---------------------------------------------------------------- 抽屉手势 */
  function bindDrawer(el, cfg) {
    if (!el) return;

    var side = cfg.side;                     // 'left' | 'right'
    var openClass = cfg.openClass;           // body 上的状态类
    var drag = null;
    var lastX = 0;

    function width() { return el.offsetWidth || 300; }
    function isOpen() { return doc.body.classList.contains(openClass); }

    function readX() {
      var t = window.getComputedStyle(el).transform;
      if (!t || t === 'none') return 0;
      var m = t.match(/matrix(3d)?\(([^)]+)\)/);
      if (!m) return 0;
      var v = m[2].split(',');
      return parseFloat(m[1] ? v[12] : v[4]) || 0;
    }

    function setTx(x) {
      lastX = x;
      el.style.setProperty('--tx', x.toFixed(2) + 'px');
    }

    function closedX() {
      return side === 'left' ? -(width() + 16) : (width() + 16);
    }

    function paintProgress(x) {
      var p = 1 - Math.abs(x) / Math.abs(closedX());
      doc.body.style.setProperty('--drawer-p', clamp(p, 0, 1).toFixed(3));
    }

    function velocity() {
      if (!drag || drag.samples.length < 2) return 0;
      var s = drag.samples;
      var dt = (s[s.length - 1][0] - s[0][0]) / 1000;
      if (dt <= 0.001) return 0;
      return (s[s.length - 1][1] - s[0][1]) / dt;
    }

    function sample(t, x) {
      drag.samples.push([t, x]);
      while (drag.samples.length > 2 && t - drag.samples[0][0] > 120) drag.samples.shift();
    }

    /* 释放：由弹簧曲线接管，从当前位置连续过渡，不重置到起点 */
    function settle(open) {
      if (!drag) return;
      var x = lastX;
      var id = drag.id;
      drag = null;

      el.classList.remove('is-dragging');
      setTx(x);                              // 固定当前位置
      void el.offsetWidth;                    // 强制提交样式，保证过渡起点正确
      doc.body.classList.toggle(openClass, open);
      el.style.removeProperty('--tx');        // 交给 CSS 状态类给出目标位置
      doc.body.style.removeProperty('--drawer-p');
      try { el.releasePointerCapture(id); } catch (err) { /* 忽略 */ }
    }

    function onDown(e) {
      if (!isMobile()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      var base = readX();
      drag = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        base: base,
        axis: null,
        samples: [[performance.now(), e.clientX]]
      };
      setTx(base);
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }

    function onMove(e) {
      if (!drag || e.pointerId !== drag.id) return;

      var dx = e.clientX - drag.x0;
      var dy = e.clientY - drag.y0;

      if (!drag.axis) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        if (drag.axis === 'y') {               // 纵向交给页面滚动
          var vid = drag.id;
          drag = null;
          el.classList.remove('is-dragging');
          el.style.removeProperty('--tx');
          try { el.releasePointerCapture(vid); } catch (err) { /* 忽略 */ }
          return;
        }
        el.classList.add('is-dragging');
      }

      sample(performance.now(), e.clientX);

      var x = drag.base + dx;
      var closed = closedX();

      if (side === 'left') {
        if (x > 0) x = rubber(x, width());                       // 越过完全展开
        else if (x < closed) x = closed + rubber(x - closed, width());
      } else {
        if (x < 0) x = rubber(x, width());
        else if (x > closed) x = closed + rubber(x - closed, width());
      }

      setTx(x);
      paintProgress(x);
      e.preventDefault();
    }

    function onUp(e) {
      if (!drag || e.pointerId !== drag.id) return;

      var v = velocity();
      var projected = lastX + project(v);

      var open;
      if (side === 'left') open = projected > -width() * 0.5;
      else open = projected < width() * 0.5;

      /* 轻扫优先：朝着开方向超过 0.45px/ms 就直接开，避免慢速拖到大半却被判关闭 */
      if (v > 0.45 && side === 'left') open = true;
      if (v < -0.45 && side === 'right') open = true;
      if (v < -0.45 && side === 'left') open = false;
      if (v > 0.45 && side === 'right') open = false;

      settle(open);
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }

    el.addEventListener('pointerdown', onDown, { passive: true });
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', function () {
      if (drag) settle(isOpen());
    });

    /* 边缘右滑唤出（仅左侧抽屉，且仅在关闭态） */
    if (side === 'left') {
      doc.addEventListener('pointerdown', function (e) {
        if (!isMobile() || isOpen()) return;
        if (e.clientX > 24) return;
        if (doc.body.classList.contains('toc-open')) return;
        if (e.target.closest && e.target.closest('.sidebar')) return;

        doc.body.classList.add(openClass);
        el.classList.add('is-dragging');
        setTx(closedX());
        paintProgress(closedX());            // 起点必须是全透明，否则会闪一下遮罩
        drag = {
          id: e.pointerId,
          x0: e.clientX,
          y0: e.clientY,
          base: closedX(),
          axis: 'x',
          samples: [[performance.now(), e.clientX]]
        };
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }, { passive: true });
    }
  }

  /* ---------------------------------------------------------------- 顶栏与进度 */
  var topbar = doc.querySelector('.topbar');

  var onScroll = raf(function () {
    if (topbar) topbar.classList.toggle('is-scrolled', window.pageYOffset > 8);
  });

  /* ---------------------------------------------------------------- 指针高光 */
  /* 指针高光：只在指针进入卡片时取一次 rect，移动时不再查询 DOM 与布局。
     滚动导致 rect 失效时，用 pageYOffset 变化检测并重取一次。 */
  var sheenEl = null;
  var sheenRect = null;
  var sheenScroll = 0;
  var sheenPoint = null;

  var paintSheen = raf(function () {
    if (!sheenEl || !sheenPoint) return;
    sheenEl.style.setProperty('--mx', sheenPoint[0] + 'px');
    sheenEl.style.setProperty('--my', sheenPoint[1] + 'px');
  });

  function onPointerOver(e) {
    if (reduced() || e.pointerType !== 'mouse') return;
    var t = e.target;
    var el = t && t.closest ? t.closest('.note-card, .hero, .load-more, .side-list a, .tag, .tag-cloud-lg a') : null;
    if (el === sheenEl) return;
    sheenEl = el;
    sheenRect = el ? el.getBoundingClientRect() : null;
    sheenScroll = window.pageYOffset;
    /* 进入瞬间就落位，否则第一帧会停在上一次的位置再跳过去 */
    if (el && sheenRect) {
      sheenPoint = [e.clientX - sheenRect.left, e.clientY - sheenRect.top];
      paintSheen();
    }
  }

  function onPointerMove(e) {
    if (!sheenEl || e.pointerType !== 'mouse') return;
    var sy = window.pageYOffset;
    if (sy !== sheenScroll) {
      sheenScroll = sy;
      sheenRect = sheenEl.getBoundingClientRect();
    }
    sheenPoint = [e.clientX - sheenRect.left, e.clientY - sheenRect.top];
    paintSheen();
  }

  /* ---------------------------------------------------------------- 入场编排 */
  function playEntrance() {
    if (reduced()) return;
    var app = doc.getElementById('app');
    if (!app) return;

    var els = app.querySelectorAll('.animate');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.dataset.anim === '1') continue;
      el.dataset.anim = '1';
      if (typeof el.animate !== 'function') continue;

      var delay = Math.min(i, 8) * 28;
      var anim = el.animate(
        [
          { opacity: 0, transform: 'translateY(10px) scale(0.996)' },
          { opacity: 1, transform: 'none' }
        ],
        {
          duration: 520,
          delay: delay,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'backwards'
        }
      );

      /* 兜底：动画结束后必须把填充状态清掉。
         标签页被挂起、合成器时间轴不推进（无头截图、部分省电模式）时，
         动画会停在 first-frame（opacity:0），内容就「渲染了但看不见」。 */
      (function (a, wait) {
        var done = function () {
          try { a.cancel(); } catch (err) { /* 忽略 */ }
        };
        if (a && a.addEventListener) a.addEventListener('finish', done);
        setTimeout(done, wait + 560);
      })(anim, delay);
    }
  }

  /* ---------------------------------------------------------------- 主题切换 */
  function themeSwap(run, button) {
    if (reduced() || typeof doc.startViewTransition !== 'function') {
      run();
      return;
    }

    var r = button && button.getBoundingClientRect
      ? button.getBoundingClientRect()
      : { left: window.innerWidth / 2, top: 0, width: 0, height: 0 };
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    var radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    var vt;
    try { vt = doc.startViewTransition(run); } catch (e) { run(); return; }
    if (!vt || !vt.ready) return;

    vt.ready.then(function () {
      root.animate(
        {
          clipPath: [
            'circle(0px at ' + x + 'px ' + y + 'px)',
            'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)'
          ]
        },
        {
          duration: 520,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          pseudoElement: '::view-transition-new(root)'
        }
      );
    }).catch(function () { /* 过渡不可用时已经完成切换 */ });
  }

  /* ---------------------------------------------------------------- 启动 */
  var gliderTop = null;
  var entranceRaf = null;

  /* Hero 的流动高光只在可见时播放：无限动画会让合成器一直有活干 */
  var heroObserver = window.IntersectionObserver
    ? new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          entries[i].target.classList.toggle('is-paused', !entries[i].isIntersecting);
        }
      }, { rootMargin: '120px' })
    : null;

  function watchHero() {
    if (!heroObserver) return;
    var hero = doc.querySelector('#app .hero');
    if (hero && hero.dataset.heroWatched !== '1') {
      hero.dataset.heroWatched = '1';
      heroObserver.observe(hero);
    }
  }

  function afterRender() {
    if (gliderTop) gliderTop.move();
    playEntrance();
    watchHero();
  }

  function boot() {
    /* 分类项本身已是玻璃胶囊，不再需要滑动指示块；
       顶栏仍是纯文字，保留指示块表达选中态。 */
    gliderTop = makeGlider(doc.getElementById('topnav'), 'a');

    bindDrawer(doc.getElementById('sidebar'), { side: 'left', openClass: 'nav-open' });
    bindDrawer(doc.getElementById('tocDrawer'), { side: 'right', openClass: 'toc-open' });

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    doc.addEventListener('pointerover', onPointerOver, { passive: true });
    doc.addEventListener('pointermove', onPointerMove, { passive: true });
    doc.addEventListener('pointerout', function (e) {
      if (!sheenEl) return;
      var to = e.relatedTarget;
      if (to && sheenEl.contains(to)) return;
      sheenEl = null;
      sheenRect = null;
    }, { passive: true });

    /* 动态内容（加载更多、路由切换）也走同一套入场编排 */
    var app = doc.getElementById('app');
    if (app && window.MutationObserver) {
      new MutationObserver(function () {
        if (entranceRaf) return;
        entranceRaf = requestAnimationFrame(function () {
          entranceRaf = null;
          afterRender();
        });
      }).observe(app, { childList: true, subtree: true });
    }

    /* 抽屉状态会随视口宽度失效，跨断点时清掉，避免遮罩在桌面端挡住点击 */
    var resetDrawers = function () {
      if (isMobile()) return;
      doc.body.classList.remove('nav-open', 'toc-open');
      doc.body.style.removeProperty('--drawer-p');
      var sb = doc.getElementById('sidebar');
      var td = doc.getElementById('tocDrawer');
      if (sb) sb.style.removeProperty('--tx');
      if (td) td.style.removeProperty('--tx');
    };
    if (mqMobile.addEventListener) mqMobile.addEventListener('change', resetDrawers);
    else if (mqMobile.addListener) mqMobile.addListener(resetDrawers);

    afterRender();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* app.js 在每次 render 结束后调用，保证指示块与入场动画跟着新内容走 */
  window.LiquidUI = {
    afterRender: afterRender,
    themeSwap: themeSwap
  };
})();
