/**
 * What a click on the profile avatar does: on my own page it opens the
 * visuals editor, on someone else's it toggles between their custom avatar
 * and the Intra picture underneath.
 *
 * WHY a module of its own: it is the only part of the visuals that opens the
 * editor. Keeping it out of the apply step is what lets profile.modal.ts use
 * that step without importing its own opener back.
 */
import { AVATAR_SELECTOR } from "../../../core/intra/selectors.ts";
import { createSettingsModal } from "./profile.modal.ts";
import { pageState } from "./visuals-apply.ts";
import type { VisualUrls } from "./visuals-types.ts";
import { t } from "../../../core/i18n/i18n.ts";

/**
 * The editor being built. createSettingsModal() reads several settings
 * before it appends its dialog, so a second click in that window used to
 * open a second editor on top of the first: it now joins the one opening.
 */
let opening: Promise<void> | null = null;

export function openEditor(onSave: (updatedVisuals: VisualUrls) => void): Promise<void> {
  if (opening) return opening;
  opening = Promise.resolve()
    .then(() => createSettingsModal(onSave))
    .catch((err: unknown) => {
      console.warn("Cuter Intra: the profile editor could not be opened.", err);
    })
    .finally(() => {
      opening = null;
    });
  return opening;
}

/**
 * Makes the avatar <div> a button for the keyboard and assistive tech too:
 * focusable, announced as a button with `label`, and activated by Enter or
 * Space like a native one. The avatar is the only way into the editor, and a
 * click listener alone left keyboard and screen-reader users (and link-hint
 * extensions, which look for role=button) without it. Mouse users see no
 * change: the focus ring (profile-card.ts) is drawn for :focus-visible only.
 */
function makeKeyboardButton(
  avatarEl: HTMLElement,
  label: string,
  activate: () => void,
): void {
  avatarEl.tabIndex = 0;
  avatarEl.setAttribute("role", "button");
  avatarEl.setAttribute("aria-label", label);
  avatarEl.addEventListener("keydown", (e) => {
    // A key aimed at something inside the avatar is that element's business.
    if (e.target !== avatarEl) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); // Space would scroll the page
    activate();
  });
}

/**
 * My own page: clicking the avatar (or Enter / Space on it) opens the editor,
 * and `onSave` receives the visuals it saved. Attached once per avatar
 * element.
 */
export function attachEditorListener(
  avatarEl: HTMLElement,
  onSave: (updatedVisuals: VisualUrls) => void,
): void {
  if (avatarEl.dataset.modalListener) return;
  avatarEl.dataset.modalListener = "true";
  avatarEl.style.cursor = "pointer";
  // The title helps mouse users find the feature, as the toggle's does.
  avatarEl.title = t("Edit my profile visuals");
  const open = () => {
    pageState.showingOriginalAvatar = false;
    void openEditor(onSave);
  };
  avatarEl.addEventListener("click", (e) => {
    e.stopPropagation();
    open();
  });
  makeKeyboardButton(avatarEl, t("Edit my profile visuals"), open);
}

/**
 * Someone else's page: clicking the avatar (or Enter / Space on it) swaps
 * their custom avatar for the original Intra picture and back. `getVisuals` is
 * read at click time, so the listener always restores the visuals currently
 * cached for the page.
 */
export function attachToggleListener(
  avatarEl: HTMLElement,
  getVisuals: () => VisualUrls | null,
): void {
  if (avatarEl.dataset.toggleListener) return;
  avatarEl.dataset.toggleListener = "true";
  avatarEl.style.cursor = "pointer";
  avatarEl.title = t("Click to view original avatar");
  // A toggle button: the label stays, aria-pressed says which picture shows.
  // Synced on focus too, because visuals.ts resets the state for a new
  // profile without going through here.
  const syncPressed = () =>
    avatarEl.setAttribute("aria-pressed", String(pageState.showingOriginalAvatar));
  syncPressed();
  avatarEl.addEventListener("focus", syncPressed);
  const toggle = () => {
    const currentAvatar = document.querySelector(
      AVATAR_SELECTOR,
    ) as HTMLElement;
    if (!currentAvatar) return;
    const visualCache = getVisuals();
    if (pageState.showingOriginalAvatar) {
      pageState.showingOriginalAvatar = false;
      if (visualCache?.avatar) {
        currentAvatar.style.setProperty(
          "background-image",
          `url("${visualCache.avatar}")`,
          "important",
        );
        currentAvatar.style.setProperty(
          "background-color",
          visualCache.avatarBg || "transparent",
          "important",
        );
        currentAvatar.style.setProperty(
          "background-size",
          `${visualCache.avatarScale ?? 100}%`,
          "important",
        );
        currentAvatar.style.setProperty(
          "background-position",
          `${visualCache.avatarPosX ?? 50}% ${visualCache.avatarPosY ?? 50}%`,
          "important",
        );
        currentAvatar.classList.remove("ft-deco-solid");
        const d = visualCache.decoration;
        if (d && d !== "none") currentAvatar.classList.add(`ft-deco-${d}`);
      }
    } else {
      pageState.showingOriginalAvatar = true;
      currentAvatar.classList.remove("ft-deco-solid");
      if (pageState.originalAvatarUrl) {
        currentAvatar.style.setProperty(
          "background-image",
          `url("${pageState.originalAvatarUrl}")`,
          "important",
        );
      }
      currentAvatar.style.setProperty("background-size", "cover", "important");
      currentAvatar.style.setProperty(
        "background-position",
        "center",
        "important",
      );
      currentAvatar.style.setProperty(
        "background-color",
        "transparent",
        "important",
      );
    }
    syncPressed();
  };
  avatarEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  makeKeyboardButton(avatarEl, t("Show original avatar"), toggle);
}
