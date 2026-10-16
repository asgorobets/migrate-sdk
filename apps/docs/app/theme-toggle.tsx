"use client";

import { useTheme } from "fumadocs-ui/provider/base";
import styles from "./page.module.css";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <button
      aria-label="Toggle color theme"
      className={styles.themeToggle}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      title="Toggle light and dark theme"
      type="button"
    >
      <span aria-hidden="true">
        [ <span className={styles.themeLabel}>theme: </span>
        <span className={styles.themeLight}>light</span>
        <span className={styles.themeDark}>dark</span> ]
      </span>
    </button>
  );
}
