// MEEGO AI Telegram bot (Supabase Edge Function "telegram") - works on its own, no website needed.
// Secrets: TELEGRAM_BOT_TOKEN (from @BotFather), ANTHROPIC_API_KEY (for chart scans).
// "Verify JWT" must be OFF for this function. Open the function URL once in a browser to connect the bot.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL");
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const db = createClient(SB_URL, SB_SERVICE);
const MODEL = Deno.env.get("AI_MODEL") ?? "claude-opus-5-5";
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "30");
const CANDLES_FN = Deno.env.get("CANDLES_FUNCTION") ?? "swift-task";
const anthropic = new Anthropic();
const DISCLAIMER = "<i>Analysis tool, not financial advice. Always use a stop loss.</i>";
const TIERS = ["Basic", "Pro", "Ultimate"];

/* ---------- helpers ---------- */
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date, n) => { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => ({ ok: false }));
}
const MENU = { keyboard: [[{ text: "⚡ Scalping" }, { text: "📈 Intraday" }, { text: "⭐ Swing" }], [{ text: "🧭 Direction" }, { text: "📊 History" }], [{ text: "👤 My plan" }, { text: "❓ Help" }]], resize_keyboard: true };
const ADMIN_MENU = { keyboard: [[{ text: "➕ Add customer" }, { text: "👥 Customers" }], [{ text: "⚡ Scalping" }, { text: "📈 Intraday" }, { text: "⭐ Swing" }], [{ text: "📊 History" }, { text: "❓ Help" }]], resize_keyboard: true };
const KIND = {
  Scalping: { title: "⚡ DAILY SIGNAL SCALPING", fresh: "📢 NEW SCALPING SIGNAL", label: "Scalping", none: "No scalping setup running right now. You'll get a message here as soon as one is posted." },
  Intraday: { title: "📈 DAILY SIGNAL INTRADAY", fresh: "📢 NEW DAILY SIGNAL INTRADAY", label: "Daily Intraday", none: "No intraday setup running right now. You'll get a message here as soon as one is posted." },
  Swing: { title: "⭐ PRIORITY SIGNAL SWING", fresh: "📢 NEW PRIORITY SIGNAL SWING", label: "Priority Swing", none: "No Priority Swing right now. It's posted only when a high-quality setup appears." },
};
const kindOf = (k) => KIND[k] ?? KIND.Intraday;
const send = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const kb = (a) => ({ reply_markup: a.admin ? ADMIN_MENU : MENU });
let BOT_NAME = "";
async function botName() {
  if (!BOT_NAME) { const me = await tg("getMe", {}); BOT_NAME = me.result?.username ?? ""; }
  return BOT_NAME;
}
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
const nameOf = (u) => (u.username ? "@" + u.username : u.first_name || String(u.chat_id));

/* ---------- who is this chat? ---------- */
function planOf(u) {
  const active = !!u.tier && (!u.plan_end || u.plan_end >= today());
  return { tier: active ? u.tier : null, rawTier: u.tier || null, end: u.plan_end || null };
}
async function account(chatId) {
  const { data: u } = await db.from("telegram_users").select("*").eq("chat_id", chatId).maybeSingle();
  if (!u) return { chatId, admin: false, tier: null };
  return { ...u, chatId, admin: !!u.is_admin, ...planOf(u) };
}
const canSee = (a, kind) => a.admin || (!!a.tier && (kind !== "Swing" || a.tier === "Ultimate"));
const noPlan = (a) => `You don't have an active plan yet.\n\nSend this to the admin to get activated:\n<b>MEEGO ID: <code>${a.chatId}</code></b>`;
const privateNote = (a) => `🔒 <b>MEEGO AI is a private service.</b>\n\nIf you've bought a plan, send this to the admin:\n<b>MEEGO ID: <code>${a.chatId}</code></b>`;
// A customer reference: a Telegram username (without @, lowercase) or a MEEGO ID (chat id)
const keyOf = (ref) => {
  const k = String(ref || "").trim().replace(/^@/, "").toLowerCase();
  return /^-?\d{5,}$/.test(k) || /^[a-z][a-z0-9_]{3,31}$/.test(k) ? k : null;
};
const showRef = (k) => (/^-?\d+$/.test(k) ? `ID ${k}` : `@${k}`);

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
  const { data } = await db.from("signals").select("id,data").order("updated_at", { ascending: false }).limit(300);
  return (data ?? []).map((r) => ({ id: r.id, ...r.data })).filter((s) => s && s.kind === kind && s.sym);
}

