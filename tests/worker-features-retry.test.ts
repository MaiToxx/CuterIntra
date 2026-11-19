/**
 * /api/v1/public/features is read once per page. A failed read used to be
 * kept as "nothing offered" for the whole page: one timeout on a long-lived
 * tab hid "Load older months", the evaluation stats and the Campus card until
 * a reload. It is now asked again after a minute (not at once: every caller
 * would wait for a worker that is down).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getWorkerFeatures, resetWorkerFeatures } from "../src/core/worker";

let up = false;
const fetchMock = vi.fn(async () =>
  up
    ? new Response(JSON.stringify({ features: { coalitions: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    : new Response("down", { status: 503 }),
);

beforeEach(() => {
  up = false;
  resetWorkerFeatures();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.restoreAllMocks());

describe("getWorkerFeatures after a failure", () => {
  it("offers nothing, does not ask again at once, and asks again a minute later", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    expect(await getWorkerFeatures()).toEqual({});
    up = true;
    now.mockReturnValue(1_000_000 + 59_000);
    expect(await getWorkerFeatures()).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 60_000);
    expect(await getWorkerFeatures()).toEqual({ coalitions: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a good answer for the page", async () => {
    up = true;
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    await getWorkerFeatures();
    now.mockReturnValue(1_000_000 + 3_600_000);
    expect(await getWorkerFeatures()).toEqual({ coalitions: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
