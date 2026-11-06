import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { getConfig } from "../../core/config.ts";
import { sanitizeHexColor } from "../../core/security/css-sanitize.ts";
import GLOBE from "../../assets/svg/globe.svg";
import { t } from "../../core/i18n/i18n.ts";

export interface ShortcutLink {
  name: string;
  url: string;
  color: string;
  emoji?: string;
}

export const sanitizeColor = (color: unknown): string =>
  sanitizeHexColor(color) || "#7dd3fc";

export const sanitizeUrl = (url: unknown): string => {
  if (!url) return "";
  const raw = String(url).trim();
  if (!raw) return "";

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withProtocol);
    return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
};

export const normalizeLink = (link: unknown): ShortcutLink => {
  const obj = link as Record<string, unknown>;
  return {
    name: typeof obj.name === "string" ? obj.name.trim() : "",
    url: sanitizeUrl(obj.url),
    color: sanitizeColor(obj.color),
    emoji: typeof obj.emoji === "string" ? obj.emoji.trim() : "",
  };
};

/**
 * The name a shortcut gets when only its address was typed: the host without
 * "www.", cut to the name field's 20 characters. A row without a name used to
 * be dropped at save, and was gone the next time the tab opened.
 */
export const defaultShortcutName = (url: unknown): string => {
  const safe = sanitizeUrl(url);
  if (!safe) return "";
  try {
    return new URL(safe).hostname.replace(/^www\./, "").slice(0, 20);
  } catch {
    return "";
  }
};

export const getFaviconUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return "";
  }
};