/* ---------- member commands ---------- */
// "MEEGO AI is scanning" progress message, edited in place (about 3 seconds)
const bar = (n) => "▰".repeat(n) + "▱".repeat(10 - n);
// Scan video (made by tools/make_scan_video.py). Uploaded to Telegram once, then re-sent by file_id.
const SCAN_VIDEO = "https://raw.githubusercontent.com/syahmihafizan1905/Meego-AI-2/main/public/media/meego-scan.mp4";
const SCAN_VIDEO_KEY = "scan_video_v1";
async function sendScanVideo(chatId, caption) {
  const { data: row } = await db.from("app_settings").select("value").eq("key", SCAN_VIDEO_KEY).maybeSingle();
  if (row?.value) {
    const r = await tg("sendAnimation", { chat_id: chatId, animation: row.value, caption, parse_mode: "HTML" });
    if (r.ok) return r;
  }
  const res = await fetch(SCAN_VIDEO);
  if (!res.ok) return { ok: false };
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("caption", caption);
  fd.append("parse_mode", "HTML");
  fd.append("animation", new File([await res.blob()], "meego-scan.mp4", { type: "video/mp4" }));
  const r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/sendAnimation`, { method: "POST", body: fd })).json().catch(() => ({ ok: false }));
  const fid = r.result?.animation?.file_id ?? r.result?.document?.file_id ?? r.result?.video?.file_id;
  if (r.ok && fid) await db.from("app_settings").upsert({ key: SCAN_VIDEO_KEY, value: fid });
  return r;
}
async function scanAnimation(chatId, kind) {
  const label = kindOf(kind).label;
  const v = await sendScanVideo(chatId, `🤖 <b>MEEGO AI</b> · scanning for ${esc(label.toLowerCase())} setups…`).catch(() => ({ ok: false }));
  if (!v.ok) return textScan(chatId, kind);
  await new Promise((r) => setTimeout(r, 4200));
  await tg("editMessageCaption", { chat_id: chatId, message_id: v.result.message_id, caption: `✅ <b>MEEGO AI</b> · ${esc(label)} scan complete`, parse_mode: "HTML" });
}
async function textScan(chatId, kind) {
  const head = `🤖 <b>MEEGO AI</b> · ${kindOf(kind).label} scan`;
  const frames = [
    `🔍 Connecting to live market data…
<code>${bar(1)}</code> 10%`,
    `📊 Reading XAUUSD · EURUSD · GBPUSD · USDJPY…
<code>${bar(4)}</code> 40%`,
    `🧠 Checking trend, structure and momentum…
<code>${bar(7)}</code> 70%`,
    `🎯 Matching ${kindOf(kind).label.toLowerCase()} setups…
<code>${bar(9)}</code> 90%`,
    `✅ Scan complete
<code>${bar(10)}</code> 100%`,
  ];
  const first = await send(chatId, `${head}

${frames[0]}`);
  const id = first?.result?.message_id;
  if (!id) return;
  for (const f of frames.slice(1)) {
    await new Promise((r) => setTimeout(r, 750));
    await tg("editMessageText", { chat_id: chatId, message_id: id, text: `${head}

${f}`, parse_mode: "HTML" });
  }
}
async function cmdSignal(chatId, a, kind) {
  if (!canSee(a, kind)) {
    if (kind === "Swing" && a.tier) return send(chatId, "⭐ Priority Swing is for the <b>Ultimate</b> plan. Contact the admin to upgrade.");
    return send(chatId, noPlan(a));
  }
  const [list] = await Promise.all([
    signalsOf(kind).then((l) => l.filter((s) => s.status === "running").sort((x, y) => y.time - x.time)),
    scanAnimation(chatId, kind),
  ]);
  if (!list.length) return send(chatId, kindOf(kind).none);
  for (const s of list.slice(0, 3)) await send(chatId, signalText(s, kindOf(kind).title));
}
async function cmdHistory(chatId, a) {
  if (!a.admin && !a.tier) return send(chatId, noPlan(a));
  const from = new Date(); from.setUTCDate(1); from.setUTCMonth(from.getUTCMonth() - 1);
  const kinds = canSee(a, "Swing") ? ["Swing", "Intraday", "Scalping"] : ["Intraday", "Scalping"];
  const all = [];
  for (const k of kinds) all.push(...(await signalsOf(k)));
  const closed = all.filter((s) => s.time >= from.getTime() && (s.status === "tp" || s.status === "sl")).sort((x, y) => y.time - x.time);
  if (!closed.length) return send(chatId, "No closed signals in the last two months yet.");
  const pipsOf = (s) => (s.status === "tp" ? pipsBetween(s.tp, s.entry, s.sym) : -pipsBetween(s.entry, s.sl, s.sym));
  const tp = closed.filter((s) => s.status === "tp").length;
  const net = closed.reduce((t, s) => t + pipsOf(s), 0);
  const rows = closed.slice(0, 10).map((s) => `${s.status === "tp" ? "✅" : "❌"} ${new Date(s.time).toISOString().slice(5, 10)} ${s.dir > 0 ? "BUY" : "SELL"} ${esc(s.sym)} <b>${pipsOf(s) > 0 ? "+" : ""}${pipsOf(s)}</b> pips`);
  return send(chatId, `📊 <b>Signal history</b> (this month and last)\n\nHit TP: <b>${tp}</b> · Win rate: <b>${Math.round((tp / closed.length) * 100)}%</b> · Net: <b>${net > 0 ? "+" : ""}${net} pips</b>\n\n${rows.join("\n")}`);
}
async function cmdPlan(chatId, a) {
  if (a.admin) return send(chatId, `👤 Role: <b>ADMIN</b>\nMEEGO ID: <code>${chatId}</code>\n\nSend /admin for the admin commands.`);
  if (!a.rawTier) return send(chatId, noPlan(a));
  return send(chatId, `👤 Plan: <b>${esc(a.rawTier)}</b>${a.end ? `\nEnds: <b>${esc(a.end)}</b>` : ""}\nMEEGO ID: <code>${chatId}</code>${a.tier ? "" : "\n\n⚠️ This plan has ended. Contact the admin to renew."}`);
}
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
  if (!a.admin && !a.tier) return send(chatId, noPlan(a));
  const out = [];
  for (const p of ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"]) {
    const c = await candles(p);
    if (c.length < 120) { out.push(`${p}: no data`); continue; }
    const h1 = c.map((x) => x.c);
    const h4 = [];
    for (let i = c.length % 4; i < c.length; i += 4) h4.push(c[Math.min(i + 3, c.length - 1)].c);
    const sum = trend(h1) + trend(h4);
    out.push(`<b>${p}</b> ${sum >= 4 ? "🟢 BUY" : sum <= -4 ? "🔴 SELL" : "⚪ WAIT"} · <code>${px(h1[h1.length - 1], p)}</code>`);
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
  if (!a.admin && !a.tier) return send(chatId, noPlan(a));
  if (!a.admin) {
    const { data: use } = await db.from("tg_ai_usage").select("count").eq("chat_id", chatId).eq("day", today()).maybeSingle();
    if ((use?.count ?? 0) >= DAILY_LIMIT) return send(chatId, `You've used today's ${DAILY_LIMIT} AI scans. Try again tomorrow.`);
    await db.from("tg_ai_usage").upsert({ chat_id: chatId, day: today(), count: (use?.count ?? 0) + 1 });
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

/* ---------- admin: customers and signals ---------- */
async function findUser(ref) {
  ref = String(ref || "").trim();
  if (/^-?\d+$/.test(ref)) {
    const { data } = await db.from("telegram_users").select("*").eq("chat_id", Number(ref)).maybeSingle();
    return data;
  }
  const uname = ref.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{4,32}$/.test(uname)) return null;
  const { data } = await db.from("telegram_users").select("*").ilike("username", uname.replace(/_/g, "\\_")).limit(1);
  return data && data[0];
}
// Give (or extend) a plan and tell the customer
async function grant(u, tier, days) {
  const base = u.tier === tier && u.plan_end && u.plan_end >= today() ? u.plan_end : today();
  const end = addDays(base, days);
  await db.from("telegram_users").update({ tier, plan_end: end }).eq("chat_id", u.chat_id);
  await send(u.chat_id, `🎉 Your <b>${tier}</b> plan is active until <b>${end}</b>.\n\nYou'll get new signals here automatically. Tap ⚡ Scalping, 📈 Intraday or ⭐ Swing to see what's running.`, { reply_markup: MENU });
  return end;
}
// Admin picked customer + plan + days. If the customer hasn't pressed START yet, save it and it turns on when they do.
async function addCustomer(adminId, ref, tier, days) {
  const u = await findUser(ref);
  if (u) {
    const end = await grant(u, tier, days);
    return send(adminId, `✅ ${esc(nameOf(u))} → <b>${tier}</b> until <b>${end}</b>. They've been notified.`);
  }
  await db.from("tg_pending").upsert({ ref, tier, days, created_at: new Date().toISOString() });
  return send(adminId, `✅ Saved: <b>${esc(showRef(ref))}</b> → <b>${tier}</b>, ${days} days.\n\nSend them this link. When they press START, the plan turns on by itself:\nhttps://t.me/${await botName()}`);
}
const tierButtons = (ref) => ({ inline_keyboard: [TIERS.map((t) => ({ text: t, callback_data: `t|${ref}|${t}` }))] });
const dayButtons = (ref, tier) => ({ inline_keyboard: [[30, 90].map((d) => ({ text: `${d} days`, callback_data: `d|${ref}|${tier}|${d}` })), [180, 365].map((d) => ({ text: `${d} days`, callback_data: `d|${ref}|${tier}|${d}` }))] });
async function setState(chatId, step) { await db.from("tg_state").upsert({ chat_id: chatId, step, updated_at: new Date().toISOString() }); }
async function getState(chatId) { const { data } = await db.from("tg_state").select("step,updated_at").eq("chat_id", chatId).maybeSingle(); return data; }
async function clearState(chatId) { await db.from("tg_state").delete().eq("chat_id", chatId); }
async function cmdCustomers(chatId) {
  const { data } = await db.from("telegram_users").select("*").not("tier", "is", null).order("plan_end", { ascending: true });
  const { data: pend } = await db.from("tg_pending").select("*").order("created_at", { ascending: false });
  if (!(data ?? []).length && !(pend ?? []).length) return send(chatId, "No customers yet. Tap <b>➕ Add customer</b>.", { reply_markup: ADMIN_MENU });
  const soon = addDays(today(), 7);
  const rows = (data ?? []).slice(0, 40).map((u) => {
    const mark = !planOf(u).tier ? "❌" : u.plan_end && u.plan_end <= soon ? "⏰" : "✅";
    return [{ text: `${mark} ${nameOf(u)} · ${u.tier} · ${u.plan_end ?? "no end"}`, callback_data: `c|${u.chat_id}` }];
  });
  const waiting = (pend ?? []).slice(0, 20).map((p) => [{ text: `⏳ ${showRef(p.ref)} · ${p.tier} · ${p.days}d (cancel)`, callback_data: `q|${p.ref}` }]);
  return send(chatId, "<b>Customers</b>\n✅ active · ⏰ ends within 7 days · ❌ ended · ⏳ hasn't pressed START yet\n\nTap a customer to renew, change or end their plan.", { reply_markup: { inline_keyboard: [...rows, ...waiting] } });
}
async function onCallback(q) {
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  const chatId = q.message?.chat?.id, msgId = q.message?.message_id;
  if (!chatId) return;
  const a = await account(chatId);
  if (!a.admin) return;
  const [kind, x, y, z] = String(q.data || "").split("|");
  const edit = (text, markup) => tg("editMessageText", { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", reply_markup: markup ?? { inline_keyboard: [] } });
  if (kind === "t") return edit(`Customer: <b>${esc(showRef(x))}</b>\nPlan: <b>${esc(y)}</b>\n\nHow long?`, dayButtons(x, y));
  if (kind === "d") {
    if (!TIERS.includes(y) || !(Number(z) > 0)) return;
    await edit(`Customer: <b>${esc(showRef(x))}</b>\nPlan: <b>${esc(y)}</b> · ${z} days`);
    return addCustomer(chatId, x, y, Number(z));
  }
  const u = /^-?\d+$/.test(x || "") ? await findUser(x) : null;
  if (kind === "c") {
    if (!u) return send(chatId, "Customer not found.");
    return send(chatId, `<b>${esc(nameOf(u))}</b>\nPlan: <b>${esc(u.tier ?? "none")}</b>${u.plan_end ? ` until <b>${u.plan_end}</b>` : ""}\nMEEGO ID: <code>${u.chat_id}</code>`, { reply_markup: { inline_keyboard: [
      [{ text: "+30 days", callback_data: `r|${u.chat_id}|30` }, { text: "+90 days", callback_data: `r|${u.chat_id}|90` }],
      [{ text: "🔁 Change plan", callback_data: `p|${u.chat_id}` }, { text: "⛔ End plan", callback_data: `x|${u.chat_id}` }],
    ] } });
  }
  if (kind === "r" && u && u.tier) {
    const end = await grant({ ...u }, u.tier, Number(y) || 30);
    return edit(`✅ ${esc(nameOf(u))} renewed: <b>${esc(u.tier)}</b> until <b>${end}</b>.`);
  }
  if (kind === "p" && u) return edit(`Customer: <b>${esc(nameOf(u))}</b>\n\nWhich plan?`, tierButtons(String(u.chat_id)));
  if (kind === "x" && u) return edit(`End <b>${esc(nameOf(u))}</b>'s plan now?`, { inline_keyboard: [[{ text: "Yes, end it", callback_data: `xx|${u.chat_id}` }, { text: "No", callback_data: `c|${u.chat_id}` }]] });
  if (kind === "xx" && u) {
    await db.from("telegram_users").update({ tier: null, plan_end: null }).eq("chat_id", u.chat_id);
    return edit(`⛔ ${esc(nameOf(u))}'s plan has been ended.`);
  }
  if (kind === "q") {
    await db.from("tg_pending").delete().eq("ref", x);
    return edit(`Cancelled the waiting plan for <b>${esc(showRef(x))}</b>.`);
  }
}
async function activeMembers() {
  const { data } = await db.from("telegram_users").select("*");
  return (data ?? []).filter((u) => u.is_admin || planOf(u).tier);
}
async function cmdAdmin(chatId, a, text) {
  if (!a.admin) return send(chatId, privateNote(a));
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.*/, "");
  if (cmd === "/admin") {
    return send(chatId, [
      "<b>Customers</b> (no typing needed)",
      "Tap <b>➕ Add customer</b> → send their @username → tap the plan → tap how many days. Done.",
      "Tap <b>👥 Customers</b> to renew, change or end someone's plan.",
      "",
      "<b>Signals</b>",
      "<code>/post BUY XAUUSD 4040 4080 3990</code> intraday signal (entry, TP, SL)",
      "<code>/post BUY XAUUSD 4040 4048 4034 scalp</code> scalping signal",
      "<code>/post SELL XAUUSD 4129 4119 4140 swing Sell area, wait for price</code> swing (Ultimate only) with a note",
      "<code>/close tp</code> · <code>/close sl</code> · <code>/close be</code> closes the latest running signal (add a pair to choose: <code>/close tp XAUUSD</code>)",
      "",
      "<b>Messages</b>",
      "<code>/announce Your message</code> sends to every active member",
      "<code>/members</code> totals",
    ].join("\n"), { reply_markup: ADMIN_MENU });
  }
  if (cmd === "/activate") {
    const ref = keyOf(parts[1]);
    const tier = TIERS.find((t) => t.toLowerCase() === String(parts[2] || "").toLowerCase());
    const days = Number(parts[3] || 30);
    if (!ref || !tier || !(days > 0)) return send(chatId, "Format: <code>/activate @username Basic|Pro|Ultimate days</code>\nOr just tap <b>➕ Add customer</b>.");
    return addCustomer(chatId, ref, tier, days);
  }
  if (cmd === "/renew") {
    const u = await findUser(parts[1]);
    const days = Number(parts[2] || 30);
    if (!u || !u.tier) return send(chatId, "Customer not found or has no plan. Use /activate first.");
    if (!(days > 0)) return send(chatId, "Format: <code>/renew ID days</code>");
    const base = u.plan_end && u.plan_end >= today() ? u.plan_end : today();
    const end = addDays(base, days);
    await db.from("telegram_users").update({ plan_end: end }).eq("chat_id", u.chat_id);
    await send(u.chat_id, `✅ Your <b>${esc(u.tier)}</b> plan has been renewed until <b>${end}</b>.`);
    return send(chatId, `✅ ${esc(nameOf(u))} renewed until <b>${end}</b>.`);
  }
  if (cmd === "/remove") {
    const u = await findUser(parts[1]);
    if (!u) return send(chatId, "Customer not found.");
    await db.from("telegram_users").update({ tier: null, plan_end: null }).eq("chat_id", u.chat_id);
    return send(chatId, `✅ ${esc(nameOf(u))}'s plan has been ended.`);
  }
  if (cmd === "/customers") return cmdCustomers(chatId);
  if (cmd === "/post") {
    const side = (parts[1] || "").toUpperCase(), sym = (parts[2] || "").toUpperCase();
    const entry = Number(parts[3]), tp = Number(parts[4]), sl = Number(parts[5]);
    const tag = (parts[6] || "").toLowerCase();
    const kind = tag === "swing" ? "Swing" : /^scalp/.test(tag) ? "Scalping" : "Intraday";
    const note = parts.slice(kind === "Intraday" ? 6 : 7).join(" ");
    const dir = side === "BUY" ? 1 : side === "SELL" ? -1 : 0;
    if (!dir || !/^[A-Z0-9]{3,10}$/.test(sym) || ![entry, tp, sl].every(Number.isFinite)) return send(chatId, "Format: <code>/post BUY XAUUSD entry tp sl [scalp|swing] [note]</code>");
    if (dir > 0 ? !(tp > entry && sl < entry) : !(tp < entry && sl > entry)) return send(chatId, dir > 0 ? "For BUY, TP must be above entry and SL below it." : "For SELL, TP must be below entry and SL above it.");
    const { error } = await db.from("signals").insert({ id: crypto.randomUUID(), data: { kind, sym, dir, entry, tp, sl, note, status: "running", time: Date.now(), closedAt: null } });
    return send(chatId, error ? "Couldn't save the signal: " + esc(error.message) : "✅ Signal posted. Members are being notified.");
  }
  if (cmd === "/close") {
    const st = (parts[1] || "").toLowerCase(), sym = (parts[2] || "").toUpperCase();
    if (!["tp", "sl", "be"].includes(st)) return send(chatId, "Format: <code>/close tp</code>, <code>/close sl</code> or <code>/close be</code> (optionally add the pair)");
    const { data } = await db.from("signals").select("id,data").order("updated_at", { ascending: false }).limit(300);
    const row = (data ?? []).filter((r) => r.data?.status === "running" && (!sym || r.data.sym === sym)).sort((x, y) => y.data.time - x.data.time)[0];
    if (!row) return send(chatId, "No running signal found" + (sym ? " for " + esc(sym) : "") + ".");
    const { error } = await db.from("signals").update({ data: { ...row.data, status: st, closedAt: Date.now() }, updated_at: new Date().toISOString() }).eq("id", row.id);
    return send(chatId, error ? "Couldn't update: " + esc(error.message) : `✅ ${esc(row.data.sym)} marked ${st.toUpperCase()}. Members are being notified.`);
  }
  if (cmd === "/announce") {
    const body = text.replace(/^\/announce(@\S+)?\s*/i, "").trim();
    if (!body) return send(chatId, "Format: <code>/announce Your message</code>");
    const list = await activeMembers();
    await broadcast(list.map((u) => u.chat_id), `📣 <b>Announcement</b>\n\n${esc(body)}`);
    return send(chatId, `✅ Sent to ${list.length} people.`);
  }
  if (cmd === "/members") {
    const { data } = await db.from("telegram_users").select("*");
    const all = data ?? [];
    const active = all.filter((u) => planOf(u).tier);
    const by = (t) => active.filter((u) => u.tier === t).length;
    return send(chatId, `👥 Started the bot: <b>${all.length}</b>\nActive plans: <b>${active.length}</b> (Basic ${by("Basic")} · Pro ${by("Pro")} · Ultimate ${by("Ultimate")})`);
  }
  return send(chatId, "Unknown admin command. Send /admin for the list.");
}

/* ---------- broadcasts (new signal, Hit TP/SL, daily reminders) ---------- */
async function audience(kind) {
  const { data } = await db.from("telegram_users").select("*");
  return (data ?? []).filter((u) => u.is_admin || (planOf(u).tier && (kind !== "Swing" || planOf(u).tier === "Ultimate"))).map((u) => u.chat_id);
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
      return broadcast(chats, signalText(s, kindOf(s.kind).fresh));
    }
    if (ev.op === "UPDATE" && old && old.status !== s.status && ["tp", "sl", "be"].includes(s.status)) {
      const p = s.status === "tp" ? pipsBetween(s.tp, s.entry, s.sym) : s.status === "sl" ? -pipsBetween(s.entry, s.sl, s.sym) : 0;
      const head = s.status === "tp" ? "✅ <b>HIT TP</b>" : s.status === "sl" ? "❌ <b>HIT SL</b>" : "➖ <b>BREAKEVEN</b>";
      return broadcast(chats, `${head} · ${s.dir > 0 ? "BUY" : "SELL"} <b>${esc(s.sym)}</b>\n${kindOf(s.kind).label} · <b>${p > 0 ? "+" : ""}${p} pips</b>`);
    }
    return;
  }
  if (ev.event === "daily") {
    const { data } = await db.from("telegram_users").select("*").not("tier", "is", null);
    const soon = addDays(today(), 3), yesterday = addDays(today(), -1);
    const admins = (await db.from("telegram_users").select("chat_id").eq("is_admin", true)).data ?? [];
    const expiring = [];
    for (const u of data ?? []) {
      if (u.plan_end === soon) { await send(u.chat_id, `⏰ Your <b>${esc(u.tier)}</b> plan ends on <b>${u.plan_end}</b>. Contact the admin to renew and keep receiving signals.`); expiring.push(u); }
      if (u.plan_end === yesterday) await send(u.chat_id, `Your <b>${esc(u.tier)}</b> plan has ended. Contact the admin to renew.\nMEEGO ID: <code>${u.chat_id}</code>`);
    }
    if (expiring.length) for (const ad of admins) await send(ad.chat_id, `⏰ Plans ending in 3 days:\n${expiring.map((u) => `${esc(nameOf(u))} · ${esc(u.tier)} · <code>${u.chat_id}</code>`).join("\n")}`);
  }
}

