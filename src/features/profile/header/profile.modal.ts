/**
 * The visuals editor dialog opened from my own avatar: its lifecycle (open,
 * load my settings, live preview, save to storage and the cloud, reset) and
 * the frame around the tabs (tab bar, connect screen, save button).
 *
 * The tabs themselves are in profile-modal-tabs.ts and the shared form types
 * and widgets in profile-modal-form.ts. The live preview paints through
 * visuals-apply.ts, never through visuals.ts: visuals.ts is what opens this
 * dialog, and importing it back would close an import cycle.
 */
import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { getConfig, VISUAL_CLOUD_KEYS } from "../../../core/config.ts";
import { isValidStoredValue } from "../../../core/config/access.ts";
import {
  fetchMySettings,
  loginWith42,
  clearAuthFailed,
  syncMyVisuals,
} from "../../account/account.ts";
import { applyImgs, injectCustomStyles } from "./visuals-apply.ts";
import type { VisualUrls } from "./visuals-types.ts";
import { applyBadgeLayout } from "./badges.ts";
import { getEffectiveTheme } from "../../../core/theme/theme-manager.ts";
import { sharedStylesLink } from "../../../core/styles/shared-styles.ts";
import {
  addToHistory,
  type FormState,
  type ProfileTab,
} from "./profile-modal-form.ts";
import { renderTabPanels } from "./profile-modal-tabs.ts";
import {
  IMAGE_SLOTS,
  ownUploadHash,
  uploadedSlotOf,
  type ImageSlot,
} from "./image-upload.ts";
import {
  createPendingUploads,
  SLOT_LABELS,
  type PendingUploads,
} from "./pending-uploads.ts";
import { deleteUnusedUploads } from "./upload-cleanup.ts";
import { clearLocalPreview, paintLocalPreview } from "./local-preview.ts";
import FORTY_TWO_SVG from "../../../assets/svg/42_Logo.svg?raw";
import { t } from "../../../core/i18n/i18n.ts";

let activeTab: ProfileTab = "avatar";

/** The storage keys of each image field. */
const SLOT_URL_KEY = {
  avatar: "PROFILE_IMAGE_URL",
  banner: "PROFILE_BANNER_URL",
  background: "PROFILE_BACKGROUND_URL",
} as const;
const SLOT_HISTORY_KEY = {
  avatar: "PROFILE_IMAGE_HISTORY",
  banner: "PROFILE_BANNER_HISTORY",
  background: "PROFILE_BACKGROUND_HISTORY",
} as const;

/**
 * The look as the page and the cloud take it. Every field, always:
 * syncMyVisuals() fills an omitted one with its default.
 */
/**
 * Set while a saved look has not reached the server. A plain storage key,
 * outside the settings: it is neither synced nor written to a backup file.
 */
const UNSENT_LOOK_KEY = "PROFILE_LOOK_UNSENT";

function toVisuals(look: FormState): VisualUrls {
  return {
    avatar: look.avatar || "",
    banner: look.banner || "",
    bannerMode: look.bannerMode || "fill",
    bannerColor: look.bannerColor || "",
    background: look.background || "",
    backgroundMode: look.backgroundMode || "fill",
    backgroundColor: look.backgroundColor || "",
    avatarBg: look.avatarBg,
    decoration: look.decoration,
    avatarPosX: look.avatarPosX,
    avatarPosY: look.avatarPosY,
    avatarScale: look.avatarScale,
    badgeBg: look.badgeBg || "",
  };
}

/** The Save button's state: busy while the picked images upload and the look is stored. */
interface SaveUi {
  saving: boolean;
  saveError: string;
}

