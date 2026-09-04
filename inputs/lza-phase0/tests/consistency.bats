#!/usr/bin/env bats

setup() {
  REPOSITORY_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  source "${REPOSITORY_ROOT}/deploy/scripts/common.sh"
}

@test "Control Tower declarations and LZA global configuration agree with lza.lock" {
  python3 - "${REPOSITORY_ROOT}" "${CT_LANDING_ZONE_VERSION}" "${CT_OU_BASELINE_VERSION}" "${LZA_HOME_REGION}" <<'PY'
import json
import pathlib
import sys
import yaml

root = pathlib.Path(sys.argv[1])
landing_zone_version, baseline_version, home_region = sys.argv[2:]
global_config = yaml.safe_load((root / "config/global-config.yaml").read_text())
manifest = json.loads((root / "control-tower/landing-zone-manifest.template.json").read_text())
inputs = yaml.safe_load((root / "deployment/inputs.example.yaml").read_text())
baseline = yaml.safe_load((root / "control-tower/baselines.yaml").read_text())["baselines"][0]

assert global_config["controlTower"]["landingZone"]["version"] == landing_zone_version
assert inputs["controlTower"]["landingZoneVersion"] == landing_zone_version
assert baseline["version"] == inputs["controlTower"]["infrastructureBaselineVersion"] == baseline_version
assert global_config["homeRegion"] == inputs["aws"]["govCloudHomeRegion"] == home_region
assert global_config["enabledRegions"] == manifest["governedRegions"] == inputs["controlTower"]["governedRegions"] == [home_region]

logging = global_config["controlTower"]["landingZone"]["logging"]
central = manifest["centralizedLogging"]["configurations"]
config = manifest["config"]["configurations"]
assert logging["loggingBucketRetentionDays"] == central["loggingBucket"]["retentionDays"] == config["loggingBucket"]["retentionDays"] == inputs["controlTower"]["loggingRetentionDays"]
assert logging["accessLoggingBucketRetentionDays"] == central["accessLoggingBucket"]["retentionDays"] == config["accessLoggingBucket"]["retentionDays"] == inputs["controlTower"]["accessLogRetentionDays"]
assert logging["organizationTrail"] is True
assert global_config["logging"]["cloudtrail"]["organizationTrail"] is False
assert manifest["centralizedLogging"]["enabled"] is inputs["controlTower"]["centralizedLoggingEnabled"] is True
PY
}

@test "the permitted deployment input copy matches the LZA provenance lock" {
  python3 - "${REPOSITORY_ROOT}" "${LZA_VERSION}" "${LZA_COMMIT}" <<'PY'
import pathlib
import sys
import yaml
inputs = yaml.safe_load((pathlib.Path(sys.argv[1]) / "deployment/inputs.example.yaml").read_text())
assert inputs["lza"]["version"] == sys.argv[2]
assert inputs["lza"]["commit"] == sys.argv[3]
PY
}

@test "locked LZA and Yarn literals occur in no other Phase 0 file" {
  run python3 - "${REPOSITORY_ROOT}" "${LZA_VERSION}" "${LZA_COMMIT}" "${LZA_YARN_VERSION}" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
values = sys.argv[2:]
allowed = {root / "lza.lock", root / "deployment/inputs.example.yaml"}
paths = []
for name in ("config", "control-tower", "deployment", "deploy", "tests"):
    paths.extend(path for path in (root / name).rglob("*") if path.is_file())
paths.append(root / ".github/workflows/lza-phase0_validate-offline.yml")
for path in paths:
    if path in allowed:
        continue
    text = path.read_text()
    assert not any(value in text for value in values), path
assert values[2] not in (root / "deployment/inputs.example.yaml").read_text()
PY
  [ "${status}" -eq 0 ]
}
