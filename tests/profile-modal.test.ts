import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The visuals editor, driven through its real markup. The cloud, the page
// painter and the badge layout are stood in so the test can see what the
// editor asks them to do.
const account = vi.hoisted(() => ({
  fetchMySettings: vi.fn(async () => null as Record<string, unknown> | null),
  syncMyVisuals: vi.fn(async (_v: Record<string, unknown>) => {}),
  loginWith42: vi.fn(),
  clearAuthFailed: vi.fn(async () => {}),
}));
vi.mock("../src/features/account/account.ts", () => account);

const paint = vi.hoisted(() => ({
  applyImgs: vi.fn(),
  injectCustomStyles: vi.fn(),
  applyBadgeLayout: vi.fn(),
}));
vi.mock("../src/features/profile/header/visuals-apply.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyImgs: paint.applyImgs,
  injectCustomStyles: paint.injectCustomStyles,
}));
vi.mock("../src/features/profile/header/badges.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyBadgeLayout: paint.applyBadgeLayout,
}));
vi.mock("../src/core/theme/theme-manager.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEffectiveTheme: async () => "dark",
}));

const { createSettingsModal } = await import("../src/features/profile/header/profile.modal.ts");

// jsdom has HTMLDialogElement but neither showModal() nor close(). Same
// contract as the browser: close() on an open dialog clears `open` and fires
// `close` from a queued task, a closed dialog ignores it.
const proto = HTMLDialogElement.prototype as unknown as {
  showModal: () => void;
  close: () => void;
};
proto.showModal = function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
proto.close = function (this: HTMLDialogElement) {
  if (!this.hasAttribute("open")) return;
  this.removeAttribute("open");
  setTimeout(() => this.dispatchEvent(new Event("close")), 0);
};

const tick = () => new Promise((r) => setTimeout(r, 0));
/**
 * Lets the editor's awaited storage calls (all resolved at once by the mock)
 * and the queued `close` event run. Few ticks: a timer tick is ~15 ms on
 * Windows.
 */
async function settle() {
  for (let i = 0; i < 3; i++) await tick();
}

const SAVED = {
  CLOUD_TOKEN: "token",
  PROFILE_BANNER_URL: "https://img.example/old-banner.png",
  PROFILE_BANNER_MODE: "fill",
  PROFILE_DECORATION: "none",
  PROFILE_BADGE_ORDER: ["b", "a"],
  PROFILE_BADGE_WRAP: true,
};

function host() {
  return document.getElementById("profile-modal-host") as HTMLDialogElement | null;
}
function shadow(): ShadowRoot {
  return host()!.querySelector("div")!.shadowRoot!;
}

async function openEditor(onSave = vi.fn()) {
  await createSettingsModal(onSave);
  expect(host()?.open).toBe(true);
  return onSave;
}

/** Picks the "Solid" decoration: an edit the live preview paints on the page. */
function editDecoration() {
  const solid = shadow().querySelector<HTMLInputElement>(
    'input[name="PROFILE_DECORATION"][value="solid"]',
  )!;
  solid.checked = true;
  solid.dispatchEvent(new Event("change", { bubbles: true }));
}

function lastPainted() {
  return paint.applyImgs.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  await chrome.storage.local.clear();
  await chrome.storage.local.set(SAVED);
  vi.clearAllMocks();
  account.fetchMySettings.mockResolvedValue(null);
});

afterEach(() => {
  host()?.remove();
  vi.restoreAllMocks();
});

describe("visuals editor: closing on the backdrop", () => {
  it("a drag that starts in the editor and is released outside keeps it open", async () => {
    await openEditor();
    const dialog = host()!;
    const preview = shadow().querySelector("[role=tabpanel]")!;
    // What the browser sends when the avatar preview is dragged and the button
    // comes up past the dialog's edge: the press inside, the click on the
    // common ancestor, i.e. the dialog itself.
    preview.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(host()).toBe(dialog);
    expect(dialog.open).toBe(true);
  });

  it("a press and release on the backdrop still closes it", async () => {
    await openEditor();
    const dialog = host()!;
    dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(dialog.open).toBe(false);
    expect(host()).toBeNull();
  });

  it("an earlier press on the backdrop does not make the next outward drag close it", async () => {
    await openEditor();
    const dialog = host()!;
    dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const panel = shadow().querySelector("[role=tabpanel]")!;
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    // next press starts inside, released outside
    panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(dialog.open).toBe(true);
  });
});

