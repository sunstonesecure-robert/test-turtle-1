Feature: Check 8 — deterministic digest verification (DONE-090)
  As a gate runner
  I want the digest calculation to be reproducible across independent subprocess invocations
  So that DONE-090 determinism guarantees hold under varying OS environments

  Scenario: Two independent subprocess invocations of digest calculation produce byte-identical output
    Given the repository content is accessible at REPOSITORY_ROOT
    When the digest calculation script runs in two separate Python subprocesses in distinct temporary directories
    Then both invocations produce byte-for-byte identical JSON digest output

  Scenario: Digest calculation is independent of umask value
    Given the repository content is accessible at REPOSITORY_ROOT
    When the first subprocess runs with umask 022 and the second subprocess runs with umask 077
    Then both invocations produce byte-for-byte identical JSON digest output

  Scenario: Digest calculation is independent of locale environment variable
    Given the repository content is accessible at REPOSITORY_ROOT
    When the first subprocess runs with LC_ALL=C and the second subprocess runs with LC_ALL=en_US.UTF-8
    Then both invocations produce byte-for-byte identical JSON digest output

  Scenario: check_digests writes deterministicDigestsVerified true to evidence JSON
    Given two independent subprocess invocations complete and produce identical digest outputs
    When the evidence JSON is assembled with the agreed digest set
    Then the evidence JSON contains a deterministicDigestsVerified field with value true

  Scenario: Digest calculation detects a perturbed config file and exits non-zero
    Given the repository content is copied to two separate temporary directories
    And one config file byte is appended to in the second directory
    When the digest calculation script runs against each directory independently
    Then the two outputs differ
    And a byte-for-byte comparison of the outputs exits non-zero
