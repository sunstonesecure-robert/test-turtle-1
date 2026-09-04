# GovCloud Landing Zone Accelerator foundation

This repository’s Phase 0 gate validates the desired Landing Zone Accelerator and AWS Control Tower configuration without AWS credentials.

The authoritative upstream source, runtime toolchain, partition, Regions, and Control Tower compatibility versions are recorded only in `lza.lock`. All shell readers source `deploy/scripts/common.sh`.

From the repository root, run `make -C inputs/lza-phase0 validate-offline` after checking the locked upstream source out at `inputs/lza-phase0/vendor/lza`. Generated manifests, evidence, and source checkouts remain under the bundle's ignored `build/` and `vendor/` directories.
