const PHOTO_ORIGIN = "https://7t6779x4.us-east.insforge.app";
const PHOTO_PATH = "/api/storage/buckets/photos/objects/";
const UUID = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";
const PHOTO_KEY = new RegExp(`^${UUID}(?:/|%2f)${UUID}\\.jpg$`, "i");
export const FIXTURE_PHOTO = "fixture:line-photo";

export function safePhotoUrl(raw: string | null): string | null {
  if (raw === FIXTURE_PHOTO) return raw;
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    return null;
  }
  if (url.origin !== PHOTO_ORIGIN || url.username || url.password || !url.pathname.startsWith(PHOTO_PATH)) {
    return null;
  }
  return PHOTO_KEY.test(url.pathname.slice(PHOTO_PATH.length)) ? url.href : null;
}
