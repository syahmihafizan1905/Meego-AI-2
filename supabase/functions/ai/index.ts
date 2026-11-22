// MEEGO AI — server function that talks to Claude for signed-in members.
// Deploy: Supabase → Edge Functions → Deploy new function "ai" (paste this file),
// then add the secret ANTHROPIC_API_KEY in Edge Functions → Secrets.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the function's secrets
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "30"); // per member per day (admins unlimited)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM =
  "You are MEEGO AI, a trading analysis assistant inside a market-signals app. " +
  "Follow the output format the request asks for exactly. Use only prices that appear in the request or image. " +
  "This is analysis, not financial advice; mention risk management where it helps.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ code: "invalid_request", error: "Use POST." }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: userData } = await asUser.auth.getUser();
  const user = userData?.user;
  if (!user) return json({ code: "session_expired", error: "Sign in again." }, 401);

  // plan check: admins always; members need an active plan
  const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const isAdmin = prof?.role === "owner" || prof?.role === "admin";
  if (!isAdmin) {
    const { data: mem } = await admin.from("members").select("data").eq("id", user.id).maybeSingle();
    const end = mem?.data?.end as string | undefined;
    const active = !!mem?.data?.tier && (!end || end >= new Date().toISOString().slice(0, 10));
    if (!active) return json({ code: "not_granted", error: "Your plan isn't active." }, 403);
    // daily limit
    const day = new Date().toISOString().slice(0, 10);
    const { data: use } = await admin.from("ai_usage").select("count").eq("user_id", user.id).eq("day", day).maybeSingle();
    if ((use?.count ?? 0) >= DAILY_LIMIT) return json({ code: "rate_limited", error: "Daily AI limit reached." }, 429);
    await admin.from("ai_usage").upsert({ user_id: user.id, day, count: (use?.count ?? 0) + 1 });
  }

  let body: { prompt?: string; image?: { media_type: string; data: string } | null };
  try { body = await req.json(); } catch { return json({ code: "invalid_request", error: "Bad JSON." }, 400); }
  const prompt = String(body.prompt ?? "").slice(0, 200_000);
  if (!prompt.trim()) return json({ code: "invalid_request", error: "Empty prompt." }, 400);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const img = body.image;
  if (img && img.data && ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(img.media_type)) {
    content.push({ type: "image", source: { type: "base64", media_type: img.media_type as "image/jpeg", data: img.data } });
  }
  content.push({ type: "text", text: prompt });

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal") {
      return json({ code: "refused", error: "The AI declined this request." }, 422);
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) return json({ code: "empty_completion", error: "No answer." }, 502);
    return json({ text, truncated: response.stop_reason === "max_tokens" });
  } catch (error) {
    console.error("AI call failed:", error);
    const msg = String((error as Error)?.message ?? error).slice(0, 200);
    if (error instanceof Anthropic.RateLimitError) return json({ code: "rate_limited", error: "AI is busy. Try again shortly." }, 429);
    if (error instanceof Anthropic.AuthenticationError) return json({ code: "upstream_error", error: "Anthropic API key is invalid" }, 500);
    if (error instanceof Anthropic.PermissionDeniedError) return json({ code: "upstream_error", error: "Anthropic key has no access to this model" }, 500);
    if (error instanceof Anthropic.NotFoundError) return json({ code: "upstream_error", error: "Model not found: " + msg }, 500);
    if (error instanceof Anthropic.BadRequestError) {
      return json({ code: "upstream_error", error: /credit/i.test(msg) ? "Anthropic credit balance is too low" : "Bad request: " + msg }, 400);
    }
    if (error instanceof Anthropic.APIError) return json({ code: "upstream_error", error: `Anthropic error ${error.status}: ${msg}` }, 502);
    return json({ code: "upstream_error", error: "Server error: " + msg }, 500);
  }
});
