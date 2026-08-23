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
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 5000 "Actions · assets" >/dev/null
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
"${PILOTTY_BIN}" click -s "${BUTTON_SESSION}" 29 54 >/dev/null
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
  "m messages · s scan · R reload status · q quit" \
  "compact shortcut footer remains readable"
assert_contains \
  "${ARTIFACT_DIR}/compact.txt" \
  "r Run" \
  "compact details display the Run action"
assert_contains \
  "${ARTIFACT_DIR}/compact.txt" \
  "↵ Actions" \
  "compact details display the Actions menu"
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
  "authors · Affected migrations will roll back in this order." \
  "rollback confirmation explains the ordered dependent scope"
assert_contains \
  "${ARTIFACT_DIR}/rollback-confirmation.txt" \
  "Rollback order" \
  "rollback confirmation labels the hierarchy"
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
  "authors #3" \
  "rollback hierarchy labels the selected migration with its execution step"
assert_contains \
  "${ARTIFACT_DIR}/transitive-rollback-hierarchy.txt" \
  "└─ ○ articles #2" \
  "rollback hierarchy nests a direct dependent under the selected migration"
assert_contains \
  "${ARTIFACT_DIR}/transitive-rollback-hierarchy.txt" \
  "   └─ ○ pages #1" \
  "rollback hierarchy preserves transitive dependency depth"
assert_contains \
  "${ARTIFACT_DIR}/large-rollback-hierarchy.txt" \
  "↑↓ scroll · y rollback · n/esc cancel" \
  "large rollback hierarchy keeps its controls visible"
assert_contains \
  "${ARTIFACT_DIR}/large-rollback-hierarchy-scrolled.txt" \
  "migration-02 #17" \
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
  "${ARTIFACT_DIR}/messages-tab.txt" \
  "No messages." \
  "messages open inside the migration detail panel"
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
