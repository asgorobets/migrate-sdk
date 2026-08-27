import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>
          Migrate SDK · remote observation example
        </p>
        <h1>Durable migrations, observed from a local terminal.</h1>
        <p className={styles.summary}>
          This Next.js service exposes the migration-server protocol, dispatches
          work through Vercel Workflow, and stores source data and migration
          state in PostgreSQL. No local migrate config is involved.
        </p>
      </section>

      <section className={styles.grid}>
        <article>
          <span>01</span>
          <h2>Authors</h2>
          <p>PostgreSQL source rows migrate in durable cursor windows.</p>
        </article>
        <article>
          <span>02</span>
          <h2>Books</h2>
          <p>240 independent rows run beside authors on the TUI dashboard.</p>
        </article>
        <article>
          <span>RPC</span>
          <h2>Remote TUI</h2>
          <p>
            Point <code>migrate-tui --server</code> at <code>/api/migrate</code>{" "}
            with a bearer token.
          </p>
        </article>
      </section>

      <footer className={styles.footer}>
        <a href="/api/health">Database health</a>
        <span>Workflow execution remains provider-owned.</span>
      </footer>
    </main>
  );
}
