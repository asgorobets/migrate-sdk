/** @jsxImportSource @opentui/react */

import type { KeyEvent } from "@opentui/core";
import type {
  SessionActivityEntry,
  SessionActivityState,
} from "../session-activity.ts";
import { SessionActivity } from "./session-activity.tsx";
import { SessionActivityDetailDialog } from "./session-activity-detail-dialog.tsx";
import { SessionActivityExportDialog } from "./session-activity-export-dialog.tsx";

export type SessionActivityViewMode =
  | "activity"
  | "activity-detail"
  | "activity-export";

export interface SessionActivityViewProps {
  readonly activity: SessionActivityState;
  readonly detailEntry: SessionActivityEntry | null;
  readonly environmentLabel: string;
  readonly exportError?: string | undefined;
  readonly exportInputReady: boolean;
  readonly exportPath: string;
  readonly exportSaving: boolean;
  readonly height: number;
  readonly mode: SessionActivityViewMode;
  readonly onCancelExport: () => void;
  readonly onCloseDetail: () => void;
  readonly onExport: () => void;
  readonly onExportKeyDown: (key: KeyEvent) => void;
  readonly onExportPathChange: (path: string) => void;
  readonly selectedIndex: number;
  readonly width: number;
}

export const SessionActivityView = ({
  activity,
  detailEntry,
  environmentLabel,
  exportError,
  exportInputReady,
  exportPath,
  exportSaving,
  height,
  mode,
  onCancelExport,
  onCloseDetail,
  onExport,
  onExportKeyDown,
  onExportPathChange,
  selectedIndex,
  width,
}: SessionActivityViewProps) => (
  <>
    <SessionActivity
      entries={activity.entries}
      environmentLabel={environmentLabel}
      height={height}
      omitted={activity.omitted}
      selectedIndex={selectedIndex}
    />
    {mode === "activity-export" ? (
      <SessionActivityExportDialog
        entryCount={activity.entries.length}
        {...(exportError === undefined ? {} : { error: exportError })}
        height={height}
        inputReady={exportInputReady}
        onCancel={onCancelExport}
        onExport={onExport}
        onKeyDown={onExportKeyDown}
        onPathChange={onExportPathChange}
        outputPath={exportPath}
        saving={exportSaving}
        width={width}
      />
    ) : null}
    {mode === "activity-detail" && detailEntry !== null ? (
      <SessionActivityDetailDialog
        entry={detailEntry}
        height={height}
        onClose={onCloseDetail}
        width={width}
      />
    ) : null}
  </>
);
