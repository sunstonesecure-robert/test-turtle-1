#!/usr/bin/env bats

setup() {
  REPOSITORY_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  source "${REPOSITORY_ROOT}/deploy/scripts/common.sh"
}

@test "baseline and control declarations validate" {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import json
import pathlib
import sys
import yaml
from jsonschema import Draft202012Validator

root = pathlib.Path(sys.argv[1])
for data_name, schema_name in (("baselines", "baselines"), ("controls", "controls")):
    data = yaml.safe_load((root / f"control-tower/{data_name}.yaml").read_text())
    schema = json.loads((root / f"deployment/schemas/{schema_name}.schema.json").read_text())
    Draft202012Validator(schema).validate(data)

exceptions = yaml.safe_load((root / "control-tower/control-exceptions.yaml").read_text())
assert exceptions == {"schemaVersion": 1, "exceptions": []}
PY
}

@test "control and baseline versions derive their expected values from lza.lock" {
  python3 - "${REPOSITORY_ROOT}" "${CT_OU_BASELINE_VERSION}" "${LZA_HOME_REGION}" <<'PY'
import pathlib
import sys
import yaml

root = pathlib.Path(sys.argv[1])
baseline = yaml.safe_load((root / "control-tower/baselines.yaml").read_text())["baselines"][0]
control = yaml.safe_load((root / "control-tower/controls.yaml").read_text())["controls"][0]
assert baseline["version"] == sys.argv[2]
assert control["parameters"]["AllowedRegions"] == [sys.argv[3]]
PY
}
