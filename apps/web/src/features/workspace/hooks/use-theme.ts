"use client";

import { useCallback, useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const KEY = "support-ai:theme";
const listeners = new Set<() => void>();

function read(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

function apply(pref: ThemePreference) {
  const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset.theme = dark ? "dark" : "light";
  root.style.colorScheme = dark ? "dark" : "light";
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const osDark = () => matchMedia(DARK_QUERY).matches;

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Follow the OS while the preference is "system" (the OS can switch while the app is open).
  const mq = matchMedia(DARK_QUERY);
  const onOs = () => {
    if (read() === "system") apply("system");
    cb();
  };
  mq.addEventListener("change", onOs);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener("change", onOs);
  };
}

/** [preference, setPreference, isDark, toggle]. `isDark` is what is on screen, so a toggle always flips the visible theme. */
export function useTheme(): [ThemePreference, (t: ThemePreference) => void, boolean, () => void] {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as ThemePreference);
  const dark = useSyncExternalStore(subscribe, () => theme === "dark" || (theme === "system" && osDark()), () => false);
  const setTheme = useCallback((t: ThemePreference) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {}
    apply(t);
    listeners.forEach((l) => l());
  }, []);
  // Choosing the theme the OS already uses goes back to "system", so the app keeps following the OS from then on.
  const toggle = useCallback(() => {
    const next = !dark;
    setTheme(next === osDark() ? "system" : next ? "dark" : "light");
  }, [dark, setTheme]);
  return [theme, setTheme, dark, toggle];
}
