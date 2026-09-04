#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
export AWS_PAGER=''

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

readonly LZA_DIR="${REPOSITORY_ROOT}/vendor/lza"
readonly EVIDENCE_FILE="${REPOSITORY_ROOT}/build/deployment-evidence.json"
CURRENT_CHECK='initialization'
status=0
trap 'status=$?; printf "FAILED: %s (exit %s)\n" "${CURRENT_CHECK}" "${status}" >&2; exit "${status}"' ERR

check_tag_and_commit() {
  test -d "${LZA_DIR}/.git"
  test "$(git -C "${LZA_DIR}" rev-parse "${LZA_VERSION}^{commit}")" = "${LZA_COMMIT}"
  test "$(git -C "${LZA_DIR}" rev-parse HEAD)" = "${LZA_COMMIT}"
}

check_runtime_lock() {
  python3 - "${LZA_DIR}/source/package.json" "${LZA_DIR}/source/yarn.lock" "${LZA_NODE_MAJOR}" "${LZA_YARN_VERSION}" <<'PY'
import json
import pathlib
import re
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
lock_text = pathlib.Path(sys.argv[2]).read_text()
expected_node = int(sys.argv[3])
expected_yarn = sys.argv[4]
assert manifest["config"]["node"]["version"]["default"] == expected_node
assert manifest["packageManager"].split("@", 1)[1].split("+", 1)[0] == expected_yarn
assert re.search(r"^# yarn lockfile v1$", lock_text, re.MULTILINE)
PY
}

check_syntax() {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import json
import pathlib
import sys
import yaml

root = pathlib.Path(sys.argv[1])
for directory in ("config", "control-tower", "deployment"):
    for path in sorted((root / directory).rglob("*")):
        if not path.is_file():
            continue
        if path.suffix == ".json":
            json.loads(path.read_text())
        elif path.suffix in {".yaml", ".yml"}:
            yaml.safe_load(path.read_text())
PY
}

check_schemas() {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import json
import pathlib
import sys
import yaml
from jsonschema import Draft202012Validator, FormatChecker

root = pathlib.Path(sys.argv[1])
schemas = root / "deployment/schemas"

def load(path):
    text = path.read_text()
    return json.loads(text) if path.suffix == ".json" else yaml.safe_load(text)

def validate(instance_path, schema_path, ref=None):
    schema = load(schema_path)
    if ref:
        schema = {"$schema": schema["$schema"], "$ref": ref, "$defs": schema["$defs"]}
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(load(instance_path))

state_schema = schemas / "deployment-state.schema.json"
validate(root / "deployment/inputs.example.yaml", state_schema, "#/$defs/inputs")
validate(root / "deployment/render-map.example.json", state_schema, "#/$defs/renderMap")
validate(root / "deployment/phase-state.example.json", state_schema, "#/$defs/phaseState")
validate(root / "deployment/state.example.json", state_schema)
validate(root / "control-tower/landing-zone-manifest.template.json", schemas / "landing-zone-manifest.schema.json")
validate(root / "control-tower/baselines.yaml", schemas / "baselines.schema.json")
validate(root / "control-tower/controls.yaml", schemas / "controls.schema.json")
validate(root / "control-tower/ownership-matrix.yaml", schemas / "ownership-matrix.schema.json")

evidence_fixture = {
    "schemaVersion": 2,
    "gate": "phase0-offline",
    "generatedAt": "2000-01-01T00:00:00Z",
    "repositoryValidationOnly": True,
    "liveValidatorRan": False,
    "checks": [{"number": n, "name": f"check-{n}", "status": "passed"} for n in range(1, 9)],
    "digests": {f"digest-{n}": "0" * 64 for n in range(1, 12)},
}
validate_schema = load(schemas / "deployment-evidence.schema.json")
Draft202012Validator(validate_schema, format_checker=FormatChecker()).validate(evidence_fixture)
PY
}

check_placeholders() {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
roots = [root / name for name in ("config", "control-tower", "deployment")]
allowed = {
    ("deployment/inputs.example.yaml", "REPLACE_ME"): 2,
    ("control-tower/landing-zone-manifest.template.json", "${LOG_ARCHIVE_ACCOUNT_ID}"): 1,
    ("control-tower/landing-zone-manifest.template.json", "${AUDIT_ACCOUNT_ID}"): 2,
    ("control-tower/landing-zone-manifest.template.json", "${CONTROL_TOWER_KMS_KEY_ARN}"): 2,
}
seen = {key: 0 for key in allowed}
token = re.compile(r"REPLACE_ME|TODO|CHANGEME|\$\{[^}]+\}")
for base in roots:
    paths = [base] if base.is_file() else sorted(path for path in base.rglob("*") if path.is_file())
    for path in paths:
        relative = path.relative_to(root).as_posix()
        for match in token.findall(path.read_text()):
            key = (relative, match)
            if key not in allowed:
                raise AssertionError(f"unresolved placeholder {match} in {relative}")
            seen[key] += 1
assert seen == allowed, f"declared placeholder counts differ: {seen}"
PY
}

