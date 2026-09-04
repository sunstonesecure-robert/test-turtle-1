#!/usr/bin/env bats

setup() {
  REPOSITORY_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  source "${REPOSITORY_ROOT}/deploy/scripts/common.sh"
}

@test "every deploy shell entry point has the required strict-mode header" {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
expected = ["#!/usr/bin/env bash", "set -Eeuo pipefail", "IFS=$'\\n\\t'", "export AWS_PAGER=''" ]
for path in sorted((root / "deploy/scripts").glob("*.sh")):
    assert path.read_text().splitlines()[:4] == expected, path
PY
}

@test "every deploy script other than common sources common.sh" {
  for path in "${REPOSITORY_ROOT}"/deploy/scripts/*.sh; do
    if [[ "${path}" != */common.sh ]]; then
      run grep -F 'source "${SCRIPT_DIR}/common.sh"' "${path}"
      [ "${status}" -eq 0 ]
    fi
  done
}
