#!/usr/bin/env bash

set -euo pipefail

PILOTTY_BIN="${PILOTTY_BIN:-pilotty}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TASK_TEMP_ROOT="${TMPDIR:-/tmp}"
ARTIFACT_DIR="${TASK_TEMP_ROOT%/}/migrate-tui-binary-smoke-$$"
BINARY_DIR="${TASK_TEMP_ROOT%/}/migrate-tui-binary-$$"
SESSION="migrate-tui-binary"

mkdir -p "${ARTIFACT_DIR}" "${BINARY_DIR}"
export PILOTTY_SOCKET_DIR="${ARTIFACT_DIR}/socket"
mkdir -p "${PILOTTY_SOCKET_DIR}"

cleanup() {
  "${PILOTTY_BIN}" key -s "${SESSION}" q >/dev/null 2>&1 || true
  "${PILOTTY_BIN}" stop >/dev/null 2>&1 || true
  rm -rf "${BINARY_DIR}"
}

trap cleanup EXIT

cd "${PACKAGE_DIR}"
pnpm build:binary >/dev/null
cp "${PACKAGE_DIR}/dist/binary/migrate-tui" "${BINARY_DIR}/migrate-tui"

expected_version="$(node -p 'require("./package.json").version')"
actual_version="$("${BINARY_DIR}/migrate-tui" --version)"

if [[ "${actual_version}" != "${expected_version}" ]]; then
  echo "FAIL: compiled version ${actual_version} != ${expected_version}" >&2
  exit 1
fi

"${PILOTTY_BIN}" spawn \
  --name "${SESSION}" \
  --cwd "${PACKAGE_DIR}" \
  "${BINARY_DIR}/migrate-tui" \
  --config "${PACKAGE_DIR}/examples/packaging.config.ts" >/dev/null
"${PILOTTY_BIN}" resize -s "${SESSION}" 120 36 >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 30000 \
  "Status reloaded" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 200 \
  --strict \
  --format text >"${ARTIFACT_DIR}/relocated-binary.txt"
"${PILOTTY_BIN}" key -s "${SESSION}" r >/dev/null
"${PILOTTY_BIN}" wait-for -s "${SESSION}" -t 10000 \
  "packaging-fixture  SUCCEEDED" >/dev/null
"${PILOTTY_BIN}" snapshot -s "${SESSION}" \
  --settle 200 \
  --strict \
  --format text >"${ARTIFACT_DIR}/relocated-binary-after-run.txt"
"${PILOTTY_BIN}" key -s "${SESSION}" q >/dev/null

for _ in {1..30}; do
  "${PILOTTY_BIN}" status -s "${SESSION}" \
    >"${ARTIFACT_DIR}/status.json"
  if grep -Fq '"state": "exited"' "${ARTIFACT_DIR}/status.json"; then
    break
  fi
  sleep 0.1
done

if ! grep -Fq '"state": "exited"' "${ARTIFACT_DIR}/status.json"; then
  echo "FAIL: relocated compiled binary did not exit cleanly" >&2
  cat "${ARTIFACT_DIR}/status.json" >&2
  exit 1
fi

if ! grep -Fq "[ Migrations 1 ]" "${ARTIFACT_DIR}/relocated-binary.txt"; then
  echo "FAIL: relocated compiled binary did not load external config" >&2
  cat "${ARTIFACT_DIR}/relocated-binary.txt" >&2
  exit 1
fi

if ! grep -Fq \
  "packaging-fixture  SUCCEEDED" \
  "${ARTIFACT_DIR}/relocated-binary-after-run.txt"; then
  echo "FAIL: relocated compiled binary did not execute the local SDK" >&2
  cat "${ARTIFACT_DIR}/relocated-binary-after-run.txt" >&2
  exit 1
fi

echo "Compiled binary smoke check passed"
echo "Evidence: ${ARTIFACT_DIR}"
