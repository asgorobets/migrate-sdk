"use client";

import Link from "next/link";
import { useId, useState } from "react";
import styles from "./infrastructure.module.css";

const stories = [
  {
    id: "code",
    number: "01",
    title: "Define and run in TypeScript.",
    description:
      "Use your own clients, schemas, and mapping code. Run from your application, a cron job, or a webhook.",
    caption: "Use the SDK directly in your application. A server is optional.",
    href: "/docs/learn/execution",
    link: "Run from code",
  },
  {
    id: "run",
    number: "02",
    title: "Run locally or remotely.",
    description:
      "Use code, the CLI, or the TUI. Connect to a migration server to run the same definitions on another machine.",
    caption:
      "The migration server connects your clients to the code and state you host.",
    href: "/docs/operate",
    link: "Use the CLI and TUI",
  },
  {
    id: "observe",
    number: "03",
    title: "Follow runs from anywhere.",
    description:
      "Check a run started by a cron job or another client. With Workflow SDK, a durable run can continue after its starting request ends.",
    caption:
      "Host the server in a serverless function. Let Workflow SDK handle the long-running work.",
    href: "/docs/cookbook/workflow-sdk",
    link: "Run with Workflow SDK",
  },
] as const;

export function Infrastructure() {
  const [story, setStory] = useState<(typeof stories)[number]>(stories[0]);
  const id = useId();

  return (
    <div className={styles.infrastructure}>
      <div className={styles.explorer} data-story={story.id}>
        <ol aria-label="Ways to use Migrate SDK" className={styles.stories}>
          {stories.map((entry) => (
            <li key={entry.id}>
              <button
                aria-controls={`${id}-diagram`}
                aria-pressed={story.id === entry.id}
                className={styles.story}
                onClick={() => setStory(entry)}
                onFocus={() => setStory(entry)}
                type="button"
              >
                <span aria-hidden="true" className={styles.number}>
                  {entry.number}
                </span>
                <span className={styles.storyText}>
                  <strong>{entry.title}</strong>
                  <span>{entry.description}</span>
                </span>
                <span aria-hidden="true" className={styles.arrow}>
                  →
                </span>
              </button>
            </li>
          ))}
        </ol>

        <figure className={styles.diagram} id={`${id}-diagram`}>
          <div className={styles.diagramHeader}>
            <span>Your infrastructure</span>
            <span aria-hidden="true">[m]</span>
          </div>
          <div className={styles.map}>
            <div className={`${styles.node} ${styles.definition}`}>
              <span className={styles.nodeLabel}>Your code</span>
              <strong>migration.ts</strong>
              <small>TypeScript + Effect</small>
            </div>
            <div className={styles.clients}>
              <span className={styles.nodeLabel}>Your clients</span>
              <div>
                <span>CLI</span>
                <span>TUI</span>
                <span>Your app</span>
              </div>
            </div>
            <div aria-hidden="true" className={styles.codeConnector}>
              ↓
            </div>
            <div aria-hidden="true" className={styles.clientConnector}>
              ↕
            </div>
            <div className={`${styles.node} ${styles.process}`}>
              <strong>Your process</strong>
              <small>App · cron · webhook</small>
            </div>
            <div aria-hidden="true" className={styles.bridge}>
              <svg
                aria-hidden="true"
                preserveAspectRatio="none"
                viewBox="0 0 36 20"
              >
                <path d="M1 6H35M1 6l5-5M1 6l5 5M1 14H35M35 14l-5-5M35 14l-5 5" />
              </svg>
            </div>
            <div className={`${styles.node} ${styles.server}`}>
              <strong>Migration server</strong>
              <small>Local or remote</small>
            </div>
            <span className={styles.or}>or</span>
            <div className={`${styles.node} ${styles.workflow}`}>
              <strong>Workflow SDK</strong>
              <small>Durable execution</small>
            </div>
            <span className={styles.observation}>Start · stop · observe</span>
            <div aria-hidden="true" className={styles.storeConnector}>
              <span />
              <span />
            </div>
            <div className={styles.store}>
              <div>
                <strong>Migration store</strong>
                <span>Saved progress, results, and locks</span>
              </div>
              <span className={styles.storeOptions}>File / SQL / Custom</span>
            </div>
          </div>
          <figcaption className={styles.caption}>
            <p>{story.caption}</p>
            <Link href={story.href}>
              {story.link} <span aria-hidden="true">↗</span>
            </Link>
          </figcaption>
        </figure>
      </div>

      <div className={styles.foundation}>
        <div className={styles.effect}>
          <h3>Built with Effect.</h3>
          <p>
            Typed errors, schema validation, and retries with exponential
            backoff are part of your TypeScript code.
          </p>
          <a
            className={styles.platforms}
            href="https://effect.website/docs/v4/platform/introduction"
          >
            <span>Effect platform</span>
            <span>Node.js · Bun · Deno · Browser ↗</span>
          </a>
          <p className={styles.platformNote}>
            Runtime support depends on the clients, sources, and stores you use.
          </p>
        </div>
        <div className={styles.state}>
          <h3>Terraform-style state. For content and data.</h3>
          <p>
            Keep a record of what ran and what it created. Store that record in
            your infrastructure so the next run can use it, wherever it starts.
          </p>
          <Link href="/docs/learn/migration-stores">
            Choose a migration store <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
