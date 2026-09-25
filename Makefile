# Makefile — Phase 0 offline validation and tests.
#
# The offline gate is Phase 0's deliverable (Section 7.1). Both targets below
# are thin wrappers so that a developer runs locally exactly what the workflow
# .github/workflows/lza-phase0-5-1_validate-offline.yml runs in CI — one
# implementation of the eight checks, never a second copy.

SHELL := /usr/bin/env bash

# Directory holding the offline Bats suites.
TESTS_DIR := tests

.PHONY: all help validate-offline test lint

all: validate-offline test

help:
	@echo 'Targets:'
	@echo '  validate-offline  Run the credential-free Section 7.1 offline gate'
	@echo '  test              Run the Bats suites under $(TESTS_DIR)/'
	@echo '  lint              Run yamllint/shellcheck/actionlint if installed'
	@echo '  all               validate-offline then test'

# The Phase 0 gate. Runs without AWS credentials.
validate-offline:
	deploy/scripts/validate-config-offline.sh

# Bats suites the gate also runs (check 6).
test:
	bats $(TESTS_DIR)

# Best-effort local linting; each linter is skipped if not on PATH.
lint:
	@command -v yamllint   >/dev/null 2>&1 && yamllint -c .yamllint.yml config control-tower deployment || echo 'yamllint not installed, skipping'
	@command -v shellcheck >/dev/null 2>&1 && shellcheck deploy/scripts/*.sh || echo 'shellcheck not installed, skipping'
	@command -v actionlint >/dev/null 2>&1 && actionlint || echo 'actionlint not installed, skipping'
