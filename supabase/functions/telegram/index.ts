// MEEGO AI Telegram bot (Supabase Edge Function "telegram").
// Secrets needed: TELEGRAM_BOT_TOKEN (from @BotFather) and ANTHROPIC_API_KEY (already set for the website).
// Turn OFF "Verify JWT" for this function: Telegram calls it directly; it checks its own secret instead.
// After deploying, open this function's URL once in a browser to connect the bot to Telegram.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL");
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const db = createClient(SB_URL, SB_SERVICE);
const SITE = Deno.env.get("SITE_URL") ?? "https://syahmihafizan1905.github.io/Meego-AI-2/";
const MODEL = Deno.env.get("AI_MODEL") ?? "claude-opus-5-5";
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "30");
const CANDLES_FN = Deno.env.get("CANDLES_FUNCTION") ?? "swift-task";
const anthropic = new Anthropic();
const DISCLAIMER = "<i>Analysis tool, not financial advice. Always use a stop loss.</i>";

/* ---------- helpers ---------- */
const today = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => ({ ok: false }));
}
const MENU = { keyboard: [[{ text: "📈 Signal" }, { text: "⭐ Swing" }], [{ text: "🧭 Direction" }, { text: "📊 History" }], [{ text: "👤 My plan" }, { text: "❓ Help" }]], resize_keyboard: true };
const send = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: MENU, ...extra });
async function settings() {
  const { data } = await db.from("app_settings").select("key,value");
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}
function pip(sym) {
  const s = String(sym).toUpperCase();
  if (s.startsWith("XAU")) return 0.1;
  if (s.startsWith("XAG")) return 0.01;
  if (/BTC|ETH|US30|NAS|SPX|US500/.test(s)) return 1;
  if (s.endsWith("JPY")) return 0.01;
  return 0.0001;
}
function digits(sym) {
  const s = String(sym).toUpperCase();
  if (s.startsWith("XAU")) return 2;
  if (s.startsWith("XAG")) return 3;
  if (/BTC|ETH|US30|NAS|SPX|US500/.test(s)) return 1;
  if (s.endsWith("JPY")) return 3;
  return 5;
}
const px = (v, sym) => Number(v).toFixed(digits(sym));
const pipsBetween = (a, b, sym) => Math.round(Math.abs(a - b) / pip(sym));

/* ---------- who is this chat? ---------- */
async function account(chatId) {
  const { data: t } = await db.from("telegram_users").select("user_id").eq("chat_id", chatId).maybeSingle();
  if (!t || !t.user_id) return { linked: false };
  const { data: p } = await db.from("profiles").select("role,email,name").eq("id", t.user_id).maybeSingle();
  const admin = p?.role === "owner" || p?.role === "admin";
  const { data: m } = await db.from("members").select("data").eq("id", t.user_id).maybeSingle();
  const end = m?.data?.end || null;
  const tier = m?.data?.tier && (!end || end >= today()) ? m.data.tier : null;
  return { linked: true, userId: t.user_id, admin, tier, end, rawTier: m?.data?.tier || null, name: p?.name || p?.email || "" };
}
const canSee = (a, kind) => a.admin || (!!a.tier && (kind !== "Swing" || a.tier === "Ultimate"));
const linkHelp = () => `To get MEEGO signals here, connect your account:\n1. Open <a href="${SITE}">MEEGO AI</a> and sign in\n2. Tap <b>Telegram</b> at the top\n3. Tap <b>Connect Telegram</b>`;

