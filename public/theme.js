// Runs before the page paints so there is no flash: 'system' (default), 'light' or 'dark'.
(function () {
  var t = 'system';
  try {
    t = localStorage.getItem('wd.theme') || 'system';
  } catch (e) {}
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
})();
