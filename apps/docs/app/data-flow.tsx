"use client";

import { useState } from "react";
import styles from "./page.module.css";

const packets = [
  { id: "a", lane: "upper", delay: "-1s" },
  { id: "b", lane: "middle", delay: "-3s" },
  { id: "c", lane: "lower", delay: "-5s" },
  { id: "d", lane: "upper", delay: "-4s" },
  { id: "e", lane: "middle", delay: "0s" },
  { id: "f", lane: "lower", delay: "-2s" },
] as const;

export function DataFlow() {
  const [paused, setPaused] = useState(false);

  return (
    <figure className={styles.dataFlow} data-paused={paused}>
      <button
        aria-label={
          paused ? "Play data flow animation" : "Pause data flow animation"
        }
        className={styles.flowToggle}
        onClick={() => setPaused(!paused)}
        type="button"
      >
        <span aria-hidden="true">{paused ? "[ ▷ ]" : "[ Ⅱ ]"}</span>
      </button>
      <svg
        aria-labelledby="data-flow-title"
        className={styles.flowDiagram}
        role="img"
        viewBox="-40 0 600 120"
      >
        <title id="data-flow-title">
          A Source emits Source Items. A Process Pipeline performs destination
          work.
        </title>
        <g className={styles.flowRails}>
          <path d="M48 36H158V60H260M48 60H260M48 84H158V60" />
          <path d="M260 60H362V36H472M260 60H472M362 60V84H472" />
        </g>
        <g>
          {packets.map((packet) => (
            <g
              className={styles.flowPacket}
              data-copy={packet.id}
              data-lane={packet.lane}
              key={packet.id}
              style={{ animationDelay: packet.delay }}
            >
              <rect height="10" width="16" x="-8" y="-5" />
              <path d="M-4-1H4M-4 2H1" />
            </g>
          ))}
        </g>
        <g className={styles.flowSource}>
          <path d="M61 24H27V96H61" />
          <path d="M35 36H48M35 60H48M35 84H48" />
          <path
            className={styles.flowNodeDetail}
            d="M37 42H43M37 66H43M37 90H43"
          />
        </g>
        <g className={styles.flowProcessor}>
          <rect height="46" width="50" x="235" y="37" />
          <path d="M246 52L253 60L246 68M260 68H273" />
        </g>
        <g className={styles.flowDestination}>
          <path d="M459 24H493V96H459" />
          <path className={styles.flowReceipt} d="M471 33L475 37L482 30" />
          <path
            className={styles.flowReceipt}
            d="M471 57L475 61L482 54"
            style={{ animationDelay: "-2s" }}
          />
          <path
            className={styles.flowReceipt}
            d="M471 81L475 85L482 78"
            style={{ animationDelay: "-4s" }}
          />
          <path
            className={styles.flowNodeDetail}
            d="M473 44H481M473 68H481M473 92H481"
          />
        </g>
      </svg>
      <figcaption className={styles.flowLabels}>
        <span>source</span>
        <span>process</span>
        <span>destination</span>
      </figcaption>
    </figure>
  );
}
