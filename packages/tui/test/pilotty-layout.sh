#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PILOTTY_BIN="${PILOTTY_BIN:-${PACKAGE_DIR}/node_modules/.bin/pilotty}"
TASK_TEMP_ROOT="${TMPDIR:-/tmp}"
ARTIFACT_DIR="${TASK_TEMP_ROOT%/}/migrate-tui-pilotty-$$"
SESSION="migrate-tui-layout"
BUTTON_SESSION="migrate-tui-button"
CANCELLATION_SESSION="migrate-tui-cancellation"
GROUP_SESSION="migrate-tui-groups"
DEPENDENCY_SESSION="migrate-tui-dependencies"
FORCE_SESSION="migrate-tui-force"
HIERARCHY_SESSION="migrate-tui-hierarchy"
LARGE_HIERARCHY_SESSION="migrate-tui-large-hierarchy"
SELECTIVE_SESSION="migrate-tui-selective"
SOURCE_STATUS_SESSION="migrate-tui-source-status"
LOCK_SESSION="migrate-tui-lock"

mkdir -p "${ARTIFACT_DIR}"
PILOTTY_SOCKET_DIR="/tmp/migrate-tui-pilotty-socket-$$"
export PILOTTY_SOCKET_DIR
mkdir -p "${PILOTTY_SOCKET_DIR}"

