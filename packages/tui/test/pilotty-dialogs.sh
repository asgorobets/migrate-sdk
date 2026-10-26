#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SDK_PACKAGE_DIR="$(cd "${PACKAGE_DIR}/../migrate-sdk" && pwd)"
PILOTTY_BIN="${PILOTTY_BIN:-${PACKAGE_DIR}/node_modules/.bin/pilotty}"
ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/migrate-tui-dialogs.XXXXXX")"
export PILOTTY_SOCKET_DIR="/tmp/mtd-$$"
ACTIVE_SESSION=""

cleanup() {
  "${PILOTTY_BIN}" stop >/dev/null 2>&1 || true
}

report_failure() {
  echo "Dialog check failed: $BASH_COMMAND" >&2
  "${PILOTTY_BIN}" snapshot -s "${ACTIVE_SESSION}" --format text >&2 || true
  echo "Evidence: ${ARTIFACT_DIR}" >&2
}

trap cleanup EXIT
trap report_failure ERR

wait_for() {
  node "${SCRIPT_DIR}/pilotty-wait-for.mjs" \
    "${PILOTTY_BIN}" "${ACTIVE_SESSION}" 30000 "$1" >/dev/null
}

key() {
  "${PILOTTY_BIN}" key -s "${ACTIVE_SESSION}" "$1" --delay "${2:-0}" >/dev/null
}

capture() {
  "${PILOTTY_BIN}" snapshot -s "${ACTIVE_SESSION}" \
    --settle 150 --strict --format text >"${ARTIFACT_DIR}/$1.txt"
}

spawn() {
  ACTIVE_SESSION="$1"
  mkdir -p "${PILOTTY_SOCKET_DIR}/${ACTIVE_SESSION}"
  "${PILOTTY_BIN}" spawn --name "${ACTIVE_SESSION}" --cwd "${PACKAGE_DIR}" \
    env TMPDIR="${PILOTTY_SOCKET_DIR}/${ACTIVE_SESSION}" \
    node bin/migrate-tui.js --config "$2" >/dev/null
  "${PILOTTY_BIN}" resize -s "${ACTIVE_SESSION}" 72 24 >/dev/null
  wait_for "Status reloaded"
}

for mode in include force; do
  spawn "dependency-${mode}" "${SDK_PACKAGE_DIR}/test/fixtures/server/dependency-preflight.config.ts"
  key Down
  wait_for "articles  NOT RUN"
  key r
  wait_for "Dependencies incomplete"
  capture "${mode}-default"
  grep -Fq "● i Include dependencies" "${ARTIFACT_DIR}/${mode}-default.txt"
  grep -Fq "1. ○ authors" "${ARTIFACT_DIR}/${mode}-default.txt"
  grep -Fq "2. ○ articles" "${ARTIFACT_DIR}/${mode}-default.txt"

  key Down
  wait_for "● f Force run"
  capture "${mode}-force-preview"
  grep -Fq "1. ○ articles" "${ARTIFACT_DIR}/${mode}-force-preview.txt"
  if grep -Fq "1. ○ authors" "${ARTIFACT_DIR}/${mode}-force-preview.txt"; then
    echo "Force preview includes an omitted dependency" >&2
    exit 1
  fi
  key Escape
  wait_for "articles  NOT RUN"
  capture "${mode}-cancelled"
  if grep -Fq "1 migrated" "${ARTIFACT_DIR}/${mode}-cancelled.txt"; then
    echo "Cancelling unexpectedly started a migration" >&2
    exit 1
  fi

  key r
  wait_for "Dependencies incomplete"
  capture "${mode}-reopened"
  # Protect only the opening Enter; changing radios must allow immediate confirmation.
  if [[ "$mode" == include ]]; then
    key "Down Up Enter" 20
  else
    key "Down Enter" 20
  fi
  wait_for "articles  COMPLETE"
  capture "${mode}-completed"
  grep -Fq "1 migrated" "${ARTIFACT_DIR}/${mode}-completed.txt"
  if [[ "$mode" == include ]]; then
    grep -Fq "✓ authors" "${ARTIFACT_DIR}/${mode}-completed.txt"
  else
    grep -Fq "○ authors" "${ARTIFACT_DIR}/${mode}-completed.txt"
  fi
  key q
  echo "PASS: ${mode} preview, Escape cancellation, and arrow/Enter with 20ms between keys"
done

spawn rollback "${PACKAGE_DIR}/test/fixtures/configs/transitive-dependency.config.ts"
"${PILOTTY_BIN}" resize -s "${ACTIVE_SESSION}" 120 36 >/dev/null
key "Down Down"
wait_for "pages  NOT RUN"
key r
wait_for "Dependencies incomplete"
capture rollback-run-ready
key Enter
wait_for "pages  COMPLETE"
key "Up Up"
wait_for "authors  COMPLETE"
key b
wait_for "Confirm rollback"
capture rollback-default
key Down
wait_for "● s Selected only"
capture rollback-selected-only
# The choice refreshes the reviewed rollback plan before confirmation.
grep -Fq "1. ✓ authors" "${ARTIFACT_DIR}/rollback-selected-only.txt"
if grep -Fq "2. ✓ articles" "${ARTIFACT_DIR}/rollback-selected-only.txt"; then
  echo "Selected-only rollback preview includes dependents" >&2
  exit 1
fi
key Enter
wait_for "authors  NOT RUN"
capture rollback-completed
grep -Fq "✓ articles" "${ARTIFACT_DIR}/rollback-completed.txt"
grep -Fq "✓ pages" "${ARTIFACT_DIR}/rollback-completed.txt"
key q
echo "PASS: rollback radio scope, Enter confirmation, and untouched dependent migrations"

spawn lock "${SDK_PACKAGE_DIR}/test/fixtures/server/locked.config.ts"
key u
wait_for "Break migration lock"
capture lock-ready
key Escape
wait_for "u Break lock"
key u
wait_for "Break migration lock"
capture lock-reopened
key Enter
wait_for "Lock cleared for locked-migration"
capture lock-cleared
key q
echo "PASS: lock confirmation with Enter and cancellation with Escape"
spawn settings "${SDK_PACKAGE_DIR}/test/fixtures/server/migrate.config.ts"
key c
wait_for "Concurrency settings"
capture settings-compact
grep -Fq "tab move · ↑↓ value · space toggle · ↵ save · esc cancel" "${ARTIFACT_DIR}/settings-compact.txt"
grep -Fq "↵ Save" "${ARTIFACT_DIR}/settings-compact.txt"
grep -Fq "esc Cancel" "${ARTIFACT_DIR}/settings-compact.txt"
key Escape
wait_for "All actions"
key q
echo "PASS: concurrency actions and keyboard hint remain visible at 72x24"
echo "Pilotty dialog checks passed"
echo "Evidence: ${ARTIFACT_DIR}"
