const PHOTO_ORIGIN = "https://7t6779x4.us-east.insforge.app";
const PHOTO_PATH = "/api/storage/buckets/photos/objects/";
export const FIXTURE_PHOTO = "fixture:line-photo";

export function safePhotoUrl(raw: string | null): string | null {
  if (raw === FIXTURE_PHOTO) return raw;
  const url = raw ? URL.parse(raw) : null;
  if (!url || url.origin !== PHOTO_ORIGIN || url.username || url.password) return null;
  return url.pathname.startsWith(PHOTO_PATH) && url.pathname.length > PHOTO_PATH.length ? url.href : null;
}
