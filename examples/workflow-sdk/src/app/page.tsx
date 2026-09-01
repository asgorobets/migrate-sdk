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
        <span>workflow-sdk · durable migrations</span>
      </header>

      <div className={styles.hero} id="top">
        <p className={styles.eyebrow}>Powered by Vercel Workflow</p>
        <h1>Run migrations that outlive a serverless request</h1>
        <p className={styles.summary}>
          Authors and books migrate through a durable workflow, so a run can
          take hours, retry transient errors, and keep going after you close
          this page. Reopen it—or open a second window—to follow the same live
          progress.
        </p>
        <div className={styles.runtimeLine}>
          <span>[ Vercel Workflow ]</span>
          <span>[ Effect RPC ]</span>
          <span>[ PostgreSQL ]</span>
          <span>[ Bring Your Own Client ]</span>
        </div>
      </div>

      <section aria-label="Workflow migration demo" className={styles.clients}>
        <MigrationWidget bearerToken={demoMigrateServerToken} />
      </section>

      <section className={styles.grid}>
        <article>
          <span>01 / clients</span>
          <h2>Bring your own client</h2>
          <p>
            This page is one small example of what you can build with the
            Migrate Server protocol. Your application only needs the server URL
            and credentials; migration code and data access stay where they run.
          </p>
        </article>
        <article>
          <span>02 / workflow</span>
          <h2>Long-running by design</h2>
          <p>
            Every run is a Vercel Workflow, not a serverless request. It can run
            for hours, retry transient errors, start on a cron schedule, and be
            stopped explicitly. Close this page or open another window—the run
            continues and every window shows the same progress.
          </p>
        </article>
        <article>
          <span>03 / terminal</span>
          <h2>Full control from your terminal</h2>
          <p>
            The Migrate TUI helps you discover, start, stop, retry, and monitor
            migrations running locally or on a remote Migrate Server. The CLI
            supports scripts, agents, and cron jobs.
          </p>
        </article>
      </section>
    </main>
  );
}
