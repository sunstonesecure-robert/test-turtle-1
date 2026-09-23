#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
export AWS_PAGER=''

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPOSITORY_ROOT
readonly LZA_LOCK_FILE="${REPOSITORY_ROOT}/lza.lock"

lza_lock_value() {
  local key="$1"
  local value

  value="$(awk -v wanted="${key}" '
    $0 ~ "^[[:space:]]*" wanted ":[[:space:]]*" {
      count++
      line = $0
      sub("^[[:space:]]*" wanted ":[[:space:]]*", "", line)
      print line
    }
    END { if (count != 1) exit 1 }
  ' "${LZA_LOCK_FILE}")" || {
    printf 'lza.lock must contain exactly one %s key\n' "${key}" >&2
    return 1
  }

  if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
    value="${value:1:${#value}-2}"
  fi
  [[ -n "${value}" ]] || {
    printf 'lza.lock key %s must not be empty\n' "${key}" >&2
    return 1
  }
  printf '%s\n' "${value}"
}

readonly -a _lza_expected_lock_keys=(
  schemaVersion sourceRepository version commit nodeMajor yarnVersion partition
  homeRegion controlTowerLandingZoneVersion controlTowerOuBaselineVersion
)
_lza_lock_key_count="$(awk -F: '/^[A-Za-z][A-Za-z0-9]*:/ { count++ } END { print count + 0 }' "${LZA_LOCK_FILE}")"
[[ "${_lza_lock_key_count}" -eq "${#_lza_expected_lock_keys[@]}" ]] || {
  printf 'lza.lock must contain exactly %s flat keys\n' "${#_lza_expected_lock_keys[@]}" >&2
  exit 1
}
for _lza_key in "${_lza_expected_lock_keys[@]}"; do
  lza_lock_value "${_lza_key}" >/dev/null
done

LZA_LOCK_SCHEMA_VERSION="$(lza_lock_value schemaVersion)"
LZA_SOURCE_REPOSITORY="$(lza_lock_value sourceRepository)"
LZA_VERSION="$(lza_lock_value version)"
LZA_COMMIT="$(lza_lock_value commit)"
LZA_NODE_MAJOR="$(lza_lock_value nodeMajor)"
LZA_YARN_VERSION="$(lza_lock_value yarnVersion)"
LZA_PARTITION="$(lza_lock_value partition)"
LZA_HOME_REGION="$(lza_lock_value homeRegion)"
CT_LANDING_ZONE_VERSION="$(lza_lock_value controlTowerLandingZoneVersion)"
CT_OU_BASELINE_VERSION="$(lza_lock_value controlTowerOuBaselineVersion)"
readonly LZA_LOCK_SCHEMA_VERSION LZA_SOURCE_REPOSITORY LZA_VERSION LZA_COMMIT
readonly LZA_NODE_MAJOR LZA_YARN_VERSION LZA_PARTITION LZA_HOME_REGION
readonly CT_LANDING_ZONE_VERSION CT_OU_BASELINE_VERSION

export LZA_LOCK_SCHEMA_VERSION LZA_SOURCE_REPOSITORY LZA_VERSION LZA_COMMIT
export LZA_NODE_MAJOR LZA_YARN_VERSION LZA_PARTITION LZA_HOME_REGION
export CT_LANDING_ZONE_VERSION CT_OU_BASELINE_VERSION
