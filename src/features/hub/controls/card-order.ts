/**
 * Dashboard card order (Profile tab): the profile cards as coloured chips to
 * drag into order, with an eye to hide a card (stored with a leading "-").
 * Saves on every drop, hide and Reset; a hidden input mirrors the order under
 * data-setting-key like every other control of the hub.
 */
import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import EYE_SVG from "../../../assets/svg/eye.svg?raw";
import EYE_SLASH_SVG from "../../../assets/svg/eye-slash.svg?raw";
import GRIP_VERTICAL_SVG from "../../../assets/svg/grip-vertical.svg?raw";
import RESET_SVG from "../../../assets/svg/reset.svg?raw";
import { getConfig } from "../../../core/config.ts";
import { t } from "../../../core/i18n/i18n.ts";
import type { HubSettingDef } from "../hubSettings.data.ts";
import { saveSetting, settingIds } from "./context.ts";

/**
 * The name a chip shows for a stored card name. The Intra's own cards keep
 * their headings as the Intra writes them (in English, whatever the hub's
 * language), but the roulette card is Cuter Intra's: roulette-stats.ts
 * titles it in the hub's language, and its chip follows. The stored value
 * itself never changes.
 */
function chipName(stored: string): string {
  return stored === "THURSDAY ROULETTE"
    ? t("Thursday Roulette").toUpperCase()
    : stored;
}

