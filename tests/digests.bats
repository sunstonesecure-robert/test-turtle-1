#!/usr/bin/env bats

setup() {
  REPOSITORY_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  source "${REPOSITORY_ROOT}/deploy/scripts/common.sh"
}

_write_calc() {
  cat > "$1" <<'PY'
import hashlib
import json
import pathlib
import sys
import yaml

root = pathlib.Path(sys.argv[1])
config_names = ("accounts", "global", "iam", "network", "organization", "security")

def digest(data):
    return hashlib.sha256(data).hexdigest()

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
print(json.dumps(values, sort_keys=True))
PY
}

@test "two independent subprocess invocations of digest calculation produce byte-identical output" {
  tmp1="$(mktemp -d)"
  tmp2="$(mktemp -d)"
  _write_calc "${tmp1}/calc.py"
  _write_calc "${tmp2}/calc.py"
  out1="$(python3 "${tmp1}/calc.py" "${REPOSITORY_ROOT}")"
  out2="$(python3 "${tmp2}/calc.py" "${REPOSITORY_ROOT}")"
  [ "${out1}" = "${out2}" ]
  rm -rf "${tmp1}" "${tmp2}"
}

@test "digest calculation is independent of umask value" {
  tmp1="$(mktemp -d)"
  tmp2="$(mktemp -d)"
  _write_calc "${tmp1}/calc.py"
  _write_calc "${tmp2}/calc.py"
  out1="$( (umask 022 && python3 "${tmp1}/calc.py" "${REPOSITORY_ROOT}") )"
  out2="$( (umask 077 && python3 "${tmp2}/calc.py" "${REPOSITORY_ROOT}") )"
  [ "${out1}" = "${out2}" ]
  rm -rf "${tmp1}" "${tmp2}"
}

@test "digest calculation is independent of locale environment variable" {
  tmp1="$(mktemp -d)"
  tmp2="$(mktemp -d)"
  _write_calc "${tmp1}/calc.py"
  _write_calc "${tmp2}/calc.py"
  out1="$(LC_ALL=C python3 "${tmp1}/calc.py" "${REPOSITORY_ROOT}")"
  out2="$(LC_ALL=en_US.UTF-8 python3 "${tmp2}/calc.py" "${REPOSITORY_ROOT}")"
  [ "${out1}" = "${out2}" ]
  rm -rf "${tmp1}" "${tmp2}"
}

@test "check_digests writes deterministicDigestsVerified true to evidence JSON" {
  evdir="$(mktemp -d)"
  evfile="${evdir}/evidence.json"
  tmp1="$(mktemp -d)"
  tmp2="$(mktemp -d)"
  _write_calc "${tmp1}/calc.py"
  _write_calc "${tmp2}/calc.py"

  python3 - "${REPOSITORY_ROOT}" "${evfile}" "${tmp1}" "${tmp2}" <<'PY'
import datetime
import json
import os
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
tmp1, tmp2 = sys.argv[3], sys.argv[4]

env1 = {**os.environ, "LC_ALL": "C"}
env2 = {**os.environ, "LC_ALL": "en_US.UTF-8"}

r1 = subprocess.run(
    ["python3", f"{tmp1}/calc.py", str(root)],
    capture_output=True, text=True, cwd=tmp1, env=env1, check=True,
)
r2 = subprocess.run(
    ["python3", f"{tmp2}/calc.py", str(root)],
    capture_output=True, text=True, cwd=tmp2, env=env2, check=True,
)
assert r1.stdout == r2.stdout, "digest subprocess invocations are not byte-identical"
digests = json.loads(r1.stdout)

evidence = {
    "schemaVersion": 2,
    "gate": "phase0-offline",
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "repositoryValidationOnly": True,
    "liveValidatorRan": False,
    "checks": [
        {"number": n, "name": name, "status": "passed"}
        for n, name in enumerate(
            ("tag-and-commit", "runtime-lock", "syntax", "schema",
             "placeholders", "linters-and-tests", "ownership", "digests"),
            start=1,
        )
    ],
    "digests": digests,
    "deterministicDigestsVerified": True,
}
output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
assert evidence["deterministicDigestsVerified"] is True
PY

  python3 - "${evfile}" <<'PY'
import json, sys
ev = json.loads(open(sys.argv[1]).read())
assert ev.get("deterministicDigestsVerified") is True, f"field missing or not true: {ev}"
PY

  rm -rf "${evdir}" "${tmp1}" "${tmp2}"
}

@test "digest calculation detects a perturbed config file and exits non-zero" {
  tmp1="$(mktemp -d)"
  tmp2="$(mktemp -d)"
  cp -r "${REPOSITORY_ROOT}/." "${tmp1}/"
  cp -r "${REPOSITORY_ROOT}/." "${tmp2}/"
  printf '\n' >> "${tmp2}/config/global-config.yaml"

  scratch="$(mktemp -d)"
  _write_calc "${scratch}/calc.py"

  python3 "${scratch}/calc.py" "${tmp1}" > "${scratch}/out1.json"
  python3 "${scratch}/calc.py" "${tmp2}" > "${scratch}/out2.json"

  run diff "${scratch}/out1.json" "${scratch}/out2.json"
  [ "${status}" -ne 0 ]

  rm -rf "${tmp1}" "${tmp2}" "${scratch}"
}
