import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point the bridge home at a throwaway directory BEFORE src/config.js loads,
 * so tests can exercise real store/outbound/journal code paths without ever
 * touching the repo's live auth/, data/ or logs/ directories. Import this
 * FIRST in any test file that (transitively) imports src/config.js.
 */
process.env.WA_BRIDGE_HOME = mkdtempSync(join(tmpdir(), "wa-bridge-test-home-"));
