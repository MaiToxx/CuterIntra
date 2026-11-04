/**
 * What the toolbar popup asks the content script of the active Intra tab, and
 * the content script's answers. One module for both ends so the message names
 * and the answer shape cannot drift apart.
 *
 *  - FT_INTRA_LOGIN: sign in with this page's Intra token (the popup cannot
 *    see it). Answers an IntraLoginResult.
 *  - FT_PING: "is Cuter Intra running here?". Chrome does not inject content
 *    scripts into tabs opened before an install or an update, so the popup
 *    needs to know whether to offer a reload. Answers a PingAnswer.
 *  - FT_OPEN_HUB: open the settings hub, then answer, so the popup can close
 *    itself without cutting the dialog off.
 *
 * Wire it in the content script with
 *   chrome.runtime.onMessage.addListener((m, _s, reply) =>
 *     answerPopupMessage(m, reply, { openHub }));
 */
import { loginWithIntraSession, INTRA_LOGIN_MESSAGE } from "./intra-login.ts";

export { INTRA_LOGIN_MESSAGE };
export const PING_MESSAGE = "FT_PING";
export const OPEN_HUB_MESSAGE = "FT_OPEN_HUB";

export interface PingAnswer {
  ok: true;
  /** The settings hub can be opened on this page. */
  hub: boolean;
}

export function isPingAnswer(value: unknown): value is PingAnswer {
  return (
    !!value &&
    typeof value === "object" &&
    (value as PingAnswer).ok === true &&
    typeof (value as PingAnswer).hub === "boolean"
  );
}

/**
 * The hub has only been checked on the v3 pages, where its gear lives; the v2
 * pages (profile., projects.intra.42.fr) are sent to the v3 profile instead.
 */
export function hubAvailableHere(hostname: string = location.hostname): boolean {
  return hostname === "profile-v3.intra.42.fr";
}

export interface PopupBridgeDeps {
  openHub: () => Promise<void>;
}

/**
 * A runtime.onMessage listener body. Returns true when the answer comes
 * later (the channel must stay open), undefined for a message that is not
 * the popup's, so other listeners can still answer it.
 */
export function answerPopupMessage(
  message: unknown,
  sendResponse: (answer: unknown) => void,
  deps: PopupBridgeDeps,
): true | undefined {
  const type = (message as { type?: unknown } | null)?.type;
  if (type === INTRA_LOGIN_MESSAGE) {
    loginWithIntraSession()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (type === PING_MESSAGE) {
    sendResponse({ ok: true, hub: hubAvailableHere() } satisfies PingAnswer);
    return undefined;
  }
  if (type === OPEN_HUB_MESSAGE) {
    if (!hubAvailableHere()) {
      sendResponse({ ok: false });
      return undefined;
    }
    deps
      .openHub()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return undefined;
}
