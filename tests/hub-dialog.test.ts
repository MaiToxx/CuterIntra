/**
 * The settings hub <dialog>, as a keyboard and screen reader user meets it:
 * a name, a named close button, and no closing when a key activates one of
 * its controls. A key that activates a control (Space on a switch, Enter on
 * a button, an arrow key moving between the radio tabs) fires a click at
 * (0, 0); the "click outside the box closes it" test used to read that as a
 * click on the backdrop, so the first arrow key in the tabs shut the hub.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../src/features/hub/controls/context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/hub/controls/context.ts")>()),
  // No network in a unit test: the lists fall back to the defs' own options.
  loadLiveOptions: vi.fn(async () => ({ campuses: [], eventTypes: [] })),
}));

/** Where the dialog box sits on screen (jsdom lays nothing out). */
const BOX = { left: 100, right: 900, top: 50, bottom: 750 };

beforeAll(() => {
  // jsdom has <dialog> but neither showModal() nor close().
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
    this.dispatchEvent(new Event("close"));
  };
  // createDialog sizes the box from a media query.
  (window as unknown as { matchMedia: unknown }).matchMedia ??= vi.fn(() => ({ matches: true }));
  const storage = chrome.storage as unknown as { onChanged?: unknown };
  storage.onChanged ??= { addListener: vi.fn(), removeListener: vi.fn() };
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

let dialog: HTMLDialogElement;
let shadow: ShadowRoot;

beforeEach(async () => {
  if (!document.getElementById("hub-dialog")) {
    const { openHubModal } = await import("../src/features/hub/hubSettings.ui.ts");
    await openHubModal(["profile", "logtime"]);
    await settle();
  }
  dialog = document.getElementById("hub-dialog") as HTMLDialogElement;
  dialog.getBoundingClientRect = () => ({ ...BOX, x: BOX.left, y: BOX.top, width: 800, height: 700 }) as DOMRect;
  shadow = dialog.querySelector("#hub-shadow-wrapper")!.shadowRoot!;
  dialog.showModal();
});

/** The click a key press synthesises on a control: no pointer, at (0, 0). */
function keyboardClick(target: Element) {
  target.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true, clientX: 0, clientY: 0, detail: 0 }),
  );
}

describe("the hub dialog", () => {
  it("has a name, and a close button that says what it does", () => {
    expect(dialog.getAttribute("aria-label")).toBe("Cuter Intra settings");
    const close = [...shadow.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Close settings",
    );
    expect(close).toBeDefined();
    expect(close!.querySelector('[aria-hidden="true"]')!.textContent).toBe("✕");
    expect(shadow.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe(
      "Settings sections",
    );
  });

  it("stays open when a key moves between the tabs", () => {
    const tabs = [...shadow.querySelectorAll<HTMLInputElement>('input[name="hub_tabs"]')];
    expect(tabs.length).toBeGreaterThan(3);
    keyboardClick(tabs[1]);
    expect(dialog.open).toBe(true);
  });

  it("stays open when Space flips a switch or Enter presses a button", () => {
    keyboardClick(shadow.querySelector("input.toggle")!);
    expect(dialog.open).toBe(true);
    // Backup's "Export" (the one button here with no page-wide effect in a test).
    const exportButton = [...shadow.querySelectorAll("button")].find(
      (b) => b.textContent!.trim() === "Export",
    )!;
    keyboardClick(exportButton);
    expect(dialog.open).toBe(true);
  });

  it("still closes on a click on the backdrop", () => {
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }));
    expect(dialog.open).toBe(false);
  });

  it("still ignores a click inside the box", () => {
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 400, clientY: 300 }));
    expect(dialog.open).toBe(true);
  });

  it("names the footer's theme switch by what checked means", () => {
    const toggle = shadow.querySelector<HTMLInputElement>("#hub-theme-toggle")!;
    expect(toggle.getAttribute("aria-label")).toBe("Dark theme");
  });
});
