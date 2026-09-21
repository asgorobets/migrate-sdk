import Link from "next/link";
import { DataFlow } from "./data-flow";
import { DefinitionPreview } from "./definition-preview";
import { InstallCommand } from "./install-command";
import { MigrationDemo } from "./migration-demo";
import styles from "./page.module.css";
import { ThemeToggle } from "./theme-toggle";

const repository = "https://github.com/asgorobets/migrate-sdk";
const gettingStarted = "/docs/getting-started";
export default function Home() {
  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <nav aria-label="Main navigation" className={styles.navigation}>
          <Link
            aria-label="Migrate SDK home"
            className={styles.wordmark}
            href="/"
          >
            <span aria-hidden="true" className={styles.logo}>
              [m]
            </span>
            migrate-sdk
          </Link>
          <div className={styles.navLinks}>
            <a className={styles.howItWorksLink} href="#how-it-works">
              [ workflow ]
            </a>
            <Link href="/docs">[ docs ]</Link>
            <ThemeToggle />
            <a className={styles.navCta} href={gettingStarted}>
              install <span aria-hidden="true">↗</span>
            </a>
          </div>
        </nav>
      </header>
      <main id="main">
        <section aria-labelledby="hero-title" className={styles.hero}>
          <div className={styles.heroCopy}>
            <DataFlow />
            <h1 id="hero-title">
              Data migrations.
              <span className={styles.heroAccent}>
                Defined in{" "}
                <span className={styles.heroEnding}>
                  TypeScript.
                  <span aria-hidden="true" className={styles.cursor} />
                </span>
              </span>
            </h1>
            <p className={styles.heroDescription}>
              Move data between APIs, databases, files, and CMSes. Write the
              mapping. The SDK preserves item state for retries and rollback.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primaryButton} href={gettingStarted}>
                <span aria-hidden="true">&gt;</span> Get started
              </a>
              <a className={styles.secondaryLink} href={repository}>
                [ GitHub ↗ ]
              </a>
            </div>
            <InstallCommand />
          </div>
          <DefinitionPreview />
        </section>
        <section
          aria-label="Operate your migrations"
          className={styles.demoSection}
          id="how-it-works"
        >
          <MigrationDemo />
        </section>
        <section aria-labelledby="start-title" className={styles.closing}>
          <div>
            <p className={styles.eyebrow}>03 / build</p>
            <h2 id="start-title">Define your migration.</h2>
          </div>
          <a className={styles.primaryButton} href={gettingStarted}>
            <span aria-hidden="true">&gt;</span> Get started
          </a>
        </section>
      </main>
      <footer className={styles.footer}>
        <nav aria-label="Footer navigation">
          <Link href="/docs">Documentation</Link>
          <a href={repository}>GitHub</a>
        </nav>
      </footer>
    </div>
  );
}
