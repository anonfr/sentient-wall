// /api/twitter-pfp.js
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const token = process.env.TWITTER_BEARER;
    if (!token) return res.status(500).json({ error: "TWITTER_BEARER not set" });

    const raw = (req.query.u || "").toString().trim();
    const handle = raw.replace(/^@+/, "");

    // Validate: X usernames are 1–15 chars, letters/numbers/underscore
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      return res.status(400).json({ error: "Invalid handle" });
    }

    // Try x.com first, then twitter.com as a fallback (some environments differ)
    const apiVariants = [
      `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url`,
      `https://api.twitter.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url`,
    ];

    // Small timeout so we don’t hang your function
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);

    let r, data;
    for (const url of apiVariants) {
      r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "AztecWall/1.0",
          Accept: "application/json",
        },
        cache: "no-store",
        signal: ac.signal,
      }).catch((e) => ({ ok: false, status: 502, _err: e }));

      if (r?.ok) {
        data = await r.json();
        break;
      }
      // If it’s a client/server error that isn’t networky, try next variant only for 404/5xx.
      if (r && r.status < 500 && r.status !== 404) break;
    }
    clearTimeout(t);

    if (!r?.ok) {
      // Surface rate limit nicely
      if (r?.status === 429) {
        const ra = r.headers?.get?.("retry-after") || "60";
        return res.status(429).json({ error: "Rate limited by X API", retryAfter: ra });
      }
      return res.status(r?.status || 502).json({ error: `Upstream ${r?.status || 502}` });
    }

    const base = data?.data?.profile_image_url;
    if (!base) return res.status(404).json({ error: "No profile_image_url" });

    // Upgrade to hi‑res robustly:
    // 1) Old-style: ..._normal.jpg → ..._400x400.jpg
    // 2) New-style query param: ?format=jpg&name=normal → name=400x400
    let hi = base;
    if (/_normal(\.\w+)$/.test(hi)) {
      hi = hi.replace(/_normal(\.\w+)$/, "_400x400$1");
    } else if (/(?:\?|&)name=normal\b/.test(hi)) {
      hi = hi.replace(/name=normal\b/, "name=400x400");
    } else if (!/(?:\?|&)name=/.test(hi) && /pbs\.twimg\.com/.test(hi)) {
      // If it's a twimg URL without name=, append a safe size param
      const sep = hi.includes("?") ? "&" : "?";
      hi = `${hi}${sep}name=400x400`;
    }

    // Cache at the edge; your client will proxy it via /api/img (recommended)
    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    return res.status(200).json({
      handle,
      url: hi,
      raw: base,
      user_id: data?.data?.id || null,
    });
  } catch (e) {
    // AbortError => timeout
    if (e?.name === "AbortError") {
      return res.status(504).json({ error: "X API timeout" });
    }
    return res.status(500).json({ error: e.message || "Server error" });
  }
}