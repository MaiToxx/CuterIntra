/**
 * Easter eggs and the people they must not bother: someone typing in one of
 * Cuter Intra's own fields (they live in shadow roots, where a document
 * listener only sees the host), someone who asked for less motion (the OS
 * preference or the Advanced "Disable animations" switch), and someone who
 * uses a screen reader (the toast is a live region).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Listener = EventListenerOrEventListenerObject;
/** keydown listeners each fresh module instance adds, removed after each case. */
const added: Listener[] = [];
/** storage.onChanged listeners, and a way to fire them like the browser does. */
const storageListeners: ((changes: object, area: string) => void)[] = [];
function storageChanged(values: Record<string, unknown>) {
  const changes = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }]));
  for (const fn of storageListeners) fn(changes, "local");
}

async function startEggs(stored: Record<string, unknown> = {}) {
  await chrome.storage.local.clear();
  if (Object.keys(stored).length) await chrome.storage.local.set(stored);
  vi.resetModules();
  const mod = await import("../src/features/eggs/eggs.ts");
  await mod.initEasterEggs();
  return mod;
}

function typeInto(target: EventTarget, text: string | string[]) {
  for (const key of typeof text === "string" ? [...text] : text) {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, composed: true }),
    );
  }
}

/** A text field inside an open shadow root, like every hub field. */
function shadowInput(): HTMLInputElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const input = document.createElement("input");
  root.appendChild(input);
  return input;
}

function reducedMotion(on: boolean) {
  (window as unknown as { matchMedia: unknown }).matchMedia = vi.fn((query: string) => ({
    matches: on && query === "(prefers-reduced-motion: reduce)",
    media: query,
  }));
}

async function foundEggs(): Promise<unknown> {
  // found() records asynchronously, after the effect started.
  await vi.advanceTimersByTimeAsync(0);
  return (await chrome.storage.local.get("EGGS_FOUND")).EGGS_FOUND;
}

const KONAMI = [
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a",
];

beforeEach(() => {
  vi.useFakeTimers();
  // A Monday at noon, local time: the fake clock otherwise starts at the real
  // one, and between 02:00 and 05:00 startEggs() records the night secret,
  // which the first case then finds in EGGS_FOUND (a Thursday adds a wait).
  vi.setSystemTime(new Date(2026, 8, 21, 12, 0));
  document.body.replaceChildren();
  document.head.replaceChildren();
  document.documentElement.removeAttribute("style");
  const real = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type: string, fn: Listener, opts?: boolean | AddEventListenerOptions) => {
      if (type === "keydown") added.push(fn);
      real(type, fn, opts);
    },
  );
  (chrome.storage as unknown as { onChanged: unknown }).onChanged = {
    addListener: (fn: (changes: object, area: string) => void) => storageListeners.push(fn),
  };
  // jsdom has no 2D context; a stub lets the canvas effects mount.
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  reducedMotion(false);
});

