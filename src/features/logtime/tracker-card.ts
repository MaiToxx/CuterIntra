import { html, render } from "lit-html";
import { adoptSharedStyles } from "../../core/styles/shared-styles.ts";
import { getEffectiveTheme } from "../../core/theme/theme-manager.ts";
import { appendSvg } from "../../core/dom/svg.ts";
import {
  getTrackerState,
  trackerStateFor,
  computeWeekProgress,
  formatHours,
  saveTrackerMode,
  findTrackerBadgeEl,
  thresholdsMet,
  weekOutlook,
  PEGASUS_MAX_HOURS_PER_DAY,
  TRACKER_MODES,
  type TrackerState,
} from "./tracker.ts";
import { lastStats } from "./logtime.ts";
import { t, tp } from "../../core/i18n/i18n.ts";
import VALIDATED_SVG from "../../assets/svg/validated.svg?raw";
import INVALIDE_SVG from "../../assets/svg/invalide.svg?raw";

let _state: TrackerState | null = null;
let _badgeEl: HTMLElement | null = null;
let _badgeType: "phoenix" | "pegasus" | null = null;
let _popoverHost: HTMLElement | null = null;
let _popoverTimer: ReturnType<typeof setTimeout> | null = null;

function updateBadgeIndicator() {
  if (!_state || !_badgeEl) return;
  // No week to judge yet (the Logtime feature fills lastStats, and it may be
  // off): the badge stays neutral. It used to glow red with a cross, a "not
  // met" that meant "not measured".
  if (!lastStats) {
    for (const prop of ["border", "border-color", "box-shadow"]) _badgeEl.style.removeProperty(prop);
    _badgeEl.querySelector(".ft-tracker-icon")?.remove();
    return;
  }
  const progress = computeWeekProgress(lastStats, _state);
  const met = progress ? thresholdsMet(progress, _state) : false;
  const color = met ? "#10b981" : "#ef4444";
  const glow = met
    ? "0 0 16px rgba(16,185,129,0.5), 0 0 4px rgba(16,185,129,0.3)"
    : "0 0 16px rgba(239,68,68,0.5), 0 0 4px rgba(239,68,68,0.3)";

  _badgeEl.style.setProperty("border", "2px solid", "important");
  _badgeEl.style.setProperty("border-color", color, "important");
  _badgeEl.style.setProperty("box-shadow", glow, "important");

  const existing = _badgeEl.querySelector(".ft-tracker-icon");
  if (existing) existing.remove();

  const icon = document.createElement("span");
  icon.className = "ft-tracker-icon";
  icon.style.cssText =
    "margin-left:0.25rem;display:inline-flex;align-items:center;";
  appendSvg(icon, met ? VALIDATED_SVG : INVALIDE_SVG);
  _badgeEl.appendChild(icon);
}

/** What is left of the week, in the popover under the two cards. */
function renderOutlook(stats: Record<string, string>, state: TrackerState) {
  const outlook = weekOutlook(stats, state.thresholds);
  if (!outlook) return "";
  if (outlook.met) {
    return html`<p class="text-xs font-semibold text-success">${t("Goal met")}</p>`;
  }
  const left = formatHours(outlook.hoursLeft);
  return html`<div class="flex flex-col gap-0.5 text-xs">
    ${outlook.hoursLeft > 0
      ? html`<p>
          ${outlook.daysLeft === 1
            ? t("{left} left today", { left })
            : t("{left} left · {perDay}/day for {n} days (today included)", {
                left,
                perDay: formatHours(outlook.perDay),
                n: outlook.daysLeft,
              })}
        </p>`
      : ""}
    ${outlook.daysNeeded > 0
      ? html`<p>
          ${tp(
            outlook.daysNeeded,
            "{n} more day with logtime to go",
            "{n} more days with logtime to go",
          )}
        </p>`
      : ""}
    ${outlook.reachable
      ? ""
      : html`<p class="font-semibold text-warning">${t("Out of reach this week")}</p>`}
  </div>`;
}

/**
 * `focusSelect`: opened from the keyboard, the focus goes to the phase
 * selector. The popover is appended at the end of the page, so Tab from the
 * badge would never reach it.
 */
