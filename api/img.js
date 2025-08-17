// /api/img.js
import { pipeline } from "node:stream";
import { promisify } from "node:util";
const pump = promisify(pipeline);

// Only proxy these hosts (safe!)
const ALLOWED_HOSTS = new Set([
  "pbs.twimg.com",
  "abs.twimg.com",
  "unavatar.io",
  "images.weserv.nl"
]);

export default async function handler(req, res) {
  try {
    // Support GET and HEAD (browsers/CDNs often send HEAD first)
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return res.status(405).send("Method Not Allowed");
    }

    const raw = req.query.u;
    if (!raw) return res.status(400).send("missing url");

    let url;
    try { url = new URL(raw); } catch { return res.status(400).send("invalid url"); }
    if (url.protocol !== "https:") return res.status(400).send("https only");
    if (!ALLOWED_HOSTS.has(url.hostname)) return res.status(400).send("host not allowed");

    // Normalize Unavatar -> force JPG + no gray fallback
    if (url.hostname === "unavatar.io") {
      // if path is /twitter/<handle> (no ext), append .jpg
      if (!/\.(jpg|jpeg|png|webp|avif)$/i.test(url.pathname)) {
        url.pathname += ".jpg";
      }
      // force "fallback=false" so we don't cache the gray placeholder
      if (!url.searchParams.has("fallback")) url.searchParams.set("fallback", "false");
    }

    // Fetch upstream (mirror method for HEAD/GET)
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    const upstream = await fetch(url.toString(), {
      method: req.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (AztecWall proxy)",
        "Accept": "image/avif,image/webp,image/apng,image/*;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
      cache: "no-store",
      signal: ac.signal,
    }).catch(() => null);
    clearTimeout(t);

    if (!upstream || !upstream.ok) {
      return res.status(upstream?.status || 502).send("upstream error");
    }

    // Mirror headers & strong edge cache
    const ct = upstream.headers.get("content-type") || "image/jpeg";
    const cl = upstream.headers.get("content-length");
    res.setHeader("Content-Type", ct);
    if (cl) res.setHeader("Content-Length", cl);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");

    // For HEAD, return headers only
    if (req.method === "HEAD") return res.status(200).end();

    // Stream body (no big buffering)
    res.statusCode = 200;
    if (!upstream.body) return res.end(); // safety
    await pump(upstream.body, res);
  } catch (e) {
    if (e?.name === "AbortError") return res.status(504).send("upstream timeout");
    res.status(500).send("proxy error");
  }
}