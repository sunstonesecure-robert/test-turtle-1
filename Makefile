.PHONY: validate-offline test-phase0

validate-offline:
	deploy/scripts/validate-config-offline.sh

test-phase0:
	bats tests/*.bats
