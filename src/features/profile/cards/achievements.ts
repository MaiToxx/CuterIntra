import { html, nothing, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import { svgFromUntrustedMarkup } from "../../../core/dom/svg.ts";
import { getConfig } from "../../../core/config.ts";
import { getCloudLogin } from "../../account/account.ts";
import { getLoginFromPage } from "../../../core/intra/profile-login.ts";
import {
  findDashboardCard,
  waitForDashboardCard,
} from "../../../core/intra/selectors.ts";
import {
  parseIntraDate,
  waitForIntrapyToken,
} from "../../../core/intra/intrapy.ts";
import { INTRA_FONT } from "../../logtime/constants.ts";
import CHECK_CIRCLE_SVG from "../../../assets/svg/check-circle.svg?raw";
import { intlLocale, t } from "../../../core/i18n/i18n.ts";

interface Achievement {
  name: string;
  achieved_at: string;
  description: string;
  svg: string;
}

const INJECTED_ID = "ft-achievements-injected";
/** How long to wait for the page to hand over a usable Intra token. */
const TOKEN_WAIT_MS = 30000;
/**
 * A failed request is asked again on a timer, a few times: a failure is not
 * "no achievements". Not on a later profile pass: passes only run on Intra
 * mutation bursts and stop 30 s after load, so a settled dashboard may never
 * run another one (the list then stayed missing for the whole visit). The
 * passes in between leave the card alone, so an API that keeps failing is
 * not called on every burst either. Same scheme as marks.ts.
 */
const RETRY_AFTER_MS = 10000;
const MAX_RETRIES = 3;
let achievementsInitialized = false;
let lastInjectedLogin: string | null = null;
let retriesLeft = MAX_RETRIES;
let retryNotBefore = 0;

/** The achievements of `login`, or null when the request failed. */
async function fetchAchievements(
  login: string,
  token: string,
): Promise<Achievement[] | null> {
  try {
    const res = await fetch(
      `https://intrapy.intra.42.fr/api/v1/users/${login}/achievements`,
      { headers: { Authorization: token } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Achievement[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

const findCard = () => findDashboardCard("LAST ACHIEVEMENTS");

/**
 * The icons of one list, by URL: the SVG, scrubbed and stripped of its own
 * size, or null when it could not be loaded. A URL not in the map is on its way.
 */
type Icons = Map<string, SVGSVGElement | null>;

/**
 * Where an achievement icon may come from: an Intra host over https. The
 * URL is intrapy's, and the SVG it names is drawn inline in the Intra page.
 */
export function achievementIconUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw, location.href);
    return u.protocol === "https:" && /(^|\.)intra\.42\.fr$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

function iconTile(icons: Icons, url: string) {
  if (!icons.has(url)) {
    return html`<div
      class="w-8 h-8 bg-zinc-200 rounded-sm animate-pulse"
    ></div>`;
  }
  const svg = icons.get(url);
  // A lost icon leaves the tile empty: the placeholder used to pulse there
  // for the rest of the visit.
  if (!svg) return nothing;
  // A copy per tile and per draw: one node cannot sit in two places.
  return html`<div style="width:45px;height:45px">${svg.cloneNode(true)}</div>`;
}

function renderList(
  achievements: Achievement[],
  dates: readonly string[],
  icons: Icons,
) {
  return html`<div
    class="grid gap-4 mt-4"
    style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))"
  >
    ${achievements.map(
      (a, i) =>
        html` <div
          class="w-full border-2 border-neutral-200 flex flex-row justify-between rounded-sm h-24"
        >
          <div class="p-3 flex flex-row justify-between w-full items-center">
            <div class="flex flex-col min-w-0 flex-1">
              <h1 class="text-base font-medium leading-none">${a.name}</h1>
              <p
                class="text-xs max-h-10 overflow-y-auto text-neutral-400 pt-2"
                style="scrollbar-width:none"
              >
                ${a.description}
              </p>
            </div>
            <div class="pt-1 flex flex-row gap-1 shrink-0 ml-3">
              <div>
                <span
                  class="size-6 flex items-center justify-center"
                  style="color: hsl(var(--legacy-main))"
                  >${unsafeHTML(CHECK_CIRCLE_SVG)}</span
                >
              </div>
              <div>
                <p class="font-bold text-legacy-main">${t("Achieved")}</p>
                <p>${dates[i]}</p>
              </div>
            </div>
          </div>
          <div class="bg-zinc-100 w-20 grid place-items-center shrink-0">
            ${iconTile(icons, a.svg)}
          </div>
        </div>`,
    )}
  </div>`;
}

function inject(achievements: Achievement[]) {
  const existing = document.getElementById(INJECTED_ID);
  const card = findCard();
  if (!card) {
    if (existing) existing.remove();
    return;
  }

  const grid = card.querySelector<HTMLElement>(
    ":scope .h-full .grid, :scope .grid",
  );
  const area = grid?.parentElement;
  if (!area) return;

  if (existing) {
    if (grid) grid.style.display = "";
    existing.remove();
  }
  if (grid) grid.style.display = "none";

  const container = document.createElement("div");
  container.id = INJECTED_ID;
  container.style.cssText = `font-family: ${INTRA_FONT};`;

  // WHY formatted, stripped and rendered this way: the list used to be
  // redrawn once per arriving icon, and every redraw formatted all N dates
  // again (toLocaleDateString builds a new formatter per call) and re-stripped
  // every icon already there: (N+1) x N formatter builds, about 355 ms of
  // main thread for 100 achievements while the dashboard loads.
  const dateFormat = new Intl.DateTimeFormat(intlLocale("en-US"), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const dates = achievements.map((a) =>
    dateFormat.format(parseIntraDate(a.achieved_at)),
  );
  const icons: Icons = new Map();
  const draw = () => render(renderList(achievements, dates, icons), container);
  // Icons that land in the same frame share one redraw. Not a single render
  // after all of them: one slow icon would keep every other one a placeholder.
  let frame = 0;
  const scheduleDraw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };
  for (const url of new Set(achievements.map((a) => a.svg))) {
    const from = achievementIconUrl(url);
    if (!from) {
      icons.set(url, null);
      continue;
    }
    fetch(from)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null)
      .then((svg) => {
        // Parsed and scrubbed, never inserted as HTML: an icon is remote markup.
        icons.set(url, svg ? svgFromUntrustedMarkup(svg.replace(/(width|height)="[^"]*"/g, "")) : null);
        scheduleDraw();
      });
  }
  draw();
  area.appendChild(container);
}

async function tryInject(achievements: Achievement[]) {
  const sorted = [...achievements].sort(
    (a, b) =>
      parseIntraDate(b.achieved_at).getTime() -
      parseIntraDate(a.achieved_at).getTime(),
  );
  const card = await waitForDashboardCard("LAST ACHIEVEMENTS", {
    maxFrames: 50,
  });
  if (card) inject(sorted);
}

export async function initAchievements() {
  if (!(await getConfig("PROFILE_SHOW_ACHIEVEMENTS"))) return;
  if (
    location.hostname !== "profile-v3.intra.42.fr" ||
    location.pathname !== "/"
  )
    return;

  const pageLogin = getLoginFromPage();
  const login = (await getCloudLogin()) || pageLogin;
  if (!login) return;
  if (achievementsInitialized && login === lastInjectedLogin) return;
  if (Date.now() < retryNotBefore) return;

  const token = await waitForIntrapyToken(TOKEN_WAIT_MS);
  if (!token) return;
  achievementsInitialized = true;
  lastInjectedLogin = login;

  const achievements = await fetchAchievements(login, token);
  if (achievements === null) {
    achievementsInitialized = false;
    if (retriesLeft > 0) {
      retriesLeft--;
      retryNotBefore = Date.now() + RETRY_AFTER_MS;
      setTimeout(() => {
        retryNotBefore = 0;
        void initAchievements();
      }, RETRY_AFTER_MS);
    } else {
      // given up for this page
      retryNotBefore = Infinity;
    }
    return;
  }
  if (achievements.length === 0) return;

  await tryInject(achievements);
}
