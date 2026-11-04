/**
 * Manages all configuration for the Cuter Intra extension: the one public
 * entry point for settings. Every feature imports from here, never from
 * src/core/config/ directly.
 *
 * The pieces live in src/core/config/:
 *  - schema.ts    BetterIntraConfig and ConfigKey, the shape of every setting
 *  - defaults.ts  CONFIG_DEFAULT, the value of every setting never written
 *  - keys.ts      CLOUD_SYNC_KEYS and VISUAL_CLOUD_KEYS, what goes to the cloud
 *  - access.ts    getConfig(), getConfigMany(), setConfig() and normalisation
 *  - snapshot.ts  the in-memory settings snapshot behind the reads
 *
 * Importing this module also switches the snapshot on (last line), which is
 * why it must stay the entry point: see "Ordering" in snapshot.ts.
 */
export type { BetterIntraConfig, ConfigKey } from "./config/schema.ts";
export { CONFIG_DEFAULT } from "./config/defaults.ts";
export { CLOUD_SYNC_KEYS, VISUAL_CLOUD_KEYS } from "./config/keys.ts";
export { getConfig, getConfigMany, setConfig } from "./config/access.ts";
export { resetConfigCache } from "./config/snapshot.ts";

import { initSnapshot } from "./config/snapshot.ts";

// Last, so that every module above is evaluated and its bindings initialised.
// Registers the onChanged listener and wraps storage.local's writes once per
// context, before any importer can register a listener of its own.
initSnapshot();