export const getContrastColor = (hex: string): string => {
  const safeHex = sanitizeColor(hex);
  const r = parseInt(safeHex.slice(1, 3), 16);
  const g = parseInt(safeHex.slice(3, 5), 16);
  const b = parseInt(safeHex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? "#000000" : "#ffffff";
};

/** The row's "move earlier / later" buttons; a missing one is drawn disabled. */
export type RowMoves = { up?: () => void; down?: () => void };

export function renderShortcutRow(
  link: ShortcutLink,
  onDelete: () => void,
  position?: number,
  moves?: RowMoves,
): ReturnType<typeof html> {
  // The placeholders are not names: each field says which shortcut it edits.
  // Whole sentences, so a language can put the number where it belongs.
  const n = position;
  const labels = n
    ? {
        emoji: t("Shortcut {n} emoji", { n }),
        name: t("Shortcut {n} name", { n }),
        address: t("Shortcut {n} address", { n }),
        colour: t("Shortcut {n} colour", { n }),
        up: t("Move shortcut {n} up", { n }),
        down: t("Move shortcut {n} down", { n }),
        remove: t("Remove shortcut {n}", { n }),
      }
    : {
        emoji: t("Shortcut emoji"),
        name: t("Shortcut name"),
        address: t("Shortcut address"),
        colour: t("Shortcut colour"),
        up: t("Move shortcut up"),
        down: t("Move shortcut down"),
        remove: t("Remove shortcut"),
      };
  // A name without a usable address cannot be stored: say so on the row
  // instead of dropping it without a word.
  const unsaved = !!link.name.trim() && !sanitizeUrl(link.url);
  // Three groups that wrap: one line on a wide hub; on a phone emoji + name,
  // then the address, then the colour and the buttons (one line there left
  // the name 26 px and the address 48 px wide). live(): the editor redraws
  // from what the rows hold, and a field must show that even when lit's
  // last written value is the same. The arrows: drag and drop is mouse
  // only, a keyboard or a finger reorders with them.
  return html` <div
    class="link-group flex flex-wrap gap-2 border border-base-300 rounded-lg p-2 bg-base-200/30 items-end"
  >
    <div class="flex gap-2 flex-1 min-w-48">
      <input
        type="text"
        class="input w-16 shrink-0 text-center text-xl"
        data-shortcuts-emoji
        aria-label="${labels.emoji}"
        .value="${live(link.emoji || "")}"
        placeholder="🐝"
        maxlength="16"
      />
      <input
        type="text"
        class="input flex-1 min-w-0"
        data-shortcuts-name
        aria-label="${labels.name}"
        .value="${live(link.name)}"
        placeholder="${defaultShortcutName(link.url) || t("Name")}"
        maxlength="20"
      />
    </div>
    <div class="flex-2 min-w-48">
      <input
        type="url"
        class="input w-full"
        placeholder="https://example.com"
        .value="${live(link.url)}"
        data-shortcuts-url
        aria-label="${labels.address}"
        pattern="^(https?://)?.*"
      />
    </div>
    <div class="flex gap-2 items-end ms-auto">
      <input
        type="color"
        class="input w-12 p-1 cursor-pointer"
        data-shortcuts-color
        aria-label="${labels.colour}"
        .value="${live(link.color)}"
      />
      ${moves
        ? html`<button
              type="button"
              class="btn btn-square btn-ghost"
              data-move-up
              aria-label="${labels.up}"
              ?disabled="${!moves.up}"
              @click="${() => moves.up?.()}"
            >
              <span aria-hidden="true">↑</span>
            </button>
            <button
              type="button"
              class="btn btn-square btn-ghost"
              data-move-down
              aria-label="${labels.down}"
              ?disabled="${!moves.down}"
              @click="${() => moves.down?.()}"
            >
              <span aria-hidden="true">↓</span>
            </button>`
        : nothing}
      <button
        type="button"
        class="btn btn-outline btn-error"
        aria-label="${labels.remove}"
        @click="${onDelete}"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
    ${unsaved
      ? html`<p class="w-full text-xs text-warning" role="status">
          ${t("Not saved: add the address this shortcut opens.")}
        </p>`
      : nothing}
  </div>`;
}

export function renderShortcutsSettings(
  links: ShortcutLink[],
  onAddRow: () => void,
  onDeleteRow: (index: number) => void,
  onInput: () => void,
  onMoveRow: (from: number, to: number) => void,
): ReturnType<typeof html> {
  const maxLinks = 8;
  const isFull = links.length >= maxLinks;
  // The rows can hold what is being typed: the preview shows the sanitised
  // form (no javascript: href) under the name it will be saved with, one
  // chip per row so the indexes match.
  const previewLinks = links.map((link) => {
    const normalized = normalizeLink(link);
    return normalized.name ? normalized : { ...normalized, name: defaultShortcutName(normalized.url) };
  });

  return html`
    <div class="shortcuts-settings flex flex-col gap-4">
      <div class="space-y-2" @input="${onInput}">
        ${links.map((link, idx) =>
          renderShortcutRow(link, () => onDeleteRow(idx), idx + 1, {
            up: idx > 0 ? () => onMoveRow(idx, idx - 1) : undefined,
            down:
              idx < links.length - 1 ? () => onMoveRow(idx, idx + 1) : undefined,
          }),
        )}
      </div>

      <div class="flex gap-2">
        <button
          type="button"
          class="btn btn-success flex-1"
          @click="${onAddRow}"
          ?disabled="${isFull}"
        >
          ${isFull
            ? t("Limit Reached")
            : t("Add Link ({count}/{max})", { count: links.length, max: maxLinks })}
        </button>
      </div>

      ${links.length > 0
        ? html`
            <div class="divider my-1"></div>
            <div
              class="preview-section p-4 rounded-xl border border-base-300 bg-base-200/10"
            >
              <div class="flex justify-center">
                ${renderShortcutsDisplay(previewLinks, onMoveRow)}
              </div>
            </div>
          `
        : ""}
    </div>
  `;
}

export async function getStoredLinks(): Promise<ShortcutLink[]> {
  const stored = await getConfig("SHORTCUTS_LINKS");
  const fallback = [{ name: "", url: "", color: "#7dd3fc", emoji: "" }];
  if (!stored) return fallback;
  try {
    let parsed: any;
    if (typeof stored === "string") {
      parsed = JSON.parse(stored);
    } else {
      parsed = stored;
    }
    if (!Array.isArray(parsed)) return fallback;
    const normalized = parsed.map(normalizeLink).slice(0, 8);
    return normalized.length > 0 ? normalized : fallback;
  } catch {
    return fallback;
  }
}

export function extractLinksFromForm(root: HTMLElement): ShortcutLink[] {
  const rows = root.querySelectorAll(".link-group");
  const links: ShortcutLink[] = [];

  rows.forEach((row) => {
    const nameInput = row.querySelector(
      "[data-shortcuts-name]",
    ) as HTMLInputElement;
    const urlInput = row.querySelector(
      "[data-shortcuts-url]",
    ) as HTMLInputElement;
    const colorInput = row.querySelector(
      "[data-shortcuts-color]",
    ) as HTMLInputElement;
    const emojiInput = row.querySelector(
      "[data-shortcuts-emoji]",
    ) as HTMLInputElement;

    if (nameInput && urlInput && colorInput) {
      const link = normalizeLink({
        name: nameInput.value,
        url: urlInput.value,
        color: colorInput.value,
        emoji: emojiInput ? emojiInput.value : "",
      });

      if (link.url) {
        links.push(link.name ? link : { ...link, name: defaultShortcutName(link.url) });
      }
    }
  });

  return links;
}

/**
 * Every row of the editor as it reads now, the incomplete ones and the text
 * as typed included (extractLinksFromForm keeps only what is worth storing).
 * The editor redraws from this, so a redraw loses nothing on screen.
 */
export function readLinkRows(root: HTMLElement): ShortcutLink[] {
  const value = (row: Element, attr: string) =>
    row.querySelector<HTMLInputElement>(`[${attr}]`)?.value ?? "";
  return [...root.querySelectorAll(".link-group")].map((row) => ({
    name: value(row, "data-shortcuts-name"),
    url: value(row, "data-shortcuts-url"),
    color: sanitizeColor(value(row, "data-shortcuts-color")),
    emoji: value(row, "data-shortcuts-emoji"),
  }));
}

function renderLinkContent(
  link: ShortcutLink,
  contrast: string,
  hasEmoji: boolean,
): ReturnType<typeof html> {
  return html`
    <div
      class="flex items-center justify-center bg-white/20 p-1 rounded-lg transition-transform hover:rotate-6 w-10 h-10"
    >
      ${hasEmoji
        ? html`<span class="text-2xl">${link.emoji}</span>`
        : html`
            <img
              src="${getFaviconUrl(link.url || "https://example.com")}"
              class="w-8 h-8 object-contain"
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="${(e: Event) => {
                const img = e.target as HTMLImageElement;
                try {
                  const parsedUrl = new URL(link.url);
                  if (!img.hasAttribute("data-fallback-tried")) {
                    img.setAttribute("data-fallback-tried", "true");
                    img.src = `https://icons.duckduckgo.com/ip3/${parsedUrl.hostname}.ico`;
                    return;
                  }
                } catch {}
                img.onerror = null;
                img.src = GLOBE;
              }}"
            />
          `}
    </div>
    <span class="text-sm"> ${link.name || t("Empty")} </span>
  `;
}

