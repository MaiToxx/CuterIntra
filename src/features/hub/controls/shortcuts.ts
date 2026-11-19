/**
 * Shortcuts editor (Shortcuts tab): the list of custom links, drawn by
 * shortcuts.ui.ts. It stores the whole list under SHORTCUTS_LINKS itself,
 * debounced while a field is being typed in, and at once after a removal
 * or a move.
 */
import { render } from "lit-html";
import { t } from "../../../core/i18n/i18n.ts";
import {
  getStoredLinks,
  extractLinksFromForm,
  readLinkRows,
  renderShortcutsSettings,
  type ShortcutLink,
} from "../../shortcuts/shortcuts.ui.ts";

/**
 * Sent to the editor by a Reset of the Shortcuts tab (tab-panel.ts): it
 * drops what it holds and reads the list back from storage.
 */
export const SHORTCUTS_RELOAD_EVENT = "bi-shortcuts-reload";

/** The save a panel still holds back while a field is being typed in. */
let pendingSave: (() => Promise<void>) | null = null;

/**
 * Stores now what the editor was about to store, and says whether there was
 * anything: the hub calls it before it closes or reloads the page.
 */
export async function flushShortcuts(): Promise<boolean> {
  const save = pendingSave;
  if (!save) return false;
  await save();
  return true;
}

export function renderShortcutsPanel(): HTMLElement {
  const container = document.createElement("div");
  container.setAttribute("data-shortcuts-panel", "true");
  let links: ShortcutLink[] = [];

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const save = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    pendingSave = null;
    await chrome.storage.local.set({
      SHORTCUTS_LINKS: JSON.stringify(extractLinksFromForm(container)),
    });
  };
  // The preview follows the typing (it used to wait for an "Update Preview"
  // button): the rows redraw from what they hold, so nothing typed is lost.
  const debouncedSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    pendingSave = save;
    saveTimer = setTimeout(() => {
      void save();
      syncFromForm();
      update();
    }, 300);
  };

  // What the rows show now, half-typed text included. `links` used to be
  // only what the last save kept (complete rows): Add then wiped a row being
  // typed, and a move shifted the wrong link once an incomplete row was gone.
  const syncFromForm = () => {
    if (container.querySelector(".link-group")) links = readLinkRows(container);
  };

  const update = () => {
    render(
      renderShortcutsSettings(
        links,
        () => {
          syncFromForm();
          if (links.length < 8) {
            links = [
              ...links,
              { name: "", url: "", color: "#7dd3fc", emoji: "" },
            ];
            update();
          }
        },
        async (idx) => {
          syncFromForm();
          const row = links[idx];
          const name = row?.name.trim();
          // an empty row goes without a question: nothing is lost
          if (
            row &&
            (name || row.url.trim()) &&
            !window.confirm(
              name
                ? t('Delete shortcut "{name}"?', { name })
                : t("Delete shortcut {n}?", { n: idx + 1 }),
            )
          ) {
            return;
          }
          links = links.filter((_, i) => i !== idx);
          update();
          await save();
        },
        () => debouncedSave(),
        (from, to) => {
          syncFromForm();
          if (to < 0 || to >= links.length || from === to) return;
          const moved = focusedMoveButton();
          const newLinks = [...links];
          const [item] = newLinks.splice(from, 1);
          newLinks.splice(to, 0, item);
          links = newLinks;
          update();
          if (moved) refocusMove(to, moved);
          // A move used to be drawn and never stored: the old order came
          // back with the next page.
          void save();
        },
      ),
      container,
    );
  };

  /** "up" or "down" when a row's move button has the focus (keyboard, tap). */
  const focusedMoveButton = (): "up" | "down" | null => {
    const root = container.getRootNode() as Document | ShadowRoot;
    const active = root.activeElement as HTMLElement | null;
    if (!active || !container.contains(active)) return null;
    if (active.hasAttribute("data-move-up")) return "up";
    if (active.hasAttribute("data-move-down")) return "down";
    return null;
  };

  /**
   * The focus follows the moved row, so the same key moves it again; at the
   * end of the list it goes to the other arrow, the one still enabled.
   */
  const refocusMove = (row: number, dir: "up" | "down") => {
    const group = container.querySelectorAll(".link-group")[row];
    const same = group?.querySelector<HTMLButtonElement>(`[data-move-${dir}]`);
    const other = group?.querySelector<HTMLButtonElement>(
      `[data-move-${dir === "up" ? "down" : "up"}]`,
    );
    (same && !same.disabled ? same : other)?.focus();
  };

  container.addEventListener(SHORTCUTS_RELOAD_EVENT, () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    pendingSave = null;
    void getStoredLinks().then((stored) => {
      links = stored;
      update();
    });
  });

  getStoredLinks().then((storedLinks) => {
    links = storedLinks;
    update();
  });

  return container;
}
