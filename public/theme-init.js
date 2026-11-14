(() => {
  try {
    const stored = localStorage.getItem("gitfi.theme");
    const theme =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f2f0ea" : "#0c0e0d");
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
})();
