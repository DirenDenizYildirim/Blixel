// Where a mod's files are served: the core's `mod` URI scheme, one folder per
// mod id. WebKit (Linux, macOS) loads custom schemes as written; WebView2 on
// Windows reaches them as http://<scheme>.localhost instead.

const onWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** The URL of a file in a mod's folder, e.g. modUrl("a.b", "view.html"). */
export function modUrl(id: string, path: string): string {
  const base = onWindows ? "http://mod.localhost" : "mod://localhost";
  const rel = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/${encodeURIComponent(id)}/${rel}`;
}

/** A new random key for one frame: 32 hex digits. */
export function frameKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A frame's address with its key after "#k=". Only the page loaded there can
 * read it (the fragment is never sent with the request), and it must send the
 * key back before the app reads anything else on its port (frame/logic.js
 * and frame/view.js do).
 */
export function withKey(url: string, key: string): string {
  return `${url}#k=${key}`;
}