function renderPopover(focusSelect = false) {
  if (!_state || !_badgeEl) return;
  if (_popoverHost) closePopover();

  const progress = lastStats ? computeWeekProgress(lastStats, _state) : null;
  const stats = lastStats;
  const badge = _badgeEl;

  const host = document.createElement("div");
  _popoverHost = host;
  host.style.cssText = "position:absolute;z-index:99999;width:200px;";

  const shadow = host.attachShadow({ mode: "open" });
  adoptSharedStyles(
    shadow,
    `.ft-popover { box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
    .ft-popover:focus { outline: none; }
    .ft-popover td { padding: 0.2rem 0.4rem; font-size: 0.8125rem; }`,
  );

  (async () => {
    const theme = await getEffectiveTheme();
    // closed (or replaced) while the theme was read
    if (_popoverHost !== host) return;
    const daisyTheme = theme === "light" ? "light" : "dark";
    const th = _state!.thresholds;
    const title = trackerStateFor(_state!.mode);
    // tabindex -1: a click on the popover's text keeps the focus inside it.
    // It went to the page, and the focus leaving closed the popover under
    // the pointer once the badge or the select had held it.
    render(
      html`
        <div data-theme="${daisyTheme}">
          <div
            class="card card-compact ft-popover bg-base-100"
            role="dialog"
            tabindex="-1"
            aria-label="${title ? t(title.label) : ""}"
          >
            <div class="card-body p-3">
              <div class="mb-1">
                <select
                  class="select select-xs select-ghost w-full"
                  aria-label="${t("Weekly goal")}"
                  @change="${(e: Event) => {
                    const val = (e.target as HTMLSelectElement).value;
                    saveTrackerMode(val).then(() => window.location.reload());
                  }}"
                >
                  ${TRACKER_MODES.filter((m) => m.startsWith(_badgeType!)).map(
                    (m) => {
                      const s = trackerStateFor(m);
                      const selected = m === _state!.mode;
                      return html`
                        <option value="${m}" ?selected="${selected}">
                          ${s ? t(s.label).replace(/^(Phoenix|Pegasus) - /, "") : ""}
                        </option>
                      `;
                    },
                  )}
                </select>
              </div>
              <div class="grid grid-cols-2 gap-2">
                ${progress
                  ? html`
                      <div
                        class="card card-compact"
                        style="background:${progress.daysDone >= th.days
                          ? "rgba(16,185,129,0.15)"
                          : "rgba(239,68,68,0.15)"}"
                      >
                        <div class="card-body p-2 items-center text-center">
                          <span class="text-xs opacity-60">${t("Days")}</span>
                          <span class="font-bold tabular-nums"
                            >${progress.daysDone}/${th.days}</span
                          >
                        </div>
                      </div>
                      <div
                        class="card card-compact"
                        style="background:${progress.hoursDone >= th.hours
                          ? "rgba(16,185,129,0.15)"
                          : "rgba(239,68,68,0.15)"}"
                      >
                        <div class="card-body p-2 items-center text-center">
                          <span class="text-xs opacity-60">${t("Hours")}</span>
                          <span class="font-bold tabular-nums"
                            >${formatHours(progress.hoursDone)}/${formatHours(
                              th.hours,
                            )}</span
                          >
                        </div>
                      </div>
                    `
                  : html`
                      <div
                        class="col-span-2 text-center text-xs opacity-50 py-2"
                      >
                        ${t("No logtime data yet (it comes from the Logtime feature).")}
                      </div>
                    `}
              </div>
              ${stats ? renderOutlook(stats, _state!) : ""}
              <p class="text-xs opacity-60">
                ${t("Saturday to Friday, {cap} max counted per day", {
                  cap: formatHours(PEGASUS_MAX_HOURS_PER_DAY),
                })}
              </p>
            </div>
          </div>
        </div>
      `,
      shadow,
    );

    const rect = badge.getBoundingClientRect();
    host.style.top = `${rect.bottom + 6 + window.scrollY}px`;
    host.style.left = `${Math.min(rect.left + window.scrollX, document.documentElement.scrollWidth - 276)}px`;
    if (focusSelect) shadow.querySelector("select")?.focus();
  })();

  document.body.appendChild(host);
  badge.setAttribute("aria-expanded", "true");

  host.addEventListener("mouseenter", () => {
    if (_popoverTimer) clearTimeout(_popoverTimer);
  });
  host.addEventListener("mouseleave", scheduleClose);
  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePopover();
      badge.focus();
    } else if (e.key === "Tab") {
      // The popover sits at the end of the page: Tab from its select went
      // to the browser's address bar, Shift+Tab to the page's last link.
      // Back to the badge instead; Tab (not prevented) then moves on from
      // there, Shift+Tab stops on it.
      if (e.shiftKey) e.preventDefault();
      closePopover();
      badge.focus();
    }
  });
  host.addEventListener("focusout", (e) => {
    if (leavesTracker(e.relatedTarget)) closePopover();
  });
}

