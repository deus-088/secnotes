/* ============================================================================
   Protocol Explorer — 站内默认值（2026-11-04）
   ----------------------------------------------------------------------------
   首次进入：深色主题 + 简体中文。
   用户手动切换过（localStorage 已有值）则尊重其选择，不再覆盖。
   独立外链（同源）而不是改写 index.html 的内联脚本，这样无需维护 CSP 哈希。
   ========================================================================== */
(function () {
  var root = document.documentElement;
  try {
    var savedTheme = localStorage.getItem('protocol-explorer:theme');
    var dark = savedTheme ? savedTheme === 'dark' : true;
    root.dataset.theme = dark ? 'dark' : 'light';
    if (!localStorage.getItem('protocol-explorer:lang')) {
      localStorage.setItem('protocol-explorer:lang', 'zh');
      root.lang = 'zh-CN';
    }
    var color = dark ? '#121212' : '#fdfdfe';
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].content = color;
  } catch (e) {
    root.dataset.theme = 'dark';
  }
})();
