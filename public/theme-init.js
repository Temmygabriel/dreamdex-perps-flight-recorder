// Early theme preference initializer; kept external so the site can use a strict script-src CSP.
(() => {
  try {
    if (window.localStorage.getItem("perps-stress-lab-theme") === "dim") {
      document.documentElement.dataset.theme = "dim";
    }
  } catch {
    // Theme preference is optional; the app initializes in light mode.
  }
})();
