// /api/submit.js
import { sb } from "./_supabase.js";

/* =========================
   Config
========================= */
const BANNED_PARTIALS = [
  // Adult content
  "porn", "pornhub", "xvideos", "sex", "xxx", "nude", "nsfw", "onlyfans", "adult", "milf", "teen", "sexy", "hot", "babe", "cam", "strip", "naked", "escort", "sugar", "daddy", "fetish",
  
  // Crypto/Scam
  "bitcoin", "btc", "crypto", "nft", "pump", "scam", "free", "win", "giveaway", "lottery", "airdrop", "moon", "lambo", "hodl", "diamond", "hands", "dump", "rugpull",
  
  // Spam/Bots
  "bot", "fake", "spam", "follow", "f4f", "like4like", "promo", "guru", "coach", "followback", "sub4sub", "promotion", "marketing", "advertise", "sponsor", "influencer",
  
  // Hate/Violence
  "nazi", "hitler", "terrorist", "kill", "murder", "suicide", "bomb", "weapon", "hate", "violence", "fight", "war", "destroy", "explode",
  
  // Drugs
  "drug", "weed", "cocaine", "dealer", "trap", "lean", "marijuana", "cannabis", "heroin", "meth", "crack", "pills", "xanax", "molly",
  
  // Political figures
  "elonmusk", "trump", "biden", "putin", "obama", "clinton", "musk", "bezos", "gates", "zuck", "modi", "xi", "kim",
  
  // Impersonation
  "official", "verified", "real", "ceo", "president", "celebrity", "check", "blue", "tick", "authentic", "genuine", "legit", "original", "founder"
].map(s => s.toLowerCase());

const DEFAULT_PFP = "/img/sentient-logo.jpeg";
const T1 = process.env.TWITTER_BEARER;            // your existing token
const T2 = process.env.TWITTER_BEARER_TOKEN_2;    // second token (optional)

/* =========================
   Helpers
========================= */
const startsWithAt = v => typeof v === "string" && v.trim().startsWith("@");
const clean = s => s?.trim().replace(/^@+/, "").toLowerCase() || "";

function isBannedPartial(handle) {
  // handle is already cleaned (no @, lowercase)
  return BANNED_PARTIALS.some(bad => handle.includes(bad));
}

async function fetchTwitterPfp(handle, bearer) {
  if (!bearer) return null;
  console.log(`Fetching PFP for ${handle} with a bearer token.`);
  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
    cache: "no-store",
  });

  if (!r.ok) {
    const errorText = await r.text();
    console.error(`Twitter API error for ${handle}: ${r.status}`, errorText);
    return null;
  }

  const j = await r.json();
  const base = j?.data?.profile_image_url;
  if (!base) {
    console.log(`Twitter API success, but no profile_image_url for ${handle}.`);
    return null;
  }

  // upgrade to 400x400 where possible
  console.log(`Successfully fetched PFP for ${handle} from Twitter.`);
  return base.replace("_normal.", "_400x400.").replace("_normal.", ".");
}

/* =========================
   Handler
========================= */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const raw = req.body?.handle;

    // 1) Require it to start with '@'
    if (!startsWithAt(raw)) {
      return res.status(400).json({ error: "Please enter your @handle (must start with @)" });
    }

    // 2) Normalize handle and ban partial matches
    const handle = clean(raw);
    if (!handle) return res.status(400).json({ error: "Invalid handle" });
    if (isBannedPartial(handle)) {
      return res.status(400).json({ error: "This handle is not allowed" });
    }

    // 3) Try Twitter API with T1, then T2
    let pfpUrl = await fetchTwitterPfp(handle, T1);
    if (!pfpUrl && T2) {
      pfpUrl = await fetchTwitterPfp(handle, T2);
    }

    // 4) Fallback: Unavatar (JSON) → direct URL
    if (!pfpUrl) {
      console.log(`Twitter fetch failed for ${handle}, trying Unavatar.`);
      try {
        const u = await fetch(
          `https://unavatar.io/twitter/${encodeURIComponent(handle)}?json`,
          { headers: { Accept: "application/json" }, cache: "no-store" }
        );
        if (u.ok) {
          const j = await u.json();
          if (j?.url && !j.url.includes('fallback.png')) {
            pfpUrl = j.url;
            console.log(`Successfully fetched PFP for ${handle} from Unavatar.`);
          } else {
            console.log(`Unavatar returned fallback image for ${handle}, skipping.`);
          }
        } else {
          console.error(`Unavatar error for ${handle}: ${u.status}`);
        }
      } catch (err) {
        console.error(`Unavatar fetch threw an error for ${handle}:`, err.message);
      }
    }

    // 5) Reject if no valid profile found
    if (!pfpUrl) {
      console.log(`No valid X profile found for ${handle}`);
      return res.status(400).json({ error: "X handle not found. Please enter a valid X username." });
    }

    // 6) Save to Supabase (keep columns exactly as before)
    const client = sb();
    const { data, error } = await client
      .from("profiles")
      .upsert(
        {
          handle,
          pfp_url: pfpUrl,
          twitter_url: `https://twitter.com/${handle}`,
          website: `https://twitter.com/${handle}`,
          last_refreshed: new Date().toISOString(),
        },
        { onConflict: "handle" }
      )
      .select()
      .single();

    if (error) throw error;

    return res.status(200).json({ ok: true, profile: data });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}