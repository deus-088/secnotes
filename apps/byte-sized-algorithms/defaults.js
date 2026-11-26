(function () {
  try {
    if (!localStorage.getItem('algolab:lang')) {
      localStorage.setItem('algolab:lang', 'zh-Hans');
    }
    if (!localStorage.getItem('algolab:theme')) {
      localStorage.setItem('algolab:theme', localStorage.getItem('sec-theme') || 'dark');
    }
  } catch (error) {
    // The app retains its own fallback when browser storage is unavailable.
  }
})();
