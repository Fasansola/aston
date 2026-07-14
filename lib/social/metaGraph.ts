/**
 * lib/social/metaGraph.ts
 * Thin wrapper over the Meta Graph API (Facebook, Instagram) and the Threads
 * Graph API. All three are the same shape: versioned base URL, params either in
 * the query string (GET) or form body (POST), and an access token.
 *
 * NOTE: these targets require a reviewed Meta app plus (for FB/IG) a Business
 * account. Until the app's publishing permissions are granted, calls will fail
 * with a permissions error — the connector surfaces that verbatim.
 */

/** Bump when Meta deprecates a version. Overridable per call via env. */
export const FB_GRAPH_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v21.0"}`;
export const THREADS_GRAPH_BASE = `https://graph.threads.net/${process.env.THREADS_GRAPH_VERSION || "v1.0"}`;

export async function graphCall<T = Record<string, unknown>>(
  base: string,
  path: string,
  params: Record<string, string>,
  method: "GET" | "POST" = "GET"
): Promise<T> {
  const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
  const init: RequestInit = { method };

  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    init.body = new URLSearchParams(params);
  }

  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(data?.error?.message || `Graph API ${res.status} on ${path}`);
  }
  return data;
}