describe("visuals editor: the live preview", () => {
  it("closing with the X after an edit paints the saved look back", async () => {
    await openEditor();
    editDecoration();
    expect(lastPainted()?.decoration).toBe("solid");

    shadow().querySelector<HTMLElement>("#profile-close-btn")!.click();
    await settle();
    expect(host()).toBeNull();
    expect(lastPainted()).toMatchObject({
      decoration: "none",
      banner: "https://img.example/old-banner.png",
    });
    expect(paint.applyBadgeLayout.mock.calls.at(-1)?.[1]).toEqual({
      order: ["b", "a"],
      wrap: true,
    });
  });

  it("Escape (the native close, not close()) paints the saved look back too", async () => {
    await openEditor();
    editDecoration();
    host()!.close();
    await settle();
    expect(lastPainted()?.decoration).toBe("none");
  });

  it("closing without any edit paints nothing", async () => {
    await openEditor();
    const before = paint.applyImgs.mock.calls.length;
    shadow().querySelector<HTMLElement>("#profile-close-btn")!.click();
    await settle();
    expect(paint.applyImgs.mock.calls.length).toBe(before);
  });

  it("Save keeps the new look: the old one is not painted over it", async () => {
    const onSave = await openEditor();
    editDecoration();
    shadow().querySelector<HTMLElement>("#profile-save")!.click();
    await settle();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ decoration: "solid" });
    expect(host()).toBeNull();
    expect(lastPainted()?.decoration).toBe("solid");
    expect((await chrome.storage.local.get("PROFILE_DECORATION")).PROFILE_DECORATION).toBe(
      "solid",
    );
  });
});

describe("visuals editor: Save with the server out of reach", () => {
  const FAILED = /Saved on this browser only/;

  it("stays open and says the look is on this browser only; Save sends it again", async () => {
    // it closed like a success, and the next open put the cloud's look back
    vi.spyOn(console, "error").mockImplementation(() => {});
    account.syncMyVisuals.mockResolvedValueOnce(false as never);
    const onSave = await openEditor();
    editDecoration();
    shadow().querySelector<HTMLElement>("#profile-save")!.click();
    await settle();

    expect(host()?.open).toBe(true);
    expect(shadow().textContent).toMatch(FAILED);
    // stored and painted all the same
    expect(onSave).toHaveBeenCalledTimes(1);
    const kept = await chrome.storage.local.get(["PROFILE_DECORATION", "PROFILE_LOOK_UNSENT"]);
    expect(kept).toEqual({ PROFILE_DECORATION: "solid", PROFILE_LOOK_UNSENT: true });

    shadow().querySelector<HTMLElement>("#profile-save")!.click();
    await settle();
    expect(host()).toBeNull();
    expect(account.syncMyVisuals).toHaveBeenCalledTimes(2);
    expect((await chrome.storage.local.get("PROFILE_LOOK_UNSENT")).PROFILE_LOOK_UNSENT).toBeUndefined();
  });

  it("a request that throws counts as not sent too, and Cancel keeps the stored look", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    account.syncMyVisuals.mockRejectedValueOnce(new Error("offline"));
    await openEditor();
    editDecoration();
    shadow().querySelector<HTMLElement>("#profile-save")!.click();
    await settle();
    expect(shadow().textContent).toMatch(FAILED);

    shadow().querySelector<HTMLElement>("#profile-close-btn")!.click();
    await settle();
    expect(host()).toBeNull();
    // the look just stored, not the one from before the Save
    expect(lastPainted()?.decoration).toBe("solid");
  });

  it("the next open keeps this browser's look and sends it, instead of copying the cloud's over it", async () => {
    await chrome.storage.local.set({ PROFILE_DECORATION: "solid", PROFILE_LOOK_UNSENT: true });
    account.fetchMySettings.mockResolvedValue({ PROFILE_DECORATION: "none" });
    await openEditor();
    await settle();
    expect(account.fetchMySettings).not.toHaveBeenCalled();
    expect((await chrome.storage.local.get("PROFILE_DECORATION")).PROFILE_DECORATION).toBe("solid");
    expect(account.syncMyVisuals).toHaveBeenCalledTimes(1);
    expect(account.syncMyVisuals.mock.calls[0][0]).toMatchObject({ decoration: "solid" });
    expect((await chrome.storage.local.get("PROFILE_LOOK_UNSENT")).PROFILE_LOOK_UNSENT).toBeUndefined();
  });
});

describe("visuals editor: Reset", () => {
  it("clears the cloud copy too, so visitors and the next open see the reset", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await openEditor();
    editDecoration();
    shadow().querySelector<HTMLElement>("#profile-reset-btn")!.click();
    await settle();

    expect(account.syncMyVisuals).toHaveBeenCalledTimes(1);
    expect(account.syncMyVisuals.mock.calls[0][0]).toMatchObject({
      avatar: "",
      banner: "",
      background: "",
    });
    const left = await chrome.storage.local.get(["PROFILE_BANNER_URL", "PROFILE_DECORATION"]);
    expect(left.PROFILE_BANNER_URL).toBeUndefined();
    expect(left.PROFILE_DECORATION).toBeUndefined();
    // the page reloads: no point painting the old look back in the meantime
    expect(lastPainted()?.decoration).toBe("solid");
  });

  it("a failed cloud call does not stop the local reset", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    account.syncMyVisuals.mockRejectedValueOnce(new Error("offline"));
    await openEditor();
    shadow().querySelector<HTMLElement>("#profile-reset-btn")!.click();
    await settle();
    expect(host()).toBeNull();
    expect((await chrome.storage.local.get("PROFILE_BANNER_URL")).PROFILE_BANNER_URL).toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it("cancelling the confirmation changes nothing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await openEditor();
    shadow().querySelector<HTMLElement>("#profile-reset-btn")!.click();
    await settle();
    expect(account.syncMyVisuals).not.toHaveBeenCalled();
    expect(host()?.open).toBe(true);
  });
});
