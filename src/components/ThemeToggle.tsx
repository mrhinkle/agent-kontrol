"use client";

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "ak-theme";

/**
 * Runs in <head> before paint so a saved dark choice never flashes light.
 * Light is the default; only an explicit saved "dark" changes it.
 */
export const THEME_BOOT_SCRIPT = `try{if(localStorage.getItem("${THEME_STORAGE_KEY}")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;

/** Light/dark switch for the Ion theme. The choice is kept in this browser only. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    if (next === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage blocked: the choice lasts for this page only */
    }
    setTheme(next);
  }

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="mono shrink-0 rounded border border-fg/10 px-2 py-0.5 text-[11px] text-gray-500 transition-colors hover:border-fg/20 hover:text-fg"
    >
      {theme === "dark" ? "☀ light" : "☾ dark"}
    </button>
  );
}