export function renderCardOrder(
  def: HubSettingDef,
  enabled: boolean,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "w-full flex flex-col gap-2 relative mt-2";
  container.setAttribute("data-card-order-panel", "true");
  // Its buttons (Reset, one eye per card) are announced under the setting.
  const ids = settingIds(def);
  container.setAttribute("role", "group");
  container.setAttribute("aria-labelledby", ids.label);
  if (ids.desc) container.setAttribute("aria-describedby", ids.desc);

  let draggedIdx: number | null = null;

  const cardColors: Record<string, string> = {
    EVALUATIONS: "bg-error text-error-content hover:bg-error/80 border-error",
    AGENDA: "bg-info text-info-content hover:bg-info/80 border-info",
    LOGTIME:
      "bg-success text-success-content hover:bg-success/80 border-success",
    PROJECTS:
      "bg-warning text-warning-content hover:bg-warning/80 border-warning",
    ACHIEVEMENTS:
      "bg-primary text-primary-content hover:bg-primary/80 border-primary",
    "THURSDAY ROULETTE":
      "bg-accent text-accent-content hover:bg-accent/80 border-accent",
  };

  const getCardColor = (name: string) => {
    const cleanName = name.startsWith("-") ? name.substring(1) : name;
    return cardColors[cleanName.toUpperCase().trim()] || "btn-neutral";
  };

  // Each visible card also gets "earlier" / "later" arrows: drag and drop
  // is mouse only, and a keyboard or a finger had no way to reorder.
  const renderOrder = (currentOrder: string[]) => {
    render(
      html`
        <button
          type="button"
          class="btn btn-xs btn-outline btn-error gap-1 absolute -top-11 right-0 md:right-2 z-30"
          aria-label="${t("Reset {label}", { label: t(def.label) })}"
          ?disabled="${!enabled}"
          @click="${() => {
            if (enabled) resetToDefault();
          }}"
        >
          <span class="size-3 flex items-center justify-center" aria-hidden="true"
            >${unsafeHTML(RESET_SVG)}</span
          >
          ${t("Reset")}
        </button>

        <div
          class="flex flex-wrap gap-3 items-center p-4 bg-base-300/30 rounded-xl border border-base-300 w-full"
        >
          <span class="text-xs opacity-50 w-full pb-1"
            >${t("Drag to reorder, or use the arrows")}</span
          >
          ${currentOrder.map((rawName, idx) => {
            const isDisabled = rawName.startsWith("-");
            // the card's heading as the Intra writes it (a stored value)
            const displayName = isDisabled ? rawName.substring(1) : rawName;
            // what the chip and its buttons say (chipName above)
            const shownName = chipName(displayName);

            const toggleVisibility = (e: Event) => {
              e.stopPropagation();
              if (!enabled) return;

              const newOrder = [...currentOrder];
              newOrder[idx] = isDisabled ? displayName : `-${displayName}`;

              renderOrder(newOrder);

              const input = container.querySelector<HTMLInputElement>(
                "input[type='hidden']",
              );
              if (input) {
                input.value = JSON.stringify(newOrder);
                input.dispatchEvent(new Event("input", { bubbles: true }));
              }
              saveSetting(def.key!, newOrder);
            };

            return html`
              <div
                class="btn btn-md border shadow-sm transition-all select-none gap-2 font-bold normal-case px-4 
    ${getCardColor(rawName)} 
    ${enabled && !isDisabled
                  ? "cursor-grab active:cursor-grabbing"
                  : "cursor-not-allowed"}
    ${isDisabled ? "opacity-30 line-through saturate-50 scale-95" : ""}"
                data-card-chip
                draggable="${enabled && !isDisabled}"
                @dragstart="${(e: DragEvent) =>
                  enabled && !isDisabled && handleDragStart(e, idx)}"
                @dragover="${(e: DragEvent) =>
                  enabled && handleDragOver(e, idx)}"
                @dragend="${() => enabled && handleDragEnd()}"
                @drop="${(e: DragEvent) =>
                  enabled && handleDrop(e, currentOrder, idx)}"
              >
                ${enabled && !isDisabled
                  ? html`<span
                      class="size-4 shrink-0 opacity-40 pointer-events-none flex items-center justify-center"
                      >${unsafeHTML(GRIP_VERTICAL_SVG)}</span
                    >`
                  : ""}
                ${displayName.toUpperCase().trim() !== "EVALUATIONS" &&
                displayName.toUpperCase().trim() !== "PENDING EVALUATIONS" &&
                displayName.toUpperCase().trim() !== "PROJECTS"
                  ? html`
                      <button
                        type="button"
                        class="p-1 -ml-1 rounded hover:bg-black/10 transition-colors pointer-events-auto cursor-pointer flex items-center justify-center text-white"
                        @click="${toggleVisibility}"
                        data-tip="${isDisabled ? t("Show card") : t("Hide card")}"
                        aria-label="${isDisabled
                          ? t("Show {name} card", { name: shownName })
                          : t("Hide {name} card", { name: shownName })}"
                      >
                        ${isDisabled
                          ? html`<span
                              class="size-4 opacity-80 flex items-center justify-center"
                              aria-hidden="true"
                              >${unsafeHTML(EYE_SLASH_SVG)}</span
                            >`
                          : html`<span
                              class="size-4 opacity-60 flex items-center justify-center"
                              aria-hidden="true"
                              >${unsafeHTML(EYE_SVG)}</span
                            >`}
                      </button>
                    `
                  : ""}

                <span class="pointer-events-none">${shownName}</span>
                ${enabled && !isDisabled
                  ? html`<button
                        type="button"
                        class="p-1 rounded hover:bg-black/10 disabled:opacity-30 cursor-pointer"
                        data-card-move="earlier"
                        aria-label="${t("Move {name} card earlier", { name: shownName })}"
                        ?disabled="${idx === 0}"
                        @click="${(e: Event) => moveCard(e, currentOrder, idx, idx - 1)}"
                      >
                        <span aria-hidden="true">←</span>
                      </button>
                      <button
                        type="button"
                        class="p-1 -mr-2 rounded hover:bg-black/10 disabled:opacity-30 cursor-pointer"
                        data-card-move="later"
                        aria-label="${t("Move {name} card later", { name: shownName })}"
                        ?disabled="${idx === currentOrder.length - 1}"
                        @click="${(e: Event) => moveCard(e, currentOrder, idx, idx + 1)}"
                      >
                        <span aria-hidden="true">→</span>
                      </button>`
                  : ""}
              </div>
            `;
          })}
        </div>

        <input
          type="hidden"
          data-setting-key="${def.key}"
          .value="${JSON.stringify(currentOrder)}"
        />
      `,
      container,
    );
  };

  const handleDragStart = (e: DragEvent, idx: number) => {
    draggedIdx = idx;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    (e.currentTarget as HTMLElement).style.opacity = "0.3";
  };

  const handleDragOver = (e: DragEvent, idx: number) => {
    e.preventDefault();
  };

  const handleDragEnd = () => {
    draggedIdx = null;
    container
      .querySelectorAll<HTMLElement>(".btn")
      .forEach((p) => (p.style.opacity = ""));
  };

  const handleDrop = (
    e: DragEvent,
    currentOrder: string[],
    targetIdx: number,
  ) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === targetIdx) return;

    const newOrder = [...currentOrder];
    const [removed] = newOrder.splice(draggedIdx, 1);
    newOrder.splice(targetIdx, 0, removed);

    draggedIdx = null;
    renderOrder(newOrder);
    saveSetting(def.key!, newOrder);
  };

  /**
   * The arrows' move: the same splice as a drop. The focus follows the card
   * (the chips are redrawn by position), onto the other arrow at either end.
   */
  const moveCard = (
    e: Event,
    currentOrder: string[],
    from: number,
    to: number,
  ) => {
    e.stopPropagation();
    if (!enabled || to < 0 || to >= currentOrder.length) return;
    const newOrder = [...currentOrder];
    const [moved] = newOrder.splice(from, 1);
    newOrder.splice(to, 0, moved);
    renderOrder(newOrder);
    saveSetting(def.key!, newOrder);
    const dir = to < from ? "earlier" : "later";
    const chip = container.querySelectorAll<HTMLElement>("[data-card-chip]")[to];
    const same = chip?.querySelector<HTMLButtonElement>(`[data-card-move="${dir}"]`);
    const other = chip?.querySelector<HTMLButtonElement>(
      `[data-card-move="${dir === "earlier" ? "later" : "earlier"}"]`,
    );
    (same && !same.disabled ? same : other)?.focus();
  };

  const resetToDefault = () => {
    renderOrder((def.defaultValue as string[]) || []);
    saveSetting(def.key!, def.defaultValue as string[]);
  };

  if (!def.key) return container;
  getConfig(def.key).then((savedOrder) => {
    let order: string[] = def.defaultValue as string[];
    if (savedOrder) {
      try {
        order =
          typeof savedOrder === "string"
            ? JSON.parse(savedOrder)
            : savedOrder;
      } catch {
        order = def.defaultValue as string[];
      }
    }
    renderOrder(order);
  });

  return container;
}
