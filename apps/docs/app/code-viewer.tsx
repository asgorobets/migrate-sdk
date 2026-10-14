"use client";

import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import styles from "./editor.module.css";

interface CodeToken {
  content: string;
  dark: string;
  light: string;
  offset: number;
  symbol?: string;
  type?: string;
}

export interface CodeLine {
  number: number;
  tokens: CodeToken[];
}

interface LineRange {
  end: number;
  start: number;
}

interface CodeViewerProps {
  compact?: boolean;
  highlights?: LineRange[];
  lines: CodeLine[];
}

interface TypeInfo {
  left: number;
  token: CodeToken;
  top: number;
  width: number;
}

type TokenStyle = CSSProperties & {
  "--token-light": string;
  "--token-dark": string;
};

export function CodeViewer({
  lines,
  compact = false,
  highlights = [],
}: CodeViewerProps) {
  const [typeInfo, setTypeInfo] = useState<TypeInfo | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!typeInfo) {
      return;
    }
    function dismiss(event: Event) {
      if (
        event.target instanceof Element &&
        event.target.closest('[role="tooltip"]')
      ) {
        return;
      }
      setTypeInfo(null);
    }
    function dismissOutside(event: Event) {
      if (
        event.target instanceof Node &&
        !surface.current?.contains(event.target)
      ) {
        setTypeInfo(null);
      }
    }
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("pointerover", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("pointerdown", dismissOutside);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("pointerover", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("pointerdown", dismissOutside);
    };
  }, [typeInfo]);

  function inspect(token: CodeToken, element: HTMLElement) {
    const bounds = element.closest("dialog")?.getBoundingClientRect() ?? {
      left: 0,
      right: window.innerWidth,
      top: 0,
      bottom: window.innerHeight,
    };
    const rect = element.getBoundingClientRect();
    const width = Math.min(520, bounds.right - bounds.left - 32);
    const left = Math.max(
      bounds.left + 16,
      Math.min(rect.left, bounds.right - width - 16)
    );
    const height = Math.min(
      240,
      (token.type?.split("\n").length ?? 1) * 20 + 70
    );
    const top =
      rect.bottom + height + 12 < bounds.bottom
        ? rect.bottom + 8
        : Math.max(bounds.top + 16, rect.top - height - 8);
    setTypeInfo({ token, left, top, width });
  }

  return (
    <div
      className={`${styles.codeSurface} ${compact ? styles.compactCode : styles.expandedCode}`}
      ref={surface}
    >
      <pre className={styles.codePre}>
        <code>
          {lines.map((line) => (
            <span
              className={styles.codeLine}
              data-highlighted={highlights.some(
                (range) =>
                  line.number >= range.start && line.number <= range.end
              )}
              data-line={line.number}
              key={line.number}
            >
              <span aria-hidden="true" className={styles.lineNumber}>
                {line.number}
              </span>
              <span className={styles.lineContent}>
                {line.tokens.map((token) => {
                  const color: TokenStyle = {
                    "--token-light": token.light,
                    "--token-dark": token.dark,
                  };
                  return token.type ? (
                    <button
                      aria-describedby={
                        typeInfo?.token.offset === token.offset ? id : undefined
                      }
                      aria-label={`Inspect type of ${token.symbol ?? token.content}`}
                      className={`${styles.token} ${styles.typeTrigger}`}
                      key={token.offset}
                      onClick={(event) => inspect(token, event.currentTarget)}
                      onFocus={(event) => inspect(token, event.currentTarget)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape" && typeInfo) {
                          event.preventDefault();
                          event.stopPropagation();
                          setTypeInfo(null);
                        }
                      }}
                      onPointerEnter={(event) => {
                        if (event.pointerType === "mouse") {
                          inspect(token, event.currentTarget);
                        }
                      }}
                      style={color}
                      type="button"
                    >
                      {token.content}
                    </button>
                  ) : (
                    <span
                      className={styles.token}
                      key={token.offset}
                      style={color}
                    >
                      {token.content}
                    </span>
                  );
                })}
                {line.tokens.length === 0 ? "\u200b" : null}
              </span>
            </span>
          ))}
        </code>
      </pre>
      {typeInfo && (
        <div
          className={styles.typeTooltip}
          id={id}
          role="tooltip"
          style={{
            left: typeInfo.left,
            top: typeInfo.top,
            width: typeInfo.width,
          }}
        >
          <span className={styles.typeLabel}>
            TypeScript / {typeInfo.token.symbol}
          </span>
          <pre>{typeInfo.token.type}</pre>
        </div>
      )}
    </div>
  );
}
