/**
 * Escape closes a modal <dialog> by itself. The confirm dialog had no answer
 * for that: the caller ("Restore your settings?") waited for ever and the
 * closed dialog stayed in the page.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { showConfirmDialog } from "../src/core/dom/confirm-dialog";

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
});

const dialog = () => document.getElementById("ft-confirm-dialog") as HTMLDialogElement | null;

describe("the confirm dialog", () => {
  it("answers no when Escape closes it, and leaves the page", async () => {
    const answer = showConfirmDialog({ message: "Restore?" });
    expect(dialog()).not.toBeNull();
    dialog()!.close(); // what Escape does
    await expect(answer).resolves.toBe(false);
    expect(dialog()).toBeNull();
  });

  it("still answers yes from its button, once", async () => {
    const answer = showConfirmDialog({ message: "Restore?", confirmLabel: "Yes" });
    const host = dialog()!.firstElementChild as HTMLElement;
    const yes = [...host.shadowRoot!.querySelectorAll("button")].find(
      (b) => b.textContent!.trim() === "Yes",
    )!;
    yes.click();
    await expect(answer).resolves.toBe(true);
    expect(dialog()).toBeNull();
  });
});