check_linters_and_tests() {
  actionlint "${REPOSITORY_ROOT}/.github/workflows/lza-phase0_validate-offline.yml"
  shellcheck "${REPOSITORY_ROOT}"/deploy/scripts/*.sh
  yamllint -c "${REPOSITORY_ROOT}/.yamllint.yml" \
    "${REPOSITORY_ROOT}/lza.lock" \
    "${REPOSITORY_ROOT}/config" \
    "${REPOSITORY_ROOT}/control-tower" \
    "${REPOSITORY_ROOT}/deployment" \
    "${REPOSITORY_ROOT}/.github/workflows/lza-phase0_validate-offline.yml"
  cfn_templates=()
  while IFS= read -r -d '' template; do
    cfn_templates+=("${template}")
  done < <(find "${REPOSITORY_ROOT}" -path '*/vendor' -prune -o -path '*/build' -prune -o -type f \( -name '*.template.yaml' -o -name '*.template.yml' \) -print0)
  if ((${#cfn_templates[@]})); then
    cfn-lint "${cfn_templates[@]}"
  else
    cfn-lint --version >/dev/null
  fi
  bats "${REPOSITORY_ROOT}"/tests/*.bats
}

check_ownership() {
  bats "${REPOSITORY_ROOT}/tests/ownership.bats"
}

check_digests() {
  mkdir -p "${REPOSITORY_ROOT}/build"
  python3 - "${REPOSITORY_ROOT}" "${EVIDENCE_FILE}" <<'PY'
import datetime
import hashlib
import json
import pathlib
import sys
import yaml
from jsonschema import Draft202012Validator, FormatChecker

root = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
config_names = ("accounts", "global", "iam", "network", "organization", "security")

def digest(data):
    return hashlib.sha256(data).hexdigest()

def calculate():
    inputs = yaml.safe_load((root / "deployment/inputs.example.yaml").read_text())
    values = {
        "inputs": digest(json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode()),
        "baselines": digest((root / "control-tower/baselines.yaml").read_bytes()),
        "controls": digest((root / "control-tower/controls.yaml").read_bytes()),
        "ownershipMatrix": digest((root / "control-tower/ownership-matrix.yaml").read_bytes()),
    }
    aggregate = b""
    for name in config_names:
        content = (root / f"config/{name}-config.yaml").read_bytes()
        values[f"lza.{name}"] = digest(content)
        aggregate += content
    values["lza.aggregate"] = digest(aggregate)
    return values

first = calculate()
second = calculate()
assert first == second
evidence = {
    "schemaVersion": 2,
    "gate": "phase0-offline",
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "repositoryValidationOnly": True,
    "liveValidatorRan": False,
    "checks": [
        {"number": number, "name": name, "status": "passed"}
        for number, name in enumerate((
            "tag-and-commit", "runtime-lock", "syntax", "schema", "placeholders",
            "linters-and-tests", "ownership", "digests",
        ), start=1)
    ],
    "digests": first,
}
output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
schema = json.loads((root / "deployment/schemas/deployment-evidence.schema.json").read_text())
Draft202012Validator(schema, format_checker=FormatChecker()).validate(evidence)
PY
}

run_check() {
  local number="$1"
  local description="$2"
  local command_name="$3"
  CURRENT_CHECK="check ${number}: ${description}"
  printf 'RUN: %s\n' "${CURRENT_CHECK}"
  "${command_name}"
  printf 'PASS: %s\n' "${CURRENT_CHECK}"
}

cd "${REPOSITORY_ROOT}"
run_check 1 'tag and commit' check_tag_and_commit
run_check 2 'runtime lock' check_runtime_lock
run_check 3 'JSON and YAML syntax' check_syntax
run_check 4 'repository schemas' check_schemas
run_check 5 'placeholder allowlist' check_placeholders
run_check 6 'linters and Bats tests' check_linters_and_tests
run_check 7 'ownership boundaries' check_ownership
run_check 8 'deterministic digests and evidence' check_digests

printf 'Offline repository validation passed. No live LZA validator or AWS API was used.\n'