function renderPanelContent(
  state: FormState,
  currentTheme: string,
  onFormUpdate: (updates: Partial<FormState>) => void,
  history: { avatar: string[]; banner: string[]; background: string[] },
  onClearHistory: (key: "avatar" | "banner" | "background") => void,
  isConnected: boolean,
  needsReconnect: boolean,
  onConnect: () => void,
  onTabChange: (tab: ProfileTab) => void,
  uploads: PendingUploads,
  ui: SaveUi,
) {
  const tabItems: { id: ProfileTab; label: string }[] = [
    { id: "avatar", label: t("Avatar") },
    { id: "banner", label: t("Banner") },
    { id: "background", label: t("Background") },
    { id: "badges", label: t("Badges") },
  ];

  const panels = renderTabPanels(
    state,
    onFormUpdate,
    history,
    onClearHistory,
    uploads,
  );

  return html`
    ${sharedStylesLink()}
    <style>
      :host { display: block; }
    </style>
    <div
      data-theme="${currentTheme}"
      class="flex flex-col p-4 gap-3 bg-base-100 rounded-2xl"
    >
      <div class="flex justify-between items-center shrink-0">
        <button
          type="button"
          id="profile-reset-btn"
          class="btn btn-outline btn-error btn-sm"
          ?disabled="${ui.saving}"
        >
          ${t("Reset")}
        </button>
        <button
          class="btn btn-circle btn-ghost btn-sm"
          id="profile-close-btn"
          ?disabled="${ui.saving}"
        >
          ✕
        </button>
      </div>

      ${!isConnected
        ? html`
            <div
              class="flex flex-col items-center gap-4 py-12 px-6 text-center"
            >
              <p class="opacity-50 max-w-72 text-sm">
                ${needsReconnect
                  ? t("Session expired. Reconnect to customize your profile pictures.")
                  : t("Connect your 42 account to customize your profile pictures.")}
              </p>
              <button
                type="button"
                class="btn bg-[#00babc] text-white border-none hover:bg-[#1fd2d4] flex items-center justify-center gap-3 mt-2"
                style="height:3rem; min-width:15rem; font-size:1rem;"
                @click="${onConnect}"
              >
                <span class="font-bold tracking-wide"
                  >${needsReconnect ? t("Reconnect") : t("Connect with")}</span
                >
                <span
                  class="size-8 flex items-center justify-center [&_polygon]:fill-current"
                >
                  ${unsafeHTML(FORTY_TWO_SVG)}
                </span>
              </button>
            </div>
          `
        : html`
            <div role="tablist" class="tabs tabs-box shrink-0">
              ${tabItems.map(
                (tab) => html`
                  <button
                    type="button"
                    role="tab"
                    aria-selected="${activeTab === tab.id}"
                    class="tab ${activeTab === tab.id ? "tab-active" : ""}"
                    @click="${() => onTabChange(tab.id)}"
                  >
                    ${tab.label}
                  </button>
                `,
              )}
            </div>

            <div
              role="tabpanel"
              style="min-height: 260px;"
              class="flex flex-col"
              ?inert="${ui.saving}"
            >
              ${panels[activeTab]}
            </div>

            ${ui.saveError
              ? html`<p class="text-error text-sm" role="alert" data-save-error>
                  ${ui.saveError}
                </p>`
              : ""}
            <button
              id="profile-save"
              class="btn btn-success font-bold shrink-0"
              ?disabled="${ui.saving || uploads.reading}"
            >
              ${ui.saving ? t("Saving…") : t("Save Changes")}
            </button>
          `}
    </div>
  `;
}

