/**
 * The friends widget's state: the shape every render function reads, and the
 * stored settings a new widget starts from. The single live instance, and the
 * handlers that mutate it, belong to the controller (friends.ui.ts).
 */
import { getConfig } from "../../core/config.ts";
import { AUTH_MODE } from "../../core/worker.ts";
import {
  getEffectiveTheme,
  onThemeChange,
  widgetTheme,
} from "../../core/theme/theme-manager.ts";
import type { FriendData } from "./friends-types.ts";
import { SORT_MODES, type SortDir, type SortMode } from "./friends-sort.ts";

/** What the panel displays. */
export interface WidgetData {
  open: boolean;
  loading: boolean;
  /** The last load failed (in part): the list shows an error and Retry. */
  loadError: boolean;
  friends: FriendData[];
  /**
   * The rows carry level, picture and custom avatar from a full load. False
   * while they come from the cheaper "online" load the closed widget does
   * for its badge (with the last known details), or from nothing yet: the
   * panel completes them when it opens.
   */
  detailed: boolean;
  sortBy: SortMode;
  sortDir: SortDir;
  onlineOnly: boolean;
  addInput: string;
  addLoading: boolean;
  addError: string;
  /**
   * A login saved although the check could not reach the server: the add
   * form offers to check it again (shown with addError, cleared with it).
   */
  addPending: string | null;
  /**
   * Saved logins the server answered for without a row (the Intra has no
   * such user: a typo saved while the check could not run). Listed with a
   * Remove button; never deleted on their own, since a changed API could
   * make every login look unknown.
   */
  missingLogins: string[];
  addOpen: boolean;
  lastFetch: number | null;
  theme: string;
  needsReconnect: boolean;
  notConnected: boolean;
  deleteMode: boolean;
  selected: string[];
  showCustomAvatars: boolean;
}

/** What the panel's controls call back into. */
export interface WidgetHandlers {
  onToggle: () => void;
  onRefresh: () => void;
  onSortChange: (mode: SortMode, dir: SortDir) => void;
  onToggleOnline: () => void;
  onDeleteMode: () => void;
  onToggleSelect: (login: string) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onInputChange: (val: string) => void;
  onAdd: () => void;
  /** Check addPending again. */
  onRetryAdd: () => void;
  /** Give up on addPending: remove it from the list. */
  onCancelAdd: () => void;
  /** Remove one of missingLogins from the list. */
  onRemoveMissing: (login: string) => void;
  onToggleAdd: () => void;
  onConnect: () => void;
  /** A row swapped between the custom and the 42 avatar: re-render. */
  onAvatarToggle: () => void;
}

export interface WidgetState extends WidgetData, WidgetHandlers {}

/**
 * The state of a freshly mounted widget: closed, empty list, and the
 * connection status, theme, sort and filters read from the stored settings.
 */
export async function loadInitialData(): Promise<WidgetData> {
  const token = await getConfig("CLOUD_TOKEN");
  const authFailed = !!(await getConfig("CLOUD_AUTH_FAILED"));

  const effectiveTheme = await getEffectiveTheme();
  const presetKey = await getConfig("PROFILE_THEME_PRESET");
  const daisyTheme = widgetTheme(effectiveTheme, presetKey || "dark");

  const storedSort = await getConfig("FRIENDS_SORT_MODE");
  const sortBy: SortMode = SORT_MODES.includes(storedSort)
    ? storedSort
    : "level";
  const storedDir = await getConfig("FRIENDS_SORT_DIR");
  const sortDir: SortDir = storedDir === "asc" ? "asc" : "desc";

  return {
    open: false,
    loading: false,
    loadError: false,
    friends: [],
    detailed: false,
    sortBy,
    sortDir,
    onlineOnly: await getConfig("FRIENDS_ONLINE_ONLY"),
    addInput: "",
    addLoading: false,
    addError: "",
    addPending: null,
    missingLogins: [],
    addOpen: false,
    lastFetch: null,
    theme: daisyTheme,
    // In intra mode nothing the widget loads uses the Cuter Intra session
    // (see loadFriendsData), so neither a missing nor an expired sign-in may
    // lock it behind a Connect or Reconnect screen.
    needsReconnect: AUTH_MODE !== "intra" && !!token && authFailed,
    notConnected: AUTH_MODE !== "intra" && !token,
    deleteMode: false,
    selected: [],
    showCustomAvatars: await getConfig("SHOW_CUSTOM_AVATARS_IN_FRIENDS"),
  };
}

/**
 * Keeps `state.theme` equal to the hub's theme after it is toggled (the page
 * is restyled live, the widget's data-theme is baked into each render) and
 * asks the controller to re-render. Returns the unsubscribe function.
 */
export function followTheme(
  state: WidgetData,
  rerender: () => void,
): () => void {
  return onThemeChange(({ theme, preset }) => {
    const next = widgetTheme(theme, preset);
    if (next === state.theme) return;
    state.theme = next;
    rerender();
  });
}
