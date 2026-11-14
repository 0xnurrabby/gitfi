(() => {
  const root = document.documentElement;
  const themeButton = document.getElementById("themeButton");
  const menuButton = document.getElementById("menuButton");
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  const navItems = [...document.querySelectorAll(".nav-item")];
  const sections = [...document.querySelectorAll(".doc-section[id]")];

  // App links work on the app host and on a future docs subdomain.
  const host = window.location.hostname;
  const appOrigin = host === "localhost" || host === "127.0.0.1" || host.endsWith("trycloudflare.com") || host.endsWith("workers.dev")
    ? window.location.origin
    : "https://gitfi.fun";
  for (const link of document.querySelectorAll("[data-app-link]")) {
    const path = link.getAttribute("href") || "/";
    link.setAttribute("href", `${appOrigin}${path}`);
  }

  const applyTheme = (theme) => {
    root.dataset.theme = theme;
    try { localStorage.setItem("gitfi-docs-theme", theme); } catch {}
  };
  themeButton?.addEventListener("click", () => {
    applyTheme(root.dataset.theme === "dark" ? "light" : "dark");
  });
  if (!root.dataset.theme) {
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = prefersDark ? "dark" : "light";
  }

  const openMenu = (open) => {
    sidebar?.classList.toggle("open", open);
    backdrop?.classList.toggle("show", open);
    menuButton?.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
  };
  menuButton?.addEventListener("click", () => openMenu(!sidebar?.classList.contains("open")));
  backdrop?.addEventListener("click", () => openMenu(false));
  for (const item of navItems) item.addEventListener("click", () => openMenu(false));

  // Highlight the section currently in view.
  if ("IntersectionObserver" in window) {
    const byId = new Map(navItems.map((item) => [item.getAttribute("href")?.slice(1), item]));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          for (const item of navItems) item.classList.remove("active");
          byId.get(entry.target.id)?.classList.add("active");
        }
      },
      { rootMargin: "-18% 0px -72% 0px", threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
  }

  // Copy contract addresses and code snippets.
  const toast = document.createElement("div");
  toast.className = "copy-toast";
  document.body.appendChild(toast);
  const showToast = (text) => {
    toast.textContent = text;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1400);
  };
  for (const element of document.querySelectorAll(".contract-address")) {
    element.addEventListener("click", async (event) => {
      const text = element.textContent.replace("↗", "").trim();
      if (!text.includes(".")) return;
      event.preventDefault();
      try {
        await navigator.clipboard.writeText(text);
        showToast("Contract address copied");
      } catch {
        showToast(text);
      }
    });
  }

  // Add a "copy" affordance to code blocks.
  for (const block of document.querySelectorAll(".code-block")) {
    const code = block.querySelector("code");
    if (!code) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Copy";
    button.className = "mini-copy";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent || "");
        showToast("Copied to clipboard");
      } catch {
        showToast("Select the code to copy");
      }
    });
    block.querySelector(".code-head")?.appendChild(button);
  }
})();