export const createSettingsModal = async (
  onSaveCallback: (updatedVisuals: VisualUrls) => void,
) => {
  if (document.getElementById("profile-modal-host")) return;

  activeTab = "avatar";

  const token = await getConfig("CLOUD_TOKEN");
  const authFailed = !!(await getConfig("CLOUD_AUTH_FAILED"));
  const isConnected = !!token && !authFailed;
  const needsReconnect = !!token && authFailed;

  const presetKey = (await getConfig("PROFILE_THEME_PRESET")) || "dark";
  const currentTheme =
    presetKey !== "dark" && presetKey !== "light"
      ? presetKey
      : await getEffectiveTheme();

  const dialog = Object.assign(document.createElement("dialog"), {
    id: "profile-modal-host",
    className: "bg-transparent backdrop:bg-black/50",
  });
  dialog.setAttribute("aria-label", t("Edit my profile visuals"));
  Object.assign(dialog.style, {
    marginTop: "auto",
    // dvh: with the browser's toolbar at the bottom (Firefox for Android) a
    // vh-sized dialog could put Save under it.
    marginBottom: "5dvh",
    width: "min(820px, calc(100dvw - 1.5rem))",
    maxHeight: "92dvh",
    borderRadius: "1.5rem",
    overflowY: "auto",
    padding: "0",
  });

  const content = document.createElement("div");
  content.style.cssText = "width:100%;display:flex;flex-direction:column;";
  dialog.appendChild(content);
  document.body.appendChild(dialog);

  const shadow = content.attachShadow({ mode: "open" });

  const skeleton = html`
    ${sharedStylesLink()}
    <style>
      :host { display: block; }
    </style>
    <div
      data-theme="${currentTheme}"
      class="flex flex-col p-4 gap-3 bg-base-100 rounded-2xl"
    >
      <div class="flex justify-between items-center">
        <div class="skeleton h-8 w-16"></div>
        <div class="skeleton h-8 w-8 rounded-full"></div>
      </div>
      <div class="flex gap-5">
        <div class="skeleton flex-1 h-64 rounded-xl"></div>
        <div class="skeleton flex-1 h-64 rounded-xl"></div>
      </div>
      <div class="flex gap-5">
        <div class="skeleton flex-1 h-48 rounded-xl"></div>
        <div class="skeleton flex-1 h-48 rounded-xl"></div>
      </div>
      <div class="skeleton h-12 w-full rounded-xl"></div>
    </div>
  `;

  render(skeleton, shadow);
  dialog.showModal();

  content.addEventListener("click", (e) => e.stopPropagation());
  // Escape triggers the native close without going through close(): the host
  // stayed in the DOM and the editor could not be reopened until a reload.
  dialog.addEventListener("close", () => dialog.remove());
  // A backdrop click closes, but only when the press started on the backdrop
  // too. Dragging the avatar preview and letting go past the dialog's edge
  // sends the click to the dialog (the common ancestor), which used to close
  // the editor and lose every unsaved edit. A press inside is seen here as
  // coming from the `content` host (the shadow root retargets it), so it never
  // counts. dialog.close() rather than `close`, which is declared further
  // down: the backdrop can be clicked while the settings are still loading.
  let downOnBackdrop = false;
  // While Save uploads and stores, the editor stays open: the X is disabled,
  // and the backdrop and Escape are ignored. A close that still happens (a
  // second Escape in Chrome) drops the results: see uploads.closed below.
  let saving = false;
  dialog.addEventListener("pointerdown", (e) => {
    downOnBackdrop = e.target === dialog;
  });
  dialog.addEventListener("click", (e) => {
    if (downOnBackdrop && e.target === dialog && !saving) dialog.close();
    downOnBackdrop = false;
  });
  dialog.addEventListener("cancel", (e) => {
    if (saving) e.preventDefault();
  });

  // A Save the server never got (offline, a 429): the look of this browser
  // is the newer one. Copying the cloud's over it, as below, put the old look
  // back at the next open of the editor.
  const unsent =
    isConnected &&
    (await chrome.storage.local.get(UNSENT_LOOK_KEY))[UNSENT_LOOK_KEY] === true;
  /** Sends the look; remembers a failure for the next open. */
  const sendLook = async (look: VisualUrls): Promise<boolean> => {
    let sent = false;
    try {
      sent = (await syncMyVisuals(look)) !== false;
    } catch (e) {
      console.error("Failed to sync visuals:", e);
    }
    if (sent) await chrome.storage.local.remove(UNSENT_LOOK_KEY);
    else await chrome.storage.local.set({ [UNSENT_LOOK_KEY]: true });
    return sent;
  };

  if (isConnected && !unsent) {
    const cloudSettings = await fetchMySettings();
    if (cloudSettings) {
      const visualData: Record<string, unknown> = {};
      for (const key of VISUAL_CLOUD_KEYS) {
        if (!(key in cloudSettings)) continue;
        const value = (cloudSettings as Record<string, unknown>)[key];
        // a malformed cloud copy (a history holding numbers) must not be
        // written where every later read would choke on it
        if (isValidStoredValue(key, value)) visualData[key] = value;
      }
      if (Object.keys(visualData).length > 0) {
        await chrome.storage.local.set(visualData);
      }
    }
  }

  const saved: FormState = {
    avatar: await getConfig("PROFILE_IMAGE_URL"),
    banner: await getConfig("PROFILE_BANNER_URL"),
    bannerMode: (await getConfig("PROFILE_BANNER_MODE")) || "fill",
    bannerColor: await getConfig("PROFILE_BANNER_COLOR"),
    background: await getConfig("PROFILE_BACKGROUND_URL"),
    backgroundMode: (await getConfig("PROFILE_BACKGROUND_MODE")) || "fill",
    backgroundColor: await getConfig("PROFILE_BACKGROUND_COLOR"),
    avatarBg: await getConfig("PROFILE_AVATAR_BG"),
    decoration: await getConfig("PROFILE_DECORATION"),
    avatarPosX: await getConfig("PROFILE_AVATAR_POSITION_X"),
    avatarPosY: await getConfig("PROFILE_AVATAR_POSITION_Y"),
    avatarScale: await getConfig("PROFILE_AVATAR_SCALE"),
    badgeBg: await getConfig("PROFILE_BADGE_BG"),
    badgeOrder: await getConfig("PROFILE_BADGE_ORDER"),
    badgeWrap: await getConfig("PROFILE_BADGE_WRAP"),
  };

  const state: FormState = { ...saved };
  if (unsent) void sendLook(toVisuals(saved));

  // Every edit is previewed on the real page (liveApplyBannerBg), and nothing
  // else repaints it: the profile observer ignores our own dialog and stops
  // after a few seconds. So a close without Save (the X, Escape, a backdrop
  // click: all three fire `close`) paints the saved look back, otherwise the
  // unsaved banner, background, decoration and badges stayed until a reload
  // and looked saved. `committed` skips it once the new look is stored (Save)
  // or the page is about to reload (Reset): Save's own close() fires `close`
  // too, and repainting then would put the old look over the new one.
  let dirty = false;
  let committed = false;
  let saveError = "";
  const savedUrls = [saved.avatar, saved.banner, saved.background];
  const uploads = createPendingUploads(() => handleFormUpdate({}));
  dialog.addEventListener("close", () => {
    uploads.close();
    clearLocalPreview();
    if (dirty && !committed) liveApplyBannerBg(saved);
    // An image uploaded by a Save that did not finish (another slot failed,
    // then Cancel) and used by nothing is removed. One that replaced a picture
    // of the saved look was saved on its own (see commitReplacedUploads), so
    // savedUrls keeps it. While a Save is still running, it cleans up itself
    // once its upload lands.
    if (!committed && !saving && uploads.uploaded.size > 0) {
      void deleteUnusedUploads([], uploads.uploaded, savedUrls);
    }
  });

  const imgHistory = {
    avatar: await getConfig("PROFILE_IMAGE_HISTORY"),
    banner: await getConfig("PROFILE_BANNER_HISTORY"),
    background: await getConfig("PROFILE_BACKGROUND_HISTORY"),
  };

  if (saved.avatar)
    imgHistory.avatar = addToHistory(saved.avatar, imgHistory.avatar);
  if (saved.banner)
    imgHistory.banner = addToHistory(saved.banner, imgHistory.banner);
  if (saved.background)
    imgHistory.background = addToHistory(
      saved.background,
      imgHistory.background,
    );

  const closeDialog = () => {
    dialog.close();
    dialog.remove();
  };

  /**
   * After a Save that stopped half-way: saves, on their own, the uploads that
   * replaced a picture the saved look uses, and returns their slots.
   *
   * WHY: the worker keeps one image per slot and redirects every older ?v= to
   * the current bytes. An upload into a slot the saved look uses has already
   * replaced that picture for every visitor, and the old bytes are gone, so a
   * Cancel cannot bring it back. Left unsaved, the saved URL kept showing the
   * cancelled picture to everyone but the owner (whose browser caches the old
   * one for a year). Saved, the stored look matches what visitors get. Only
   * these URLs change: every other field keeps its saved value, and the other
   * edits wait for the next Save. An upload into a slot nothing uses is not
   * public anywhere, and Cancel still removes it.
   */
  const commitReplacedUploads = async (): Promise<ImageSlot[]> => {
    // Read before the await: a close meanwhile empties the pending files.
    const uploadedUrls = new Map<ImageSlot, string>();
    for (const slot of uploads.uploaded) {
      const url = uploads.get(slot)?.uploadedUrl;
      if (url) uploadedUrls.set(slot, url);
    }
    const hash = await ownUploadHash();
    if (!hash) return [];
    const usedBySaved = new Set(savedUrls.map((url) => uploadedSlotOf(url, hash)));
    const replaced = IMAGE_SLOTS.filter(
      (slot) => usedBySaved.has(slot) && uploadedUrls.has(slot),
    );
    if (replaced.length === 0) return [];

    const urls: Record<string, string> = {};
    const histories: Record<string, string[]> = {};
    for (const slot of replaced) {
      const url = uploadedUrls.get(slot)!;
      saved[slot] = url;
      urls[SLOT_URL_KEY[slot]] = url;
      imgHistory[slot] = addToHistory(url, imgHistory[slot]);
      histories[SLOT_HISTORY_KEY[slot]] = imgHistory[slot];
    }
    savedUrls.splice(0, savedUrls.length, saved.avatar, saved.banner, saved.background);
    await chrome.storage.local.set({ ...urls, ...histories });
    const look = toVisuals(saved);
    try {
      await syncMyVisuals(look);
    } catch (e) {
      console.error("Failed to sync visuals:", e);
    }
    // Paints the saved look (and the new avatar) on the page, then the edits
    // still pending over it.
    onSaveCallback(look);
    if (!uploads.closed) liveApplyBannerBg(state, uploads.previews());
    return replaced;
  };

  const close = () => {
    if (!saving) closeDialog();
  };

  const reset = async () => {
    if (saving || !confirm(t("Reset visuals?"))) return;
    await chrome.storage.local.remove([
      "PROFILE_IMAGE_URL",
      "PROFILE_BANNER_URL",
      "PROFILE_BANNER_MODE",
      "PROFILE_BANNER_COLOR",
      "PROFILE_BACKGROUND_URL",
      "PROFILE_BACKGROUND_MODE",
      "PROFILE_BACKGROUND_COLOR",
      "PROFILE_AVATAR_BG",
      "PROFILE_DECORATION",
      "PROFILE_AVATAR_POSITION_X",
      "PROFILE_AVATAR_POSITION_Y",
      "PROFILE_AVATAR_SCALE",
      "PROFILE_BADGE_BG",
      "PROFILE_BADGE_ORDER",
      "PROFILE_BADGE_WRAP",
    ]);
    // `saved` is gone and the page reloads below: nothing to paint back.
    committed = true;
    // The cloud copy has to go too: visitors read it (/public/visuals), and the
    // next open of this editor copies it back into local storage, which undid
    // the reset. Empty fields are the defaults syncMyVisuals() fills in; it
    // does nothing when not signed in. Awaited so reload() cannot cut it off.
    try {
      await syncMyVisuals({ avatar: "", banner: "", background: "" });
    } catch (e) {
      console.error("Failed to sync reset:", e);
    }
    // After the push (the check reads the cloud copy back), awaited: the
    // reload would cut the requests off.
    await deleteUnusedUploads(savedUrls, uploads.uploaded, []);
    closeDialog();
    location.reload();
  };

  const handleConnect42 = () => {
    loginWith42(async () => {
      await clearAuthFailed();
      window.location.reload();
    });
  };

  const handleFormUpdate = (updates: Partial<FormState>) => {
    // A new value for an image field (typed, picked from the history, Color
    // mode) replaces the file waiting for Save.
    for (const slot of IMAGE_SLOTS) if (slot in updates) uploads.discard(slot);
    Object.assign(state, updates);
    dirty = true;
    liveApplyBannerBg(state, uploads.previews());
    rerender();
  };

  const handleClearHistory = async (
    key: "avatar" | "banner" | "background",
  ) => {
    const historyKey =
      key === "avatar"
        ? "PROFILE_IMAGE_HISTORY"
        : key === "banner"
          ? "PROFILE_BANNER_HISTORY"
          : "PROFILE_BACKGROUND_HISTORY";
    imgHistory[key] = [];
    await chrome.storage.local.set({ [historyKey]: [] });
    rerender();
  };

  const rerender = () => {
    render(
      renderPanelContent(
        state,
        currentTheme,
        handleFormUpdate,
        imgHistory,
        handleClearHistory,
        isConnected,
        needsReconnect,
        handleConnect42,
        (tab) => {
          activeTab = tab;
          rerender();
        },
        uploads,
        { saving, saveError },
      ),
      shadow,
    );
    bindButtons(shadow, close, reset);
  };

  injectCustomStyles();
  rerender();

  if (isConnected) {
    shadow
      .querySelector("#profile-save")
      ?.addEventListener("click", async () => {
        // A file still being read would be left out of this Save.
        if (saving || uploads.closed || uploads.reading) return;
        saving = true;
        saveError = "";
        rerender();

        // The picked images go up first: the look is stored only with the
        // URLs the worker answered, and a failure leaves everything as it was.
        const upload = await uploads.uploadAll();
        if (!upload.ok) {
          if (upload.closed) {
            saving = false;
            void deleteUnusedUploads([], uploads.uploaded, savedUrls);
            return;
          }
          const kept = await commitReplacedUploads();
          saving = false;
          if (uploads.closed) {
            // Closed while the kept uploads were stored: the close handler
            // skipped the cleanup, which runs here instead.
            void deleteUnusedUploads([], uploads.uploaded, savedUrls);
            return;
          }
          saveError = t("{slot}: {error}", {
            slot: t(SLOT_LABELS[upload.slot]),
            error: upload.error,
          });
          if (kept.length > 0) {
            saveError += ` ${t(
              "Saved anyway: {slots} (the upload had already replaced the previous picture).",
              { slots: kept.map((slot) => t(SLOT_LABELS[slot])).join(", ") },
            )}`;
          }
          rerender();
          return;
        }
        Object.assign(state, upload.urls);
        uploads.clear();

        const batchData: Record<string, string | number | boolean | string[]> =
          {};
        const keysToRemove: string[] = [];

        if (!state.avatar) {
          keysToRemove.push("PROFILE_IMAGE_URL");
        } else {
          batchData["PROFILE_IMAGE_URL"] = state.avatar;
        }

        if (!state.banner) {
          keysToRemove.push("PROFILE_BANNER_URL", "PROFILE_BANNER_MODE");
        } else {
          batchData["PROFILE_BANNER_URL"] = state.banner;
          batchData["PROFILE_BANNER_MODE"] = state.bannerMode;
        }

        if (!state.bannerColor) {
          keysToRemove.push("PROFILE_BANNER_COLOR");
        } else {
          batchData["PROFILE_BANNER_COLOR"] = state.bannerColor;
        }

        if (!state.background) {
          keysToRemove.push(
            "PROFILE_BACKGROUND_URL",
            "PROFILE_BACKGROUND_MODE",
          );
        } else {
          batchData["PROFILE_BACKGROUND_URL"] = state.background;
          batchData["PROFILE_BACKGROUND_MODE"] = state.backgroundMode;
        }

        if (!state.backgroundColor) {
          keysToRemove.push("PROFILE_BACKGROUND_COLOR");
        } else {
          batchData["PROFILE_BACKGROUND_COLOR"] = state.backgroundColor;
        }

        batchData["PROFILE_AVATAR_BG"] = state.avatarBg;
        batchData["PROFILE_DECORATION"] = state.decoration;
        batchData["PROFILE_AVATAR_POSITION_X"] = state.avatarPosX;
        batchData["PROFILE_AVATAR_POSITION_Y"] = state.avatarPosY;
        batchData["PROFILE_AVATAR_SCALE"] = state.avatarScale;

        if (!state.badgeBg) {
          keysToRemove.push("PROFILE_BADGE_BG");
        } else {
          batchData["PROFILE_BADGE_BG"] = state.badgeBg;
        }

        batchData["PROFILE_BADGE_ORDER"] = state.badgeOrder;
        batchData["PROFILE_BADGE_WRAP"] = state.badgeWrap;

        if (Object.keys(batchData).length > 0)
          await chrome.storage.local.set(batchData as Record<string, unknown>);
        if (keysToRemove.length > 0)
          await chrome.storage.local.remove(keysToRemove);
        // From here the new look is the stored one: an Escape while the cloud
        // sync below is pending must not paint the old one back.
        committed = true;

        imgHistory.avatar = addToHistory(state.avatar, imgHistory.avatar);
        imgHistory.banner = addToHistory(state.banner, imgHistory.banner);
        imgHistory.background = addToHistory(
          state.background,
          imgHistory.background,
        );
        await chrome.storage.local.set({
          PROFILE_IMAGE_HISTORY: imgHistory.avatar,
          PROFILE_BANNER_HISTORY: imgHistory.banner,
          PROFILE_BACKGROUND_HISTORY: imgHistory.background,
        });

        const updatedVisuals = toVisuals(state);

        // read before a failed send makes the new look the saved one (below)
        const previousUrls = [...savedUrls];
        const sent = await sendLook(updatedVisuals);
        onSaveCallback(updatedVisuals);
        saving = false;
        if (sent) {
          closeDialog();
        } else if (!uploads.closed) {
          // Closing here looked like a success, and the next open then put
          // the cloud's old look back. The editor stays, says so, and Save
          // sends again. The stored look is now the one a Cancel goes back to.
          Object.assign(saved, state);
          savedUrls.splice(0, savedUrls.length, saved.avatar, saved.banner, saved.background);
          dirty = false;
          committed = false;
          saveError = t(
            "Saved on this browser only: the server could not be reached. Save again, or it will be sent the next time you open this editor.",
          );
          rerender();
        }
        // After the push: the check reads the cloud copy back.
        void deleteUnusedUploads(previousUrls, uploads.uploaded, [
          state.avatar,
          state.banner,
          state.background,
        ]);
      });
  }
};

