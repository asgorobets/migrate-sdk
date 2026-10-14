"use client";

import { useState } from "react";
import styles from "./page.module.css";

const command = "pnpm add migrate-sdk effect";

export function InstallCommand() {
  const [message, setMessage] = useState("copy");

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setMessage("copied!");
    } catch {
      setMessage("Select the command to copy");
    }
  }

  return (
    <div className={styles.install}>
      <div>
        <span aria-hidden="true" className={styles.prompt}>
          $
        </span>
        <code>{command}</code>
      </div>
      <button
        aria-label="Copy installation command"
        className={styles.copyButton}
        onClick={copyCommand}
        type="button"
      >
        <span aria-hidden="true">[ </span>
        <span aria-live="polite">{message}</span>
        <span aria-hidden="true"> ]</span>
      </button>
    </div>
  );
}
