/**
 * The maintenance block of the Advanced tab: backup export and import, the
 * detected campus and the reload of its configuration, and Reset all data.
 * Also the Profile tab's way into the visuals editor. These are one-shot
 * buttons, not stored settings.
 */
import { html, nothing, render } from "lit-html";
import { getConfig } from "../../../core/config.ts";
import { getLang, intlLocale, t, tp } from "../../../core/i18n/i18n.ts";
import { AVATAR_SELECTOR, EDIT_VISUALS_HASH } from "../../../core/intra/selectors.ts";
import { logoutCloud } from "../../account/account.ts";
import { fetchCampusList } from "../../clusters/clusters.data.ts";
import { loadCampusData } from "../../campus/campus.ts";
import {
  backupSensitiveKeys,
  exportableSettings,
  sanitizeBackup,
  unwrapBackup,
  wrapBackup,
} from "../backup.ts";
import { HUB_INFO, type HubSettingDef } from "../hubSettings.data.ts";
import { getActiveFeatures } from "../hubSettings.storage.ts";
import { settingIds, type LiveOptions } from "./context.ts";
import { renderCloudAccountAction } from "./cloud-account.ts";

export function renderAction(def: HubSettingDef) {
  const { actionType, actionLabel } = def as {
    actionType?: string;
    actionLabel?: string;
  };
  const ids = settingIds(def);
  const desc = ids.desc ?? nothing;

  if (actionType === "backup") {
    // Two buttons, each named by its own word, under the setting's label.
    return html`<div
      class="flex gap-2"
      role="group"
      aria-labelledby="${ids.label}"
      aria-describedby="${desc}"
    >
      <button
        type="button"
        class="btn btn-sm btn-primary font-bold"
        @click="${exportBackup}"
      >
        ${t("Export")}
      </button>
      <button
        type="button"
        class="btn btn-sm btn-primary font-bold"
        @click="${importBackup}"
      >
        ${t("Import")}
      </button>
    </div>`;
  }

  // A lone "Reload" or "Reset" says too little: the button is named by the
  // setting's label ("Reload campus config", "Reset all data"), which keeps
  // the visible word for voice control.
  if (actionType === "reload-campus") {
    // The outcome is written under the button: a failed fetch used to leave
    // no trace on screen (and no page reload to hint at it).
    return html`<div class="flex flex-col items-end gap-1">
      <button
        type="button"
        class="btn btn-sm btn-primary font-bold"
        aria-labelledby="${ids.label}"
        aria-describedby="${desc}"
        @click="${(e: Event) => void reloadCampusConfig(e.currentTarget as HTMLButtonElement)}"
      >
        ${actionLabel ? t(actionLabel) : t("Reload")}
      </button>
      <p class="text-xs text-error hidden" role="status" data-campus-reload-status></p>
    </div>`;
  }

  if (actionType === "cloud-sessions" || actionType === "cloud-export") {
    return renderCloudAccountAction(def);
  }

  // Its own branch: an action type this function does not know falls
  // through to the red Reset all data below.
  if (actionType === "open-visuals-editor") {
    return html`<div class="flex flex-col items-end gap-1">
      <button
        type="button"
        class="btn btn-sm btn-primary font-bold"
        aria-labelledby="${ids.label}"
        aria-describedby="${desc}"
        @click="${(e: Event) => void openVisualsEditor(e.currentTarget as HTMLButtonElement)}"
      >
        ${t("Edit")}
      </button>
      <p class="text-xs text-right max-w-xs hidden" role="status" data-visuals-editor-status></p>
    </div>`;
  }

  return html`<button
    type="button"
    class="btn btn-sm btn-error font-bold"
    aria-labelledby="${ids.label}"
    aria-describedby="${desc}"
    @click="${() => void resetAllData()}"
  >
    ${actionLabel ? t(actionLabel) : t("Reset")}
  </button>`;
}

/** My own profile page: the Intra v3 dashboard. */
export const OWN_PROFILE_URL = "https://profile-v3.intra.42.fr/";

/**
 * Opens the avatar, banner and background editor. It belongs to my own
 * profile page, where visuals.ts turns my avatar into its button (marked
 * data-modal-listener by avatar-clicks.ts): the hub clicks that very avatar
 * instead of opening the dialog itself, because the avatar's listener holds
 * the save callback that keeps visuals.ts's cache in step. Opened without
 * it, a save would be followed by the old look painted back on the page's
 * next pass. Anywhere else (someone else's profile, another page, the
 * Profile feature off), the line under the button says where to go; its
 * link carries EDIT_VISUALS_HASH, and visuals.ts opens the editor there.
 */
export async function openVisualsEditor(button?: HTMLButtonElement | null): Promise<void> {
  const avatar = document.querySelector<HTMLElement>(`${AVATAR_SELECTOR}[data-modal-listener]`);
  if (avatar) {
    // the editor is a modal of its own: it would open over the hub
    document.querySelector<HTMLDialogElement>("#hub-dialog")?.close();
    avatar.click();
    return;
  }
  const status = button?.parentElement?.querySelector<HTMLElement>(
    "[data-visuals-editor-status]",
  );
  if (!status) return;
  // Profile off: visuals.ts never runs, so no page has the editor.
  const profileOn = (await getActiveFeatures()).includes("profile");
  render(
    profileOn
      ? html`${t(
            "The editor opens on your own profile page: go there, then click your avatar or this button again.",
          )}
          <a
            class="underline"
            href="${OWN_PROFILE_URL}${EDIT_VISUALS_HASH}"
            @click="${reloadIfOnOwnProfile}"
            >${t("Open my profile")}</a
          >`
      : t(
          "Turn on Profile (the switch at the top of this tab) and reload the page first: the editor needs it.",
        ),
    status,
  );
  status.classList.remove("hidden");
}