/**
 * Whether the focus moving to `next` leaves both the badge and its popover.
 * From inside the popover's shadow root, `next` arrives retargeted: the
 * popover host itself.
 */
function leavesTracker(next: EventTarget | null): boolean {
  if (!(next instanceof Node)) return true;
  return next !== _badgeEl && !(_popoverHost?.contains(next) ?? false);
}

/**
 * The pointer left the badge or the popover. A popover that holds the focus
 * (opened from the keyboard, or its select clicked) stays until the focus
 * leaves: closing it under the select dropped the focus on the page.
 */
function scheduleClose() {
  if (_popoverTimer) clearTimeout(_popoverTimer);
  _popoverTimer = setTimeout(() => {
    _popoverTimer = null;
    const active = document.activeElement;
    if (active && (active === _badgeEl || active === _popoverHost)) return;
    closePopover();
  }, 100);
}

function closePopover() {
  if (!_popoverHost) return;
  _popoverHost.remove();
  _popoverHost = null;
  _badgeEl?.setAttribute("aria-expanded", "false");
}

/** Click, Enter or Space: opens the popover, or keeps an open one as it is. */
function openPopover(fromKeyboard: boolean) {
  if (_popoverTimer) clearTimeout(_popoverTimer);
  if (!_popoverHost) renderPopover(fromKeyboard);
  else if (fromKeyboard) _popoverHost.shadowRoot?.querySelector("select")?.focus();
}

export async function colorTrackerBadge(): Promise<void> {
  if (_badgeEl) return;

  const found = findTrackerBadgeEl();
  if (!found) return;

  const badge = found.element;
  _badgeEl = badge;
  _badgeType = found.type;
  badge.style.cursor = "pointer";
  badge.title = "";

  // The popover opened on hover only: keyboard users could neither read the
  // week nor change their phase, which is chosen nowhere else. The badge is
  // the Intra's own element, so it becomes a button here, as the avatar does
  // in avatar-clicks.ts. Not opened on focus: Tab would pop it up on the way
  // to somewhere else, and a blur would close it before the focus got in.
  badge.tabIndex = 0;
  badge.setAttribute("role", "button");
  badge.setAttribute("aria-haspopup", "dialog");
  badge.setAttribute("aria-expanded", "false");
  badge.addEventListener("click", () => openPopover(false));
  badge.addEventListener("keydown", (e) => {
    if (e.target !== badge) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); // Space would scroll the page
      openPopover(true);
    } else if (e.key === "Escape") {
      closePopover();
    }
  });
  badge.addEventListener("focusout", (e) => {
    if (leavesTracker(e.relatedTarget)) closePopover();
  });

  badge.addEventListener("mouseenter", () => {
    if (_popoverTimer) clearTimeout(_popoverTimer);
    if (!_popoverHost) renderPopover();
  });
  badge.addEventListener("mouseleave", scheduleClose);

  let state = await getTrackerState();
  // A phase of the other programme too: a student who moved from Phoenix to
  // Pegasus kept the Phoenix thresholds, and the list (Pegasus phases only)
  // showed none selected.
  if (!state || !state.mode.startsWith(found.type)) {
    const defaultMode =
      found.type === "phoenix" ? "phoenix-1" : "pegasus-bronze";
    await saveTrackerMode(defaultMode);
    state = await getTrackerState();
  }
  if (!state) return;
  _state = state;

  updateBadgeIndicator();

  // 42_LOGTIME_RENDERED is dispatched by logtime.ts right after lastStats is
  // assigned; listening to the raw 42_LOGTIME_DATA event ran this before the
  // logtime module had stored the new stats (it awaits storage first), so the
  // badge reflected the previous payload, or none on first load.
  document.addEventListener("42_LOGTIME_RENDERED", updateBadgeIndicator);
}
