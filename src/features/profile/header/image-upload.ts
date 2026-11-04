/**
 * Upload of a profile image (avatar, banner, background) to the worker,
 * which keeps one image per slot and serves it from its own origin. The
 * editor's URL field then holds that URL like any pasted one, so nothing
 * else in the visuals pipeline knows about uploads.
 *
 * The editor uploads on Save only (pending-uploads.ts): the slot's one image
 * is what the saved URL serves to every visitor, so an upload made while
 * trying a picture out replaced the published one even after Cancel.
 */
import { getConfigMany } from "../../../core/config.ts";
import { WORKER_URL, hashedLogin, workerErrorText, workerFetch } from "../../../core/worker.ts";
import { msg, t } from "../../../core/i18n/i18n.ts";

export type ImageSlot = "avatar" | "banner" | "background";

export const IMAGE_SLOTS: readonly ImageSlot[] = ["avatar", "banner", "background"];

/** The worker's cap; checked here too so a 5 MB photo fails before the upload. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const ACCEPTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const TYPE_ERROR = msg("Choose a PNG, JPEG, GIF or WebP image.");
const SIZE_ERROR = msg("The image is over 2 MB. Resize it, or paste a link instead.");

export type UploadResult = { ok: true; url: string } | { ok: false; error: string };
export type PreparedImage = { ok: true; blob: Blob } | { ok: false; error: string };

/**
 * Longest side of a photo shrunk to fit the cap: the avatar is shown at
 * 208 px (416 zoomed in, twice that on a high-density screen), banners and
 * backgrounds span a screen.
 */
const SHRINK_MAX_SIDE: Record<ImageSlot, number> = {
  avatar: 1024,
  banner: 2560,
  background: 2560,
};

/** Above this a file is not even decoded: phone photos are 3 to 12 MB. */
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

/**
 * A JPEG over the cap, decoded and re-encoded smaller, or null when the
 * browser cannot (no OffscreenCanvas, a decode error) or the result is still
 * too big. The decode applies the EXIF orientation, so the result is upright
 * without the metadata a phone photo carries.
 */
async function shrinkJpeg(file: Blob, maxSide: number): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return null;
  }
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    for (const quality of [0.9, 0.8, 0.7]) {
      const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
      if (out.size <= MAX_UPLOAD_BYTES) return out;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * What the editor keeps for a picked file until Save: the file itself, or a
 * smaller copy for a JPEG over the cap. Only JPEGs are shrunk: re-encoding
 * would drop a PNG's or WebP's transparency and a GIF's animation.
 */
export async function prepareUpload(slot: ImageSlot, file: File): Promise<PreparedImage> {
  if (!ACCEPTED.has(file.type)) return { ok: false, error: t(TYPE_ERROR) };
  if (file.size <= MAX_UPLOAD_BYTES) return { ok: true, blob: file };
  if (file.type === "image/jpeg" && file.size <= MAX_SOURCE_BYTES) {
    const smaller = await shrinkJpeg(file, SHRINK_MAX_SIDE[slot]);
    if (smaller) return { ok: true, blob: smaller };
  }
  return { ok: false, error: t(SIZE_ERROR) };
}

export async function uploadProfileImage(
  slot: ImageSlot,
  file: Blob,
): Promise<UploadResult> {
  if (!ACCEPTED.has(file.type)) {
    return { ok: false, error: t(TYPE_ERROR) };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: t(SIZE_ERROR) };
  }
  const { CLOUD_LOGIN, CLOUD_TOKEN } = await getConfigMany(["CLOUD_LOGIN", "CLOUD_TOKEN"]);
  if (!CLOUD_LOGIN || !CLOUD_TOKEN) {
    return { ok: false, error: t("Sign in with 42 first (bottom of this editor) to upload images.") };
  }
  const res = await workerFetch(`/api/v1/private/images?slot=${slot}`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type },
    auth: { login: CLOUD_LOGIN, token: CLOUD_TOKEN },
    timeoutMs: 30_000,
  });
  if (res.status === 0) return { ok: false, error: t("Could not reach the Cuter Intra server.") };
  if (res.status === 401) return { ok: false, error: t("Your session expired: reconnect, then retry.") };
  if (res.status === 413) return { ok: false, error: t("The image is over 2 MB.") };
  if (res.status === 429) return { ok: false, error: t("Too many uploads: wait a minute.") };
  // The two 503s of the worker's KV writes (the day's budget spent, the key
  // busy twice), told apart by their code: "Upload failed (503)" said neither
  // when to try again nor that nothing is wrong with the image.
  const shared = workerErrorText(res);
  if (shared) return { ok: false, error: shared };
  const url = (res.json as { url?: unknown } | null)?.url;
  if (!res.ok || typeof url !== "string") {
    return { ok: false, error: t("Upload failed ({status}).", { status: res.status }) };
  }
  return { ok: true, url };
}

const WORKER_ORIGIN = new URL(WORKER_URL).origin;
const IMG_PATH_RE = /^\/img\/([a-f0-9]{64})\/(avatar|banner|background)$/;

/** The slot `url` serves when it is one of `loginHash`'s uploads on this worker, else null. */
export function uploadedSlotOf(url: unknown, loginHash: string): ImageSlot | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== WORKER_ORIGIN) return null;
    const match = parsed.pathname.match(IMG_PATH_RE);
    return match && match[1] === loginHash ? (match[2] as ImageSlot) : null;
  } catch {
    return null;
  }
}

/** The signed-in login's hash, as it appears in its /img/ URLs; null when signed out. */
export async function ownUploadHash(): Promise<string | null> {
  const { CLOUD_LOGIN, CLOUD_TOKEN } = await getConfigMany(["CLOUD_LOGIN", "CLOUD_TOKEN"]);
  if (!CLOUD_LOGIN || !CLOUD_TOKEN) return null;
  return hashedLogin(CLOUD_LOGIN);
}

/**
 * Removes the slot's image from the worker. True when it is gone, including
 * when there was none (404). A worker without the route (405) or any other
 * failure leaves the image where it was: removal is best effort.
 */
export async function deleteProfileImage(slot: ImageSlot): Promise<boolean> {
  const { CLOUD_LOGIN, CLOUD_TOKEN } = await getConfigMany(["CLOUD_LOGIN", "CLOUD_TOKEN"]);
  if (!CLOUD_LOGIN || !CLOUD_TOKEN) return false;
  const res = await workerFetch(`/api/v1/private/images?slot=${slot}`, {
    method: "DELETE",
    auth: { login: CLOUD_LOGIN, token: CLOUD_TOKEN },
  });
  if (res.ok || res.status === 404) return true;
  if (res.status !== 405) console.warn(`[images] delete ${slot} failed (${res.status})`);
  return false;
}
