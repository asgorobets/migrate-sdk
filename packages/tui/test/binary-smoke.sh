#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TASK_TEMP_ROOT="${TMPDIR:-/tmp}"
BINARY_DIR="${TASK_TEMP_ROOT%/}/migrate-tui-binary-$$"

mkdir -p "${BINARY_DIR}"

cleanup() {
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

echo "Compiled renderer binary version smoke check passed"
