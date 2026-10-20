import Link from "next/link";
import { DataFlow } from "./data-flow";
import { DefinitionPreview } from "./definition-preview";
import { Infrastructure } from "./infrastructure";
import { InstallCommand } from "./install-command";
import { MigrationDemo } from "./migration-demo";
import styles from "./page.module.css";
import { ThemeToggle } from "./theme-toggle";

const repository = "https://github.com/asgorobets/migrate-sdk";
const gettingStarted = "/docs/getting-started";
const liveDemo = "https://migrate-sdk-workflow.vercel.app";
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
              Data migrations
              <span className={styles.heroAccent}>
                Defined in{" "}
                <span className={styles.heroEnding}>
                  TypeScript
                  <span aria-hidden="true" className={styles.cursor} />
                </span>
              </span>
            </h1>
            <p className={styles.heroDescription}>
              Migrate data between APIs, databases, files, and CMSes. Define the
              work in TypeScript and Effect. Keep migration progress between
              runs and resume where you left off.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primaryButton} href={gettingStarted}>
                <span aria-hidden="true">&gt;</span> Get started
              </a>
              <a className={styles.secondaryLink} href={liveDemo}>
                [ Try live demo ↗ ]
              </a>
            </div>
            <InstallCommand />
          </div>
          <div className={styles.definitionSection}>
            <div className={styles.definitionIntro}>
              <p className={styles.eyebrow}>01 / define</p>
              <h2>Your source. Your mapping.</h2>
              <p>
                Connect source data, destination calls, and saved results in one
                migration definition.
              </p>
            </div>
            <DefinitionPreview />
          </div>
        </section>
        <section
          aria-label="Operate your migrations"
          className={styles.demoSection}
          id="how-it-works"
        >
          <div className={styles.sectionIntro}>
            <div>
              <p className={styles.eyebrow}>02 / run</p>
              <h2>Run migrations your way.</h2>
            </div>
          </div>
          <MigrationDemo />
        </section>
        <section
          aria-labelledby="infrastructure-title"
          className={styles.infrastructureSection}
          id="your-infrastructure"
        >
          <div className={styles.sectionIntro}>
            <div>
              <p className={styles.eyebrow}>03 / deploy</p>
              <h2 id="infrastructure-title">Your code. Your infrastructure.</h2>
            </div>
            <p>
              Start in your application. Add a server for remote access, or
              Workflow SDK for durable execution.
            </p>
          </div>
          <Infrastructure />
        </section>
        <section aria-labelledby="start-title" className={styles.closing}>
          <div>
            <h2 id="start-title">Get started with Migrate SDK.</h2>
            <p>Define a migration, or work through a complete recipe.</p>
          </div>
          <div className={styles.closingActions}>
            <Link className={styles.secondaryLink} href="/docs/cookbook">
              [ Cookbook ↗ ]
            </Link>
            <a className={styles.primaryButton} href={gettingStarted}>
              <span aria-hidden="true">&gt;</span> Get started
            </a>
          </div>
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
