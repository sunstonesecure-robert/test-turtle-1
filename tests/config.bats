#!/usr/bin/env bats

setup() {
  REPOSITORY_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  source "${REPOSITORY_ROOT}/deploy/scripts/common.sh"
}

@test "config contains exactly the six mandatory LZA files" {
  run find "${REPOSITORY_ROOT}/config" -maxdepth 1 -type f -print
  [ "${status}" -eq 0 ]
  [ "${#lines[@]}" -eq 6 ]
  for name in accounts global iam network organization security; do
    [ -f "${REPOSITORY_ROOT}/config/${name}-config.yaml" ]
  done
  [ ! -e "${REPOSITORY_ROOT}/config/customizations-config.yaml" ]
}

@test "all six files conform to the pinned LZA schemas" {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import json
import pathlib
import sys
import yaml
from jsonschema import Draft7Validator

root = pathlib.Path(sys.argv[1])
schemas = root / "vendor/lza/source/packages/@aws-accelerator/config/lib/schemas"
for name in ("accounts", "global", "iam", "network", "organization", "security"):
    instance = yaml.safe_load((root / f"config/{name}-config.yaml").read_text())
    schema = json.loads((schemas / f"{name}-config.json").read_text())
    Draft7Validator(schema).validate(instance)
PY
}

@test "IAM network and security extension collections are empty" {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import pathlib
import sys
import yaml

root = pathlib.Path(sys.argv[1])
load = lambda name: yaml.safe_load((root / f"config/{name}-config.yaml").read_text())
iam = load("iam")
for key in ("providers", "policySets", "roleSets", "groupSets", "userSets"):
    assert iam[key] == []
assert "identityCenter" not in iam

network = load("network")
for key in ("transitGateways", "transitGatewayPeering", "transitGatewayConnects", "directConnectGateways", "customerGateways", "vpcs", "vpcTemplates", "vpcPeering"):
    assert network[key] == []
assert "centralNetworkServices" not in network

security = load("security")
assert security["awsConfig"]["enableConfigurationRecorder"] is False
assert security["awsConfig"]["enableDeliveryChannel"] is False
assert security["awsConfig"]["aggregation"]["enable"] is False
assert security["awsConfig"]["ruleSets"] == []
services = security["centralSecurityServices"]
for name in ("macie", "guardduty", "securityHub", "detective", "auditManager"):
    assert services[name]["enable"] is False
PY
}

@test "inputs schema rejects disabled account auto-enrollment" {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import json
import pathlib
import sys
import yaml
from jsonschema import Draft202012Validator, ValidationError

root = pathlib.Path(sys.argv[1])
inputs = yaml.safe_load((root / "deployment/inputs.example.yaml").read_text())
inputs["controlTower"]["accountAutoEnrollment"] = False
schema_root = json.loads((root / "deployment/schemas/deployment-state.schema.json").read_text())
schema = {"$schema": schema_root["$schema"], "$ref": "#/$defs/inputs", "$defs": schema_root["$defs"]}
try:
    Draft202012Validator(schema).validate(inputs)
except ValidationError:
    pass
else:
    raise AssertionError("accountAutoEnrollment=false was accepted")
PY
}
