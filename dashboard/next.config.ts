import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // scripts/gates/lib/readiness.ts is shared with the gate CLIs so the intake
  // refusal and CI enforcement cannot drift (plan.md's second seam) — it lives
  // outside the dashboard root, so allow external-dir imports.
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
