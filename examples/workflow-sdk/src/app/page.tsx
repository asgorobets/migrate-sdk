import { BrowserTerminal } from "./browser-terminal";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      <header className={styles.nav}>
        <a className={styles.brand} href="#top">
          Migrate
        </a>
        <span>workflow-sdk · browser demo</span>
      </header>

      <div className={styles.hero} id="top">
        <p className={styles.eyebrow}>
          <span aria-hidden="true">$</span> migrate observe --server
          workflow-sdk.demo
        </p>
        <h1>Try a durable migration from your browser</h1>
        <p className={styles.summary}>
          The actual OpenTUI client starts below inside a shared Vercel Sandbox.
          Run or roll back PostgreSQL migrations while Vercel Workflow owns the
          durable execution.
        </p>
        <div className={styles.runtimeLine}>
          <span>[ wterm ]</span>
          <span>[ libghostty ]</span>
          <span>[ Vercel Sandbox ]</span>
          <span>[ Vercel Workflow ]</span>
        </div>
      </div>

      <BrowserTerminal />

      <section className={styles.grid}>
        <article>
          <span>01 / terminal</span>
          <h2>The real TUI</h2>
          <p>
            OpenTUI runs under Bun in Linux. The browser only renders its PTY
            byte stream with libghostty.
          </p>
        </article>
        <article>
          <span>02 / execution</span>
          <h2>Durable workflows</h2>
          <p>
            Authors and books migrate in durable cursor windows backed by
            PostgreSQL and Vercel Workflow.
          </p>
        </article>
        <article>
          <span>03 / playground</span>
          <h2>Shared and disposable</h2>
          <p>
            Every visitor gets their own TUI process in the same temporary
            sandbox. Activity keeps it warm, with an absolute 30-minute limit.
          </p>
        </article>
      </section>

      <footer className={styles.footer}>
        <span>Migration execution remains provider-owned.</span>
        <span>Terminal sessions are temporary; workflow runs are durable.</span>
      </footer>
    </main>
  );
}