/**
 * Already on my profile page (Profile turned on since it loaded): a link that
 * only adds a fragment would not reload it, and the editor comes with the
 * reload.
 */
function reloadIfOnOwnProfile(e: Event): void {
  if (location.origin + location.pathname !== OWN_PROFILE_URL) return;
  e.preventDefault();
  history.replaceState(history.state, "", EDIT_VISUALS_HASH);
  location.reload();
}

/** The campus the 42 API reported, named from the campus manifest. */
export async function renderCampusInfo(live: LiveOptions) {
  const campusId = await getConfig("CLUSTERS_CAMPUS");
  const campusName = campusId
    ? live.campuses.find((c) => c.value === campusId)?.label || campusId
    : t("Not detected");
  return html`<span class="badge badge-info badge-lg text-base"
    >${campusName}</span
  >`;
}

/** Downloads the settings as a dated JSON file. */
function exportBackup(): void {
  chrome.storage.local.get(null, (items) => {
    // never write credentials (cloud token, calendar secret...) to disk
    const filtered = wrapBackup(exportableSettings(items), HUB_INFO.version);
    const blob = new Blob([JSON.stringify(filtered, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const n = new Date();
    a.download = `cuter-intra-settings-${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}_${String(n.getHours()).padStart(2, "0")}-${String(n.getMinutes()).padStart(2, "0")}-${String(n.getSeconds()).padStart(2, "0")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

/** Asks for a backup file, restores it and reloads the page. */
function importBackup(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let data: Record<string, unknown>;
    let summary: string;
    try {
      const text = await file.text();
      const backup = unwrapBackup(JSON.parse(text));
      // only known, non-sensitive, correctly typed keys are restored
      data = sanitizeBackup(backup.settings);
      summary = describeBackup(Object.keys(data).length, backup);
    } catch {
      alert(t("Invalid backup file."));
      return;
    }
    if (!(await confirmBackupImport(data, summary))) return;
    await chrome.storage.local.set(data);
    location.reload();
  };
  input.click();
}

/**
 * "12 settings exported on 3 Sep 2026 (v1.12.1)" for the confirmation. The
 * date is in the browser's format, or in French when Cuter Intra is.
 */
export function describeBackup(
  count: number,
  meta: { version?: string; exportedAt?: string },
): string {
  const when = meta.exportedAt ? new Date(meta.exportedAt) : null;
  const date =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleDateString(getLang() === "fr" ? intlLocale() : [], {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";
  const version = meta.version ? ` (v${meta.version})` : "";
  const what = date
    ? tp(count, "{n} setting exported on {date}", "{n} settings exported on {date}", { date })
    : tp(count, "{n} setting", "{n} settings");
  return `${what}${version}`;
}

/**
 * Restoring overwrites the current settings at once and reloads, so it asks
 * first, like Reset all data. The custom CSS and the public profile fields
 * of a file made by someone else get a question of their own: on "no" they
 * are left out of `data`.
 */
export async function confirmBackupImport(
  data: Record<string, unknown>,
  summary: string,
  ask: (message: string) => boolean = (m) => window.confirm(m),
): Promise<boolean> {
  if (!ask(t("Restore {summary}? Your current settings will be overwritten.", { summary }))) {
    return false;
  }
  const sensitive = backupSensitiveKeys(data);
  if (sensitive.length > 0) {
    const keep = ask(
      t(
        "This backup also contains custom CSS or public profile fields (bio, status, links). Only restore them if you made this backup yourself. Restore them too?",
      ),
    );
    if (!keep) for (const key of sensitive) delete data[key];
  }
  return true;
}

/**
 * Fetches the campus configuration again and reloads. The cache is not
 * dropped first: a forced fetch overwrites it on success, and while the
 * worker is unreachable the copy of an hour ago is all the page has.
 */
export async function reloadCampusConfig(
  button?: HTMLButtonElement | null,
): Promise<void> {
  const status = button?.parentElement?.querySelector<HTMLElement>(
    "[data-campus-reload-status]",
  );
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  status?.classList.add("hidden");
  try {
    const campusId = (await getConfig("CLUSTERS_CAMPUS")) || "";
    await fetchCampusList(true);
    if (campusId) await loadCampusData(campusId, true);
    location.reload();
  } catch (e) {
    console.warn("Campus configuration reload failed", e);
    if (status) {
      status.textContent = t(
        "Could not reach the campus configuration; kept the current one.",
      );
      status.classList.remove("hidden");
    }
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

/**
 * Clears every Cuter Intra setting, after a confirmation, and reloads.
 *
 * The question used to say "settings" only: the reset also signs out, and
 * the shortcuts, friends list and calendar link that were never pushed are
 * gone for good. Signed in, the session is revoked on the worker first
 * (logoutCloud keeps the cloud copy), instead of being left to hold one of
 * the account's ten session slots.
 */
export async function resetAllData(
  ask: (message: string) => boolean = (m) => window.confirm(m),
): Promise<void> {
  const signedIn = !!(await chrome.storage.local.get("CLOUD_TOKEN")).CLOUD_TOKEN;
  const message = signedIn
    ? t(
        "Reset all data? This clears every Cuter Intra setting on this browser and signs you out. What was never pushed to the cloud (shortcuts, friends list, calendar link) is lost; your cloud copy stays, and is offered back when you sign in again.",
      )
    : t(
        "Reset all data? This clears every Cuter Intra setting on this browser, shortcuts, friends list and calendar link included. Export first to keep a copy.",
      );
  if (!ask(message)) return;
  if (signedIn) {
    try {
      await logoutCloud();
    } catch {
      /* the local reset goes on: the worker drops the session in time */
    }
  }
  await chrome.storage.local.clear();
  location.reload();
}
