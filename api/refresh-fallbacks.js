// /api/refresh-fallbacks.js
import { sb } from "./_supabase.js";

/** ---- Config ---- */
const DEFAULT_SVG = "/img/sentient-logo.jpeg";
const SECRET = process.env.REFRESH_SECRET;

// Bearer tokens (add as many as you have; blank ones are ignored)
const TOKENS = [
  process.env.TWITTER_BEARER,             // T1 (existing)
  process.env.TWITTER_BEARER_TOKEN_2,     // T2
  process.env.TWITTER_BEARER_TOKEN_3,     // T3
  process.env.TWITTER_BEARER_TOKEN_4,     // T4
  process.env.TWITTER_BEARER_TOKEN_5,     // T5
].filter(Boolean);

/** Decide if a stored URL needs refreshing */
function looksLikeFallback(u = "") {
  if (!u) return true;                               // empty -> refresh
  try {
    if (u.includes("/img/default-pfp.svg")) return true;

    const url = new URL(u, "https://dummy.base");   // support relative /api/img?u=...
    const host = url.hostname;

    // raw Unavatar
    if (host === "unavatar.io") return true;

    // our proxy /api/img?u=...unavatar...
    if (host.endsWith("vercel.app") && url.pathname.startsWith("/api/img")) {
      const inner = decodeURIComponent(url.searchParams.get("u") || "");
      if (inner.includes("unavatar.io/twitter/")) return true;
      if (inner.includes("/img/default-pfp.svg")) return true;
    }

    // Weserv wrapper
    if (host === "images.weserv.nl") {
      const inner = decodeURIComponent(url.searchParams.get("url") || "");
      const deflt = decodeURIComponent(url.searchParams.get("default") || "");
      if (inner.includes("unavatar.io/twitter/")) return true;
      if (deflt.includes("/img/default-pfp.svg")) return true;
    }

    // otherwise treat as good (e.g., pbs.twimg.com)
    return false;
  } catch {
    return true; // malformed -> try to fix
  }
}

/** Call Twitter API v2 with a specific bearer */
async function fetchTwitterPfpDirect(handle, bearer) {
  if (!bearer) return { ok: false, status: 401, error: "missing bearer" };
  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
    cache: "no-store",
  });

  if (!r.ok) return { ok: false, status: r.status, error: `twitter ${r.status}` };

  const j = await r.json();
  const base = j?.data?.profile_image_url;
  if (!base) return { ok: false, status: 404, error: "no profile_image_url" };

  // upgrade to higher-res
  const hi = base.replace("_normal.", "_400x400.").replace("_normal.", ".");
  return { ok: true, url: hi };
}

/** Try all tokens in order until one works */
async function fetchTwitterPfpMulti(handle) {
  for (let i = 0; i < TOKENS.length; i++) {
    const r = await fetchTwitterPfpDirect(handle, TOKENS[i]);
    if (r.ok) return { ...r, tokenIndex: i + 1 }; // 1-based index
  }
  return { ok: false, status: 429, error: "all tokens failed" };
}

export default async function handler(req, res) {
  const methodOK = req.method === "POST" || req.method === "GET";
  if (!methodOK) return res.status(405).json({ error: "Use GET or POST" });

  if (!SECRET) return res.status(500).json({ error: "REFRESH_SECRET not set" });
  const provided = req.query.secret || req.headers["x-refresh-secret"];
  if (provided !== SECRET) return res.status(401).json({ error: "Unauthorized" });

  if (!TOKENS.length) {
    return res.status(500).json({ error: "No TWITTER_BEARER tokens configured" });
  }

  try {
    const client = sb();
    const { data: rows, error } = await client
      .from("profiles")
      .select("id, handle, pfp_url");

    if (error) throw error;

    let scanned = 0, refreshed = 0, kept = 0, errors = 0;
    const tokenUsage = Array(TOKENS.length).fill(0);
    const refreshedHandles = [];

    for (const row of rows || []) {
      scanned++;
      const handle = (row?.handle || "").trim().toLowerCase();
      const current = row?.pfp_url || "";
      if (!handle) { kept++; continue; }

      // Only refresh obvious fallbacks
      if (!looksLikeFallback(current)) { kept++; continue; }

      // Try Twitter (multi-token)
      const tw = await fetchTwitterPfpMulti(handle);
      if (!tw.ok) { kept++; continue; }

      const { error: upErr } = await client
        .from("profiles")
        .update({
          pfp_url: tw.url,
          last_refreshed: new Date().toISOString(),
        })
        .eq("handle", handle);

      if (upErr) {
        errors++;
      } else {
        refreshed++;
        refreshedHandles.push(handle);
        if (tw.tokenIndex) tokenUsage[tw.tokenIndex - 1]++;
      }

      // gentle delay (tune as needed)
      await new Promise(r => setTimeout(r, 120));
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      scanned,
      refreshed,
      kept,
      errors,
      tokenUsage,          // e.g. [3,1,0,0,0]
      refreshedHandles,    // which handles were improved
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "server error" });
  }
}