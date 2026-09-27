/** Normalize supported YouTube video links to a player path without tracking parameters. */
export function youtubePlayerPath(link: string | null): string | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const hostname = url.hostname.replace(/^www\./, "");
  let id: string | null = null;
  if (hostname === "youtu.be") {
    id = url.pathname.slice(1);
  } else if (hostname === "youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = /^\/(?:embed|shorts)\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const time = url.searchParams.get("start") ?? url.searchParams.get("t");
  const match = time?.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  const start = match
    ? Number(match[1] ?? 0) * 3600 +
      Number(match[2] ?? 0) * 60 +
      Number(match[3] ?? 0)
    : 0;
  return start > 0 && start <= 4_294_967_295
    ? `${id}?start=${start}`
    : id;
}