/* ---------- signal text ---------- */
function signalText(s, title) {
  const side = s.dir > 0 ? "🟢 <b>BUY</b>" : "🔴 <b>SELL</b>";
  const lines = [
    `<b>${esc(title)}</b>`,
    `${side} <b>${esc(s.sym)}</b>`,
    "",
    `Entry: <code>${px(s.entry, s.sym)}</code>`,
    `TP: <code>${px(s.tp, s.sym)}</code>`,
    `SL: <code>${px(s.sl, s.sym)}</code>`,
    `Target ${pipsBetween(s.tp, s.entry, s.sym)} pips · Risk ${pipsBetween(s.entry, s.sl, s.sym)} pips`,
  ];
  if (s.note) lines.push("", `📝 ${esc(s.note)}`);
  lines.push("", DISCLAIMER);
  return lines.join("\n");
}
async function signalsOf(kind) {
  const { data } = await db.from("signals").select("id,data").order("updated_at", { ascending: false }).limit(200);
  return (data ?? []).map((r) => ({ id: r.id, ...r.data })).filter((s) => s && s.kind === kind && s.sym);
}

/* ---------- commands ---------- */
async function cmdSignal(chatId, a, kind) {
  if (!a.linked) return send(chatId, linkHelp());
  if (!canSee(a, kind)) {
    return send(chatId, kind === "Swing" ? "⭐ Priority Swing is for the <b>Ultimate</b> plan. Contact the admin to upgrade." : "Your plan isn't active. Contact the admin to activate or renew it.");
  }
  const list = (await signalsOf(kind)).filter((s) => s.status === "running").sort((x, y) => y.time - x.time);
  if (!list.length) return send(chatId, kind === "Swing" ? "No Priority Swing right now. It's posted only when a high-quality setup appears." : "No intraday signal running right now. You'll get a message here when one is posted.");
  for (const s of list.slice(0, 3)) await send(chatId, signalText(s, kind === "Swing" ? "⭐ PRIORITY SIGNAL SWING" : "📈 DAILY SIGNAL INTRADAY"));
}
async function cmdHistory(chatId, a) {
  if (!a.linked) return send(chatId, linkHelp());
  const from = new Date(); from.setUTCDate(1); from.setUTCMonth(from.getUTCMonth() - 1);
  const kinds = canSee(a, "Swing") ? ["Swing", "Intraday"] : ["Intraday"];
  const all = [];
  for (const k of kinds) all.push(...(await signalsOf(k)));
  const closed = all.filter((s) => s.time >= from.getTime() && (s.status === "tp" || s.status === "sl")).sort((x, y) => y.time - x.time);
  if (!closed.length) return send(chatId, "No closed signals in the last two months yet.");
  const tp = closed.filter((s) => s.status === "tp").length;
  let net = 0;
  const rows = closed.slice(0, 10).map((s) => {
    const p = s.status === "tp" ? pipsBetween(s.tp, s.entry, s.sym) : -pipsBetween(s.entry, s.sl, s.sym);
    return `${s.status === "tp" ? "✅" : "❌"} ${new Date(s.time).toISOString().slice(5, 10)} ${s.dir > 0 ? "BUY" : "SELL"} ${esc(s.sym)} <b>${p > 0 ? "+" : ""}${p}</b> pips`;
  });
  for (const s of closed) net += s.status === "tp" ? pipsBetween(s.tp, s.entry, s.sym) : -pipsBetween(s.entry, s.sl, s.sym);
  return send(chatId, `📊 <b>Signal history</b> (this month and last)\n\nHit TP: <b>${tp}</b> · Win rate: <b>${Math.round((tp / closed.length) * 100)}%</b> · Net: <b>${net > 0 ? "+" : ""}${net} pips</b>\n\n${rows.join("\n")}`);
}
async function cmdPlan(chatId, a) {
  if (!a.linked) return send(chatId, linkHelp());
  if (a.admin) return send(chatId, `👤 ${esc(a.name)}\nRole: <b>ADMIN</b> (all signals, admin commands). Send /admin for the admin commands.`);
  if (!a.rawTier) return send(chatId, `👤 ${esc(a.name)}\nPlan: <b>none yet</b>. Contact the admin to activate a plan.`);
  return send(chatId, `👤 ${esc(a.name)}\nPlan: <b>${esc(a.rawTier)}</b>${a.end ? `\nEnds: <b>${esc(a.end)}</b>` : ""}${a.tier ? "" : "\n⚠️ This plan has ended. Contact the admin to renew."}`);
}

