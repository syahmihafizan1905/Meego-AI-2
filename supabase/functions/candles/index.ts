// MEEGO AI — market candles from Twelve Data, cached in the database so many
// members share a few API calls. Deploy as Edge Function "candles" and add the
// secret TWELVEDATA_API_KEY. Free plan: 8 calls/min, 800/day.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// how long a cached answer is reused, per interval (seconds)
const TTL: Record<string, number> = { "1min": 180, "15min": 300, "1h": 900 };
const SIZE: Record<string, number> = { "1min": 400, "15min": 500, "1h": 2000 };

function toProvider(sym: string): string | null {
  const s = sym.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const special: Record<string, string> = { US30: "DJI", NAS100: "NDX", SPX500: "SPX", US500: "SPX" };
  if (special[s]) return special[s];
  if (/^[A-Z]{6}$/.test(s)) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const u = new URL(req.url);
  const symbol = u.searchParams.get("symbol") ?? "";
  const interval = u.searchParams.get("interval") ?? "15min";
  const prov = toProvider(symbol);
  if (!prov || (!TTL[interval] && interval !== "price")) return json({ error: "Unknown symbol or interval." }, 400);
  // the current price (candles are only complete ones, 1-2 minutes late). Server only, so nobody else can use up the daily calls
  if (interval === "price") {
    if (req.headers.get("Authorization") !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) return json({ error: "Not allowed." }, 403);
    const apiKey = Deno.env.get("TWELVEDATA_API_KEY");
    if (!apiKey) return json({ error: "Server price key is missing." }, 500);
    try {
      const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(prov)}&apikey=${apiKey}`);
      const j = await r.json(), price = Number(j.price);
      return Number.isFinite(price) && price > 0 ? json({ price, at: Date.now() }) : json({ error: "No price." }, 502);
    } catch {
      return json({ error: "Couldn't reach the price provider." }, 502);
    }
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const key = `${prov}|${interval}`;
  const { data: cached } = await db.from("price_cache").select("data, fetched_at").eq("key", key).maybeSingle();
  const age = cached ? (Date.now() - new Date(cached.fetched_at).getTime()) / 1000 : Infinity;
  if (cached && age < TTL[interval]) return json({ ...cached.data, cached: true });

  const apiKey = Deno.env.get("TWELVEDATA_API_KEY");
  if (!apiKey) return json({ error: "Server price key is missing." }, 500);
  const api = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(prov)}&interval=${interval}&outputsize=${SIZE[interval]}&timezone=UTC&apikey=${apiKey}`;
  try {
    const r = await fetch(api);
    const j = await r.json();
    if (j.status !== "ok" || !Array.isArray(j.values)) {
      // provider limit or unknown symbol: serve the last good copy if we have one
      if (cached) return json({ ...cached.data, cached: true, stale: true });
      const limited = String(j.message ?? "").toLowerCase().includes("limit") || j.code === 429;
      return json({ error: limited ? "Price provider limit reached. Try again in a minute." : (j.message ?? "No data.") }, limited ? 429 : 404);
    }
    const candles = j.values
      .map((v: Record<string, string>) => ({ t: Date.parse(v.datetime.replace(" ", "T") + "Z"), o: +v.open, h: +v.high, l: +v.low, c: +v.close }))
      .filter((c: { o: number; h: number; l: number; c: number }) => [c.o, c.h, c.l, c.c].every(Number.isFinite))
      .reverse(); // oldest first
    const payload = { symbol: symbol.toUpperCase(), interval, candles, at: Date.now() };
    await db.from("price_cache").upsert({ key, data: payload, fetched_at: new Date().toISOString() });
    return json(payload);
  } catch {
    if (cached) return json({ ...cached.data, cached: true, stale: true });
    return json({ error: "Couldn't reach the price provider." }, 502);
  }
});