/* ---------- incoming messages ---------- */
async function onMessage(msg) {
  const chatId = msg.chat?.id;
  if (!chatId || msg.chat.type !== "private") return;
  const text = String(msg.text ?? "").trim();
  await db.from("telegram_users").upsert({ chat_id: chatId, username: msg.from?.username ?? null, first_name: msg.from?.first_name ?? null }, { onConflict: "chat_id" });
  let a = await account(chatId);
  const t = text.toLowerCase();

  // One-time: the first person to send /claimadmin becomes the admin (only while there is no admin)
  if (t.startsWith("/claimadmin")) {
    const { count } = await db.from("telegram_users").select("chat_id", { count: "exact", head: true }).eq("is_admin", true);
    if ((count ?? 0) > 0) return send(chatId, a.admin ? "You're already the admin." : "This bot already has an admin.");
    await db.from("telegram_users").update({ is_admin: true }).eq("chat_id", chatId);
    return send(chatId, "👑 You're now the <b>MEEGO admin</b>. Tap <b>➕ Add customer</b> to give someone a plan.", { reply_markup: ADMIN_MENU });
  }

  // Admin: button flows (no typing commands)
  if (a.admin) {
    const st = await getState(chatId);
    if (t.includes("add customer")) {
      await setState(chatId, "add");
      return send(chatId, "Send the customer's Telegram <b>username</b> (for example <code>@ali</code>).\n\nNo username? Ask them to press START in this bot and send you the MEEGO ID it shows, then paste that number here.");
    }
    if (t.includes("customers")) { await clearState(chatId); return cmdCustomers(chatId); }
    if (st?.step === "add" && text && !text.startsWith("/") && Date.now() - new Date(st.updated_at).getTime() < 30 * 60 * 1000) {
      await clearState(chatId);
      const ref = keyOf(text);
      if (!ref) return send(chatId, "That doesn't look like a Telegram username or MEEGO ID. Tap <b>➕ Add customer</b> to try again.");
      return send(chatId, `Customer: <b>${esc(showRef(ref))}</b>\n\nWhich plan?`, { reply_markup: tierButtons(ref) });
    }
    if (st) await clearState(chatId);
  } else if (!a.tier) {
    // Not a member: switch on a plan the admin saved for this username/ID, otherwise stay private
    const keys = [String(chatId)];
    if (msg.from?.username) keys.push(msg.from.username.toLowerCase());
    const { data: pend } = await db.from("tg_pending").select("*").in("ref", keys).limit(1);
    if (pend && pend[0]) {
      const p = pend[0];
      const end = await grant({ chat_id: chatId, tier: null, plan_end: null }, p.tier, p.days);
      await db.from("tg_pending").delete().eq("ref", p.ref);
      const admins = (await db.from("telegram_users").select("chat_id").eq("is_admin", true)).data ?? [];
      for (const ad of admins) await send(ad.chat_id, `✅ ${esc(showRef(p.ref))} pressed START. <b>${esc(p.tier)}</b> is now active until <b>${end}</b>.`);
      return;
    }
    if (!a.rawTier) return send(chatId, privateNote(a), { reply_markup: { remove_keyboard: true } });
  }

  if (t.startsWith("/start")) {
    if (a.admin) return send(chatId, "Welcome back, admin. Tap <b>➕ Add customer</b> to give someone a plan, or send /admin for everything else.", { reply_markup: ADMIN_MENU });
    if (a.tier) return send(chatId, `Welcome back to <b>MEEGO AI</b>! Your <b>${esc(a.tier)}</b> plan is active${a.end ? ` until <b>${a.end}</b>` : ""}.\n\nUse the buttons below, or send a chart screenshot for an AI scan.`, kb(a));
    return send(chatId, `Your <b>${esc(a.rawTier)}</b> plan has ended. Contact the admin to renew.\nMEEGO ID: <code>${chatId}</code>`, { reply_markup: { remove_keyboard: true } });
  }
  if (msg.photo && msg.photo.length) return scanPhoto(chatId, a, msg);
  if (/^\/(admin|activate|renew|remove|customers|post|close|announce|members)\b/.test(t)) return cmdAdmin(chatId, a, text);
  if (t.startsWith("/scalp") || t.includes("scalp")) return cmdSignal(chatId, a, "Scalping");
  if (t.startsWith("/intraday") || t.startsWith("/signal") || t.includes("intraday") || (t.includes("signal") && !t.includes("swing"))) return cmdSignal(chatId, a, "Intraday");
  if (t.startsWith("/swing") || t.includes("swing")) return cmdSignal(chatId, a, "Swing");
  if (t.startsWith("/direction") || t.includes("direction")) return cmdDirection(chatId, a);
  if (t.startsWith("/history") || t.includes("history")) return cmdHistory(chatId, a);
  if (t.startsWith("/plan") || t.includes("my plan")) return cmdPlan(chatId, a);
  return send(chatId, [
    "<b>MEEGO AI</b>",
    "⚡ /scalping scalping signals",
    "📈 /intraday intraday signals",
    "⭐ /swing Priority Swing (Ultimate)",
    "🧭 /direction today's direction",
    "📊 /history wins and pips",
    "👤 /plan your plan and MEEGO ID",
    "🖼 Send a chart screenshot for an AI scan",
  ].join("\n"), kb(a));
}