afterEach(() => {
  for (const fn of added.splice(0)) window.removeEventListener("keydown", fn, true);
  storageListeners.splice(0);
  delete (chrome.storage as unknown as { onChanged?: unknown }).onChanged;
  // Every startEggs() arms the 42h badge watcher (jsdom's path is "/"); the
  // fake deadline dies with useRealTimers(), and the observers would fire
  // after the environment is torn down ("document is not defined").
  window.dispatchEvent(new Event("pagehide"));
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("typing in Cuter Intra's own fields", () => {
  it("does not trigger a secret from a field inside a shadow root", async () => {
    await startEggs();
    const input = shadowInput();
    typeInto(input, "barrel");
    typeInto(input, "matrix");
    expect(document.documentElement.style.transform).toBe("");
    expect(document.querySelector("canvas")).toBeNull();
    expect(await foundEggs()).toBeUndefined();
  });

  it("still triggers from the page itself", async () => {
    await startEggs();
    typeInto(document.body, "barrel");
    expect(document.documentElement.style.transform).toBe("rotate(360deg)");
    expect(await foundEggs()).toEqual(["barrel"]);
  });

  it("does not trigger from a closed shadow root's field, whose host says it has focus", async () => {
    // The cluster map's search box: a window listener's composed path stops
    // at the host of a closed root, so the field itself is never seen.
    await startEggs();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const input = document.createElement("input");
    host.attachShadow({ mode: "closed" }).appendChild(input);
    host.dataset.ftTyping = "";
    typeInto(input, "barrel");
    expect(document.documentElement.style.transform).toBe("");
    delete host.dataset.ftTyping;
    typeInto(host, "barrel");
    expect(document.documentElement.style.transform).toBe("rotate(360deg)");
  });

  it("ignores light-DOM fields as before", async () => {
    await startEggs();
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    typeInto(input, "barrel");
    expect(document.documentElement.style.transform).toBe("");
  });
});

describe("the key listener", () => {
  it("sees a key the page stops on its way (it listens first, on the window)", async () => {
    await startEggs();
    const stopper = (e: Event) => e.stopPropagation();
    document.body.addEventListener("keydown", stopper, true);
    try {
      typeInto(document.body, "barrel");
    } finally {
      document.body.removeEventListener("keydown", stopper, true);
    }
    expect(document.documentElement.style.transform).toBe("rotate(360deg)");
  });

  it("follows the switch without a reload, both ways", async () => {
    await startEggs({ EASTER_EGGS_ENABLED: false });
    typeInto(document.body, "barrel");
    expect(document.documentElement.style.transform).toBe("");

    storageChanged({ EASTER_EGGS_ENABLED: true });
    typeInto(document.body, "barrel");
    expect(document.documentElement.style.transform).toBe("rotate(360deg)");
    expect(await foundEggs()).toEqual(["barrel"]);

    await vi.advanceTimersByTimeAsync(1400);
    storageChanged({ EASTER_EGGS_ENABLED: false });
    typeInto(document.body, "barrel");
    expect(document.documentElement.style.transform).toBe("");
  });

  it("counts keys pressed on a switch or a button, and skips a key-less autofill event", async () => {
    await startEggs();
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    box.dispatchEvent(new Event("keydown", { bubbles: true }));
    typeInto(box, "barrel");
    expect(document.documentElement.style.transform).toBe("rotate(360deg)");
  });

  it("still shows the secret when storage is gone (an orphaned script)", async () => {
    await startEggs();
    const get = vi.spyOn(chrome.storage.local, "get").mockRejectedValue(new Error("Extension context invalidated."));
    typeInto(document.body, "maxwell");
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("ft-egg-maxwell")).not.toBeNull();
    expect(document.getElementById("ft-egg-toast")?.textContent).toContain("Maxwell");
    get.mockRestore();
  });
});

describe("the hub gear secret", () => {
  it("takes seven clicks in a row, each under five seconds after the last", async () => {
    const { gearClicked } = await startEggs();
    for (let i = 0; i < 6; i++) {
      await gearClicked();
      await vi.advanceTimersByTimeAsync(4000);
    }
    expect(await foundEggs()).toBeUndefined();
    await gearClicked();
    await vi.advanceTimersByTimeAsync(0);
    expect(await foundEggs()).toEqual(["hacker"]);
  });

  it("starts over after a longer pause", async () => {
    const { gearClicked } = await startEggs();
    for (let i = 0; i < 6; i++) await gearClicked();
    await vi.advanceTimersByTimeAsync(5001);
    await gearClicked();
    expect(await foundEggs()).toBeUndefined();
  });
});

describe("reduced motion", () => {
  for (const [why, stored, os] of [
    ["the OS preference", {}, true],
    ["the Disable animations switch", { DISABLE_ANIMATIONS: true }, false],
  ] as const) {
    it(`finds the secrets but moves nothing, with ${why}`, async () => {
      reducedMotion(os);
      await startEggs(stored);

      // One at a time: two secrets recorded in the same tick race on storage.
      typeInto(document.body, "barrel");
      expect(document.documentElement.style.transform).toBe("");
      expect(await foundEggs()).toEqual(["barrel"]);

      typeInto(document.body, KONAMI);
      expect(document.getElementById("ft-egg-party")).toBeNull();
      expect(await foundEggs()).toContain("konami");

      typeInto(document.body, "matrix");
      // Neither the konami confetti nor the digital rain.
      expect(document.querySelector("canvas")).toBeNull();
      expect(await foundEggs()).toContain("matrix");

      typeInto(document.body, "maxwell");
      const cat = document.getElementById("ft-egg-maxwell");
      expect(cat?.classList.contains("still")).toBe(true);
      expect(await foundEggs()).toContain("maxwell");
      typeInto(document.body, "maxwell");
      expect(document.getElementById("ft-egg-maxwells")?.classList.contains("still")).toBe(true);
      // Listed in EGG_IDS order.
      expect(await foundEggs()).toEqual(["konami", "barrel", "matrix", "maxwell", "invasion"]);
    });
  }

  it("keeps every effect when nothing asks for less motion", async () => {
    await startEggs();
    typeInto(document.body, KONAMI);
    expect(document.getElementById("ft-egg-party")).not.toBeNull();
    expect(document.querySelector("canvas")).not.toBeNull();
    typeInto(document.body, "maxwell");
    expect(document.getElementById("ft-egg-maxwell")?.classList.contains("still")).toBe(false);
  });
});

describe("the toast", () => {
  it("is announced through a polite live region written after it exists", async () => {
    const { toast } = await startEggs();
    toast("Party mode", 1000);
    const host = document.getElementById("ft-egg-toast")!;
    const region = host.querySelector<HTMLElement>('[role="status"]');
    expect(region).not.toBeNull();
    expect(region!.getAttribute("aria-live")).toBe("polite");
    // The <style> is not inside what gets announced.
    expect(region!.querySelector("style")).toBeNull();
    // What the eye sees is there at once, and hidden from screen readers so
    // that the message is not read twice.
    const pill = host.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    expect(pill.textContent).toBe("Party mode");
    expect(region!.textContent).toBe("");
    await vi.advanceTimersByTimeAsync(100);
    expect(region!.textContent).toBe("Party mode");

    // Emptied first, so the same message is read again.
    toast("Party mode", 1000);
    expect(region!.textContent).toBe("");
    await vi.advanceTimersByTimeAsync(100);
    expect(document.querySelectorAll("#ft-egg-toast")).toHaveLength(1);
    expect(region!.textContent).toBe("Party mode");

    // The first toast's timer (due 1000 ms after it) does not cut the second
    // one short; the second one's own timer removes it.
    await vi.advanceTimersByTimeAsync(850);
    expect(host.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.isConnected).toBe(false);
  });

  it("is as wide as its text needs, up to the viewport less a margin", async () => {
    // With only left: 50%, a fixed box is capped at half the viewport: a
    // French message wrapped at 640 px on a 1280 px screen, and became a
    // five-line lens on a phone.
    const { toast } = await startEggs();
    toast("Maxwell (clique dessus pour qu’il tourne plus vite) · secret 1/9 trouvé");
    const css = document.querySelector("#ft-egg-toast style")!.textContent!.replace(/\s+/g, " ");
    expect(css).toContain("width: max-content;");
    expect(css).toContain("max-width: min(40rem, calc(100vw - 32px));");
    expect(css).toContain("box-sizing: border-box;");
    expect(css).not.toContain("border-radius: 999px");
    // still centred, entry animation included
    expect(css).toContain("left: 50%");
    expect(css).toContain("translate(-50%, 0)");
  });

  it("does not slide in under reduced motion", async () => {
    reducedMotion(true);
    const { toast } = await startEggs();
    toast("Party mode");
    expect(document.getElementById("ft-egg-toast")!.classList.contains("still")).toBe(true);
  });
});