export function renderShortcutsDisplay(
  links: ShortcutLink[],
  onMoveRow?: (from: number, to: number) => void,
  openNewTab = true,
): ReturnType<typeof html> {
  const isDragMode = !!onMoveRow;
  const displayLinks = isDragMode
    ? links
    : links.filter((l) => l.url && l.name);

  if (displayLinks.length === 0) return html``;

  return html`
    <div
      class="flex flex-wrap gap-3 p-0 m-0 items-center"
      id="shortcuts-display"
    >
      ${displayLinks.map((link, idx) => {
        const contrast = getContrastColor(link.color);
        const hasEmoji = !!(link.emoji && link.emoji.trim().length > 0);
        const isValid = link.url && link.name;

        if (isDragMode) {
          const dimmed = !isValid;

          return html`<a
            href="${isValid ? link.url : "#"}"
            target="${openNewTab ? "_blank" : ""}"
            rel="${openNewTab ? "noopener noreferrer" : ""}"
            class="btn btn-lg h-auto min-h-12 px-4 py-2 rounded-2xl border-none font-bold uppercase tracking-wider shadow-lg hover:shadow-lg no-underline inline-flex items-center gap-3 ${dimmed
              ? "opacity-40 grayscale"
              : ""}"
            style="background-color: ${link.color}; color: ${contrast};"
            draggable="${isValid}"
            @dragstart="${(e: DragEvent) => {
              if (!isValid) {
                e.preventDefault();
                return;
              }
              e.dataTransfer?.setData("text/plain", String(idx));
              (e.currentTarget as HTMLElement).classList.add("opacity-30");
            }}"
            @dragover="${(e: DragEvent) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).classList.add(
                "ring-2",
                "ring-primary",
              );
            }}"
            @dragleave="${(e: DragEvent) => {
              (e.currentTarget as HTMLElement).classList.remove(
                "ring-2",
                "ring-primary",
              );
            }}"
            @drop="${(e: DragEvent) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).classList.remove(
                "ring-2",
                "ring-primary",
              );
              const fromIdx = parseInt(
                e.dataTransfer?.getData("text/plain") || "-1",
              );
              if (fromIdx !== -1 && fromIdx !== idx) {
                onMoveRow!(fromIdx, idx);
              }
            }}"
            @dragend="${(e: DragEvent) => {
              (e.currentTarget as HTMLElement).classList.remove(
                "opacity-30",
                "ring-2",
                "ring-primary",
              );
            }}"
          >
            ${renderLinkContent(link, contrast, hasEmoji)}
          </a>`;
        }

        return html`<a
          href="${link.url}"
          target="${openNewTab ? "_blank" : ""}"
          rel="${openNewTab ? "noopener noreferrer" : ""}"
          class="btn btn-lg h-auto min-h-12 px-4 py-2 rounded-2xl border-none font-bold uppercase tracking-wider shadow-lg hover:shadow-lg no-underline inline-flex items-center gap-3"
          style="background-color: ${link.color}; color: ${contrast};"
        >
          ${renderLinkContent(link, contrast, hasEmoji)}
        </a>`;
      })}
    </div>
  `;
}