/* direction from H1 + H4 EMA trend */
function ema(arr, n) { const k = 2 / (n + 1); let e = arr[0]; return arr.map((v, i) => (e = i ? v * k + e * (1 - k) : v)); }
function trend(closes) {
  const e20 = ema(closes, 20), e50 = ema(closes, 50), n = closes.length - 1;
  let sc = 0;
  sc += closes[n] > e50[n] ? 1 : -1;
  sc += e20[n] > e50[n] ? 1 : -1;
  sc += e20[n] > e20[Math.max(0, n - 5)] ? 1 : -1;
  return sc;
}
async function candles(sym) {
  const r = await fetch(`${SB_URL}/functions/v1/${CANDLES_FN}?symbol=${sym}&interval=1h`, { headers: { Authorization: `Bearer ${SB_SERVICE}`, apikey: SB_SERVICE } });
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j.candles) ? j.candles : [];
}
async function cmdDirection(chatId, a) {
  if (!a.linked) return send(chatId, linkHelp());
  if (!a.admin && !a.tier) return send(chatId, "Your plan isn't active. Contact the admin to activate or renew it.");
  const pairs = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"];
  const out = [];
  for (const p of pairs) {
    const c = await candles(p);
    if (c.length < 120) { out.push(`${p}: no data`); continue; }
    const h1 = c.map((x) => x.c);
    const h4 = [];
    for (let i = c.length % 4; i < c.length; i += 4) h4.push(c[Math.min(i + 3, c.length - 1)].c);
    const sum = trend(h1) + trend(h4);
    const dir = sum >= 4 ? "🟢 BUY" : sum <= -4 ? "🔴 SELL" : "⚪ WAIT";
    out.push(`<b>${p}</b> ${dir} · <code>${px(h1[h1.length - 1], p)}</code>`);
  }
  return send(chatId, `🧭 <b>Direction today</b> (H1 + H4 trend)\n\n${out.join("\n")}\n\n${DISCLAIMER}`);
}

