/**
 * Shared base URL for every Tianzi service call.
 *
 * The `shsrc` marker lets the service tell where the traffic comes from.
 */

export const TIANZI_API_ORIGIN = "https://tianzi.hongbot.icu";

export function tianziUrl(path: string): URL {
  const url = new URL(path, TIANZI_API_ORIGIN);
  url.searchParams.set("shsrc", "ziblock");
  return url;
}
