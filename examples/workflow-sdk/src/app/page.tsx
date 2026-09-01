import { Effect } from "effect";
import { connection } from "next/server";
import { MigrateServerAccess } from "@/server/migrate-server-access";
import { MigrationWidget } from "./migration-widget";
import styles from "./page.module.css";

export default async function Home() {
  await connection();
  const { token: demoMigrateServerToken } = await Effect.runPromise(
    MigrateServerAccess.pipe(Effect.provide(MigrateServerAccess.layer))
  );

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
          Run and roll back PostgreSQL migrations, watch cursor-window progress,
          and inspect durable item messages while Vercel Workflow owns the
          execution. The complete TUI is one command away in your terminal.
        </p>
        <div className={styles.runtimeLine}>
          <span>[ Vercel Workflow ]</span>
          <span>[ Effect RPC ]</span>
          <span>[ PostgreSQL ]</span>
          <span>[ Browser Migrate Client ]</span>
        </div>
      </div>

      <section aria-label="Migration clients" className={styles.clients}>
        <MigrationWidget bearerToken={demoMigrateServerToken} />
      </section>

      <section className={styles.grid}>
        <article>
          <span>01 / browser</span>
          <h2>A focused web client</h2>
          <p>
            This page uses the public browser client directly. It keeps the demo
            small while showing the same remote protocol used by the TUI.
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
          <span>03 / terminal</span>
          <h2>The complete TUI</h2>
          <p>
            Copy the one-off command above to open the canonical interface in
            your own terminal. The published demo token exercises the same
            Bearer authentication as any external client.
          </p>
        </article>
      </section>

      <footer className={styles.footer}>
        <span>Migration execution remains provider-owned.</span>
        <span>Closing this page does not stop a Workflow run.</span>
      </footer>
    </main>
  );
}