/* ---------- entry point ---------- */
Deno.serve(async (req) => {
  const cfg = await settings();
  const secret = cfg.telegram_secret || "";
  if (req.method === "GET") {
    if (!TOKEN) return new Response("Add the secret TELEGRAM_BOT_TOKEN in Supabase → Edge Functions → Secrets, then reload this page.", { status: 500 });
    if (!cfg.telegram_url || !secret) return new Response("Run supabase/telegram.sql in the SQL Editor first, then reload this page.", { status: 500 });
    const me = await tg("getMe", {});
    const hook = await tg("setWebhook", { url: cfg.telegram_url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    await tg("setMyCommands", { commands: [
      { command: "scalping", description: "Scalping signals" },
      { command: "intraday", description: "Intraday signals" },
      { command: "swing", description: "Priority Swing (Ultimate)" },
      { command: "direction", description: "Today's direction" },
      { command: "history", description: "Wins and pips" },
      { command: "plan", description: "Your plan and MEEGO ID" },
    ] });
    const ok = me.ok && hook.ok;
    return new Response(ok ? `MEEGO bot connected: @${me.result.username}. You can close this page.` : `Couldn't connect the bot: ${JSON.stringify(me.ok ? hook : me)}`, { status: ok ? 200 : 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-meego-secret")) {
    if (req.headers.get("x-meego-secret") !== secret) return new Response("forbidden", { status: 403 });
    const ev = await req.json().catch(() => null);
    if (ev) EdgeRuntime.waitUntil(onDbEvent(ev).catch((e) => console.error("event failed", e)));
    return new Response("ok");
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });
  const update = await req.json().catch(() => null);
  if (update?.message) EdgeRuntime.waitUntil(onMessage(update.message).catch((e) => console.error("message failed", e)));
  if (update?.callback_query) EdgeRuntime.waitUntil(onCallback(update.callback_query).catch((e) => console.error("button failed", e)));
  return new Response("ok");
});
