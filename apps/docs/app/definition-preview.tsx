"use client";

import dynamic from "next/dynamic";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { CodeViewer } from "./code-viewer";
import definitionSteps from "./generated/migration-previews.json";
import styles from "./page.module.css";

const ExpandedEditor = dynamic(() => import("./expanded-editor"));

export function DefinitionPreview() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    let nextIndex = index;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % definitionSteps.length;
        break;
      case "ArrowLeft":
        nextIndex =
          (index - 1 + definitionSteps.length) % definitionSteps.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = definitionSteps.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setActiveIndex(nextIndex);
    tabs.current[nextIndex]?.focus({ preventScroll: true });
  }

  return (
    <div className={styles.definition}>
      <div className={styles.editorHeader}>
        <span className={styles.fileName}>
          <span aria-hidden="true" className={styles.fileIcon}>
            ├
          </span>
          Migration overview
        </span>
      </div>
      <div
        aria-label="Build a migration"
        className={styles.definitionTabs}
        role="tablist"
      >
        {definitionSteps.map((step, index) => (
          <button
            aria-controls={`${id}-panel-${step.id}`}
            aria-selected={index === activeIndex}
            className={styles.definitionTab}
            id={`${id}-tab-${step.id}`}
            key={step.id}
            onClick={() => setActiveIndex(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            role="tab"
            tabIndex={index === activeIndex ? 0 : -1}
            type="button"
          >
            <span aria-hidden="true">0{index + 1}</span>
            {step.label}
          </button>
        ))}
      </div>
      {definitionSteps.map((step, index) => (
        <div
          aria-labelledby={`${id}-tab-${step.id}`}
          className={styles.definitionPanel}
          hidden={index !== activeIndex}
          id={`${id}-panel-${step.id}`}
          key={step.id}
          role="tabpanel"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The code panel is the next keyboard stop after its active tab.
          tabIndex={0}
        >
          <div className={styles.definitionStory}>
            <h2>{step.title}</h2>
            <p>{step.description}</p>
          </div>
          <CodeViewer compact lines={step.lines} />
        </div>
      ))}
      <div className={styles.codeCaption}>
        <button
          className={styles.expandButton}
          onClick={() => setExpanded(true)}
          type="button"
        >
          Expand editor <span aria-hidden="true">⤢</span>
        </button>
        {activeIndex < definitionSteps.length - 1 ? (
          <button
            aria-label={`Next: ${definitionSteps[activeIndex + 1]?.label}`}
            className={styles.nextStep}
            onClick={() => {
              const nextIndex = activeIndex + 1;
              setActiveIndex(nextIndex);
              tabs.current[nextIndex]?.focus({ preventScroll: true });
            }}
            type="button"
          >
            Next <span aria-hidden="true">→</span>
          </button>
        ) : (
          <a className={styles.nextStep} href="/docs/getting-started">
            Start building <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
      {expanded && (
        <ExpandedEditor
          initialStep={activeIndex}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  );
}