/* ---------- AI chart scan from a photo ---------- */
function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function parseJSON(t) {
  t = String(t).trim();
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { /* fall through */ } }
  return null;
}
async function scanPhoto(chatId, a, msg) {
  if (!a.linked) return send(chatId, linkHelp());
  if (!a.admin && !a.tier) return send(chatId, "Chart scans need an active plan. Contact the admin to activate it.");
  if (!a.admin) {
    const { data: use } = await db.from("ai_usage").select("count").eq("user_id", a.userId).eq("day", today()).maybeSingle();
    if ((use?.count ?? 0) >= DAILY_LIMIT) return send(chatId, `You've used today's ${DAILY_LIMIT} AI scans. Try again tomorrow.`);
    await db.from("ai_usage").upsert({ user_id: a.userId, day: today(), count: (use?.count ?? 0) + 1 });
  }
  const pairHint = (String(msg.caption ?? "").toUpperCase().match(/[A-Z]{6}|US30|NAS100/) ?? [""])[0];
  await send(chatId, "🔍 Reading your chart… this takes about 20–60 seconds.");
  const photo = msg.photo[msg.photo.length - 1];
  const f = await tg("getFile", { file_id: photo.file_id });
  if (!f.ok) return send(chatId, "Couldn't download that image. Try sending it again.");
  const img = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`)).arrayBuffer());
  const prompt = `You are a professional price-action trader. The image is a trading chart screenshot${pairHint ? ` of ${pairHint}` : ""}.
Read the price axis carefully to get real price levels. Identify the pair and timeframe if visible, the trend, structure, key support and resistance, and momentum.
Give ONE trade idea only if risk-to-reward is at least 1.5, otherwise direction "WAIT".
Reply with ONLY one JSON object:
{"pair":"text or null","direction":"BUY|SELL|WAIT","confidence":0-100,"timeframe":"text or null","entry":number|null,"sl":number|null,"tp":number|null,"reason":"2-4 sentences in English","invalidation":"text"}
If the image is not a price chart, reply {"pair":null,"direction":"WAIT","confidence":0,"timeframe":null,"entry":null,"sl":null,"tp":null,"reason":"This doesn't look like a price chart.","invalidation":""}`;
  const content = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: toBase64(img) } },
    { type: "text", text: prompt },
  ];
  let text = "";
  try {
    const opusLike = /^claude-(opus-5|fable|sonnet-5-5)/.test(MODEL);
    const res = opusLike
      ? await anthropic.beta.messages.create({ model: MODEL, max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "medium" }, messages: [{ role: "user", content }] })
      : await anthropic.messages.create({ model: MODEL, max_tokens: 16000, messages: [{ role: "user", content }] });
    if (res.stop_reason === "refusal") return send(chatId, "The AI declined to analyse this image. Try a different chart.");
    text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  } catch (e) {
    console.error("AI scan failed:", e);
    if (e instanceof Anthropic.AuthenticationError) return send(chatId, a.admin ? "⚠️ AI setup issue: the Anthropic API key is invalid. Replace ANTHROPIC_API_KEY in Supabase → Edge Functions → Secrets." : "AI is temporarily unavailable. Please try again later.");
    if (e instanceof Anthropic.BadRequestError && /credit/i.test(String(e.message))) return send(chatId, a.admin ? "⚠️ AI setup issue: Anthropic credit balance is too low. Add credit at console.anthropic.com → Billing." : "AI is temporarily unavailable. Please try again later.");
    if (e instanceof Anthropic.RateLimitError) return send(chatId, "AI is busy right now. Try again in a minute.");
    return send(chatId, "AI couldn't read the chart this time. Please try again.");
  }
  const r = parseJSON(text);
  if (!r) return send(chatId, "AI couldn't read the chart this time. Please try again.");
  const d = String(r.direction || "WAIT").toUpperCase();
  const sym = String(r.pair || pairHint || "PAIR").toUpperCase().replace(/[^A-Z0-9]/g, "") || "PAIR";
  const ok = (d === "BUY" || d === "SELL") && [r.entry, r.sl, r.tp].every((v) => Number.isFinite(Number(v))) &&
    (d === "BUY" ? r.tp > r.entry && r.sl < r.entry : r.tp < r.entry && r.sl > r.entry);
  const lines = [`🤖 <b>AI CHART SCAN</b>${r.timeframe ? ` · ${esc(r.timeframe)}` : ""}`];
  if (ok) {
    const rr = Math.abs(r.tp - r.entry) / Math.abs(r.entry - r.sl);
    lines.push(`${d === "BUY" ? "🟢" : "🔴"} <b>${d} ${esc(sym)}</b> · confidence ${Math.round(Number(r.confidence) || 0)}%`, "",
      `Entry: <code>${px(r.entry, sym)}</code>`, `TP: <code>${px(r.tp, sym)}</code>`, `SL: <code>${px(r.sl, sym)}</code>`, `Risk-to-reward 1:${rr.toFixed(2)}`);
  } else {
    lines.push(`⚪ <b>WAIT</b>${sym !== "PAIR" ? ` ${esc(sym)}` : ""} · no clean setup right now`);
  }
  if (r.reason) lines.push("", esc(r.reason));
  if (r.invalidation) lines.push(`Invalid if: ${esc(r.invalidation)}`);
  lines.push("", DISCLAIMER);
  return send(chatId, lines.join("\n"));
}

/* ---------- admin commands ---------- */
async function cmdAdmin(chatId, a, text) {
  if (!a.admin) return send(chatId, "This command is for the admin only.");
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.*/, "");
  if (cmd === "/admin") {
    return send(chatId, [
      "<b>Admin commands</b>",
      "<code>/post BUY XAUUSD 4040 4080 3990</code> intraday signal (entry, TP, SL)",
      "<code>/post SELL XAUUSD 4129 4119 4140 swing Sell area, wait for price</code> swing signal with a note",
      "<code>/close tp</code> · <code>/close sl</code> · <code>/close be</code> closes the latest running signal (add a pair to choose, e.g. <code>/close tp XAUUSD</code>)",
      "<code>/announce Your message</code> sends to every active member here and in the Mailbox",
      "<code>/members</code> shows how many people are connected",
    ].join("\n"));
  }
  if (cmd === "/post") {
    const side = (parts[1] || "").toUpperCase(), sym = (parts[2] || "").toUpperCase();
    const entry = Number(parts[3]), tp = Number(parts[4]), sl = Number(parts[5]);
    const swing = (parts[6] || "").toLowerCase() === "swing";
    const note = parts.slice(swing ? 7 : 6).join(" ");
    const dir = side === "BUY" ? 1 : side === "SELL" ? -1 : 0;
    if (!dir || !/^[A-Z0-9]{3,10}$/.test(sym) || ![entry, tp, sl].every(Number.isFinite)) return send(chatId, "Format: <code>/post BUY XAUUSD entry tp sl [swing] [note]</code>");
    if (dir > 0 ? !(tp > entry && sl < entry) : !(tp < entry && sl > entry)) return send(chatId, dir > 0 ? "For BUY, TP must be above entry and SL below it." : "For SELL, TP must be below entry and SL above it.");
    const { error } = await db.from("signals").insert({ id: crypto.randomUUID(), data: { kind: swing ? "Swing" : "Intraday", sym, dir, entry, tp, sl, note, status: "running", time: Date.now(), closedAt: null } });
    return send(chatId, error ? "Couldn't save the signal: " + esc(error.message) : "✅ Signal posted. Members are being notified.");
  }
  if (cmd === "/close") {
    const st = (parts[1] || "").toLowerCase(), sym = (parts[2] || "").toUpperCase();
    if (!["tp", "sl", "be"].includes(st)) return send(chatId, "Format: <code>/close tp</code>, <code>/close sl</code> or <code>/close be</code> (optionally add the pair)");
    const { data } = await db.from("signals").select("id,data").order("updated_at", { ascending: false }).limit(200);
    const row = (data ?? []).filter((r) => r.data?.status === "running" && (!sym || r.data.sym === sym)).sort((x, y) => y.data.time - x.data.time)[0];
    if (!row) return send(chatId, "No running signal found" + (sym ? " for " + esc(sym) : "") + ".");
    const { error } = await db.from("signals").update({ data: { ...row.data, status: st, closedAt: Date.now() }, updated_at: new Date().toISOString() }).eq("id", row.id);
    return send(chatId, error ? "Couldn't update: " + esc(error.message) : `✅ ${esc(row.data.sym)} marked ${st.toUpperCase()}. Members are being notified.`);
  }
  if (cmd === "/announce") {
    const body = text.replace(/^\/announce(@\S+)?\s*/i, "").trim();
    if (!body) return send(chatId, "Format: <code>/announce Your message</code>");
    const { error } = await db.from("mail").insert({ id: crypto.randomUUID(), data: { title: "Announcement", body, time: Date.now() } });
    return send(chatId, error ? "Couldn't send: " + esc(error.message) : "✅ Announcement sent.");
  }
  if (cmd === "/members") {
    const { count: total } = await db.from("telegram_users").select("chat_id", { count: "exact", head: true });
    const { count: linked } = await db.from("telegram_users").select("chat_id", { count: "exact", head: true }).not("user_id", "is", null);
    return send(chatId, `👥 Telegram: <b>${total ?? 0}</b> people started the bot, <b>${linked ?? 0}</b> linked to a MEEGO account.`);
  }
  return send(chatId, "Unknown admin command. Send /admin for the list.");
}

/* ---------- broadcasts (called by the database) ---------- */
async function audience(kind) {
  const { data: rows } = await db.from("telegram_users").select("chat_id,user_id").not("user_id", "is", null);
  const out = [];
  for (const r of rows ?? []) {
    const { data: p } = await db.from("profiles").select("role").eq("id", r.user_id).maybeSingle();
    const admin = p?.role === "owner" || p?.role === "admin";
    const { data: m } = await db.from("members").select("data").eq("id", r.user_id).maybeSingle();
    const end = m?.data?.end;
    const tier = m?.data?.tier && (!end || end >= today()) ? m.data.tier : null;
    if (admin || (tier && (kind !== "Swing" || tier === "Ultimate"))) out.push(r.chat_id);
  }
  return out;
}
async function broadcast(chats, text) {
  for (const c of chats) { await send(c, text); await new Promise((r) => setTimeout(r, 60)); }
}
async function onDbEvent(ev) {
  if (ev.event === "signals") {
    const s = ev.record?.data, old = ev.old?.data;
    if (!s || !s.sym) return;
    const chats = await audience(s.kind);
    if (ev.op === "INSERT" && s.status === "running") {
      return broadcast(chats, signalText(s, s.kind === "Swing" ? "📢 NEW PRIORITY SIGNAL SWING" : "📢 NEW DAILY SIGNAL INTRADAY"));
    }
    if (ev.op === "UPDATE" && old && old.status !== s.status && ["tp", "sl", "be"].includes(s.status)) {
      const p = s.status === "tp" ? pipsBetween(s.tp, s.entry, s.sym) : s.status === "sl" ? -pipsBetween(s.entry, s.sl, s.sym) : 0;
      const head = s.status === "tp" ? "✅ <b>HIT TP</b>" : s.status === "sl" ? "❌ <b>HIT SL</b>" : "➖ <b>BREAKEVEN</b>";
      return broadcast(chats, `${head} · ${s.dir > 0 ? "BUY" : "SELL"} <b>${esc(s.sym)}</b>\n${s.kind === "Swing" ? "Priority Swing" : "Daily Intraday"} · <b>${p > 0 ? "+" : ""}${p} pips</b>`);
    }
    return;
  }
  if (ev.event === "mail" && ev.op === "INSERT") {
    const m = ev.record?.data;
    if (!m) return;
    return broadcast(await audience("Intraday"), `✉️ <b>${esc(m.title || "Announcement")}</b>\n\n${esc(m.body || "")}`);
  }
  if (ev.event === "daily") {
    const { data: rows } = await db.from("telegram_users").select("chat_id,user_id").not("user_id", "is", null);
    const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    for (const r of rows ?? []) {
      const { data: m } = await db.from("members").select("data").eq("id", r.user_id).maybeSingle();
      const end = m?.data?.end;
      if (!m?.data?.tier || !end) continue;
      if (end === soon) await send(r.chat_id, `⏰ Your <b>${esc(m.data.tier)}</b> plan ends on <b>${esc(end)}</b>. Contact the admin to renew and keep receiving signals.`);
      if (end === new Date(Date.now() - 864e5).toISOString().slice(0, 10)) await send(r.chat_id, `Your <b>${esc(m.data.tier)}</b> plan has ended. Contact the admin to renew.`);
    }
  }
}

/* ---------- Telegram updates ---------- */
async function onMessage(msg) {
  const chatId = msg.chat?.id;
  if (!chatId || msg.chat.type !== "private") return;
  const text = String(msg.text ?? "").trim();
  await db.from("telegram_users").upsert({ chat_id: chatId, username: msg.from?.username ?? null, first_name: msg.from?.first_name ?? null }, { onConflict: "chat_id", ignoreDuplicates: false });

  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (code) {
      const { data: c } = await db.from("telegram_codes").select("user_id,created_at").eq("code", code).maybeSingle();
      if (!c || Date.now() - new Date(c.created_at).getTime() > 30 * 60e3) return send(chatId, "That link has expired. On the website, tap <b>Telegram → Connect Telegram</b> again.");
      await db.from("telegram_users").update({ user_id: null }).eq("user_id", c.user_id).neq("chat_id", chatId);
      await db.from("telegram_users").update({ user_id: c.user_id, linked_at: new Date().toISOString() }).eq("chat_id", chatId);
      await db.from("telegram_codes").delete().eq("code", code);
      const a = await account(chatId);
      return send(chatId, `✅ <b>Connected to MEEGO AI</b>${a.name ? `, ${esc(a.name)}` : ""}!\n\nYou'll get new signals, Hit TP/SL results and announcements here automatically.\n\nUse the buttons below, or send a chart screenshot for an AI scan.`);
    }
    const a = await account(chatId);
    if (a.linked) return send(chatId, `Welcome back to <b>MEEGO AI</b>! Use the buttons below, or send a chart screenshot for an AI scan.`);
    return send(chatId, `👋 Welcome to <b>MEEGO AI</b>: market signals, news and AI chart analysis.\n\n${linkHelp()}`);
  }

  const a = await account(chatId);
  if (msg.photo && msg.photo.length) return scanPhoto(chatId, a, msg);
  const t = text.toLowerCase();
  if (t.startsWith("/admin") || t.startsWith("/post") || t.startsWith("/close") || t.startsWith("/announce") || t.startsWith("/members")) return cmdAdmin(chatId, a, text);
  if (t.startsWith("/signal") || t.includes("signal") && !t.includes("swing")) return cmdSignal(chatId, a, "Intraday");
  if (t.startsWith("/swing") || t.includes("swing")) return cmdSignal(chatId, a, "Swing");
  if (t.startsWith("/direction") || t.includes("direction")) return cmdDirection(chatId, a);
  if (t.startsWith("/history") || t.includes("history")) return cmdHistory(chatId, a);
  if (t.startsWith("/plan") || t.includes("my plan")) return cmdPlan(chatId, a);
  return send(chatId, [
    "<b>MEEGO AI bot</b>",
    "📈 /signal latest intraday signal",
    "⭐ /swing Priority Swing (Ultimate)",
    "🧭 /direction today's direction",
    "📊 /history wins and pips",
    "👤 /plan your plan",
    "🖼 Send a chart screenshot for an AI scan",
    a.linked ? "" : "\n" + linkHelp(),
  ].join("\n"));
}

