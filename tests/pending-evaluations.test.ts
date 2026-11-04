/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * The Intra's Pending evaluations card and its own Hide button. With the
 * "Pending evaluations" extra off (the default) Cuter Intra leaves both
 * alone: the button used to be taken over for everyone, and a click on it
 * regrouped the rows and switched the extra on in the hub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** The card as the Intra renders it: title, Hide button, two rows. */
function mountCard() {
  const card = document.createElement("div");
  card.className = "bg-white";
  const header = document.createElement("div");
  const title = document.createElement("span");
  title.textContent = "Pending evaluations";
  const hide = document.createElement("button");
  hide.className = "uppercase";
  hide.textContent = "Hide";
  header.append(title, hide);
  const rows = document.createElement("div");
  for (const text of ["You will evaluate alice on libft", "You will be evaluated by bob"]) {
    const row = document.createElement("div");
    row.className = "flex justify-between w-full items-center";
    row.textContent = text;
    rows.appendChild(row);
  }
  card.append(header, rows);
  document.body.replaceChildren(card);
  return { card, hide };
}

/** What React's root listener would see of a click on the button. */
function pageClicks(): { count: number } {
  const seen = { count: 0 };
  document.addEventListener("click", () => seen.count++);
  return seen;
}

async function run(extraOn: boolean) {
  vi.resetModules();
  await chrome.storage.local.set({ PROFILE_SHOW_EVALUATIONS: extraOn });
  const { initEvaluations } = await import("../src/features/profile/cards/evaluations.ts");
  await initEvaluations();
  // the card is looked up on the next animation frame
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  await chrome.storage.local.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pending evaluations, extra off", () => {
  it("leaves the Intra's Hide button, its label and the rows alone", async () => {
    const { card, hide } = mountCard();
    const seen = pageClicks();
    await run(false);
    const set = vi.mocked(chrome.storage.local.set);
    set.mockClear();

    hide.click();

    expect(seen.count, "the click reaches the Intra's own handler").toBe(1);
    expect(hide.textContent).toBe("Hide");
    expect(card.querySelector(".ft-ev-top")).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });
});

describe("pending evaluations, extra on", () => {
  it("groups the rows; the button ungroups them once, then is the Intra's again", async () => {
    const { card, hide } = mountCard();
    const seen = pageClicks();
    await run(true);
    expect(card.querySelector(".ft-ev-top")?.textContent).toContain("Evaluator (1)");
    expect(hide.textContent).toBe("Show");

    hide.click();
    expect(seen.count, "ungrouping is ours").toBe(0);
    expect(card.querySelector(".ft-ev-top")).toBeNull();
    expect(hide.textContent).toBe("Hide");
    expect(
      (await chrome.storage.local.get("PROFILE_SHOW_EVALUATIONS")).PROFILE_SHOW_EVALUATIONS,
    ).toBe(false);

    hide.click();
    expect(seen.count).toBe(1);
    expect(card.querySelector(".ft-ev-top")).toBeNull();
  });
});
