#!/usr/bin/env bats

setup() {
  REPOSITORY_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  source "${REPOSITORY_ROOT}/deploy/scripts/common.sh"
}

@test "every ownership domain has exactly one owner and protected domains belong to Control Tower" {
  python3 - "${REPOSITORY_ROOT}/control-tower/ownership-matrix.yaml" <<'PY'
import collections
import pathlib
import sys
import yaml

matrix = yaml.safe_load(pathlib.Path(sys.argv[1]).read_text())
owners = collections.defaultdict(list)
for item in matrix["domains"]:
    owners[item["domain"]].append(item["authoritativeOwner"])
assert all(len(value) == 1 for value in owners.values())
protected = {
    "organization-cloudtrail", "config-recorders", "config-delivery-channels",
    "config-aggregator", "managed-service-control-policies", "controls",
    "control-tower-service-roles", "baseline-resources", "control-tower-stacksets",
}
assert protected <= owners.keys()
assert all(owners[name] == ["control-tower"] for name in protected)
PY
}

@test "ownership validation rejects a missing owner" {
  run python3 - "${REPOSITORY_ROOT}/control-tower/ownership-matrix.yaml" <<'PY'
import pathlib
import sys
import yaml
matrix = yaml.safe_load(pathlib.Path(sys.argv[1]).read_text())
del matrix["domains"][0]["authoritativeOwner"]
assert all(item.get("authoritativeOwner") for item in matrix["domains"])
PY
  [ "${status}" -ne 0 ]
}

@test "ownership validation rejects duplicate owners" {
  run python3 - "${REPOSITORY_ROOT}/control-tower/ownership-matrix.yaml" <<'PY'
import collections
import pathlib
import sys
import yaml
matrix = yaml.safe_load(pathlib.Path(sys.argv[1]).read_text())
matrix["domains"].append(dict(matrix["domains"][0]))
counts = collections.Counter(item["domain"] for item in matrix["domains"])
assert all(count == 1 for count in counts.values())
PY
  [ "${status}" -ne 0 ]
}

@test "ownership validation rejects LZA claims on Control Tower domains" {
  run python3 - "${REPOSITORY_ROOT}/control-tower/ownership-matrix.yaml" <<'PY'
import pathlib
import sys
import yaml
matrix = yaml.safe_load(pathlib.Path(sys.argv[1]).read_text())
matrix["domains"][0]["authoritativeOwner"] = "lza"
protected = {"organization-cloudtrail", "config-recorders", "config-delivery-channels", "config-aggregator", "controls"}
assert all(item["authoritativeOwner"] == "control-tower" for item in matrix["domains"] if item["domain"] in protected)
PY
  [ "${status}" -ne 0 ]
}
