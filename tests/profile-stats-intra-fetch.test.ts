/**
 * fetchProfileStatsViaIntra says whether it read everything, so that a failed
 * Intra v2 page is neither cached nor shown as the real numbers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchProfileStatsViaIntra } from "../src/features/profile/cards/profile-stats-intra";

const feedbackItem = (date: string, mark: number) => `
<li class="table-item scaleteam-list-item">
  <div class="header">evaluated someone scheduled on <b>${date}</b></div>
  <div class="final-mark"><div class="rating" ${mark >= 50 ? "data-positive" : ""}>${mark} %</div></div>
</li>`;
const page = (item: string, lastPage: number) =>
  `<ul>${item}</ul><a href="/users/bob/feedbacks?as=corrector&amp;page=${lastPage}">${lastPage}</a>`;
const historics = `<div class="changelog-item"><p class="title">
  <code data-count="12" data-date="2026-09-11 06:00:00 UTC">+3</code>
  <span class="reason">Thursday Roulette</span></p></div>`;

/** The background's answers; URLs containing one of `fail` get { ok: false }. */
function serve(fail: string[] = []) {
  const sendMessage = vi.fn(async ({ url }: { url: string }) => {
    if (fail.some((f) => url.includes(f))) return { ok: false, status: 504 };
    if (url.includes("correction_point_historics")) return { ok: true, text: historics };
    if (url.includes("page=1")) return { ok: true, text: page(feedbackItem("September 13, 2026 14:30", 80), 3) };
    if (url.includes("page=2")) return { ok: true, text: page(feedbackItem("September 2, 2026 10:00", 30), 3) };
    if (url.includes("page=3")) return { ok: true, text: page(feedbackItem("August 30, 2026 09:00", 90), 3) };
    return { ok: false };
  });
  (globalThis as any).chrome.runtime = { sendMessage };
  return sendMessage;
}

describe("fetchProfileStatsViaIntra", () => {
  afterEach(() => {
    delete (globalThis as any).chrome.runtime;
  });

  it("reports a complete read when every page loaded", async () => {
    serve();
    const r = await fetchProfileStatsViaIntra("bob");
    expect(r.complete).toBe(true);
    expect(r.rouletteLoaded).toBe(true);
    expect(r.roulette).toHaveLength(1);
    expect(r.evalStats?.global).toEqual({ total: 3, failed: 1, successPercentage: 66.7 });
  });

  it("a later feedback page failing gives no stats rather than a total too low", async () => {
    serve(["page=2"]);
    const r = await fetchProfileStatsViaIntra("bob");
    expect(r.complete).toBe(false);
    expect(r.evalStats).toBeNull();
    // the roulette history is independent and still usable
    expect(r.rouletteLoaded).toBe(true);
    expect(r.roulette).toHaveLength(1);
  });

  it("the first feedback page failing gives no stats either", async () => {
    serve(["page=1"]);
    const r = await fetchProfileStatsViaIntra("bob");
    expect(r.complete).toBe(false);
    expect(r.evalStats).toBeNull();
  });

  it("with feedbacks: false reads the history page only (the worker gave the stats)", async () => {
    const sendMessage = serve();
    const r = await fetchProfileStatsViaIntra("bob", { feedbacks: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].url).toContain("correction_point_historics");
    expect(r).toEqual({
      roulette: [expect.objectContaining({ sum: 3, total: 12 })],
      evalStats: null,
      complete: true,
      rouletteLoaded: true,
    });
  });

  it("the history page failing is reported as not loaded, not as zero wins", async () => {
    serve(["correction_point_historics"]);
    const r = await fetchProfileStatsViaIntra("bob");
    expect(r.complete).toBe(false);
    expect(r.rouletteLoaded).toBe(false);
    expect(r.evalStats?.global.total).toBe(3);
  });
});
