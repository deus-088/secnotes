(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const site = () => window.SEC_BLOG?.config || {};
  const mascot = $('#companionToggle');
  const mascotMessage = $('#companionMessage');
  const tocButton = $('#tocBtn');
  const tocDrawer = $('#tocDrawer');
  const imageViewer = $('#imageViewer');
  const topbar = $('.topbar');
  const profilePanel = $('#profilePanel');
  const dialogs = new Map();
  const floatingPanels = new Map();
  const boundDialogs = new WeakSet();
  let messageTimer;
  let themeTransition;
  let imageTrigger;
  let activeView;
  let initialRoute = true;
  let categoryCloud;
  let cloudResizeObserver;
  let cloudWidth = 0;
  let scrollPresentationFrame = 0;
  const popoverAnimations = new Map();

  function clearPopoverPosition(element) {
    ['position', 'inset', 'margin', 'max-height', 'left', 'top'].forEach(property =>
      element.style.removeProperty(property));
  }

  function triggerBounds(trigger) {
    const bounds = trigger?.getBoundingClientRect?.() || trigger;
    return bounds?.width ? bounds : $('#menuBtn').getBoundingClientRect();
  }

  // Keep popovers close to their control, below the navigation and inside the viewport.
  function positionPopover(element, trigger) {
    const source = triggerBounds(trigger);
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft || 0) + 12;
    const rightEdge = leftEdge + (viewport?.width || document.documentElement.clientWidth) - 24;
    const topEdge = Math.max((viewport?.offsetTop || 0) + 12, topbar.getBoundingClientRect().bottom + 12);
    const bottomEdge = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) - 12;
    const available = Math.max(80, bottomEdge - topEdge);
    Object.assign(element.style, {
      position: 'fixed', inset: 'auto', margin: '0',
      maxHeight: available + 'px'
    });
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const below = Math.max(topEdge, source.bottom + 12);
    const above = source.top - height - 12;
    const top = below + height <= bottomEdge ? below : above >= topEdge ? above :
      Math.max(topEdge, Math.min(below, bottomEdge - height));
    const left = Math.max(leftEdge, Math.min(source.right - width, rightEdge - width));
    element.style.left = left + 'px';
    element.style.top = top + 'px';
  }

  function closeDialog(dialog, afterClose, instant = false) {
    const entry = dialogs.get(dialog);
    if (!dialog.open || (entry?.closing && !instant)) return;
    if (entry) entry.closing = true;
    const finish = () => {
      dialogs.delete(dialog);
      dialog.close();
      clearPopoverPosition(entry?.surface || dialog);
      if (dialog === profilePanel) $('#menuBtn').setAttribute('aria-expanded', 'false');
      afterClose?.();
    };
    if (!entry || instant) {
      const animation = popoverAnimations.get(entry?.surface)?.animation;
      if (animation) { animation.onfinish = null; animation.cancel(); }
      popoverAnimations.delete(entry?.surface);
      entry?.surface.style.removeProperty('will-change');
      finish();
    } else animatePopover(entry.surface, false, entry.source, finish);
  }

  function openDialog(dialog, trigger, surface = dialog) {
    if (dialog.open && !dialogs.get(dialog)?.closing) return;
    const source = triggerBounds(trigger);
    const parentDialog = trigger?.closest?.('dialog[open]');
    for (const other of dialogs.keys()) {
      if (other !== dialog && other !== parentDialog) closeDialog(other, undefined, true);
    }
    closeToc();
    if (document.body.classList.contains('nav-open')) $('#navClose').click();
    if (!dialog.open) dialog.showModal();
    positionPopover(surface, source);
    dialogs.set(dialog, { surface, source, trigger, closing: false });
    if (!boundDialogs.has(dialog)) {
      boundDialogs.add(dialog);
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog); });
      dialog.addEventListener('click', event => {
        const bounds = surface.getBoundingClientRect();
        if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right ||
            event.clientY < bounds.top || event.clientY > bounds.bottom)) closeDialog(dialog);
      });
    }
    animatePopover(surface, true, source);
  }

  function showFloating(element, trigger) {
    element.hidden = false;
    floatingPanels.set(element, trigger);
    element.dataset.popupState = 'open';
    positionPopover(element, trigger);
    animatePopover(element, true, trigger);
  }

  function hideFloating(element) {
    const trigger = floatingPanels.get(element);
    if (!trigger || element.dataset.popupState === 'closing') return;
    element.dataset.popupState = 'closing';
    animatePopover(element, false, trigger, () => {
      element.hidden = true;
      clearPopoverPosition(element);
      if (trigger.matches?.('[data-reward], #catToggle')) trigger.setAttribute('aria-expanded', 'false');
      delete element.dataset.popupState;
      floatingPanels.delete(element);
    });
  }

  function openProfile() {
    const button = $('#menuBtn');
    if (profilePanel.open && !dialogs.get(profilePanel)?.closing) closeDialog(profilePanel);
    else openDialog(profilePanel, button);
    button.setAttribute('aria-expanded', String(profilePanel.open && !dialogs.get(profilePanel)?.closing));
  }

  // Sample a damped spring once; the browser plays only transform and opacity.
  function animatePopover(element, opening, trigger, onFinish = () => {}) {
    const previous = popoverAnimations.get(element);
    const current = previous ? getComputedStyle(element) : null;
    const matrix = current ? new DOMMatrixReadOnly(current.transform) : null;
    const opacity = current ? Number(current.opacity) : opening ? 0 : 1;
    previous?.animation.cancel();
    popoverAnimations.delete(element);

    if (reducedMotion.matches || !element.animate) {
      element.style.removeProperty('will-change');
      onFinish();
      return;
    }

    const bounds = element.getBoundingClientRect();
    const source = triggerBounds(trigger);
    const compact = {
      x: source.left + source.width / 2 - bounds.left - bounds.width / 2,
      y: source.top + source.height / 2 - bounds.top - bounds.height / 2,
      scale: Math.max(.06, Math.min(.16, source.width / bounds.width, source.height / bounds.height))
    };
    const full = { x: 0, y: 0, scale: 1 };
    const from = matrix ? { x: matrix.m41, y: matrix.m42, scale: matrix.a } : opening ? compact : full;
    const to = opening ? full : compact;
    const duration = opening ? 700 : 240;
    const damping = opening ? 26 : 38;
    const stiffness = opening ? 380 : 600;
    const decay = damping / 2;
    const frequency = Math.sqrt(stiffness - decay * decay);
    const response = time => 1 - Math.exp(-decay * time) *
      (Math.cos(frequency * time) + decay / frequency * Math.sin(frequency * time));
    const end = response(duration / 1000);
    const frames = Array.from({ length: 61 }, (_, index) => {
      const offset = index / 60;
      const progress = response(offset * duration / 1000) / end;
      const x = from.x + (to.x - from.x) * progress;
      const y = from.y + (to.y - from.y) * progress;
      const scale = from.scale + (to.scale - from.scale) * progress;
      return {
        offset,
        transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
        opacity: opening ? opacity + (1 - opacity) * Math.min(1, offset / .16) :
          opacity * (1 - Math.min(1, offset / .85))
      };
    });
    element.style.willChange = 'transform, opacity';
    const animation = element.animate(frames, { duration, fill: 'both', easing: 'linear' });
    const finish = () => {
      animation.cancel();
      popoverAnimations.delete(element);
      element.style.removeProperty('will-change');
      onFinish();
    };
    animation.onfinish = finish;
    popoverAnimations.set(element, { animation, finish });
  }

  function finishPopovers() {
    [...popoverAnimations.values()].forEach(entry => entry.finish());
  }

  function webURL(value) {
    if (!value) return '';
    try {
      const url = new URL(value);
      return /^(https?):$/.test(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  function localImage(value) {
    if (/^assets\/(?:[\w.-]+\/)*[\w.-]+\.(png|jpe?g|webp|gif|svg)$/i.test(value || '') &&
        !value.split('/').includes('..')) return value;
    return webURL(value);
  }

  function identity() {
    const config = site();
    return {
      brand: config.brand || "Deus's Blog",
      author: config.author || 'Deus',
      description: config.description || '',
      url: webURL(config.siteUrl)
    };
  }

  function rewardSection() {
    const methods = [['wechat', '微信'], ['alipay', '支付宝'], ['paypal', 'PayPal'], ['qq', 'QQ']];
    const buttons = methods.map(([key, label]) =>
      '<button class="surface-button" type="button" data-reward="' + key +
      '" aria-expanded="false" aria-controls="rewardPanel">' + label + '</button>').join('');
    return '<section class="article-extras" aria-label="支持作者"><strong>支持作者</strong>' +
      '<div class="reward-options">' + buttons + '</div><div id="rewardPanel" class="reward-panel" aria-live="polite" hidden></div></section>';
  }

  function articleExtras() {
    return rewardSection();
  }

  function page(name, data) {
    const info = identity();
    const config = site();
    const titles = { links: '友情链接', categories: '所有分类', about: '关于我' };
    const title = titles[name];
    if (!title) return '';
    document.title = title + ' · ' + info.brand;

    const crumbs = '<nav class="crumbs" aria-label="当前位置"><a href="#/">' + esc(info.brand) +
      '</a><span> / </span><span>' + title + '</span></nav>';
    let main;
    if (name === 'categories') {
      const cats = (data.categories || []).map(([category, count]) =>
        '<li><a href="#/category/' + encodeURIComponent(category) + '">' +
        esc(category) + '<span>' + Number(count) + '</span></a></li>').join('');
      main = cats ? '<ul class="category-overview">' + cats + '</ul>' : '<p class="component-status">暂无分类。</p>';
    } else if (name === 'links') {
      const friends = Array.isArray(config.friends) ? config.friends : [];
      const links = friends.filter(item => item && webURL(item.url)).map(item =>
        '<li><a href="' + esc(webURL(item.url)) + '" target="_blank" rel="noopener noreferrer">' +
        esc(item.name || item.url) + ' ↗</a><p>' + esc(item.description) + '</p></li>').join('');
      main = (links ? '<ul class="friend-grid">' + links + '</ul>' : '<p class="component-status">暂无友链。</p>') +
        '<section class="page-section"><h2>交换友链</h2><p>申请时请附上站点名称、地址和简介。</p>' +
        '<dl class="site-details"><dt>名称</dt><dd>' + esc(info.brand) +
        '</dd><dt>地址</dt><dd>' + esc(info.url) + '</dd><dt>简介</dt><dd>' +
        esc(info.description) + '</dd></dl><button type="button" class="surface-button" data-copy-site>复制本站信息</button> ' +
        '<button type="button" class="surface-button" data-open-feedback>申请友链 →</button></section>';
    } else {
      const contacts = [['GitHub', 'https://github.com/deus-088']];
      if (config.contact?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contact.email)) {
        contacts.push(['电子邮件', 'mailto:' + config.contact.email]);
      }
      main = '<div class="profile-head"><img src="assets/brand-avatar.png" width="68" height="68" alt="">' +
        '<div><strong>' + esc(info.author) + '</strong><p>' + esc(config.about || info.description) + '</p></div></div>' +
        '<section class="page-section"><h2>联系我</h2><ul>' + contacts.map(([label, url]) =>
          '<li><a href="' + esc(url) + '">' + label + '</a></li>').join('') + '</ul></section>';
      if (Array.isArray(config.history) && config.history.length) {
        main += '<section class="page-section"><h2>站点历程</h2><ol>' +
          config.history.filter(Boolean).map(item => '<li><time>' + esc(item.date) + '</time> ' +
            esc(item.text) + '</li>').join('') + '</ol></section>';
      }
      if (Array.isArray(config.supporters) && config.supporters.length) {
        main += '<section class="page-section"><h2>打赏记录</h2><ul>' +
          config.supporters.filter(Boolean).map(person => '<li>' + esc(person.name) + ' · ' +
            esc(person.date) + ' ' + esc(person.message) + '</li>').join('') + '</ul></section>';
      }
    }
    return '<article class="public-page animate"><header>' + crumbs + '<h1>' + title + '</h1></header>' + main + '</article>';
  }

  function announce(message) {
    window.clearTimeout(messageTimer);
    mascotMessage.textContent = message;
    showFloating(mascotMessage, mascot);
    messageTimer = window.setTimeout(() => hideFloating(mascotMessage), 3300);
  }

  function closeToc() {
    if (!document.body.classList.contains('toc-open')) return;
    document.body.classList.remove('toc-open');
    document.body.classList.add('toc-closing');
    animatePopover(tocDrawer, false, tocButton, () => {
      clearPopoverPosition(tocDrawer);
      document.body.classList.remove('toc-closing');
    });
    tocDrawer.setAttribute('aria-hidden', 'true');
    tocButton.setAttribute('aria-expanded', 'false');
    if (tocDrawer.contains(document.activeElement) && !tocButton.hidden) {
      tocButton.focus({ preventScroll: true });
    }
  }

  function openToc() {
    if (document.body.classList.contains('nav-open')) $('#navClose').click();
    document.body.classList.add('toc-open');
    document.body.classList.remove('toc-closing');
    positionPopover(tocDrawer, tocButton);
    animatePopover(tocDrawer, true, tocButton);
    tocDrawer.setAttribute('aria-hidden', 'false');
    tocButton.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      if (document.body.classList.contains('toc-open')) $('#tocClose').focus({ preventScroll: true });
    });
  }

  function themeSwap(commit) {
    if (themeTransition) return;
    if (!reducedMotion.matches && document.startViewTransition) {
      themeTransition = document.startViewTransition(commit);
      themeTransition.finished.catch(() => {}).finally(() => { themeTransition = null; });
    } else commit();
  }

  function jsonRequest(url, options = {}) {
    return fetch(url, { credentials: 'omit', ...options }).then(response => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  function loadStatistics(signal, note) {
    const url = webURL(site().statistics?.endpoint);
    if (!url) {
      $$('[data-stat]').forEach(el => { el.title = '统计暂未开通'; });
      return;
    }
    const request = new URL(url);
    if (note) request.searchParams.set('slug', note.slug);
    jsonRequest(request.href, { signal }).then(result => {
      if (signal.aborted) return;
      $$('[data-stat]').forEach(el => {
        const value = result[el.dataset.stat];
        el.textContent = Number.isFinite(value) && value >= 0 ? value.toLocaleString('zh-CN') : '—';
      });
    }).catch(() => {});
  }

  function afterRender(route, note) {
    $('#menuBtn').setAttribute('aria-controls', document.body.classList.contains('is-home') ? 'sidebar' : 'profilePanel');
    $('#menuBtn').setAttribute('aria-label', document.body.classList.contains('is-home') ? '打开导航菜单' : '查看 Deus 的个人信息');
    for (const dialog of dialogs.keys()) closeDialog(dialog, undefined, true);
    for (const panel of floatingPanels.keys()) hideFloating(panel);
    positionNavHighlight();
    cloudResizeObserver?.disconnect();
    categoryCloud = $('.category-cloud');
    if (categoryCloud) {
      layoutCategoryCloud();
      if (window.ResizeObserver) {
        cloudResizeObserver = new ResizeObserver(entries => {
          if (Math.round(entries[0].contentRect.width) === cloudWidth) return;
          layoutCategoryCloud();
          scheduleScrollPresentation();
        });
        cloudResizeObserver.observe(categoryCloud);
      }
    }
    scheduleScrollPresentation();
    activeView?.abort();
    activeView = new AbortController();
    closeToc();
    loadStatistics(activeView.signal, note);
    $$('#postBody img').forEach(image => {
      if (image.closest('a')) return;
      image.tabIndex = 0;
      image.setAttribute('role', 'button');
      image.setAttribute('aria-label', '放大图片' + (image.alt ? ' ' + image.alt : ''));
    });
    if (initialRoute) {
      initialRoute = false;
      const hour = new Date().getHours();
      const hello = hour < 11 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
      announce(hello + '，欢迎来翻阅笔记。');
      const quoteUrl = webURL(site().quoteEndpoint);
      if (quoteUrl) jsonRequest(quoteUrl).then(result => {
        const line = result.hitokoto || result.text;
        if (typeof line === 'string' && line.trim()) $('#footerQuote').textContent = line;
      }).catch(() => {});
      const start = Date.parse(site().startedAt || '');
      if (Number.isFinite(start) && start <= Date.now()) {
        const uptime = $('#siteUptime');
        const tick = () => {
          const seconds = Math.floor((Date.now() - start) / 1000);
          uptime.textContent = '运行 ' + Math.floor(seconds / 86400) + ' 天 ' +
            Math.floor(seconds / 3600) % 24 + ' 小时 ' + Math.floor(seconds / 60) % 60 + ' 分钟';
        };
        uptime.hidden = false;
        tick();
        window.setInterval(tick, 30000);
      }
    } else if (route.name === 'note' && note) announce('正在阅读「' + note.title + '」');
  }

  function openImage(source) {
    if (!imageViewer.showModal || imageViewer.open) return;
    imageTrigger = source;
    const image = $('img', imageViewer);
    image.src = source.currentSrc || source.src;
    image.alt = source.alt;
    $('figcaption', imageViewer).textContent = source.alt;
    openDialog(imageViewer, source);
    if (!image.complete) image.addEventListener('load', () => {
      if (imageViewer.open) {
        finishPopovers();
        positionPopover(imageViewer, source);
      }
    }, { once: true });
  }

  function showReward(button) {
    const panel = $('#rewardPanel');
    const method = button.dataset.reward;
    const wasOpen = button.getAttribute('aria-expanded') === 'true';
    $$('[data-reward]').forEach(control => control.setAttribute('aria-expanded', 'false'));
    if (wasOpen) { hideFloating(panel); return; }
    button.setAttribute('aria-expanded', 'true');
    const config = site().reward?.[method] || {};
    const link = webURL(config.url);
    const code = localImage(config.image);
    panel.innerHTML = code ? '<img src="' + esc(code) + '" alt="' + esc(button.textContent) + '收款码">' :
      link ? '<a href="' + esc(link) + '" rel="noopener noreferrer" target="_blank">打开' +
      esc(button.textContent) + '打赏页面 ↗</a>' : '<p class="component-status">该方式待开通。</p>';
    showFloating(panel, button);
  }

  tocButton.setAttribute('aria-controls', 'tocDrawer');
  tocButton.setAttribute('aria-expanded', 'false');
  tocButton.addEventListener('click', () =>
    document.body.classList.contains('toc-open') ? closeToc() : openToc());
  $('#tocClose').addEventListener('click', closeToc);
  $('#backdrop').addEventListener('click', closeToc);
  $('#profileClose').addEventListener('click', () => closeDialog(profilePanel));
  $('#profileDirectory').addEventListener('click', () => {
    closeDialog(profilePanel, () => window.DeusSite.openDirectory());
  });
  $('#catToggle').addEventListener('click', event => {
    const panel = $('#footerCat');
    const opening = panel.hidden || panel.dataset.popupState === 'closing';
    if (opening) showFloating(panel, event.currentTarget);
    else hideFloating(panel);
    event.currentTarget.setAttribute('aria-expanded', String(opening));
  });
  mascot.addEventListener('click', () => {
    mascot.classList.remove('is-greeting');
    requestAnimationFrame(() => requestAnimationFrame(() => mascot.classList.add('is-greeting')));
    announce('嗨，我在这里陪你读。');
  });
  mascot.addEventListener('animationend', event => {
    if (event.animationName === 'mascot-hop') mascot.classList.remove('is-greeting');
  });
  $('#toTop').addEventListener('click', event => {
    const button = event.currentTarget;
    button.classList.add('is-launching');
    window.setTimeout(() => button.classList.remove('is-launching'), 450);
    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  });
  $('.skip-link').addEventListener('click', event => {
    event.preventDefault();
    $('#app').focus();
    $('#app').scrollIntoView();
  });
  $('.viewer-close', imageViewer).addEventListener('click', () => closeDialog(imageViewer));
  imageViewer.addEventListener('close', () => imageTrigger?.focus({ preventScroll: true }));
  document.addEventListener('seccodecopied', () => announce('代码已复制。'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeToc();
      for (const panel of floatingPanels.keys()) hideFloating(panel);
    }
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('#postBody img[role="button"]')) {
      event.preventDefault();
      openImage(event.target);
    }
  });
  document.addEventListener('click', event => {
    const target = event.target;
    if (target.matches('#postBody img[role="button"]')) openImage(target);
    const feedbackTrigger = target.closest('[data-open-feedback]');
    if (feedbackTrigger) window.SecFeedbackOpen?.(feedbackTrigger);
    for (const [panel, trigger] of floatingPanels) {
      if (!panel.contains(target) && !trigger.contains(target)) hideFloating(panel);
    }
    const method = target.closest('[data-reward]');
    if (method) showReward(method);
    const copy = target.closest('[data-copy-site]');
    if (copy) {
      const info = identity();
      const text = [info.brand, info.url, info.description].join('\n');
      const feedback = () => {
        copy.textContent = '已复制';
        window.setTimeout(() => { copy.textContent = '复制本站信息'; }, 1600);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(feedback, () => {
        copy.textContent = '复制失败';
      });
      else copy.textContent = '当前浏览器不支持复制';

    }
    if (event.detail > 0 && !target.closest('button,a,input,textarea,dialog') &&
        !reducedMotion.matches && window.matchMedia('(pointer: fine)').matches && !window.getSelection()?.toString()) {
      const spark = document.createElement('span');
      spark.className = 'pointer-spark';
      spark.style.left = event.clientX + 'px';
      spark.style.top = event.clientY + 'px';
      spark.style.setProperty('--dx', (Math.random() * 18 - 9) + 'px');
      spark.style.setProperty('--dy', '-16px');
      spark.setAttribute('aria-hidden', 'true');
      document.body.append(spark);
      window.setTimeout(() => spark.remove(), 550);
    }
  });
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const app = $('#app');
  let hoveredCard;
  let cardPointerFrame = 0;

  function resetCardPointer() {
    cancelAnimationFrame(cardPointerFrame);
    cardPointerFrame = 0;
    if (!hoveredCard) return;
    hoveredCard.style.removeProperty('--tilt-rx');
    hoveredCard.style.removeProperty('--tilt-ry');
    hoveredCard = null;
  }

  function trackCardPointer(event) {
    if (!finePointer.matches || reducedMotion.matches || event.pointerType !== 'mouse') return;
    const card = event.target.closest('.note-card');
    if (!card) return;
    if (card !== hoveredCard) resetCardPointer();
    hoveredCard = card;
    cancelAnimationFrame(cardPointerFrame);
    cardPointerFrame = requestAnimationFrame(() => {
      // The anchor stays flat while the inner surface tilts, keeping the pointer coordinates stable.
      const bounds = card.getBoundingClientRect();
      const x = Math.max(0, Math.min(event.clientX - bounds.left, bounds.width));
      const y = Math.max(0, Math.min(event.clientY - bounds.top, bounds.height));
      card.style.setProperty('--card-x', x + 'px');
      card.style.setProperty('--card-y', y + 'px');
      if (!card.classList.contains('feed-item') && bounds.width && bounds.height) {
        const maxTilt = 9;
        card.style.setProperty('--tilt-rx', (1 - 2 * y / bounds.height) * maxTilt + 'deg');
        card.style.setProperty('--tilt-ry', (2 * x / bounds.width - 1) * maxTilt + 'deg');
      }
    });
  }

  app.addEventListener('pointerover', trackCardPointer, { passive: true });
  app.addEventListener('pointermove', trackCardPointer, { passive: true });
  app.addEventListener('pointerout', event => {
    if (hoveredCard && !hoveredCard.contains(event.relatedTarget)) resetCardPointer();
  }, { passive: true });
  app.addEventListener('pointercancel', resetCardPointer);

  function bindWheelDamping() {
    const desktop = window.matchMedia('(min-width: 768px) and (any-pointer: fine)');
    let frame = 0;
    let target, position, lastApplied, lastTime;

    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    }

    function step(now) {
      if (window.scrollY !== lastApplied) {
        stop();
        return;
      }
      const elapsed = Math.max(1, now - lastTime);
      lastTime = now;
      const remaining = target - position;
      if (Math.abs(remaining) < 1) {
        window.scrollTo({ top: target, behavior: 'instant' });
        frame = 0;
        return;
      }
      // Time-based decay keeps the easing consistent across display refresh rates.
      position += remaining * (1 - Math.exp(-elapsed / 85));
      window.scrollTo({ top: position, behavior: 'instant' });
      lastApplied = window.scrollY;
      frame = requestAnimationFrame(step);
    }

    function canScrollInside(node, delta) {
      const scroller = document.scrollingElement;
      for (let el = node; el && el !== document.body && el !== scroller; el = el.parentElement) {
        if (el.scrollHeight <= el.clientHeight) continue;
        const style = getComputedStyle(el);
        if (!/^(auto|scroll)$/.test(style.overflowY)) continue;
        const bottom = el.scrollHeight - el.clientHeight;
        if ((delta > 0 ? el.scrollTop < bottom - 1 : el.scrollTop > 0) ||
            style.overscrollBehaviorY !== 'auto') return true;
      }
      return false;
    }

    window.addEventListener('wheel', event => {
      if (!desktop.matches || reducedMotion.matches || !event.cancelable || event.defaultPrevented ||
          event.ctrlKey || event.metaKey || event.shiftKey) return;
      const mode = event.deltaMode;
      const delta = event.deltaY;
      if (Math.abs(event.deltaX) >= Math.abs(delta)) return;
      if ($('dialog[open], .fb-overlay.open, body.nav-open, body.toc-open') ||
          canScrollInside(event.target, delta)) {
        stop();
        return;
      }

      const viewport = document.scrollingElement;
      const current = window.scrollY;
      const scale = mode === 1 ? 16 : mode === 2 ? viewport.clientHeight : 1;
      const start = frame && current === lastApplied ? target : current;
      const limit = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const next = Math.max(0, Math.min(start + delta * scale, limit));
      if (!frame && next === current) return;
      event.preventDefault();
      target = next;
      if (frame && current === lastApplied) return;
      stop();
      position = lastApplied = current;
      lastTime = performance.now();
      frame = requestAnimationFrame(step);
    }, { passive: false });
    window.addEventListener('hashchange', stop);
    window.addEventListener('resize', stop);
    window.addEventListener('keydown', stop);
    window.addEventListener('pointerdown', stop, { passive: true });
    desktop.addEventListener?.('change', stop);
    reducedMotion.addEventListener?.('change', stop);
  }

  bindWheelDamping();

  function layoutCategoryCloud() {
    if (!categoryCloud?.isConnected) return;
    const width = categoryCloud.clientWidth;
    if (!width) return;
    cloudWidth = width;
    categoryCloud.classList.remove('is-placed');
    categoryCloud.style.height = '';
    const items = [...categoryCloud.children].map((el, index) => {
      const link = el.querySelector('a');
      el.style.width = el.style.height = '';
      link.style.fontSize = '';
      if (link.offsetWidth > width - 32) {
        link.style.fontSize = parseFloat(getComputedStyle(link).fontSize) *
          (width - 32) / link.offsetWidth + 'px';
      }
      const angle = parseFloat(el.style.getPropertyValue('--cloud-angle')) * Math.PI / 180;
      const cosine = Math.abs(Math.cos(angle)), sine = Math.abs(Math.sin(angle));
      return {
        el, index, weight: parseFloat(el.style.getPropertyValue('--cloud-weight')),
        width: Math.ceil(link.offsetWidth * cosine + link.offsetHeight * sine) + 12,
        height: Math.ceil(link.offsetHeight * cosine + link.offsetWidth * sine) + 12
      };
    }).sort((a, b) => b.weight - a.weight);
    const area = items.reduce((sum, item) => sum + item.width * item.height, 0);
    let height = Math.max(280, Math.ceil(area / width / .45));

    // Place larger words first on an elliptical spiral, with space between their rotated bounds.
    for (let attempt = 0; attempt < 8; attempt++, height += 80) {
      const placed = [];
      for (const item of items) {
        for (let step = 0; step < 2000; step++) {
          const angle = step * .22 + item.index * 2.4;
          const radius = step * .55;
          const x = (width - item.width) / 2 + Math.cos(angle) * radius * width / height;
          const y = (height - item.height) / 2 + Math.sin(angle) * radius;
          if (x < 0 || y < 0 || x + item.width > width || y + item.height > height) continue;
          if (placed.some(other => x < other.x + other.width && x + item.width > other.x &&
              y < other.y + other.height && y + item.height > other.y)) continue;
          placed.push({ ...item, x, y });
          break;
        }
      }
      if (placed.length !== items.length) continue;
      categoryCloud.style.height = height + 'px';
      for (const item of placed) {
        Object.assign(item.el.style, {
          left: item.x + 'px', top: item.y + 'px',
          width: item.width + 'px', height: item.height + 'px'
        });
      }
      categoryCloud.classList.add('is-placed');
      return;
    }
  }

  function syncScrollPresentation() {
    scrollPresentationFrame = 0;
    const hero = $('#homeHero');
    const backgroundEnd = hero.getBoundingClientRect().bottom + window.scrollY;
    const progress = Math.min(1, Math.max(0, window.scrollY / Math.max(1, backgroundEnd)));
    topbar.style.setProperty('--nav-expand', String(progress));
    if (!categoryCloud?.isConnected) return;
    const bounds = categoryCloud.parentElement.getBoundingClientRect();
    const fadeDistance = Math.min(bounds.height, window.innerHeight) * .6;
    const visibility = reducedMotion.matches ? 1 : Math.max(0, Math.min(1,
      (window.innerHeight - bounds.top) / fadeDistance,
      (bounds.bottom - topbar.offsetHeight) / fadeDistance));
    categoryCloud.style.setProperty('--cloud-visibility', visibility.toFixed(4));
  }

  function scheduleScrollPresentation() {
    if (!scrollPresentationFrame) scrollPresentationFrame = requestAnimationFrame(syncScrollPresentation);
  }

  window.addEventListener('scroll', scheduleScrollPresentation, { passive: true });
  window.addEventListener('resize', () => {
    finishPopovers();
    for (const entry of dialogs.values()) {
      entry.source = triggerBounds(entry.trigger);
      positionPopover(entry.surface, entry.source);
    }
    for (const [panel, trigger] of floatingPanels) positionPopover(panel, trigger);
    if (document.body.classList.contains('toc-open')) positionPopover(tocDrawer, tocButton);
    if (document.body.classList.contains('nav-open')) positionPopover($('#sidebar'), $('#menuBtn'));
    if (!window.ResizeObserver) layoutCategoryCloud();
    scheduleScrollPresentation();
  }, { passive: true });
  window.addEventListener('pageshow', scheduleScrollPresentation);
  reducedMotion.addEventListener?.('change', scheduleScrollPresentation);
  reducedMotion.addEventListener?.('change', finishPopovers);
  scheduleScrollPresentation();

  function bindGlassNavigation() {
    const nav = $('#topnav');
    let hoveredLink;
    let pointerFrame = 0;

    function positionHighlight() {
      const focusedLink = nav.querySelector('a:focus-visible');
      const preview = hoveredLink || focusedLink;
      const target = preview || nav.querySelector('a[aria-current="page"]');
      if (target) {
        nav.style.setProperty('--highlight-left', target.offsetLeft + 'px');
        nav.style.setProperty('--highlight-width', target.offsetWidth + 'px');
      }
      nav.classList.toggle('is-previewing', !!preview);
    }

    nav.addEventListener('pointerover', event => {
      if (!finePointer.matches || event.pointerType === 'touch') return;
      hoveredLink = event.target.closest('a');
      positionHighlight();
    });
    nav.addEventListener('pointerleave', () => {
      hoveredLink = null;
      positionHighlight();
    });
    nav.addEventListener('focusin', positionHighlight);
    nav.addEventListener('focusout', () => requestAnimationFrame(positionHighlight));
    if (window.ResizeObserver) new ResizeObserver(positionHighlight).observe(nav);
    else window.addEventListener('resize', positionHighlight, { passive: true });

    topbar.addEventListener('pointermove', event => {
      if (pointerFrame || reducedMotion.matches || !finePointer.matches ||
          event.pointerType === 'touch') return;
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        const bounds = topbar.getBoundingClientRect();
        topbar.style.setProperty('--glass-x', (event.clientX - bounds.left) + 'px');
        topbar.style.setProperty('--glass-y', (event.clientY - bounds.top) + 'px');
      });
    });
    topbar.addEventListener('pointerleave', () => {
      if (pointerFrame) cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      topbar.style.removeProperty('--glass-x');
      topbar.style.removeProperty('--glass-y');
    });

    return positionHighlight;
  }

  const positionNavHighlight = bindGlassNavigation();
  window.matchMedia('(max-width: 1100px)').addEventListener?.('change', event => {
    if (!event.matches) closeToc();
    if (!event.matches && document.body.classList.contains('is-notes') && document.body.classList.contains('nav-open')) {
      $('#navClose').click();
    }
  });

  window.DeusSite = {
    page, articleExtras, afterRender, themeSwap, closeToc, animatePopover,
    positionPopover, openDialog, closeDialog, openProfile
  };
})();
