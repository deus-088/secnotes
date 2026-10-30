/* ============================================================================
   SecNotes 首页 v2 · 舞台交互
   ----------------------------------------------------------------------------
   只做视觉：字带漂移、玻璃球折射、双光标、入场、顶栏两态。
   搜索、统计、分类这些业务逻辑仍归 app.js —— 本文件不碰 state、不写数据。
   hidden 时完全停掉 rAF（由 app.js 通过 HomeHero.setActive 控制）。
   ========================================================================== */
(function () {
  'use strict';

  var hero = document.getElementById('homeHero');
  if (!hero) return;

  var stage = document.getElementById('hhStage');
  var ball = document.getElementById('hhBall');
  var beam = document.getElementById('hhBeam');
  var canvas = document.getElementById('hhCanvas');
  var copy = document.getElementById('hhCopy');
  var tracks = [].slice.call(hero.querySelectorAll('[data-hh-track]'));
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* jsdom 等环境没有 canvas 2D 上下文：此时跳过折射绘制，
     字带与光标仍正常工作，绝不抛未捕获异常 */
  var dst = (canvas && canvas.getContext) ? canvas.getContext('2d') : null;
  var srcCanvas = document.createElement('canvas');
  var src = (dst && srcCanvas.getContext) ? srcCanvas.getContext('2d') : null;

  var WORD = 'Deus\'s Blog', COUNT = 5;
  var STRENGTH = 1.1;     // 折射强度：>1 边缘折叠
  var SPEED = 46;         // 字带漂移 px/s
  var DPR = Math.min(2, window.devicePixelRatio || 1);

  var active = false;
  var rafId = 0, lastT = 0;
  var off = 0, unit = 0, floatY = 0;
  var bx = 0, by = 0;
  /* 初始光标位置取屏幕中部偏上（与设计稿一致）；用 0,0 会把球拽向左上角 */
  var mx = window.innerWidth / 2, my = window.innerHeight * 0.42;
  var rx = mx, ry = my;
  var stageW = 0, stageH = 0, bandCY = 0, ballR = 200;
  var fontStr = '', letterSp = '';

  /* ---------- 测量 ---------- */
  function measure() {
    var r = stage.getBoundingClientRect();
    stageW = r.width;
    stageH = r.height;
    /* 球心高度由 CSS 变量给，窄屏会换成 24%，避免与标题相撞 */
    var cyVar = parseFloat(window.getComputedStyle(stage).getPropertyValue('--hh-cy')) || 29;
    bandCY = stageH * cyVar / 100;
    ballR = ball.offsetWidth / 2;

    var sp = tracks[0].firstElementChild;
    if (sp) {
      var cs = window.getComputedStyle(sp);
      unit = sp.getBoundingClientRect().width;
      fontStr = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      letterSp = cs.letterSpacing;
    }
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!dst || !src) return;
    var size = Math.max(4, Math.round(ballR * 2));
    canvas.width = srcCanvas.width = Math.round(size * DPR);
    canvas.height = srcCanvas.height = Math.round(size * DPR);
    dst.setTransform(DPR, 0, 0, DPR, 0, 0);
    src.setTransform(DPR, 0, 0, DPR, 0, 0);
    src.imageSmoothingEnabled = dst.imageSmoothingEnabled = true;
    src.imageSmoothingQuality = dst.imageSmoothingQuality = 'high';
  }

  /* ---------- 球面折射 ----------
     每列向心采样 f(r)=0.86/(1+1.1·r³)：球心略放大，边缘拉长直到折叠。
     只做横向重采样——垂直缩放会让笔画变粗糊成白块。 */
  function drawLens() {
    if (!dst || !src) return;
    var size = Math.round(ballR * 2);
    if (size < 8 || !fontStr) return;

    src.clearRect(0, 0, size, size);
    src.font = fontStr;
    src.textBaseline = 'middle';
    src.fillStyle = '#f3f8fa';
    src.filter = 'blur(5px)';
    try { src.letterSpacing = letterSp; } catch (e) { /* 老浏览器忽略 */ }

    var cx = stageW / 2 + bx;
    for (var i = 0; i < COUNT; i++) {
      var x = off + i * unit - (cx - ballR);
      if (x > size + 40 || x + unit < -40) continue;
      src.fillText(WORD, x, ballR + floatY - by + 6);
    }
    src.filter = 'none';

    dst.clearRect(0, 0, size, size);
    if (window.innerWidth < 700) {
      /* 窄屏不做扭曲：一个字就撑满球，折起来只会更糊 */
      dst.drawImage(srcCanvas, 0, 0, size * DPR, size * DPR, 0, 0, size, size);
      return;
    }
    var a = STRENGTH;
    for (var x2 = 0; x2 < size; x2++) {
      var dx = x2 + 0.5 - ballR;
      var r = Math.min(1, Math.abs(dx) / ballR);
      var f = 0.86 / (1 + a * r * r * r);
      var sx = ballR + dx * f;
      dst.drawImage(srcCanvas, (sx - 0.5) * DPR, 0, DPR, size * DPR, x2, 0, 1, size);
    }
    /* 球面暗角 */
    var g = dst.createRadialGradient(ballR, ballR, ballR * 0.25, ballR, ballR, ballR);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    dst.fillStyle = g;
    dst.fillRect(0, 0, size, size);
  }

  /* ---------- 主循环 ---------- */
  function frame(now) {
    if (!active) { rafId = 0; return; }
    var dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0;
    lastT = now;

    if (unit) {
      off -= SPEED * dt;
      if (off <= -unit) off += unit;
    }
    floatY = Math.sin(now / 1000 * 0.6) * 13;

    var tf = 'translate3d(' + off.toFixed(2) + 'px,' + floatY.toFixed(2) + 'px,0)';
    for (var i = 0; i < tracks.length; i++) tracks[i].style.transform = tf;

    /* 玻璃球只吃 10% 鼠标位移 */
    var tx = (mx - stageW / 2) * 0.1;
    var ty = (my - bandCY) * 0.1;
    bx += (tx - bx) * 0.07;
    by += (ty - by) * 0.07;
    hero.style.setProperty('--hh-bx', bx.toFixed(2) + 'px');
    hero.style.setProperty('--hh-by', by.toFixed(2) + 'px');

    drawLens();

    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (active || reduced) return;
    /* 没有 canvas 2D 上下文（jsdom / 极端降级）时不跑动画循环：
       画不出折射，字带动起来也没意义，反而拖慢懒加载与测试时序 */
    if (!dst) return;
    active = true;
    lastT = 0;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }
  function stop() {
    active = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  /* ---------- 双光标（首页全域：舞台 + 第二屏 + 顶栏） ----------
     挂在 body 上、监听 document：舞台上只是首页的一段，第二屏和顶栏同样要有。
     可见性与 cursor:none 都由 body.is-home 控制，进笔记库自动失效。 */
  var curDot = null, curRing = null;
  if (fine) {
    curDot = document.createElement('div');
    curDot.className = 'hh-cur hh-cur-dot';
    curRing = document.createElement('div');
    curRing.className = 'hh-cur hh-cur-ring';
    curRing.setAttribute('aria-hidden', 'true');
    curDot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(curDot);
    document.body.appendChild(curRing);

    document.addEventListener('pointermove', function (e) {
      mx = e.clientX; my = e.clientY;
      curDot.style.transform = 'translate3d(' + mx + 'px,' + my + 'px,0)';
    }, { passive: true });

    var HOT = 'a, button, input, textarea, select, label, .card, .btn, [data-scroll-cats]';
    document.addEventListener('pointerover', function (e) {
      if (!e.target.closest || !e.target.closest(HOT)) return;
      document.body.classList.add('hh-hot');
    }, { passive: true });
    document.addEventListener('pointerout', function (e) {
      if (!e.target.closest || !e.target.closest(HOT)) return;
      document.body.classList.remove('hh-hot');
    }, { passive: true });

    /* 圆环延迟跟随 */
    (function ringLoop() {
      if (!curRing) return;
      rx += (mx - rx) * 0.16;
      ry += (my - ry) * 0.16;
      curRing.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)';
      requestAnimationFrame(ringLoop);
    })();
  }
  /* 没有自定义光标时，球仍然要看鼠标 */
  if (!fine) {
    mx = window.innerWidth / 2;
    my = stageH * 0.29 || 200;
  }
  hero.addEventListener('pointermove', function (e) { mx = e.clientX; my = e.clientY; }, { passive: true });

  /* ---------- 顶栏两态 ---------- */
  var topbar = document.querySelector('.topbar');
  var ticking = false;

  /* 上滑时舞台内容渐隐上浮：这是设计稿里「滑动的渐消失」那层 */
  function syncCopyFade() {
    if (!copy) return;
    var y = window.scrollY || window.pageYOffset || 0;
    var h = stageH || window.innerHeight;
    if (y > h * 0.9) return;
    copy.style.transform = 'translateY(' + (y * 0.12).toFixed(1) + 'px)';
    copy.style.opacity = Math.max(0, 1 - y / (h * 0.62)).toFixed(3);
  }

  function syncStuck() {
    if (!topbar) return;
    if (!document.body.classList.contains('is-home')) {
      topbar.classList.remove('is-stuck');
      return;
    }
    var y = window.scrollY || window.pageYOffset || 0;
    var h = stageH || window.innerHeight;
    topbar.classList.toggle('is-stuck', y > 40);
    /* 滚过舞台 75% 之后落回主题玻璃，避免浅色页面顶上压一块黑条 */
    topbar.classList.toggle('is-past', y > h * 0.75);
    syncCopyFade();
  }
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; syncStuck(); });
  }, { passive: true });

  /* ---------- 入场 ---------- */
  function playIn() {
    var els = hero.querySelectorAll('.hh-rv');
    for (var i = 0; i < els.length; i++) {
      (function (el, i) {
        setTimeout(function () { el.classList.add('in'); }, 90 + i * 95);
      })(els[i], i);
    }
  }

  /* 「按分类查找」：滚到第二屏的分类区（该区由 app.js 动态渲染，走事件委托） */
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-scroll-cats]') : null;
    if (!t) return;
    e.preventDefault();
    var box = document.getElementById('hsCats');
    if (box) box.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  });

  window.addEventListener('resize', function () { measure(); }, { passive: true });

  measure();
  syncStuck();
  if (!reduced) playIn();
  else {
    var rvs = hero.querySelectorAll('.hh-rv');
    for (var k = 0; k < rvs.length; k++) rvs[k].classList.add('in');
  }

  /* app.js 在路由切换时调用：首页才跑，其他页面彻底停掉 */
  window.HomeHero = {
    setActive: function (on) {
      if (on) {
        measure();
        syncStuck();
        start();
      } else {
        stop();
        if (topbar) topbar.classList.remove('is-stuck');
      }
    }
  };

  if (!hero.hidden) start();
})();