/* ---------- entry point ---------- */
Deno.serve(async (req) => {
  const cfg = await settings();
  const secret = cfg.telegram_secret || "";

  // Opening the function URL in a browser connects the bot to Telegram.
  if (req.method === "GET") {
    if (!TOKEN) return new Response("Add the secret TELEGRAM_BOT_TOKEN in Supabase → Edge Functions → Secrets, then reload this page.", { status: 500 });
    if (!cfg.telegram_url || !secret) return new Response("Run supabase/telegram.sql in the SQL Editor first, then reload this page.", { status: 500 });
    const me = await tg("getMe", {});
    const hook = await tg("setWebhook", { url: cfg.telegram_url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
    await tg("setMyCommands", { commands: [
      { command: "signal", description: "Latest intraday signal" },
      { command: "swing", description: "Priority Swing (Ultimate)" },
      { command: "direction", description: "Today's direction" },
      { command: "history", description: "Wins and pips" },
      { command: "plan", description: "Your plan" },
    ] });
    const ok = me.ok && hook.ok;
    return new Response(ok ? `MEEGO bot connected: @${me.result.username}. You can close this page.` : `Couldn't connect the bot: ${JSON.stringify(me.ok ? hook : me)}`, { status: ok ? 200 : 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (req.method !== "POST") return new Response("ok");

  // Database events (new signal, Hit TP/SL, announcements, daily reminders)
  if (req.headers.get("x-meego-secret")) {
    if (req.headers.get("x-meego-secret") !== secret) return new Response("forbidden", { status: 403 });
    const ev = await req.json().catch(() => null);
    if (ev) EdgeRuntime.waitUntil(onDbEvent(ev).catch((e) => console.error("event failed", e)));
    return new Response("ok");
  }

  // Telegram updates
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });
  const update = await req.json().catch(() => null);
  if (update?.message) EdgeRuntime.waitUntil(onMessage(update.message).catch((e) => console.error("message failed", e)));
  return new Response("ok");
});
