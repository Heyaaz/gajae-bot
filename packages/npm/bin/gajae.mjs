#!/usr/bin/env node
// Runs the same install.sh as the curl installer. Files npm and curl download
// carry no quarantine flag, so the ad-hoc signed app opens without Gatekeeper.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [version] = process.argv.slice(2);
if (version === "-h" || version === "--help") {
  console.log("Usage: npx gajae [version]\nInstalls or updates Gajae to the latest release, or to the given version.");
  process.exit(0);
}
const script = fileURLToPath(new URL("../install.sh", import.meta.url));
const result = spawnSync("/bin/sh", [script], {
  stdio: "inherit",
  env: version ? { ...process.env, GAJAE_VERSION: version } : process.env,
});
process.exit(result.status ?? 1);