/**
 * Paints the look being edited on the page. `previews` are the images picked
 * and not uploaded yet (local data: URLs), painted over the field's current
 * value for the banner and the background; applyImgs() refuses them.
 */
function liveApplyBannerBg(
  state: FormState,
  previews: { banner?: string; background?: string } = {},
) {
  applyImgs({
    avatar: "",
    banner: state.bannerColor ? "" : state.banner,
    bannerMode: state.bannerMode,
    bannerColor: state.bannerColor,
    background: state.backgroundColor ? "" : state.background,
    backgroundMode: state.backgroundMode,
    backgroundColor: state.backgroundColor,
    avatarBg: state.avatarBg,
    decoration: state.decoration,
    badgeBg: state.badgeBg,
  });
  applyBadgeLayout(document, {
    order: state.badgeOrder,
    wrap: state.badgeWrap,
  });
  paintLocalPreview({
    banner: state.bannerColor ? "" : previews.banner,
    bannerMode: state.bannerMode,
    background: state.backgroundColor ? "" : previews.background,
    backgroundMode: state.backgroundMode,
  });
}

function bindButtons(shadow: ShadowRoot, close: () => void, reset: () => void) {
  const resetBtn = shadow.querySelector(
    "#profile-reset-btn",
  ) as HTMLElement | null;
  const closeBtn = shadow.querySelector(
    "#profile-close-btn",
  ) as HTMLElement | null;
  if (resetBtn && !resetBtn.dataset.bound) {
    resetBtn.addEventListener("click", reset);
    resetBtn.dataset.bound = "1";
  }
  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.addEventListener("click", close);
    closeBtn.dataset.bound = "1";
  }
}
