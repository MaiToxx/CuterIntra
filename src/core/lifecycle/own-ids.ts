/**
 * Ids (or id prefixes) of the nodes Cuter Intra injects itself.
 *
 * Two readers, which is why the list lives in core: the profile watcher uses
 * it to tell our own DOM writes apart from the ones the React app makes
 * (profile.ts), and the stale-instance cleanup uses it to find what an
 * earlier instance of the extension left in the tab (stale-instance.ts).
 * A new injected id that matches none of these prefixes costs a profile pass
 * per write and survives an add-on update as a dead node: add its prefix.
 */
export const OWN_ID_PREFIXES: readonly string[] = [
  "ft-",
  "better-intra",
  "logtime-",
  "events-shadow",
  "project-badges",
  "profile-badges",
  "friends-widget",
  "shortcuts-shadow",
  "hub-",
  "profile-modal-host",
  "fire-milestone",
  "update-banner",
  "permission-banner",
];

/** True when `id` is one of ours (see OWN_ID_PREFIXES). */
export const isOwnId = (id: string): boolean =>
  !!id && OWN_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
