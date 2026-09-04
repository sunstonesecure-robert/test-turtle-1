#!/usr/bin/env bats

setup() {
  REPOSITORY_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  source "${REPOSITORY_ROOT}/deploy/scripts/common.sh"
}

@test "landing-zone manifest is schema-valid and contains only declared placeholders" {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import json
import pathlib
import re
import sys
from jsonschema import Draft202012Validator

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "control-tower/landing-zone-manifest.template.json").read_text())
schema = json.loads((root / "deployment/schemas/landing-zone-manifest.schema.json").read_text())
Draft202012Validator(schema).validate(manifest)
assert "organizationStructure" not in manifest
tokens = re.findall(r"\$\{[^}]+\}", json.dumps(manifest))
assert sorted(set(tokens)) == sorted(("${LOG_ARCHIVE_ACCOUNT_ID}", "${AUDIT_ACCOUNT_ID}", "${CONTROL_TOWER_KMS_KEY_ARN}"))
assert manifest["centralizedLogging"]["accountId"] == "${LOG_ARCHIVE_ACCOUNT_ID}"
assert manifest["config"]["accountId"] == manifest["securityRoles"]["accountId"] == "${AUDIT_ACCOUNT_ID}"
PY
}

@test "all landing-zone integration flags are explicit" {
  python3 - "${REPOSITORY_ROOT}" <<'PY'
import json
import pathlib
import sys

manifest = json.loads((pathlib.Path(sys.argv[1]) / "control-tower/landing-zone-manifest.template.json").read_text())
assert manifest["accessManagement"]["enabled"] is False
assert manifest["backup"]["enabled"] is False
for key in ("centralizedLogging", "config", "securityRoles"):
    assert manifest[key]["enabled"] is True
PY
}
