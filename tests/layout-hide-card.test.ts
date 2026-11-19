/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://profile-v3.intra.42.fr/" }
 *
 * Hiding a dashboard card matched the card's whole text: with PROJECTS
 * hidden, the agenda went too as soon as an event was named "... projects".
 * Only the card's title counts.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/core/config.ts", () => ({
  getConfig: vi.fn(async (key: string) =>
    key === "PROFILE_CARD_ORDER" ? ["AGENDA", "-PROJECTS"] : true,
  ),
}));

import { optimizeLayout } from "../src/features/profile/layout/layout";

const card = (title: string, body: string) => `
  <div class="bg-white md:h-96" data-card="${title}">
    <span class="font-bold uppercase text-sm">${title}</span>
    <p>${body}</p>
  </div>`;
const shown = (title: string) =>
  document.querySelector<HTMLElement>(`[data-card="${title}"]`)!.style.display !== "none";

describe("hiding a dashboard card", () => {
  it("hides the card of that title only", async () => {
    document.body.innerHTML = `<div class="dash-main">${card(
      "Agenda",
      "Open source projects meetup",
    )}${card("Projects", "libft")}${card("Last achievements", "Validated 3 projects")}</div>`;
    await optimizeLayout();
    expect(shown("Projects")).toBe(false);
    expect(shown("Agenda")).toBe(true);
    expect(shown("Last achievements")).toBe(true);
  });
});
