/**
 * Clusters tab of the settings hub: direction markers, how profiles open from
 * the map, and the cluster a page starts on.
 */
import { CONFIG_DEFAULT } from "../../../core/config.ts";
import { CLUSTERS as CLUSTER_OPTIONS } from "../../clusters/clusters.data.ts";
import type { HubSettingDef } from "../hubSettings.data.ts";

export const CLUSTERS_SETTINGS: readonly HubSettingDef[] = [
  {
    feature: "clusters",
    key: "CLUSTERS_SHOW_MARKERS",
    label: "Show markers",
    desc: "Shows the direction markers on the cluster screen.",
    kind: "toggle",
    // only Belgium's campus file declares chair positions; elsewhere the
    // switch changed nothing and read as broken
    requiresChairMarkers: true,
    defaultValue: CONFIG_DEFAULT.CLUSTERS_SHOW_MARKERS,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "clusters",
    key: "CLUSTERS_OPEN_NEW_TAB",
    label: "Open profiles in new tab",
    desc: "On the Intra's own cluster page (meta.intra.42.fr), clicking a student opens their profile in a new tab. The Cuter Intra map always does.",
    kind: "toggle",
    defaultValue: CONFIG_DEFAULT.CLUSTERS_OPEN_NEW_TAB,
    grid: true,
    colSpan: 1,
  },
  {
    feature: "clusters",
    key: "CLUSTERS_DEFAULT_ID",
    label: "Default cluster",
    desc: "Prefills a cluster page when the page opens.",
    kind: "select",
    defaultValue: String(CONFIG_DEFAULT.CLUSTERS_DEFAULT_ID),
    // cluster names from the campus data, shown as written in every language
    translateOptions: false,
    options: CLUSTER_OPTIONS.map((c) => ({
      label: c.name.toUpperCase(),
      value: c.id,
    })),
    grid: true,
    colSpan: 1,
  },
];
