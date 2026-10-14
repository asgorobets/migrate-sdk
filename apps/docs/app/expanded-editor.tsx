"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { CodeViewer } from "./code-viewer";
import styles from "./editor.module.css";
import example from "./generated/migration-example.json";

interface ExpandedEditorProps {
  initialStep: number;
  onClose: () => void;
}

export default function ExpandedEditor({
  initialStep,
  onClose,
}: ExpandedEditorProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(initialStep);
  const [copyState, setCopyState] = useState("Copy file");
  const step = example.steps[activeIndex];

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const container = viewport.current;
    const line = step?.preview.start ?? 1;
    const target = container?.querySelector<HTMLElement>(
      `[data-line="${line}"]`
    );
    if (container && target) {
      container.scrollTo({ top: target.offsetTop - 24 });
    }
  }, [step]);

  async function copyFile() {
    try {
      await navigator.clipboard.writeText(example.code);
      setCopyState("Copied!");
    } catch {
      setCopyState("Select code to copy");
    }
  }

  function keepFocusInEditor(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") {
      return;
    }
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)"
      )
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: The native dialog owns Tab boundary handling for its focus trap.
    <dialog
      aria-labelledby="expanded-editor-title"
      className={styles.editorDialog}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={keepFocusInEditor}
      ref={dialog}
    >
      <div className={styles.editorWindow}>
        <header className={styles.modalHeader}>
          <div className={styles.modalTitle}>
            <span aria-hidden="true">├</span>
            <h2 id="expanded-editor-title">{example.filename}</h2>
          </div>
          <div className={styles.modalActions}>
            <button onClick={copyFile} type="button">
              <span aria-live="polite">{copyState}</span>
            </button>
            <button
              aria-label="Close expanded editor"
              onClick={onClose}
              type="button"
            >
              <span aria-hidden="true">[ × ]</span>
            </button>
          </div>
        </header>
        <div className={styles.editorWorkspace}>
          <nav aria-label="Example sections" className={styles.editorSidebar}>
            <button
              aria-current={activeIndex === -1 ? "location" : undefined}
              onClick={() => setActiveIndex(-1)}
              type="button"
            >
              <span aria-hidden="true">↖</span> Setup
            </button>
            {example.steps.map((item, index) => (
              <button
                aria-current={activeIndex === index ? "location" : undefined}
                key={item.id}
                onClick={() => setActiveIndex(index)}
                type="button"
              >
                <span aria-hidden="true">0{index + 1}</span> {item.label}
              </button>
            ))}
          </nav>
          <div className={styles.editorMain}>
            <div className={styles.contextBar}>
              <span>
                {step?.title ?? "CSV sample, imports, and file settings."}
              </span>
              <span className={styles.lineCount}>
                {example.lines.length} lines
              </span>
            </div>
            <div className={styles.editorViewport} ref={viewport}>
              <CodeViewer
                highlights={step ? [step.preview, step.context] : []}
                key={activeIndex}
                lines={example.lines}
              />
            </div>
          </div>
        </div>
        <footer className={styles.modalFooter}>
          <span>Select a symbol to inspect its type.</span>
          <span>
            TypeScript <span aria-hidden="true">┘</span>
          </span>
        </footer>
      </div>
    </dialog>
  );
}