cleanup() {
  "${PILOTTY_BIN}" key -s "${SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${BUTTON_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${CANCELLATION_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${GROUP_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${DEPENDENCY_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${FORCE_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${HIERARCHY_SESSION}" Escape >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${HIERARCHY_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${LARGE_HIERARCHY_SESSION}" Escape >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${LARGE_HIERARCHY_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" Escape >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${SOURCE_STATUS_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${LOCK_SESSION}" Escape >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" key -s "${LOCK_SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" stop >/dev/null 2>&1 || true
}

trap cleanup EXIT

"${PILOTTY_BIN}" spawn \
  --name "${SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/migrate.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" m >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 5000 \
  "No messages." >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/messages-tab.txt"
"${PILOTTY_BIN}" key -s "${SESSION}" Escape >/dev/null

"${PILOTTY_BIN}" key -s "${SESSION}" Down >/dev/null
"${PILOTTY_BIN}" resize -s "${SESSION}" 120 28 >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/short-dashboard.txt"
"${PILOTTY_BIN}" resize -s "${SESSION}" 120 24 >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" m >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 5000 \
  "Message 1 of 3" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/messages-populated.txt"
"${PILOTTY_BIN}" key -s "${SESSION}" Enter >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 5000 \
  "↵ Close" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/message-expanded.txt"
"${PILOTTY_BIN}" key -s "${SESSION}" Escape >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" j >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 5000 \
  "Message 2 of 3" >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" PageDown >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 5000 \
  "Message 3 of 3" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/messages-scrolled.txt"
"${PILOTTY_BIN}" key -s "${SESSION}" Escape >/dev/null
"${PILOTTY_BIN}" resize -s "${SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 150 \
  --strict \
  --format compact >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" f >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 5000 \
  "2 migrated" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 500 \
  --strict \
  --format text >"${ARTIFACT_DIR}/wide-dashboard.txt"
"${PILOTTY_BIN}" key -s "${SESSION}" Up >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" b >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 5000 \
  "Confirm rollback" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/rollback-confirmation.txt"
"${PILOTTY_BIN}" key -s "${SESSION}" y >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 750 \
  --strict \
  --format compact >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" Down >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" Down >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" Enter >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 5000 \
  "All actions · assets" >/dev/null
"${PILOTTY_BIN}" key -s "${SESSION}" Escape >/dev/null
"${PILOTTY_BIN}" resize -s "${SESSION}" 72 34 >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 750 \
  --strict \
  --format text >"${ARTIFACT_DIR}/compact.txt"

"${PILOTTY_BIN}" spawn \
  --name "${BUTTON_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/migrate.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${BUTTON_SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${BUTTON_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${BUTTON_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/button-dashboard.txt"
"${PILOTTY_BIN}" click -s "${BUTTON_SESSION}" 27 50 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${BUTTON_SESSION}" -t 5000 \
  "2 migrated" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${BUTTON_SESSION}" \
  --settle 500 \
  --strict \
  --format text >"${ARTIFACT_DIR}/button-dashboard-after-run.txt"

"${PILOTTY_BIN}" spawn \
  --name "${GROUP_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/migrate.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${GROUP_SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${GROUP_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" key -s "${GROUP_SESSION}" g >/dev/null
"${PILOTTY_BIN}" snapshot -s "${GROUP_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/group-after-switch.txt"
"${PILOTTY_BIN}" wait-for -s "${GROUP_SESSION}" -t 5000 \
  "3 migrations" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${GROUP_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/group-dashboard.txt"
"${PILOTTY_BIN}" snapshot -s "${GROUP_SESSION}" \
  --settle 150 \
  --strict \
  --format full >"${ARTIFACT_DIR}/group-dashboard.json"
"${PILOTTY_BIN}" key -s "${GROUP_SESSION}" m >/dev/null
"${PILOTTY_BIN}" wait-for -s "${GROUP_SESSION}" -t 5000 \
  "articles · Source identity article-" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${GROUP_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/group-messages.txt"
"${PILOTTY_BIN}" key -s "${GROUP_SESSION}" Escape >/dev/null
"${PILOTTY_BIN}" key -s "${GROUP_SESSION}" Enter >/dev/null
"${PILOTTY_BIN}" wait-for -s "${GROUP_SESSION}" -t 5000 \
  "All actions · content" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${GROUP_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/group-all-actions.txt"
"${PILOTTY_BIN}" key -s "${GROUP_SESSION}" Escape >/dev/null
"${PILOTTY_BIN}" key -s "${GROUP_SESSION}" r >/dev/null
"${PILOTTY_BIN}" wait-for -s "${GROUP_SESSION}" -t 5000 \
  "GROUP   SUCCEEDED" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${GROUP_SESSION}" \
  --settle 500 \
  --strict \
  --format text >"${ARTIFACT_DIR}/group-dashboard-after-run.txt"

"${PILOTTY_BIN}" spawn \
  --name "${DEPENDENCY_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/dependency-preflight.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${DEPENDENCY_SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${DEPENDENCY_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" key -s "${DEPENDENCY_SESSION}" Down >/dev/null
"${PILOTTY_BIN}" key -s "${DEPENDENCY_SESSION}" r >/dev/null
"${PILOTTY_BIN}" wait-for -s "${DEPENDENCY_SESSION}" -t 5000 \
  "Required dependencies not ready" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${DEPENDENCY_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/dependency-decision.txt"
"${PILOTTY_BIN}" resize -s "${DEPENDENCY_SESSION}" 72 34 >/dev/null
"${PILOTTY_BIN}" snapshot -s "${DEPENDENCY_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/dependency-decision-compact.txt"
"${PILOTTY_BIN}" resize -s "${DEPENDENCY_SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" key -s "${DEPENDENCY_SESSION}" i >/dev/null
"${PILOTTY_BIN}" wait-for -s "${DEPENDENCY_SESSION}" -t 5000 \
  "1 migrated" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${DEPENDENCY_SESSION}" \
  --settle 500 \
  --strict \
  --format text >"${ARTIFACT_DIR}/dependency-after-include.txt"

"${PILOTTY_BIN}" spawn \
  --name "${FORCE_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/dependency-preflight.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${FORCE_SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${FORCE_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" key -s "${FORCE_SESSION}" Down >/dev/null
"${PILOTTY_BIN}" key -s "${FORCE_SESSION}" r >/dev/null
"${PILOTTY_BIN}" wait-for -s "${FORCE_SESSION}" -t 5000 \
  "Required dependencies not ready" >/dev/null
"${PILOTTY_BIN}" key -s "${FORCE_SESSION}" f >/dev/null
"${PILOTTY_BIN}" wait-for -s "${FORCE_SESSION}" -t 5000 \
  "1 migrated" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${FORCE_SESSION}" \
  --settle 500 \
  --strict \
  --format text >"${ARTIFACT_DIR}/dependency-after-force.txt"

"${PILOTTY_BIN}" spawn \
  --name "${HIERARCHY_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js \
  --config examples/transitive-dependency.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${HIERARCHY_SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${HIERARCHY_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" key -s "${HIERARCHY_SESSION}" b >/dev/null
"${PILOTTY_BIN}" wait-for -s "${HIERARCHY_SESSION}" -t 5000 \
  "Confirm rollback" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${HIERARCHY_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/transitive-rollback-hierarchy.txt"

"${PILOTTY_BIN}" spawn \
  --name "${LARGE_HIERARCHY_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/large-rollback.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${LARGE_HIERARCHY_SESSION}" 72 24 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${LARGE_HIERARCHY_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" key -s "${LARGE_HIERARCHY_SESSION}" b >/dev/null
"${PILOTTY_BIN}" wait-for -s "${LARGE_HIERARCHY_SESSION}" -t 5000 \
  "↑↓ scroll · y rollback · n/esc cancel" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${LARGE_HIERARCHY_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/large-rollback-hierarchy.txt"
for _ in {1..20}; do
  "${PILOTTY_BIN}" key -s "${LARGE_HIERARCHY_SESSION}" Down >/dev/null
done
"${PILOTTY_BIN}" snapshot -s "${LARGE_HIERARCHY_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/large-rollback-hierarchy-scrolled.txt"

"${PILOTTY_BIN}" spawn \
  --name "${SELECTIVE_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/migrate.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${SELECTIVE_SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SELECTIVE_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" Down >/dev/null
"${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" e >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SELECTIVE_SESSION}" -t 5000 \
  "2 items" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SELECTIVE_SESSION}" \
  --settle 250 \
  --strict \
  --format compact >/dev/null
"${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" Space >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SELECTIVE_SESSION}" -t 5000 \
  "1 selected" >/dev/null
"${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" Down >/dev/null
"${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" Space >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SELECTIVE_SESSION}" -t 5000 \
  "2 selected" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SELECTIVE_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/selective-run-history.txt"
"${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" Escape >/dev/null
"${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" e >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SELECTIVE_SESSION}" -t 5000 \
  "2 selected" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SELECTIVE_SESSION}" \
  --settle 250 \
  --strict \
  --format compact >/dev/null
"${PILOTTY_BIN}" key -s "${SELECTIVE_SESSION}" Enter >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SELECTIVE_SESSION}" -t 10000 \
  "2 migrated" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SELECTIVE_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/selective-run-completed.txt"

"${PILOTTY_BIN}" spawn \
  --name "${SOURCE_STATUS_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/source-status.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${SOURCE_STATUS_SESSION}" 120 30 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SOURCE_STATUS_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" key -s "${SOURCE_STATUS_SESSION}" s >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SOURCE_STATUS_SESSION}" -t 5000 \
  "Source scan complete" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SOURCE_STATUS_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/source-status.txt"
"${PILOTTY_BIN}" resize -s "${SOURCE_STATUS_SESSION}" 72 28 >/dev/null
"${PILOTTY_BIN}" key -s "${SOURCE_STATUS_SESSION}" PageDown >/dev/null
"${PILOTTY_BIN}" key -s "${SOURCE_STATUS_SESSION}" PageDown >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SOURCE_STATUS_SESSION}" -t 5000 \
  "Capabilities" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SOURCE_STATUS_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/source-status-compact-scrolled.txt"

"${PILOTTY_BIN}" spawn \
  --name "${LOCK_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/locked.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${LOCK_SESSION}" 120 30 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${LOCK_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${LOCK_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/locked-dashboard.txt"
"${PILOTTY_BIN}" key -s "${LOCK_SESSION}" u >/dev/null
"${PILOTTY_BIN}" wait-for -s "${LOCK_SESSION}" -t 5000 \
  "Break migration lock" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${LOCK_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/break-lock-confirmation.txt"
"${PILOTTY_BIN}" key -s "${LOCK_SESSION}" y >/dev/null
"${PILOTTY_BIN}" wait-for -s "${LOCK_SESSION}" -t 5000 \
  "Lock cleared for locked-migration" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${LOCK_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/lock-cleared.txt"

"${PILOTTY_BIN}" spawn \
  --name "${CANCELLATION_SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  node bin/migrate-tui.js --config examples/cancellation.config.ts >/dev/null
"${PILOTTY_BIN}" resize -s "${CANCELLATION_SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${CANCELLATION_SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" key -s "${CANCELLATION_SESSION}" r >/dev/null
"${PILOTTY_BIN}" wait-for -s "${CANCELLATION_SESSION}" -t 5000 \
  "is running" >/dev/null
"${PILOTTY_BIN}" key -s "${CANCELLATION_SESSION}" q >/dev/null
"${PILOTTY_BIN}" wait-for -s "${CANCELLATION_SESSION}" -t 5000 \
  "waiting for active work to finish" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${CANCELLATION_SESSION}" \
  --settle 150 \
  --strict \
  --format text >"${ARTIFACT_DIR}/cancellation-drain.txt"

for _ in {1..50}; do
  "${PILOTTY_BIN}" status -s "${CANCELLATION_SESSION}" \
    >"${ARTIFACT_DIR}/cancellation-status.json"
  if grep -Fq '"state": "exited"' \
    "${ARTIFACT_DIR}/cancellation-status.json"; then
    break
  fi
  sleep 0.1
done

failed=0

assert_contains() {
  local file="$1"
  local expected="$2"
  local label="$3"

  if ! grep -Fq "${expected}" "${file}"; then
    echo "FAIL: ${label}" >&2
    failed=1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  local label="$3"

  if grep -Fq "${unexpected}" "${file}"; then
    echo "FAIL: ${label}" >&2
    failed=1
  fi
}

assert_line_excludes() {
  local file="$1"
  local containing="$2"
  local unexpected="$3"
  local label="$4"
  local line

  line="$(grep -F "${containing}" "${file}" | head -n 1 || true)"
  if [[ -z "${line}" || "${line}" == *"${unexpected}"* ]]; then
    echo "FAIL: ${label}" >&2
    failed=1
  fi
}

assert_contains \
  "${ARTIFACT_DIR}/short-dashboard.txt" \
  "f Retry failed" \
  "short wide details keep the action footer visible"
assert_line_excludes \
  "${ARTIFACT_DIR}/short-dashboard.txt" \
  "f Retry failed" \
  "article-" \
  "short wide action footer does not overlap diagnostic text"
assert_contains \
  "${ARTIFACT_DIR}/compact.txt" \
  "m messages · s scan · R reload · q quit" \
  "compact shortcut footer remains readable"
assert_contains \
  "${ARTIFACT_DIR}/compact.txt" \
  "r Run" \
  "compact details display the Run action"
assert_contains \
  "${ARTIFACT_DIR}/compact.txt" \
  "t retry skipped" \
  "compact footer advertises retrying skipped items when available"
assert_contains \
  "${ARTIFACT_DIR}/compact.txt" \
  "↵ More" \
  "compact details display the All actions menu"
assert_contains \
  "${ARTIFACT_DIR}/compact.txt" \
  "Status reloaded" \
  "compact notice remains readable"
assert_contains \
  "${ARTIFACT_DIR}/rollback-confirmation.txt" \
  "Confirm rollback" \
  "rollback confirmation remains readable"
assert_contains \
  "${ARTIFACT_DIR}/rollback-confirmation.txt" \
  "authors · Step numbers show rollback execution order." \
  "rollback confirmation explains how to read execution order"
assert_contains \
  "${ARTIFACT_DIR}/rollback-confirmation.txt" \
  "Affected migration hierarchy" \
  "rollback confirmation distinguishes hierarchy from execution order"
assert_contains \
  "${ARTIFACT_DIR}/rollback-confirmation.txt" \
  "articles" \
  "rollback hierarchy includes the affected dependent first"
assert_contains \
  "${ARTIFACT_DIR}/rollback-confirmation.txt" \
  "required SUCCEEDED" \
  "rollback hierarchy uses detail-panel dependency and status vocabulary"
assert_contains \
  "${ARTIFACT_DIR}/rollback-confirmation.txt" \
  "y rollback · n/esc cancel" \
  "rollback controls remain readable"
assert_contains \
  "${ARTIFACT_DIR}/button-dashboard-after-run.txt" \
  "2 migrated" \
  "pointer activation of an ordinary Run executes directly"
assert_not_contains \
  "${ARTIFACT_DIR}/button-dashboard-after-run.txt" \
  "Confirm" \
  "ordinary Run does not open a generic confirmation"
assert_contains \
  "${ARTIFACT_DIR}/button-dashboard.txt" \
  "✓ authors" \
  "migration list displays the succeeded status icon before the name"
assert_contains \
  "${ARTIFACT_DIR}/button-dashboard.txt" \
  "✕ articles" \
  "migration list displays the failed status icon before the name"
assert_contains \
  "${ARTIFACT_DIR}/group-dashboard.txt" \
  "[ Groups 1 ]" \
  "group hotkey activates the Groups tab"
assert_contains \
  "${ARTIFACT_DIR}/group-dashboard.txt" \
  "content  GROUP" \
  "group details display the selected group"
assert_contains \
  "${ARTIFACT_DIR}/group-dashboard.txt" \
  "FAILED" \
  "group details display aggregate status"
assert_contains \
  "${ARTIFACT_DIR}/group-dashboard.txt" \
  "3 migrations · dependencies outside this group are not included" \
  "group details disclose execution scope"
assert_contains \
  "${ARTIFACT_DIR}/group-dashboard.txt" \
  "f Retry failed" \
  "group details prioritize failed items in the retry slot"
assert_not_contains \
  "${ARTIFACT_DIR}/group-dashboard.txt" \
  "t Retry skipped" \
  "group details keep the secondary retry out of the primary row"
assert_contains \
  "${ARTIFACT_DIR}/group-dashboard.txt" \
  "↵ All actions" \
  "group details expose the complete contextual action menu"
assert_contains \
  "${ARTIFACT_DIR}/group-messages.txt" \
  "articles · Source identity article-" \
  "group messages identify both the migration and source identity"
assert_contains \
  "${ARTIFACT_DIR}/group-all-actions.txt" \
  "Retry failed  [f]" \
  "All actions includes the failed-item retry"
assert_contains \
  "${ARTIFACT_DIR}/group-all-actions.txt" \
  "Retry skipped  [t]" \
  "All actions includes the skipped-item retry"
assert_contains \
  "${ARTIFACT_DIR}/group-dashboard-after-run.txt" \
  "5 migrated" \
  "ordinary group Run executes directly"
assert_not_contains \
  "${ARTIFACT_DIR}/group-dashboard-after-run.txt" \
  "Confirm" \
  "ordinary group Run does not open a generic confirmation"
assert_contains \
  "${ARTIFACT_DIR}/dependency-decision.txt" \
  "Required dependencies not ready" \
  "blocked Run opens a dependency decision"
assert_contains \
  "${ARTIFACT_DIR}/dependency-decision.txt" \
  "articles · Some required dependencies have not succeeded." \
  "blocked Run explains its SDK preflight failure"
assert_contains \
  "${ARTIFACT_DIR}/dependency-decision.txt" \
  "Run order" \
  "dependency decision uses the detail-panel hierarchy"
assert_contains \
  "${ARTIFACT_DIR}/dependency-decision.txt" \
  "required NOT RUN" \
  "dependency decision pairs the relationship with durable status"
assert_contains \
  "${ARTIFACT_DIR}/dependency-decision.txt" \
  "i Include dependencies" \
  "dependency decision exposes the safe resolution"
assert_contains \
  "${ARTIFACT_DIR}/dependency-decision.txt" \
  "f Force run" \
  "dependency decision exposes the explicit force resolution"
assert_contains \
  "${ARTIFACT_DIR}/dependency-decision-compact.txt" \
  "i include · f force · n/esc cancel" \
  "compact dependency decision preserves its controls"
assert_contains \
  "${ARTIFACT_DIR}/dependency-after-include.txt" \
  "1 migrated" \
  "include resolution executes the expanded plan"
assert_not_contains \
  "${ARTIFACT_DIR}/dependency-after-include.txt" \
  "Required dependencies not ready" \
  "include resolution closes the decision"
assert_contains \
  "${ARTIFACT_DIR}/dependency-after-force.txt" \
  "No item history" \
  "force resolution leaves the unmet dependency untouched"
assert_contains \
  "${ARTIFACT_DIR}/dependency-after-force.txt" \
  "1 migrated" \
  "force resolution executes only the selected migration"
assert_contains \
  "${ARTIFACT_DIR}/transitive-rollback-hierarchy.txt" \
  "authors step 3" \
  "rollback hierarchy labels the selected migration with its execution step"
assert_contains \
  "${ARTIFACT_DIR}/transitive-rollback-hierarchy.txt" \
  "└─ ○ articles step 2" \
  "rollback hierarchy nests a direct dependent under the selected migration"
assert_contains \
  "${ARTIFACT_DIR}/transitive-rollback-hierarchy.txt" \
  "   └─ ○ pages step 1" \
  "rollback hierarchy preserves transitive dependency depth"
assert_contains \
  "${ARTIFACT_DIR}/large-rollback-hierarchy.txt" \
  "↑↓ scroll · y rollback · n/esc cancel" \
  "large rollback hierarchy keeps its controls visible"
assert_contains \
  "${ARTIFACT_DIR}/large-rollback-hierarchy-scrolled.txt" \
  "migration-02 step 17" \
  "large rollback hierarchy scrolls to its final entry"
assert_contains \
  "${ARTIFACT_DIR}/large-rollback-hierarchy-scrolled.txt" \
  "↑↓ scroll · y rollback · n/esc cancel" \
  "large rollback hierarchy keeps controls fixed while scrolling"
assert_contains \
  "${ARTIFACT_DIR}/selective-run-history.txt" \
  "[x] ✓ article-welcome" \
  "selective Run exposes migrated identities from durable history"
assert_contains \
  "${ARTIFACT_DIR}/selective-run-history.txt" \
  "[x] × article-effect" \
  "selective Run exposes failed identities from durable history"
assert_contains \
  "${ARTIFACT_DIR}/selective-run-history.txt" \
  "Run 2 entries" \
  "selective Run composes multiple identities in one operation"
assert_contains \
  "${ARTIFACT_DIR}/selective-run-completed.txt" \
  "2 migrated" \
  "selective Run preserves its queue when reopened and executes every identity"
assert_contains \
  "${ARTIFACT_DIR}/source-status.txt" \
  "3 total · 2 unprocessed · 0 invalid · 1 duplicate · 0 orphaned" \
  "source scan displays inventory counts"
assert_contains \
  "${ARTIFACT_DIR}/source-status.txt" \
  "Duplicate product-duplicate · 2 occurrences" \
  "source scan displays identity-specific warnings"
assert_contains \
  "${ARTIFACT_DIR}/source-status-compact-scrolled.txt" \
  "Capabilities" \
  "compact overview paging reaches details below source inventory"
assert_contains \
  "${ARTIFACT_DIR}/source-status-compact-scrolled.txt" \
  "PgUp/PgDn details" \
  "compact footer advertises overview paging"
assert_contains \
  "${ARTIFACT_DIR}/locked-dashboard.txt" \
  "Owner run  run-stuck" \
  "locked migration displays the owning run"
assert_contains \
  "${ARTIFACT_DIR}/locked-dashboard.txt" \
  "u Break lock" \
  "locked migration exposes the guarded lock action"
assert_contains \
  "${ARTIFACT_DIR}/break-lock-confirmation.txt" \
  "Only break this lock after confirming its owner is no longer" \
  "lock confirmation explains the operator precondition"
assert_contains \
  "${ARTIFACT_DIR}/break-lock-confirmation.txt" \
  "y break lock · n/esc cancel" \
  "lock confirmation keeps its controls visible"
assert_contains \
  "${ARTIFACT_DIR}/lock-cleared.txt" \
  "Lock cleared for locked-migration" \
  "confirmed lock break reloads status and reports completion"
assert_not_contains \
  "${ARTIFACT_DIR}/lock-cleared.txt" \
  "u Break lock" \
  "cleared migration no longer exposes the lock action"
assert_contains \
  "${ARTIFACT_DIR}/messages-tab.txt" \
  "No messages." \
  "messages open inside the migration detail panel"
assert_contains \
  "${ARTIFACT_DIR}/messages-populated.txt" \
  "Message 1 of 3" \
  "message navigation displays the current and total position"
assert_contains \
  "${ARTIFACT_DIR}/messages-populated.txt" \
  "Source identity article-welcome · message" \
  "message rows identify the source item"
assert_contains \
  "${ARTIFACT_DIR}/messages-populated.txt" \
  "Published article route" \
  "message rows display the durable message"
assert_contains \
  "${ARTIFACT_DIR}/messages-populated.txt" \
  "↵ expand" \
  "selected messages advertise the complete expansion view"
assert_contains \
  "${ARTIFACT_DIR}/message-expanded.txt" \
  "Details" \
  "expanded messages display structured details"
assert_contains \
  "${ARTIFACT_DIR}/message-expanded.txt" \
  "↑↓/jk scroll · PgUp/PgDn jump · Home/End" \
  "expanded message scrolling controls remain fixed"
assert_contains \
  "${ARTIFACT_DIR}/message-expanded.txt" \
  "↵ Close" \
  "expanded messages expose an explicit close action"
assert_contains \
  "${ARTIFACT_DIR}/messages-scrolled.txt" \
  "› 3/3" \
  "message navigation preserves position after scrolling"
assert_contains \
  "${ARTIFACT_DIR}/messages-scrolled.txt" \
  "↵ expand · esc back" \
  "message navigation keeps expansion controls fixed"
assert_contains \
  "${ARTIFACT_DIR}/messages-scrolled.txt" \
  "↑↓/jk move · PgUp/PgDn jump · Home/End" \
  "message navigation keeps its controls fixed while scrolling"
assert_contains \
  "${ARTIFACT_DIR}/messages-scrolled.txt" \
  "Source identity article-effect · message" \
  "scrolled messages retain their source identity"
assert_contains \
  "${ARTIFACT_DIR}/messages-scrolled.txt" \
  "Author lookup returned no result" \
  "scrolled messages retain their message text"
assert_contains \
  "${ARTIFACT_DIR}/wide-dashboard.txt" \
  "Capabilities" \
  "wide details display migration capabilities"
assert_contains \
  "${ARTIFACT_DIR}/wide-dashboard.txt" \
  "Latest message" \
  "wide details display the latest durable message"
assert_contains \
  "${ARTIFACT_DIR}/cancellation-drain.txt" \
  "waiting for active work to finish" \
  "active execution visibly finishes cancellation before quit"
assert_contains \
  "${ARTIFACT_DIR}/cancellation-status.json" \
  '"state": "exited"' \
  "attached execution exits after active work drains"

if ((failed != 0)); then
  echo "" >&2
  echo "Compact capture:" >&2
  cat "${ARTIFACT_DIR}/compact.txt" >&2
  echo "Rollback capture:" >&2
  cat "${ARTIFACT_DIR}/rollback-confirmation.txt" >&2
  echo "Dependency decision capture:" >&2
  cat "${ARTIFACT_DIR}/dependency-decision.txt" >&2
  exit 1
fi

echo "Pilotty layout checks passed"
echo "Evidence: ${ARTIFACT_DIR}"
