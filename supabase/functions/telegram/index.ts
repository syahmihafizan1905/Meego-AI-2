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
const MENU = { keyboard: [[{ text: "⚡ Scalping" }, { text: "📈 Intraday" }, { text: "⭐ Swing" }], [{ text: "🧭 Direction" }, { text: "🖼 Chart Scanner" }], [{ text: "📊 History" }, { text: "📰 News" }], [{ text: "👤 My plan" }, { text: "🤖 MT5 EA" }, { text: "❓ Help" }]], resize_keyboard: true };
const ADMIN_MENU = { keyboard: [[{ text: "➕ Add customer" }, { text: "👥 Customers" }], [{ text: "⚡ Scalping" }, { text: "📈 Intraday" }, { text: "⭐ Swing" }], [{ text: "🧭 Direction" }, { text: "🖼 Chart Scanner" }], [{ text: "📊 History" }, { text: "📰 News" }], [{ text: "🤖 MT5 EA" }, { text: "❓ Help" }]], resize_keyboard: true };
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
// Confluence score (2 to 9) as a grade: 9 = A+, 8 = A, 7 = B+, 6 = B, 5 = C+, 4 = C, 3 = D+, 2 = D
const grade = (score) => ["D", "D+", "C", "C+", "B", "B+", "A", "A+"][Math.max(0, Math.min(7, Math.round(score) - 2))];
const myTime = (t = Date.now()) => new Date(t + 8 * 3600000).toISOString().slice(11, 16); // Malaysia time
// 3 take-profits, a third of the lot each: TP1 0.7x risk (50-100 pips), TP2 2x risk (100-200), TP3 3x risk (200-500).
// After TP1 the SL moves to entry, after TP2 to TP1. Backtest: win rate (TP1 hit) 75% daily Swing, 69% news.
const TP_PLAN = [[0.7, 50, 100], [2, 100, 200], [3, 200, 500]];
function tpPlan(sym, dir, entry, sl) {
  const rp = Math.abs(entry - sl) / pip(sym), gold = /^XAU/.test(sym), d = digits(sym);
  const tps = TP_PLAN.map(([k, lo, hi]) => Number((entry + dir * (gold ? Math.min(hi, Math.max(lo, k * rp)) : k * rp) * pip(sym)).toFixed(d)));
  return { tps, tp: tps[2], sl0: sl, tpHit: 0 };
}
// Result in pips, averaged over the three thirds of the lot (old single-TP signals: as before)
function sigPips(s) {
  if (!s.tps) return s.status === "tp" ? pipsBetween(s.tp, s.entry, s.sym) : s.status === "sl" ? -pipsBetween(s.entry, s.sl, s.sym) : s.status === "closed" ? Math.round(((Number(s.exit) - s.entry) * s.dir) / pip(s.sym)) : 0;
  const n = s.tpHit || 0, won = s.tps.slice(0, n).reduce((t, x) => t + (x - s.entry) * s.dir, 0);
  const exit = s.status === "closed" ? Number(s.exit) : s.sl;
  return Math.round((won + (n < 3 ? (exit - s.entry) * s.dir * (3 - n) : 0)) / 3 / pip(s.sym));
}
const isWin = (s) => (s.tps ? (s.tpHit || 0) >= 1 : sigPips(s) > 0);
function resultLine(s) {
  if (s.status === "cancelled") return "🚫 <b>CANCELLED</b> · entry price not reached";
  const p = sigPips(s), n = s.tpHit || 0;
  const head = s.tps && s.status !== "closed"
    ? (n >= 3 ? "🏆 <b>ALL TP HIT</b>" : n === 2 ? "✅ <b>TP2 HIT</b> · rest closed at TP1" : n === 1 ? "✅ <b>TP1 HIT</b> · rest closed at entry" : "❌ <b>HIT SL</b>")
    : s.status === "tp" ? "✅ <b>HIT TP</b>" : s.status === "sl" ? "❌ <b>HIT SL</b>" : s.status === "closed" ? "⏹ <b>CLOSED</b>" : "➖ <b>BREAKEVEN</b>";
  return `${head} · <b>${p > 0 ? "+" : ""}${p} pips</b>${s.tps ? " (avg of 3 TPs)" : ""}`;
}
// Entry zone: from the entry toward the SL (a better price), at most 40 pips and never more than 30% of the risk
const ZONE_PIPS = 40;
function entryZone(s) {
  const w = Math.min(ZONE_PIPS * pip(s.sym), 0.3 * Math.abs(s.entry - (s.sl0 ?? s.sl)));
  const far = s.entry - s.dir * w;
  const [lo, hi] = [Math.min(s.entry, far), Math.max(s.entry, far)];
  return `Entry zone: <code>${px(lo, s.sym)}</code> – <code>${px(hi, s.sym)}</code> (${pipsBetween(hi, lo, s.sym)} pips)`;
}
// Lot size so one SL loses about 1% of the balance (gold: 0.01 lot = $0.10 per pip of 0.10)
function lotGuide(s) {
  if (!/^XAU/.test(s.sym)) return null;
  const riskPips = pipsBetween(s.entry, s.sl0 ?? s.sl, s.sym);
  if (!riskPips) return null;
  const lot = (bal) => { const l = Math.floor((bal * 0.01) / (riskPips * 10) * 100) / 100; return l >= 0.01 ? l.toFixed(2) : "skip"; };
  return `💰 Lot for 1% risk: $500 → <b>${lot(500)}</b> · $1k → <b>${lot(1000)}</b> · $5k → <b>${lot(5000)}</b> · $10k → <b>${lot(10000)}</b>`;
}
// live = current price (shown while the signal is running; the message is refreshed every 5 minutes)
function signalText(s, title, live) {
  const word = s.dir > 0 ? "BUY" : "SELL", dot = s.dir > 0 ? "🟢" : "🔴";
  const side = s.order === "limit" ? `${dot} <b>${word} LIMIT ${esc(s.sym)}</b>` : s.order === "instant" ? `${dot} <b>${word} ${esc(s.sym)}</b> · INSTANT ENTRY` : `${dot} <b>${word}</b> <b>${esc(s.sym)}</b>`;
  const lines = [
    `<b>${esc(title)}</b>`,
    side,
    "",
    `Entry: <code>${px(s.entry, s.sym)}</code>`,
    entryZone(s),
    ...(s.tps
      ? s.tps.map((t, i) => `TP${i + 1}: <code>${px(t, s.sym)}</code> (${pipsBetween(t, s.entry, s.sym)} pips)${(s.tpHit || 0) > i ? " ✅" : ""}`)
      : [`TP: <code>${px(s.tp, s.sym)}</code>`]),
    `SL: <code>${px(s.sl0 ?? s.sl, s.sym)}</code>${s.tps && s.sl !== (s.sl0 ?? s.sl) && s.status === "running" ? ` → moved to <code>${px(s.sl, s.sym)}</code>` : ""}`,
    s.tps ? `Risk ${pipsBetween(s.entry, s.sl0 ?? s.sl, s.sym)} pips · close 1/3 at each TP · SL to entry after TP1` : `Target ${pipsBetween(s.tp, s.entry, s.sym)} pips · Risk ${pipsBetween(s.entry, s.sl, s.sym)} pips`,
  ];
  const lg = lotGuide(s);
  if (lg) lines.push(lg);
  if (s.score) lines.push(`Rating Setup: <b>${grade(s.score)}</b>`);
  if (s.order === "limit" && s.status === "running") {
    lines.push(s.pending ? `⏳ Pending · waiting for price to reach entry (cancelled after ${s.expire ?? LIMIT.expire}h)` : `⚡ Entry triggered${s.filled ? ` at ${myTime(s.filled)}` : ""}`);
  }
  if (s.pending && Number.isFinite(live)) lines.push(`Now: <code>${px(live, s.sym)}</code> · updated ${myTime()}`);
  else if (Number.isFinite(live)) {
    const p = Math.round(((live - s.entry) * s.dir) / pip(s.sym));
    lines.push(p >= 0 ? `🟢 Running pips: <b>+${p}</b>` : `🔴 Floating pips: <b>${p}</b>`, `Now: <code>${px(live, s.sym)}</code> · updated ${myTime()}`);
  }
  if (s.status && s.status !== "running") lines.push(resultLine(s));
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
// MEEGO videos (made by tools/make_scan_video.py). Each is uploaded to Telegram once, then re-sent by file_id.
const MEDIA = "https://raw.githubusercontent.com/syahmihafizan1905/Meego-AI-2/main/public/media/";
const VIDEO_VERSION = "v2";
async function sendVideo(chatId, name, caption, extra = {}) {
  const key = `video_${VIDEO_VERSION}_${name}`;
  const { data: row } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
  if (row?.value) {
    const r = await tg("sendAnimation", { chat_id: chatId, animation: row.value, caption, parse_mode: "HTML", ...extra });
    if (r.ok) return r;
  }
  const res = await fetch(`${MEDIA}meego-${name}.mp4`);
  if (!res.ok) return { ok: false };
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("caption", caption);
  fd.append("parse_mode", "HTML");
  for (const [k, v] of Object.entries(extra)) fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
  fd.append("animation", new File([await res.blob()], `meego-${name}.mp4`, { type: "video/mp4" }));
  const r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/sendAnimation`, { method: "POST", body: fd })).json().catch(() => ({ ok: false }));
  const fid = r.result?.animation?.file_id ?? r.result?.document?.file_id ?? r.result?.video?.file_id;
  if (r.ok && fid) await db.from("app_settings").upsert({ key, value: fid });
  return r;
}
// Play a video, wait for it to finish, then change its caption to the "done" text. Returns false if no video could be sent.
async function playVideo(chatId, name, caption, doneCaption, ms = 4200) {
  const v = await sendVideo(chatId, name, caption).catch(() => ({ ok: false }));
  if (!v.ok) return false;
  await new Promise((r) => setTimeout(r, ms));
  if (doneCaption) await tg("editMessageCaption", { chat_id: chatId, message_id: v.result.message_id, caption: doneCaption, parse_mode: "HTML" });
  return true;
}
async function scanAnimation(chatId, kind) {
  const label = kindOf(kind).label;
  const ok = await playVideo(chatId, `scan-${kind.toLowerCase()}`, `🤖 <b>MEEGO AI</b> · scanning for ${esc(label.toLowerCase())} setups…`, `✅ <b>MEEGO AI</b> · ${esc(label)} scan complete`);
  if (!ok) return textScan(chatId, kind);
}
// Welcome video with the message as its caption; falls back to a plain message
async function welcome(chatId, text, extra) {
  const r = await sendVideo(chatId, "welcome", text, extra).catch(() => ({ ok: false }));
  if (!r.ok) return send(chatId, text, extra);
  return r;
}
async function textScan(chatId, kind) {
  const head = `🤖 <b>MEEGO AI</b> · ${kindOf(kind).label} scan`;
  const frames = [
    `🔍 Connecting to live market data…
<code>${bar(1)}</code> 10%`,
    `📊 Reading XAUUSD · BTCUSD…
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
  const prices = {};
  for (const s of list.slice(0, 3)) await sendLive(chatId, s, kindOf(kind).title, await priceOf(s.sym, prices));
}
/* ---------- live signal messages: pips update every 5 minutes, plus a Refresh button ---------- */
const LIVE_KB = (id) => ({ inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `lv|${id}` }]] });
async function priceOf(sym, cache = {}) {
  if (!(sym in cache)) cache[sym] = (await candles(sym, "1min").catch(() => [])).slice(-1)[0]?.c;
  return cache[sym];
}
async function sendLive(chatId, s, title, price) {
  const r = await send(chatId, signalText(s, title, price), { reply_markup: LIVE_KB(s.id) });
  if (r?.ok && s.id) await db.from("tg_live").upsert({ chat_id: chatId, message_id: r.result.message_id, signal_id: s.id, title });
  return r;
}
async function editLive(row, s, cache) {
  const running = s.status === "running";
  const r = await tg("editMessageText", { chat_id: row.chat_id, message_id: row.message_id, text: signalText(s, row.title, running ? await priceOf(s.sym, cache) : undefined), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: running ? LIVE_KB(s.id) : { inline_keyboard: [] } });
  const gone = !r.ok && !/not modified/i.test(String(r.description));
  if (!running || gone || Date.now() - new Date(row.created_at).getTime() > 7 * 86400000) await db.from("tg_live").delete().eq("chat_id", row.chat_id).eq("message_id", row.message_id);
}
async function refreshLive() {
  const { data: rows } = await db.from("tg_live").select("*").limit(2000);
  if (!rows?.length) return;
  const ids = [...new Set(rows.map((r) => r.signal_id))];
  const { data: sigs } = await db.from("signals").select("id,data").in("id", ids);
  const byId = Object.fromEntries((sigs ?? []).map((r) => [r.id, { id: r.id, ...r.data }]));
  const cache = {};
  for (const row of rows) {
    const s = byId[row.signal_id];
    if (!s) { await db.from("tg_live").delete().eq("chat_id", row.chat_id).eq("message_id", row.message_id); continue; }
    await editLive(row, s, cache);
    await new Promise((r) => setTimeout(r, 40));
  }
}
/* ---------- economic news (USD events move XAUUSD and BTCUSD) ---------- */
// The feed allows only a few requests, so the week's list is kept in app_settings (refreshed hourly by the scan)
async function newsWeek(maxAgeMin = 180) {
  const { data: row } = await db.from("app_settings").select("value").eq("key", "news_cache").maybeSingle();
  let cached = null;
  try { cached = row?.value ? JSON.parse(row.value) : null; } catch (_) { cached = null; }
  if (cached?.list && Date.now() - cached.t < maxAgeMin * 60000) return cached.list;
  try {
    const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`news ${r.status}`);
    const list = (await r.json()).filter((e) => e.country === "USD" && ["High", "Medium"].includes(e.impact)).map((e) => ({ title: e.title, impact: e.impact, forecast: e.forecast, previous: e.previous, t: new Date(e.date).getTime() })).filter((e) => Number.isFinite(e.t)).sort((x, y) => x.t - y.t);
    await db.from("app_settings").upsert({ key: "news_cache", value: JSON.stringify({ t: Date.now(), list }) });
    return list;
  } catch (e) {
    if (cached?.list) return cached.list; // use the older copy
    throw e;
  }
}
async function cmdNews(chatId, a) {
  if (!a.admin && !a.tier) return send(chatId, noPlan(a));
  let list;
  try { list = await newsWeek(); } catch (_) { return send(chatId, "📰 The news calendar is not available right now. Please try again in a few minutes."); }
  const my = (t) => new Date(t + 8 * 3600000);
  const todayStart = new Date(my(Date.now()).toISOString().slice(0, 10) + "T00:00:00Z").getTime() - 8 * 3600000;
  const shown = list.filter((e) => e.t >= todayStart);
  if (!shown.length) return send(chatId, "📰 <b>MEEGO AI · News</b>\n\nNo more important USD news this week. ✅");
  const lines = ["📰 <b>MEEGO AI · News (USD)</b>", "Malaysia time · 🔴 high impact · 🟠 medium"];
  const next = shown.find((e) => e.impact === "High" && e.t > Date.now());
  if (next && next.t - Date.now() < 3 * 3600000) lines.push("", `⚠️ Next 🔴 news: <b>${esc(next.title)}</b> in <b>${Math.max(1, Math.round((next.t - Date.now()) / 60000))} min</b>`);
  const h1 = await candles("XAUUSD", "1h").catch(() => []);
  const rows = shown.slice(0, 30);
  let day = "";
  for (const [i, e] of rows.entries()) {
    const d = my(e.t), dayName = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    if (dayName !== day) { lines.push("", `<b>${dayName}</b>`); day = dayName; }
    const extra = [e.forecast && `F ${esc(e.forecast)}`, e.previous && `P ${esc(e.previous)}`].filter(Boolean).join(" · ");
    lines.push(`${e.t < Date.now() ? "✔️" : e.impact === "High" ? "🔴" : "🟠"} ${d.toISOString().slice(11, 16)} ${esc(e.title)}${extra ? ` · ${extra}` : ""}`);
    // after the last event at this time: MEEGO AI's early call for the 🔴 news
    const highs = shown.filter((x) => x.t === e.t && x.impact === "High");
    if (e.t > Date.now() && highs.length && rows[i + 1]?.t !== e.t) {
      const p = predictNews(highs, h1);
      lines.push(`   🔮 Early call: ${callTxt(p.dir)}${p.dir ? ` · ${p.conf.split(" (")[0]}` : p.lean ? " · news vs chart disagree" : ""}`);
    }
  }
  lines.push("", "F = forecast · P = previous", "🔮 Early call can change. Final call + signal arrive ~2 min before each 🔴 news.", "⚠️ Spreads widen at news time: use a small lot.");
  return send(chatId, lines.join("\n"));
}
// Results for today, this week (from Monday) and this month, in Malaysia time
function historyStats(list, now = Date.now()) {
  const MY = 8 * 3600000, d = new Date(now + MY);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - MY;
  const weekStart = dayStart - ((d.getUTCDay() + 6) % 7) * 86400000;
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - MY;
  const block = (name, from) => {
    const c = list.filter((s) => (s.closedAt || s.time) >= from);
    if (!c.length) return `<b>${name}</b>\nNo closed signals yet.`;
    const win = c.filter(isWin).length, sl = c.filter((s) => !isWin(s) && sigPips(s) < 0).length, be = c.length - win - sl;
    const pp = c.map(sigPips), winP = pp.filter((p) => p > 0).reduce((t, p) => t + p, 0), lossP = pp.filter((p) => p < 0).reduce((t, p) => t + p, 0), net = winP + lossP;
    return [
      `<b>${name}</b> · ${c.length} closed`,
      `✅ Hit TP: <b>${win}</b> · ❌ Hit SL: <b>${sl}</b> · ➖ Hit BE: <b>${be}</b>`,
      `🎯 Win rate: <b>${Math.round((win / Math.max(1, win + sl)) * 100)}%</b>`,
      `💰 Win pips: <b>+${winP}</b> · 🔻 Loss pips: <b>${lossP}</b>`,
      `📈 Net: <b>${net > 0 ? "+" : ""}${net} pips</b>`,
    ].join("\n");
  };
  return [block("📅 Today", dayStart), block("🗓 This week", weekStart), block("📆 This month", monthStart)].join("\n\n");
}
async function cmdHistory(chatId, a) {
  if (!a.admin && !a.tier) return send(chatId, noPlan(a));
  const kinds = canSee(a, "Swing") ? ["Swing", "Intraday", "Scalping"] : ["Intraday", "Scalping"];
  const all = [];
  await Promise.all([
    (async () => { for (const k of kinds) all.push(...(await signalsOf(k))); })(),
    playVideo(chatId, "history", "📊 <b>MEEGO AI</b> · loading signal history…", "✅ <b>MEEGO AI</b> · results ready", 3700),
  ]);
  const closed = all.filter((s) => ["tp", "sl", "closed", "be"].includes(s.status)).sort((x, y) => (y.closedAt || y.time) - (x.closedAt || x.time));
  const running = all.filter((s) => s.status === "running").length;
  const rows = closed.slice(0, 10).map((s) => `${isWin(s) ? "✅" : sigPips(s) < 0 ? "❌" : "➖"}${s.tps ? ` TP${s.tpHit || 0}` : ""} ${new Date((s.closedAt || s.time) + 8 * 3600000).toISOString().slice(5, 16).replace("T", " ")} ${s.dir > 0 ? "BUY" : "SELL"} ${esc(s.sym)} · ${esc(s.kind)} <b>${sigPips(s) > 0 ? "+" : ""}${sigPips(s)}</b> pips`);
  return send(chatId, [
    "📊 <b>MEEGO AI · Signal history</b> (Malaysia time)",
    "",
    historyStats(closed),
    "",
    `⏳ Running now: <b>${running}</b>`,
    ...(rows.length ? ["", "<b>Last 10 closed</b>", ...rows] : []),
    "",
    "<i>Win = TP hit (with 3 TPs: TP1 hit). Pips = average of the 3 TPs.</i>",
  ].join("\n"));
}
async function cmdPlan(chatId, a) {
  if (a.admin) return send(chatId, `👤 Role: <b>ADMIN</b>\nMEEGO ID: <code>${chatId}</code>\n\nSend /admin for the admin commands.`);
  if (!a.rawTier) return showPlans(chatId);
  return send(chatId, `👤 Plan: <b>${esc(a.rawTier)}</b>${a.end ? `\nEnds: <b>${esc(a.end)}</b>` : ""}\nMEEGO ID: <code>${chatId}</code>${a.tier ? "" : "\n\n⚠️ This plan has ended."}`, { reply_markup: { inline_keyboard: [[{ text: "💳 Renew / upgrade", callback_data: "plans" }]] } });
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
async function candles(sym, interval = "1h") {
  const r = await fetch(`${SB_URL}/functions/v1/${CANDLES_FN}?symbol=${sym}&interval=${interval}`, { headers: { Authorization: `Bearer ${SB_SERVICE}`, apikey: SB_SERVICE } });
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j.candles) ? j.candles : [];
}
// Merge candles into a bigger timeframe (e.g. 1min -> 5min, 1h -> 4h), aligned to clock time
function group(c, minutes) {
  const ms = minutes * 60000, out = [];
  for (const x of c) {
    const b = Math.floor(x.t / ms) * ms, last = out[out.length - 1];
    if (last && last.t === b) { last.h = Math.max(last.h, x.h); last.l = Math.min(last.l, x.l); last.c = x.c; }
    else out.push({ t: b, o: x.o, h: x.h, l: x.l, c: x.c });
  }
  return out;
}
// Trend of one timeframe: +1 bullish, -1 bearish, 0 sideways, null = not enough data
function tfTrend(c) {
  if (c.length < 60) return null;
  const sc = trend(c.map((x) => x.c));
  return sc >= 2 ? 1 : sc <= -2 ? -1 : 0;
}
const TF_LABEL = (v) => (v === 1 ? "🟢 Bullish" : v === -1 ? "🔴 Bearish" : v === 0 ? "⚪ Sideways" : "▫️ –");
async function pairDirection(p) {
  const [m1, m15, h1] = [await candles(p, "1min"), await candles(p, "15min"), await candles(p, "1h")];
  const tf = { M1: tfTrend(m1), M5: tfTrend(group(m1, 5)), M15: tfTrend(m15), H1: tfTrend(h1), H4: tfTrend(group(h1, 240)) };
  const weight = { M1: 0.5, M5: 1, M15: 1.5, H1: 2, H4: 2.5 };
  let score = 0, used = 0;
  for (const k of Object.keys(tf)) if (tf[k] !== null) { score += tf[k] * weight[k]; used += weight[k]; }
  const bias = !used ? null : score / used >= 0.35 ? 1 : score / used <= -0.35 ? -1 : 0;
  const last = (h1.length ? h1 : m15.length ? m15 : m1).slice(-1)[0];
  return { p, tf, bias, price: last ? last.c : null };
}
async function cmdDirection(chatId, a) {
  if (!a.admin && !a.tier) return send(chatId, noPlan(a));
  const video = playVideo(chatId, "direction", "🧭 <b>MEEGO AI</b> · reading today's direction…", "✅ <b>MEEGO AI</b> · direction ready");
  const pairs = ["XAUUSD", "BTCUSD"];
  const rows = [];
  for (const p of pairs) rows.push(await pairDirection(p).catch(() => ({ p, tf: {}, bias: null, price: null })));
  await video;
  const blocks = rows.map((r) => {
    const head = r.bias === 1 ? "🟢" : r.bias === -1 ? "🔴" : "⚪";
    const word = r.bias === 1 ? "BULLISH" : r.bias === -1 ? "BEARISH" : r.bias === 0 ? "SIDEWAYS" : "NO DATA";
    const tfs = ["M1", "M5", "M15", "H1", "H4"].map((k) => `${k} ${TF_LABEL(r.tf[k] ?? null)}`);
    return `${head} <b>${r.p} · ${word}</b>${r.price ? ` · <code>${px(r.price, r.p)}</code>` : ""}\n${tfs.slice(0, 3).join("  ")}\n${tfs.slice(3).join("  ")}`;
  });
  return send(chatId, `🧭 <b>MEEGO AI · Market Direction</b>\n\n${blocks.join("\n\n")}\n\n${DISCLAIMER}`);
}

/* ---------- MEEGO AI auto setups (runs every 5 minutes from pg_cron "meego-scan") ---------- */
function atr(c, n = 14) {
  const tr = c.slice(-n - 1).map((x, i, a) => (i ? Math.max(x.h - x.l, Math.abs(x.h - a[i - 1].c), Math.abs(x.l - a[i - 1].c)) : 0)).slice(1);
  return tr.length ? tr.reduce((s, v) => s + v, 0) / tr.length : 0;
}
// Each check looks at closed candles c (oldest first) for a trade in direction dir (+1 buy, -1 sell).
// Pullback to the EMA: touched it in the last few candles and closed back on the trend side
function emaPullback(c, dir, n, look) {
  const e = ema(c.map((x) => x.c), n), i = c.length - 1, a = atr(c);
  const touched = c.slice(-look).some((x, k) => (dir > 0 ? x.l <= e[i - look + 1 + k] : x.h >= e[i - look + 1 + k]));
  return touched && (c[i].c - e[i]) * dir > 0 && Math.abs(c[i].c - e[i]) < a;
}
// Swing highs and lows (pivots), k candles on each side
function pivots(c, k = 3) {
  const hi = [], lo = [];
  for (let i = k; i < c.length - k; i++) {
    const w = c.slice(i - k, i + k + 1);
    if (c[i].h === Math.max(...w.map((x) => x.h))) hi.push({ i, v: c[i].h });
    if (c[i].l === Math.min(...w.map((x) => x.l))) lo.push({ i, v: c[i].l });
  }
  return { hi, lo };
}
// Rejected a support (buy) / resistance (sell) zone made by older swing points
function snrRejection(c, dir, pv, a) {
  const zone = (dir > 0 ? pv.lo : pv.hi).filter((p) => p.i < c.length - 6).map((p) => p.v);
  const recent = c.slice(-3), tip = dir > 0 ? Math.min(...recent.map((x) => x.l)) : Math.max(...recent.map((x) => x.h));
  return zone.some((v) => Math.abs(tip - v) <= 0.3 * a && (c[c.length - 1].c - v) * dir > 0);
}
// Broke an old resistance (buy) / support (sell), came back to retest it, and held
function breakRetest(c, dir, pv, a) {
  const n = c.length, levels = (dir > 0 ? pv.hi : pv.lo).filter((p) => p.i < n - 8).map((p) => p.v);
  return levels.some((v) => {
    const broke = c.slice(-12, -2).some((x) => (x.c - v) * dir > 0.2 * a);
    const retest = c.slice(-3).some((x) => Math.abs((dir > 0 ? x.l : x.h) - v) <= 0.3 * a);
    return broke && retest && (c[n - 1].c - v) * dir > 0;
  });
}
// Break of structure: a recent close beyond the last swing high (buy) / low (sell)
function bos(c, dir, pv) {
  const last = (dir > 0 ? pv.hi : pv.lo).filter((p) => p.i < c.length - 5).slice(-1)[0];
  return !!last && c.slice(-5).some((x) => (x.c - last.v) * dir > 0);
}
// Liquidity sweep: poked past the recent low (buy) / high (sell) then closed back inside
function sweep(c, dir) {
  const base = c.slice(-23, -3), recent = c.slice(-3);
  if (base.length < 10) return false;
  if (dir > 0) { const lo = Math.min(...base.map((x) => x.l)); return recent.some((x) => x.l < lo && x.c > lo); }
  const hi = Math.max(...base.map((x) => x.h)); return recent.some((x) => x.h > hi && x.c < hi);
}
// Rejection candle: pin bar or engulfing in the trade direction
function rejectionCandle(c, dir) {
  const x = c[c.length - 1], p = c[c.length - 2], body = Math.abs(x.c - x.o), range = x.h - x.l || 1e-9;
  const wick = dir > 0 ? Math.min(x.o, x.c) - x.l : x.h - Math.max(x.o, x.c);
  const pin = wick >= 2 * body && wick >= 0.5 * range;
  const engulf = (x.c - x.o) * dir > 0 && (p.c - p.o) * dir < 0 && Math.abs(x.c - x.o) > Math.abs(p.c - p.o) && (x.c - p.o) * dir > 0;
  return pin || engulf;
}
// ---- Zone setups (price must come back INTO a zone) + a confirmation candle ----
// Supply & demand: the small "base" candle right before a strong impulse candle; first return of price into that base
function sndZone(c, dir, a) {
  const n = c.length;
  for (let i = n - 6; i >= Math.max(1, n - 80); i--) {
    const base = c[i], imp = c[i + 1];
    if ((imp.c - imp.o) * dir < 1.5 * a || Math.abs(base.c - base.o) > 0.6 * a) continue;
    const top = dir > 0 ? Math.max(base.o, base.c) : base.h, bot = dir > 0 ? base.l : Math.min(base.o, base.c);
    const between = c.slice(i + 2, n - 3);
    if (between.some((x) => (dir > 0 ? x.l <= top : x.h >= bot))) continue; // not fresh any more
    const recent = c.slice(-3);
    const touched = recent.some((x) => (dir > 0 ? x.l <= top : x.h >= bot));
    const held = dir > 0 ? c[n - 1].c > bot : c[n - 1].c < top;
    if (touched && held) return true;
  }
  return false;
}
// SMC: a break of structure, then price returns to the order block (last opposite candle before the break)
function orderBlock(c, dir, pv, a) {
  const n = c.length, swings = (dir > 0 ? pv.hi : pv.lo);
  for (let k = n - 4; k >= Math.max(10, n - 30); k--) {
    const prior = swings.filter((p) => p.i < k - 1).slice(-1)[0];
    if (!prior || (c[k].c - prior.v) * dir <= 0 || (c[k - 1].c - prior.v) * dir > 0) continue; // c[k] is the breaking candle
    let j = k - 1;
    while (j > k - 10 && (c[j].c - c[j].o) * dir >= 0) j--;
    const ob = c[j];
    if ((ob.c - ob.o) * dir >= 0) return false;
    const top = ob.h, bot = ob.l;
    const touched = c.slice(-3).some((x) => (dir > 0 ? x.l <= top : x.h >= bot));
    const held = dir > 0 ? c[n - 1].c > bot : c[n - 1].c < top;
    return touched && held && Math.abs(top - bot) <= 2 * a;
  }
  return false;
}
// BBMA re-entry: a recent close outside the Bollinger Band (momentum), then a pullback to MA5/MA10 that holds
function lwma(arr, n, i) { let s = 0, w = 0; for (let k = 0; k < n; k++) { s += arr[i - k] * (n - k); w += n - k; } return s / w; }
function bbmaReentry(c, dir) {
  const n = c.length;
  if (n < 45) return false;
  const cl = c.map((x) => x.c), hi = c.map((x) => x.h), lo = c.map((x) => x.l);
  const band = (i) => { const w = cl.slice(i - 19, i + 1), m = w.reduce((t, v) => t + v, 0) / 20, sd = Math.sqrt(w.reduce((t, v) => t + (v - m) ** 2, 0) / 20); return { m, up: m + 2 * sd, dn: m - 2 * sd }; };
  let extreme = false;
  for (let i = n - 20; i < n - 3; i++) { const b = band(i); if (dir > 0 ? cl[i] > b.up : cl[i] < b.dn) extreme = true; }
  if (!extreme) return false;
  const b = band(n - 1);
  if (dir > 0 ? cl[n - 1] < b.m : cl[n - 1] > b.m) return false;
  const src = dir > 0 ? lo : hi;
  const touched = [n - 3, n - 2, n - 1].some((i) => { const ma = Math.max(lwma(src, 5, i), lwma(src, 10, i)) * (dir > 0 ? 1 : 0) + Math.min(lwma(src, 5, i), lwma(src, 10, i)) * (dir > 0 ? 0 : 1); return dir > 0 ? lo[i] <= ma : hi[i] >= ma; });
  return touched && (dir > 0 ? cl[n - 1] > lwma(lo, 5, n - 1) : cl[n - 1] < lwma(hi, 5, n - 1));
}
// Confirmation on the last closed candle: pin bar / engulfing, or a strong momentum close in the trade direction
function confirmCandle(c, dir, a) {
  if (rejectionCandle(c, dir)) return "rejection candle";
  const x = c[c.length - 1], body = (x.c - x.o) * dir, range = x.h - x.l || 1e-9;
  if (body >= 0.6 * range && body >= 0.6 * a) return "momentum candle";
  return null;
}
// Every setup needs zone(s) (SNR hold, SNR break & retest, supply/demand, SMC order block, BBMA re-entry) AND a confirmation candle.
// Tuned per type on 66 days of gold (backtest): zones = how many zone setups must line up, snrHold = whether a plain SNR hold counts.
const SETUP_RULE = { Scalping: { zones: 1, snrHold: true }, Intraday: { zones: 2, snrHold: false }, Swing: { zones: 1, snrHold: false } };
// trend: higher timeframes that must agree (need) and that add a point when they agree (bonus)
// min: score needed. step: every `step` hours without a signal of this kind, the score needed drops by 1 (down to floor),
// so there is at least one signal a day. open: how many may run at once. cool: hours to wait after the last one.
const AUTO = {
  Scalping: { tf: "m5", ema: 20, look: 3, need: ["m15"], bonus: ["m5", "h1"], min: 4, floor: 2, step: 2, buf: 0.2, rr: 1.5, life: 3, cool: 0.5, max: 5, open: 1, maxPips: 80 },
  Intraday: { tf: "m15", ema: 20, look: 3, need: ["h1"], bonus: ["m15", "h4"], min: 5, floor: 2, step: 3, buf: 0.2, rr: 2, life: 24, cool: 1, max: 3, open: 2 },
  Swing: { tf: "h1", ema: 50, look: 4, need: ["h4"], bonus: ["h1", "d1"], min: 6, floor: 2, step: 4, buf: 0.3, rr: 2, life: 72, cool: 4, max: 2, open: 2 },
};
// Limit entry: placed k of the way from price to the SL; cancelled if not reached within `expire` hours
const LIMIT = { pips: 100, k: 0.6, expire: 8 };
// Never post a setup scoring below this (grade C+), however quiet the day has been
const MIN_SCORE = 5;
const TF_NAME = { m5: "M5", m15: "M15", h1: "H1", h4: "H4", d1: "D1" };
const relaxDrop = (kind, hoursQuiet) => Math.max(0, Math.min(AUTO[kind].min - AUTO[kind].floor, Math.floor(hoursQuiet / AUTO[kind].step)));
// Confluence score out of 9: 1 for the required trend, up to 2 more trends, and 1 per pattern (6 patterns).
// drop lowers the score needed; at drop 2+ other trends are ignored.
// Sideways filter: the main trend (M15 scalping, H1 intraday, H4 swing) must always be trending the trade's way, never sideways.
function findSetup(kind, d, price, drop = 0) {
  const r = AUTO[kind], c = d[r.tf];
  if (!c || c.length < 60) return null;
  const cc = c.slice(-120), a = atr(c), pv = pivots(cc);
  if (!a) return null;
  let best = null;
  for (const dir of [1, -1]) {
    const needOk = r.need.every((k) => d.trend[k] === dir);
    if (!needOk || (drop < 2 && r.bonus.some((k) => d.trend[k] === -dir))) continue;
    const last = c[c.length - 1];
    if ((last.c - last.o) * dir <= 0) continue; // the trigger candle must close in the trade direction
    const why = r.need.filter((k) => d.trend[k] === dir).concat(r.bonus.filter((k) => d.trend[k] === dir)).map((k) => `${TF_NAME[k]} trend`);
    const trends = why.length;
    if (emaPullback(c, dir, r.ema, r.look)) why.push(`EMA${r.ema} pullback`);
    if (snrRejection(cc, dir, pv, a)) why.push(dir > 0 ? "support hold" : "resistance hold");
    if (breakRetest(cc, dir, pv, a)) why.push("SNR break & retest");
    if (bos(cc, dir, pv)) why.push("BOS");
    if (sweep(c, dir)) why.push("liquidity sweep");
    if (rejectionCandle(c, dir)) why.push("rejection candle");
    if (why.length < Math.max(MIN_SCORE, r.min - drop) || why.length === trends) continue; // always at least one price pattern
    const zones = [];
    const rule = SETUP_RULE[kind] || { zones: 1, snrHold: true };
    if (rule.snrHold && (why.includes("support hold") || why.includes("resistance hold"))) zones.push("SNR hold");
    if (why.includes("SNR break & retest")) zones.push("SNR break & retest");
    if (sndZone(c, dir, a)) zones.push(dir > 0 ? "demand zone" : "supply zone");
    if (orderBlock(cc, dir, pv, a)) zones.push("SMC order block");
    if (bbmaReentry(c, dir)) zones.push("BBMA re-entry");
    const confirm = confirmCandle(c, dir, a);
    if (zones.length < rule.zones || !confirm) continue;
    // SL beyond the nearest swing point (or the sweep wick), with a small buffer
    // Try the last 12, 6 then 3 candles, so the SL is as close as structure allows (gold scalps: within maxPips)
    const sym = d.sym || "XAUUSD";
    const maxRisk = Math.min(3 * a, r.maxPips && /^XAU/.test(sym) ? r.maxPips * pip(sym) : Infinity);
    let sl = null, risk = 0;
    for (const n of [12, 6, 3]) {
      const near = c.slice(-n);
      const s = dir > 0 ? Math.min(...near.map((x) => x.l)) - r.buf * a : Math.max(...near.map((x) => x.h)) + r.buf * a;
      const rk = (price - s) * dir;
      if (rk >= 0.4 * a && rk <= maxRisk) { sl = s; risk = rk; break; }
    }
    if (sl === null) continue;
    if (!best || why.length > best.score) best = { dir, entry: price, sl, tp: price + dir * r.rr * risk, score: why.length, note: `🤖 MEEGO AI · Setup: ${zones.join(" + ") || "trend pullback"} · Confirmation: ${confirm || "candle close"} · Confluence ${why.length}/9: ${why.join(" + ")}` };
  }
  return best;
}
// Forex/gold trade Sun 22:00 to Fri 21:00 UTC
function marketOpen(now, sym) {
  if (/BTC|ETH/.test(sym)) return true;
  const day = now.getUTCDay(), h = now.getUTCHours();
  return !(day === 6 || (day === 0 && h < 22) || (day === 5 && h >= 21));
}
const closedPips = (s) => Math.round(((Number(s.exit) - s.entry) * s.dir) / pip(s.sym));
async function setStatus(s, status, exit) {
  const { id, ...data } = s;
  await db.from("signals").update({ data: { ...data, status, exit: exit ?? null, closedAt: Date.now() }, updated_at: new Date().toISOString() }).eq("id", id);
}
// Hit TP / Hit SL / time out for running auto signals
async function watchSignals(list) {
  const bySym = {};
  for (const s of list) (bySym[s.sym] ??= []).push(s);
  for (const [sym, sigs] of Object.entries(bySym)) {
    const m1 = await candles(sym, "1min");
    if (!m1.length) continue;
    let m15 = null;
    for (const s of sigs) {
      let path = m1.filter((x) => x.t >= s.time);
      if (m1[0].t > s.time) path = (m15 ??= await candles(sym, "15min")).filter((x) => x.t >= s.time);
      let hit = null, filled = s.pending ? null : s.filled || s.time;
      const stage0 = s.tpHit || 0;
      for (const x of path) {
        if (!filled) {
          if (x.t - s.time > (s.expire ?? LIMIT.expire) * 3600000) break;
          if (!(s.dir > 0 ? x.l <= s.entry : x.h >= s.entry)) continue;
          filled = x.t; // limit order filled on this candle; check SL/TP from here on
        }
        if (s.tps) {
          if (s.stageAt && x.t <= s.stageAt) continue; // candles already checked before the last TP
          if (s.dir > 0 ? x.l <= s.sl : x.h >= s.sl) { hit = (s.tpHit || 0) === 0 ? "sl" : s.tpHit === 1 ? "be" : "tp"; break; }
          let up = false;
          while ((s.tpHit || 0) < 3 && (s.dir > 0 ? x.h >= s.tps[s.tpHit || 0] : x.l <= s.tps[s.tpHit || 0])) {
            s.tpHit = (s.tpHit || 0) + 1; up = true;
            s.sl = s.tpHit === 1 ? s.entry : s.tps[s.tpHit - 2]; // TP1: SL to entry, TP2: SL to TP1
          }
          if (up) s.stageAt = x.t;
          if (s.tpHit >= 3) { hit = "tp"; break; }
          continue;
        }
        const slHit = s.dir > 0 ? x.l <= s.sl : x.h >= s.sl, tpHit = s.dir > 0 ? x.h >= s.tp : x.l <= s.tp;
        if (slHit) { hit = "sl"; break; }
        if (tpHit) { hit = "tp"; break; }
      }
      const justFilled = s.pending && filled;
      if (justFilled) Object.assign(s, { pending: false, filled });
      if (hit) await setStatus(s, hit);
      else if ((s.tpHit || 0) > stage0) { // a TP was hit: save it (members get a "TP1 HIT" message)
        const { id, ...data } = s;
        await db.from("signals").update({ data, updated_at: new Date().toISOString() }).eq("id", id);
      }
      else if (!filled) { if (Date.now() - s.time > (s.expire ?? LIMIT.expire) * 3600000) await setStatus(s, "cancelled"); }
      else if (Date.now() - filled > (s.life ?? AUTO[s.kind].life) * 3600000) await setStatus(s, "closed", m1[m1.length - 1].c);
      else if (justFilled) {
        const { id, ...data } = s;
        await db.from("signals").update({ data, updated_at: new Date().toISOString() }).eq("id", id);
      }
    }
  }
}
/* ---------- news: prediction + signal ~2 minutes before 🔴 USD news, and a recovery setup if the spike hits SL ---------- */
const numOf = (v) => { const n = parseFloat(String(v ?? "").replace(/[%KMBT,]/gi, "")); return Number.isFinite(n) ? n : null; };
const usdInverse = (title) => /unemploy|jobless|claims/i.test(title); // higher number = weaker USD
// Prediction for the 🔴 events at one time: forecast vs previous decides USD; the H1 chart trend breaks a tie
function predictNews(evs, h1) {
  let usd = 0;
  const pred = evs.map((e) => {
    const f = numOf(e.forecast), pr = numOf(e.previous);
    if (f === null || pr === null || f === pr) return `• ${esc(e.title)}: ${f === null ? "no forecast" : `expected same as before (${esc(e.forecast)})`}`;
    const up = f > pr, good = up !== usdInverse(e.title);
    usd += good ? 1 : -1;
    return `• ${esc(e.title)}: likely <b>${up ? "HIGHER" : "LOWER"}</b> (F ${esc(e.forecast)} vs P ${esc(e.previous)}) → USD ${good ? "stronger" : "weaker"}`;
  });
  const chart = tfTrend((h1 || []).slice(0, -1)) || 0;
  const dir = usd ? -Math.sign(usd) : chart; // strong USD = gold down
  // News call against (or without) the H1 trend: skipped. In the backtest these lost most often; without them 7 of 8 news trades hit TP1.
  if (usd && chart !== dir) return { pred, chart, dir: 0, lean: dir, conf: "Skip (news and chart disagree)", usd };
  const conf = usd ? "Strong (news + chart agree)" : chart ? "Low (chart trend only)" : "None";
  return { pred, chart, dir, conf, usd };
}
const callTxt = (d) => (d > 0 ? "🟢 <b>BUY XAUUSD</b>" : d < 0 ? "🔴 <b>SELL XAUUSD</b>" : "⚪ <b>NO TRADE</b> (wait for the spike)");
const biasTxt = (d) => (d > 0 ? "🟢 BULLISH" : d < 0 ? "🔴 BEARISH" : "⚪ NEUTRAL");
async function newsAlert() {
  const now = Date.now();
  await newsRecovery().catch((e) => console.error("news recovery failed", e));
  if (!marketOpen(new Date(now), "XAUUSD")) return;
  const list = await newsWeek(100000).catch(() => []);
  const high = list.filter((e) => e.impact === "High" && e.t > now);
  if (!high.length) return;
  const cfg = await settings();
  const t0 = high[0].t, evs = high.filter((e) => e.t === t0), left = t0 - now;
  let early = null;
  try { early = cfg.news_early ? JSON.parse(cfg.news_early) : null; } catch (_) { early = null; }
  // 1) Early prediction, about an hour before
  if (left > 150000 && left <= 60 * 60000 && early?.t !== t0) {
    const p = predictNews(evs, await candles("XAUUSD", "1h"));
    await db.from("app_settings").upsert({ key: "news_early", value: JSON.stringify({ t: t0, dir: p.dir }) });
    await broadcast(await audience("Scalping"), [
      `🔮 <b>EARLY PREDICTION</b> · 🔴 news at ${myTime(t0)} (Malaysia), in ${Math.round(left / 60000)} min`,
      "",
      ...p.pred,
      "",
      `MEEGO AI call: ${callTxt(p.dir)}`,
      `Chart trend H1: ${biasTxt(p.chart)} · Confidence: <b>${p.conf}</b>`,
      "",
      "Final call and the news signal come about 2 minutes before the news. If MEEGO AI changes its mind you'll see 🔄 <b>CHANGED</b>.",
      "<i>A prediction is not a guarantee.</i>",
    ].join("\n"));
    return;
  }
  // 2) Final call + news signal, about 2 minutes before
  if (left > 150000 || Number(cfg.news_alerted || 0) >= t0) return;
  await db.from("app_settings").upsert({ key: "news_alerted", value: String(t0) });
  const [m1, m15, h1] = [await candles("XAUUSD", "1min"), await candles("XAUUSD", "15min"), await candles("XAUUSD", "1h")];
  const price = m1[m1.length - 1]?.c, a = atr(m15.slice(0, -1));
  const { pred, chart, dir, conf } = predictNews(evs, h1);
  const change = early?.t !== t0 ? "" : early.dir === dir ? "✅ Same as the early prediction" : `🔄 <b>CHANGED</b>: early call was ${callTxt(early.dir)}, now ${callTxt(dir)}`;
  const head = [
    `⚠️ <b>NEWS IN ${Math.max(1, Math.round(left / 60000))} MIN</b> · 🔴 ${myTime(t0)} (Malaysia)`,
    "",
    "🔮 <b>MEEGO AI final call</b>",
    ...pred,
    "",
    `Call: ${callTxt(dir)}`,
    ...(change ? [change] : []),
    `Bias: XAUUSD <b>${biasTxt(dir)}</b> · BTCUSD <b>${biasTxt(dir)}</b>`,
    `Chart trend H1: ${biasTxt(chart)} · Confidence: <b>${conf}</b>`,
    "",
    dir ? "📰 News signal below. Spreads widen at news time: use a small lot." : conf.startsWith("Skip") ? "The news and the chart point different ways, so MEEGO AI skips this one. Wait for the spike to finish." : "No clear bias, so no news signal this time. Wait for the spike to finish.",
    "<i>A prediction is not a guarantee. The real number can surprise.</i>",
  ];
  await broadcast(await audience("Scalping"), head.join("\n"));
  if (!dir || !price || !a) return;
  const risk = 1.2 * a, d = digits("XAUUSD"), e0 = Number(price.toFixed(d)), sl0 = Number((price - dir * risk).toFixed(d));
  const score = conf.startsWith("Strong") ? 7 : 5;
  await db.from("signals").insert({ id: crypto.randomUUID(), data: {
    kind: "Scalping", sym: "XAUUSD", dir, entry: e0, sl: sl0, ...tpPlan("XAUUSD", dir, e0, sl0),
    score, order: "instant", news: "pre", newsAt: t0, note: `🤖 MEEGO AI · News play: ${evs.map((e) => e.title).join(" + ")}`,
    status: "running", auto: true, time: Date.now(), closedAt: null } });
}
// After a news signal hits SL: trade WITH the spike, entering on a 38% pullback (same lot, never bigger)
async function newsRecovery() {
  const { data } = await db.from("signals").select("id,data").order("updated_at", { ascending: false }).limit(50);
  const lost = (data ?? []).map((r) => ({ id: r.id, ...r.data })).filter((s) => s.news === "pre" && s.status === "sl" && !s.recovered && s.closedAt && Date.now() - s.closedAt >= 3 * 60000 && Date.now() - s.closedAt < 60 * 60000);
  for (const s of lost) {
    const { id, ...rest } = s;
    await db.from("signals").update({ data: { ...rest, recovered: true } }).eq("id", id);
    const m1 = (await candles(s.sym, "1min")).filter((x) => x.t >= s.time);
    if (m1.length < 3) continue;
    const dir = -s.dir, price = m1[m1.length - 1].c;
    const extreme = dir > 0 ? Math.max(...m1.map((x) => x.h)) : Math.min(...m1.map((x) => x.l));
    const spike = Math.abs(extreme - s.entry);
    if (!spike) continue;
    let entry = extreme - dir * 0.382 * spike;
    const sl = extreme - dir * 0.786 * spike;
    let order = "limit";
    if ((price - entry) * dir <= 0) { // price already pulled back past the entry
      if ((price - sl) * dir <= 0.15 * spike) continue; // too close to the SL, skip
      entry = price; order = "instant";
    }
    const d = digits(s.sym), e0 = Number(entry.toFixed(d)), sl0 = Number(sl.toFixed(d));
    await db.from("signals").insert({ id: crypto.randomUUID(), data: {
      kind: "Scalping", sym: s.sym, dir, entry: e0, sl: sl0, ...tpPlan(s.sym, dir, e0, sl0),
      score: 5, order, pending: order === "limit", expire: 2, news: "recovery", note: `🤖 MEEGO AI · Recovery after news spike: follow the spike, enter on the pullback · same lot, never bigger`,
      status: "running", auto: true, time: Date.now(), closedAt: null } });
  }
}
/* ---------- 9:59 AM setup (Malaysia): follow the 9-10 AM candle when it agrees with the H1 trend ---------- */
// About 2 years of hourly gold futures (4 pips spread): 132 trades, 66% reached TP1, +30.7R. Same rule at other hours did far worse.
// Checked every minute by the "news" cron: 9:55 heads-up, 9:59 signal.
const NINE = { body: 0.3, sl: 0.8, min: 3, max: 15, life: 6 };
async function nineSetup(now = Date.now()) {
  const d = new Date(now), day = d.getUTCDay(), min = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day < 1 || day > 5) return;
  const early = min >= 115 && min <= 117, final = min >= 119 && min <= 121; // 9:55-9:57 and 9:59-10:01 Malaysia time
  if (!early && !final) return;
  const key = d.toISOString().slice(0, 10), open = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1);
  const cfg = await settings();
  if (cfg.auto_scan === "off") return;
  if (early ? cfg.nine_early === key : cfg.nine_done === key) return;
  const [m1, h1] = [await candles("XAUUSD", "1min"), await candles("XAUUSD", "1h")];
  const hour = m1.filter((x) => x.t >= open && x.t < open + 3600000), past = h1.filter((x) => x.t + 3600000 <= open);
  if (hour.length < 30 || hour[0].t - open > 5 * 60000 || hour[hour.length - 1].t < open + (early ? 50 : 57) * 60000) return; // prices missing or late (cached up to 3 min): try again next minute
  if (past.length < 60 || open - past[past.length - 1].t > 3 * 3600000) return;
  const a = atr(past), trend1 = tfTrend(past) || 0, price = hour[hour.length - 1].c, move = price - hour[0].o;
  if (!a) return;
  const dir = trend1 && Math.sign(move) === trend1 && Math.abs(move) >= NINE.body * a ? trend1 : 0;
  await db.from("app_settings").upsert({ key: early ? "nine_early" : "nine_done", value: key });
  const chats = await audience("Intraday");
  if (early) {
    if (!trend1) return;
    return broadcast(chats, [
      "⏰ <b>9:59 AM SETUP · heads-up</b>",
      "",
      `H1 trend: ${biasTxt(trend1)}`,
      `9-10 AM candle so far: ${biasTxt(Math.sign(move))} (${Math.round(Math.abs(move) / pip("XAUUSD"))} pips)`,
      dir ? `Possible ${callTxt(dir)}` : "They don't line up yet, so there may be no setup today.",
      "",
      "Don't enter yet. The signal comes at 9:59 AM only if the candle agrees with the trend.",
    ].join("\n"));
  }
  if (!dir) {
    if (cfg.nine_early === key && trend1) await broadcast(chats, "⏰ <b>9:59 AM SETUP</b>\nNo setup today: the 9-10 AM candle doesn't agree with the H1 trend.");
    return;
  }
  const dg = digits("XAUUSD"), risk = Math.min(NINE.max, Math.max(NINE.min, NINE.sl * a));
  const last = m1[m1.length - 1].c, entry = Number(last.toFixed(dg)), sl = Number((last - dir * risk).toFixed(dg));
  await db.from("signals").insert({ id: crypto.randomUUID(), data: {
    kind: "Intraday", sym: "XAUUSD", dir, entry, sl, ...tpPlan("XAUUSD", dir, entry, sl), order: "instant", nine: true, life: NINE.life,
    note: "🤖 MEEGO AI · 9:59 AM setup: the 9-10 AM candle and the H1 trend agree · closes after 6 hours",
    status: "running", auto: true, time: Date.now(), closedAt: null } });
}
async function autoScan() {
  const cfg = await settings();
  if (cfg.auto_scan === "off") return;
  const { data } = await db.from("signals").select("id,data").order("updated_at", { ascending: false }).limit(300);
  const all = (data ?? []).map((r) => ({ id: r.id, ...r.data })).filter((s) => s && s.sym);
  const running = all.filter((s) => s.status === "running" && s.auto);
  if (running.length) await watchSignals(running);
  const now = new Date();
  if (now.getUTCMinutes() % 15 >= 5) return; // look for new setups every 15 minutes
  const pairs = String(cfg.scan_pairs || "XAUUSD").split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);
  for (const sym of pairs) {
    if (!marketOpen(now, sym)) continue;
    const m1 = await candles(sym, "1min");
    if (!m1.length || Date.now() - m1[m1.length - 1].t > 20 * 60000) continue; // no fresh prices (holiday)
    const m15 = await candles(sym, "15min"), h1 = await candles(sym, "1h");
    const price = m1[m1.length - 1].c;
    const closed = (c) => c.slice(0, -1); // drop the candle that is still forming
    const d = { sym, m5: closed(group(m1, 5)), m15: closed(m15), h1: closed(h1), h4: closed(group(h1, 240)), d1: closed(group(h1, 1440)) };
    d.trend = { m5: tfTrend(d.m5), m15: tfTrend(d.m15), h1: tfTrend(d.h1), h4: tfTrend(d.h4), d1: tfTrend(d.d1) };
    for (const kind of ["Swing", "Intraday", "Scalping"]) {
      const mine = all.filter((s) => s.kind === kind && s.sym === sym && s.auto && !s.nine);
      if (mine.filter((s) => s.status === "running").length >= AUTO[kind].open) continue;
      const lastEnd = Math.max(0, ...mine.map((s) => s.closedAt || s.time));
      if (Date.now() - lastEnd < AUTO[kind].cool * 3600000) continue;
      if (mine.filter((s) => s.time >= Date.now() - 86400000).length >= AUTO[kind].max) continue;
      // The longer it's been quiet today, the lower the score needed (so there's at least one a day)
      const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
      const quiet = (Date.now() - Math.max(dayStart, ...mine.map((s) => s.time))) / 3600000;
      const s = findSetup(kind, d, price, relaxDrop(kind, quiet));
      if (!s) continue;
      // Sharp entry: when the stop is far (gold Intraday/Swing over LIMIT.pips), wait for a pullback with a limit order
      const risk = Math.abs(s.entry - s.sl);
      if (kind !== "Scalping" && /^XAU/.test(sym) && risk / pip(sym) > LIMIT.pips) {
        s.entry -= s.dir * LIMIT.k * risk;
        s.tp = s.entry + s.dir * AUTO[kind].rr * Math.abs(s.entry - s.sl);
        Object.assign(s, { order: "limit", pending: true });
      } else s.order = "instant";
      for (const k of ["entry", "sl"]) s[k] = Number(s[k].toFixed(digits(sym)));
      Object.assign(s, tpPlan(sym, s.dir, s.entry, s.sl));
      await db.from("signals").insert({ id: crypto.randomUUID(), data: { kind, sym, ...s, status: "running", auto: true, time: Date.now(), closedAt: null } });
    }
  }
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
  const prompt = `You are a professional price-action trader. The image is a trading chart screenshot${pairHint ? ` (the user says ${pairHint}, but trust the ticker shown on the chart)` : ""}.
Read the price axis carefully to get real price levels. Identify the pair and timeframe if visible, the trend, structure, key support and resistance, and momentum.
Give ONE trade idea only if risk-to-reward is at least 1.5, otherwise direction "WAIT".
Reply with ONLY one JSON object:
"pair" must be ONLY the short ticker read from the chart itself, e.g. "XAUUSD", "BTCUSD", "EURUSD" (no spaces, no explanation). If the user's caption names a different pair than the chart shows, silently use the chart's ticker. Do not mention the caption or any mismatch anywhere.
{"pair":"TICKER or null","direction":"BUY|SELL|WAIT","confidence":0-100,"timeframe":"text or null","entry":number|null,"sl":number|null,"tp":number|null,"reason":"2-4 sentences in English","invalidation":"text"}
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
  const first = String(r.pair || "").toUpperCase().split(/[\s(,;:·|-]+/).map((w) => w.replace(/[^A-Z0-9]/g, "")).find((w) => w.length >= 3) || "";
  const sym = (first && first.length <= 10 ? first : pairHint) || "PAIR";
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


/* ---------- payments: pick a plan → bank transfer → receipt checked by MEEGO AI → admin taps Approve ---------- */
const PRICES = { Basic: { rm: 20, days: 30 }, Pro: { rm: 35, days: 30 }, Ultimate: { rm: 50, days: 30 } };
async function prices() {
  const cfg = await settings();
  let p = {};
  try { p = cfg.plan_prices ? JSON.parse(cfg.plan_prices) : {}; } catch (_) { p = {}; }
  return Object.fromEntries(TIERS.map((t) => [t, { ...PRICES[t], ...(p[t] || {}) }]));
}
async function bankInfo() {
  const cfg = await settings();
  // one or more accounts: [{bank, name, acc}]
  try {
    const b = cfg.pay_bank ? JSON.parse(cfg.pay_bank) : null;
    const list = (Array.isArray(b) ? b : b ? [b] : []).filter((x) => x && x.bank && x.name && x.acc);
    return list.length ? list : null;
  } catch (_) { return null; }
}
async function adminIds() { return ((await db.from("telegram_users").select("chat_id").eq("is_admin", true)).data ?? []).map((r) => r.chat_id); }
async function showPlans(chatId, intro) {
  const pr = await prices();
  const lines = [
    intro || "💳 <b>MEEGO AI plans</b>",
    "",
    ...TIERS.map((t) => `${t === "Ultimate" ? "⭐" : "•"} <b>${t}</b> · RM${pr[t].rm} for ${pr[t].days} days`),
    "",
    "All plans: ⚡ Scalping, 📈 Intraday, 📰 News signals, 🧭 Direction, 🖼 Chart Scanner, 📊 History.",
    "⭐ <b>Priority Swing</b> signals are for <b>Ultimate</b> only.",
    "",
    "Tap a plan to pay by bank transfer:",
  ];
  return send(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: [TIERS.map((t) => ({ text: `${t} · RM${pr[t].rm}`, callback_data: `buy|${t}` }))] } });
}
async function startPayment(chatId, tier) {
  if (!TIERS.includes(tier)) return;
  const bank = await bankInfo();
  if (!bank) {
    for (const ad of await adminIds()) await send(ad, "⚠️ A customer tried to pay but the bank details aren't set. Send:\n<code>/setbank Bank name | Account holder name | Account number</code>");
    return send(chatId, "Online payment isn't ready yet. Please contact the admin.");
  }
  const pr = (await prices())[tier];
  const { data, error } = await db.from("tg_payments").insert({ chat_id: chatId, tier, amount: pr.rm, days: pr.days, status: "waiting" }).select("id").single();
  if (error || !data) return send(chatId, "Something went wrong. Please try again in a minute.");
  await setState(chatId, `pay|${data.id}`);
  return send(chatId, [
    `💳 <b>MEEGO AI · ${tier}</b> · RM${pr.rm} for ${pr.days} days`,
    "",
    bank.length > 1 ? "Transfer to <b>any one</b> of these accounts:" : "Transfer to:",
    ...bank.flatMap((b, i) => ["", `🏦 ${bank.length > 1 ? `${i + 1}. ` : ""}<b>${esc(b.bank)}</b>`, `👤 ${esc(b.name)}`, `🔢 <code>${esc(b.acc)}</code>`]),
    "",
    `Transfer exactly <b>RM${pr.rm}</b>, then send the <b>receipt screenshot</b> (or PDF) here.`,
    "MEEGO AI checks it and your plan turns on as soon as it's confirmed.",
  ].join("\n"));
}
const normName = (v) => String(v || "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
const digitsOf = (v) => String(v || "").replace(/\D/g, "");
// Compare what the AI read on the receipt with the admin's bank details and the plan price
// Name and account must match the SAME bank account. Common name words (BIN, MUHAMMAD...) prove nothing, so they don't count.
const COMMON_NAME = new Set(["BIN", "BINTI", "BT", "BTE", "BNT", "B", "AL", "AP", "MUHAMMAD", "MUHAMAD", "MOHAMMAD", "MOHAMAD", "MOHAMMED", "MOHAMED", "MUHAMMED", "MOHD", "MUHD", "MD", "NUR", "NOR", "SITI", "ABDUL", "ABD", "AHMAD"]);
function nameMatches(gotRaw, wantRaw) {
  const got = normName(gotRaw), want = normName(wantRaw);
  if (!got || !want) return false;
  if (got === want) return true;
  const g = got.split(" "), w = want.split(" "), key = w.filter((x) => !COMMON_NAME.has(x));
  // a receipt may cut a long name short, but it has to be the start of the full name and show the distinctive words
  if (want.startsWith(got) && g.length >= 2) {
    const whole = g.filter((x, i) => !COMMON_NAME.has(x) && w[i] === x).length;
    return whole >= Math.min(2, key.length) && got.length >= 12;
  }
  // abbreviations (MUHAMMAD -> MOHD, BIN -> B): every distinctive word must still be there, and nothing distinctive added
  const gk = g.filter((x) => !COMMON_NAME.has(x));
  return key.length > 0 && key.length === gk.length && key.every((x, i) => gk[i] === x);
}
// "yes" = full number, "part" = only the visible digits of a masked number match, "no"
function accountMatches(accRaw, acc) {
  const raw = String(accRaw || ""), d = digitsOf(raw), my = digitsOf(acc);
  if (!d) return "no";
  if (d === my) return "yes";
  if (!/[*xX•]/.test(raw)) return "no";
  const tail = digitsOf(raw.split(/[*xX•]/).pop()), head = digitsOf(raw.split(/[*xX•]/)[0]);
  return tail.length >= 4 && my.endsWith(tail) && my.startsWith(head) ? "part" : "no";
}
function receiptChecks(r, banks, pay, dup) {
  const accRaw = String(r.recipient_account || "");
  const rows = banks.map((b) => ({ name: nameMatches(r.recipient_name, b.name), acc: accountMatches(accRaw, b.acc) }));
  const score = (x) => (x.name ? 10 : 0) + (x.acc === "yes" ? 2 : x.acc === "part" ? 1 : 0);
  const best = rows.sort((x, y) => score(y) - score(x))[0] || { name: false, acc: "no" };
  const nameOk = best.name, accOk = best.acc !== "no", partial = best.acc === "part";
  const amt = Number(String(r.amount ?? "").replace(/[^0-9.]/g, ""));
  const amtOk = Number.isFinite(amt) && amt + 0.001 >= Number(pay.amount);
  const t = r.date_time ? Date.parse(String(r.date_time).slice(0, 16) + ":00+08:00") : NaN;
  const ageH = (Date.now() - t) / 3600000;
  const dateOk = Number.isFinite(t) && ageH > -1 && ageH < 72;
  return [
    { ok: nameOk, txt: `Name: ${esc(r.recipient_name || "not found")}` },
    { ok: accOk, txt: `Account: ${esc(accRaw || "not found")}${partial ? " (hidden digits, only part could be checked)" : ""}` },
    { ok: amtOk, txt: `Amount: ${Number.isFinite(amt) ? "RM" + amt.toFixed(2) : "not found"} (needs RM${pay.amount})` },
    { ok: dateOk, txt: `Date: ${esc(r.date_time || "not found")}${Number.isFinite(t) && !dateOk ? " (too old)" : ""}` },
    { ok: r.successful === true, txt: `Status: ${r.successful === true ? "successful" : r.successful === false ? "NOT successful" : "not shown"}` },
    { ok: !dup, txt: dup ? "Used before: this receipt was already sent" : "Not used before" },
  ];
}
async function handleReceipt(chatId, a, msg, payId) {
  const { data: pay } = await db.from("tg_payments").select("*").eq("id", payId).maybeSingle();
  if (!pay || pay.status !== "waiting") { await clearState(chatId); return send(chatId, "That payment is already being handled. Tap /start to choose a plan again."); }
  let fileId, uniq, media, kind;
  if (msg.photo?.length) { const ph = msg.photo[msg.photo.length - 1]; fileId = ph.file_id; uniq = ph.file_unique_id; media = "image/jpeg"; kind = "photo"; }
  else if (msg.document) {
    const m = String(msg.document.mime_type || "");
    if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(m)) return send(chatId, "Please send the receipt as a screenshot (photo) or a PDF.");
    if ((msg.document.file_size || 0) > 10 * 1024 * 1024) return send(chatId, "That file is too big. Please send a screenshot of the receipt.");
    fileId = msg.document.file_id; uniq = msg.document.file_unique_id; media = m; kind = "document";
  } else return;
  const bank = await bankInfo();
  if (!bank) return send(chatId, "Online payment isn't ready yet. Please contact the admin.");
  await send(chatId, "🔍 MEEGO AI is checking your receipt…");
  const f = await tg("getFile", { file_id: fileId });
  if (!f.ok) return send(chatId, "Couldn't download that file. Please send it again.");
  const bytes = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`)).arrayBuffer());
  const block = media === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(bytes) } }
    : { type: "image", source: { type: "base64", media_type: media, data: toBase64(bytes) } };
  const prompt = `This should be a Malaysian bank transfer / DuitNow receipt. Read it carefully and reply with ONLY one JSON object:
{"is_receipt":true|false,"successful":true|false|null,"recipient_name":"text or null","recipient_account":"exactly as shown, keep any * masking, or null","amount":number|null,"date_time":"YYYY-MM-DDTHH:MM in the receipt's local time, or null","reference":"transaction/reference ID or null","bank":"text or null"}
recipient = the person/account the money was SENT TO (not the sender). If it is not a payment receipt, set is_receipt false.`;
  let r = null;
  try {
    const content = [block, { type: "text", text: prompt }];
    const opusLike = /^claude-(opus-5|fable|sonnet-5-5)/.test(MODEL);
    const res = opusLike
      ? await anthropic.beta.messages.create({ model: MODEL, max_tokens: 4000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "low" }, messages: [{ role: "user", content }] })
      : await anthropic.messages.create({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content }] });
    r = parseJSON(res.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  } catch (e) { console.error("receipt check failed", e); }
  if (r && r.is_receipt === false) return send(chatId, "This doesn't look like a bank transfer receipt. Please send a clear screenshot of the receipt.");
  const ref = r?.reference ? String(r.reference).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null : null;
  const { data: used } = await db.from("tg_payments").select("id").neq("id", pay.id).in("status", ["review", "approved"]).or(ref ? `file_unique_id.eq.${uniq},ref.eq.${ref.replace(/[^A-Za-z0-9_-]/g, "")}` : `file_unique_id.eq.${uniq}`).limit(1);
  const checks = r ? receiptChecks(r, bank, pay, !!(used && used.length)) : [{ ok: false, txt: "MEEGO AI couldn't read the receipt" }];
  const allOk = checks.every((c) => c.ok);
  await db.from("tg_payments").update({ status: "review", file_id: fileId, file_unique_id: uniq, file_kind: kind, ref, ai: r, checks, updated_at: new Date().toISOString() }).eq("id", pay.id);
  await clearState(chatId);
  await send(chatId, allOk
    ? "✅ Receipt received and it looks correct. The admin will confirm shortly; you'll get a message here when your plan is on."
    : `⚠️ Receipt received, but some details don't match:\n${checks.filter((c) => !c.ok).map((c) => `❌ ${c.txt}`).join("\n")}\n\nThe admin will check it. If you sent the wrong receipt, tap /start and pay again.`);
  const who = msg.from?.username ? `@${esc(msg.from.username)}` : esc(msg.from?.first_name || String(chatId));
  const caption = [
    `💳 <b>New payment</b> · ${who} (<code>${chatId}</code>)`,
    `Plan: <b>${esc(pay.tier)}</b> · RM${pay.amount} · ${pay.days} days`,
    "",
    `🤖 MEEGO AI check: ${allOk ? "<b>details match</b>" : "<b>CHECK CAREFULLY</b>"}`,
    ...checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.txt}`),
    ...(ref ? [`Ref: <code>${esc(ref)}</code>`] : []),
    "",
    "⚠️ Receipts can be edited. Check the money is in your bank before you approve.",
  ].join("\n");
  const buttons = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `pa|${pay.id}` }, { text: "❌ Reject", callback_data: `pr|${pay.id}` }]] };
  for (const ad of await adminIds()) {
    const sent = await tg(kind === "photo" ? "sendPhoto" : "sendDocument", { chat_id: ad, [kind === "photo" ? "photo" : "document"]: fileId, caption, parse_mode: "HTML", reply_markup: buttons });
    if (!sent.ok) await send(ad, caption, { reply_markup: buttons });
  }
}
async function decidePayment(adminId, msgId, id, approve) {
  const { data: pay } = await db.from("tg_payments").select("*").eq("id", id).maybeSingle();
  await tg("editMessageReplyMarkup", { chat_id: adminId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
  if (!pay) return send(adminId, "Payment not found.");
  if (pay.status !== "review" && pay.status !== "waiting") return send(adminId, `This payment was already ${esc(pay.status)}.`);
  const { data: upd } = await db.from("tg_payments").update({ status: approve ? "approved" : "rejected", updated_at: new Date().toISOString() }).eq("id", id).eq("status", pay.status).select("id");
  if (!upd || !upd.length) return send(adminId, "This payment was already handled.");
  const u = (await findUser(String(pay.chat_id))) || { chat_id: pay.chat_id, tier: null, plan_end: null };
  if (approve) {
    const end = await grant(u, pay.tier, pay.days);
    return send(adminId, `✅ Approved: ${esc(nameOf(u))} → <b>${esc(pay.tier)}</b> until <b>${end}</b>. They've been notified.`);
  }
  await send(pay.chat_id, `❌ Your payment for <b>${esc(pay.tier)}</b> couldn't be confirmed.\nIf you've paid, please contact the admin with your receipt, or tap below to try again.`, { reply_markup: { inline_keyboard: [[{ text: "💳 Choose a plan", callback_data: "plans" }]] } });
  return send(adminId, `❌ Rejected: ${esc(nameOf(u))} · ${esc(pay.tier)}. They've been told.`);
}


/* ---------- MT5 EA: a private text feed of the signals, read by MEEGO_AI_EA.mq5 every ~30 s ---------- */
// EA files live in the private table ea_files (no public read), not in the public repo
async function eaFile(name) {
  const { data } = await db.from("ea_files").select("b64").eq("name", name).maybeSingle();
  if (!data?.b64) return null;
  return Uint8Array.from(atob(data.b64.replace(/\s/g, "")), (ch) => ch.charCodeAt(0));
}
// One line per signal: S|id|kind|news|sym|dir|order|status|pending|entry|sl|tp1|tp2|tp3|tpHit|slNow|time|expireH|filled
async function eaFeed(key) {
  const txt = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (!/^[a-f0-9]{32}$/.test(String(key || ""))) return txt("ERR|bad key", 403);
  const { data: u } = await db.from("telegram_users").select("*").eq("ea_key", key).maybeSingle();
  if (!u) return txt("ERR|unknown key (send /ea in the bot)", 403);
  const a = { ...u, admin: !!u.is_admin, ...planOf(u) };
  if (!a.admin && !a.tier) return txt("ERR|plan ended (renew in the bot)", 403);
  const { data } = await db.from("signals").select("id,data").order("updated_at", { ascending: false }).limit(150);
  const since = Date.now() - 72 * 3600000;
  const n = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : "0");
  const rows = (data ?? []).map((r) => ({ id: r.id, ...r.data })).filter((x) => x && x.sym && (x.status === "running" || (x.closedAt || x.time) >= since) && canSee(a, x.kind));
  const lines = rows.map((x) => ["S", x.id, x.kind, x.news || "", x.sym, x.dir, x.order || "instant", x.status, x.pending ? 1 : 0, n(x.entry), n(x.sl0 ?? x.sl),
    ...(x.tps ? x.tps.map(n) : [n(x.tp), "0", "0"]), x.tpHit || 0, n(x.sl), Math.round(x.time || 0), x.expire ?? LIMIT.expire, Math.round(x.filled || 0)].join("|"));
  return txt([`OK|${Date.now()}|${a.admin ? "ADMIN" : a.tier}`, ...lines].join("\n"));
}
async function sendFile(chatId, name, content, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) { fd.append("caption", caption); fd.append("parse_mode", "HTML"); }
  fd.append("document", new Blob([content], { type: "application/octet-stream" }), name);
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: "POST", body: fd });
  return await r.json().catch(() => ({ ok: false }));
}
async function cmdEA(chatId, a, text) {
  if (!a.admin && !a.tier) return showPlans(chatId);
  let key = a.ea_key;
  if (!key || /reset/i.test(text)) {
    key = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await db.from("telegram_users").update({ ea_key: key }).eq("chat_id", chatId);
  }
  const host = new URL(SB_URL).origin;
  await send(chatId, [
    "🤖 <b>MEEGO AI · MT5 EA</b>",
    "The EA copies MEEGO AI signals into your MT5 by itself: entry (or BUY/SELL LIMIT), SL, TP1/TP2/TP3, SL to entry after TP1, and lot size from your risk %.",
    "",
    `🔑 Your EA key (keep it private):\n<code>${key}</code>`,
    "",
    "<b>Setup (once)</b>",
    "1. Save the file below. In MT5: <b>File → Open Data Folder → MQL5 → Experts</b>, put the file there.",
    "2. In MT5 <b>Navigator</b>, right-click <b>Expert Advisors → Refresh</b>.",
    `3. MT5: <b>Tools → Options → Expert Advisors</b> → tick <b>Allow WebRequest for listed URL</b> → add:\n<code>${host}</code>`,
    "4. Drag <b>MEEGO_AI_EA</b> onto any chart → <b>Inputs</b>: paste your key, set your broker's gold symbol (XAUUSD / XAUUSDm / GOLD) and risk % → OK.",
    "5. Turn on <b>Algo Trading</b>. Keep MT5 running (a VPS is best).",
    "",
    "⚠️ Test on a <b>DEMO</b> account first. Use a <b>hedging</b> account (3 TPs = 3 positions).",
    "New key: <code>/ea reset</code> (the old key stops working).",
  ].join("\n"), kb(a));
  const bin = await eaFile("MEEGO_AI_EA.ex5").catch(() => null);
  if (!bin) return send(chatId, "Couldn't attach the EA file right now. Try /ea again in a minute.");
  await sendFile(chatId, "MEEGO_AI_EA.ex5", bin, "📎 <b>MEEGO_AI_EA.ex5</b> · put it in MQL5 → Experts");
  if (!a.admin) return;
  // Admin only: the editable source code (customers get the compiled .ex5 only)
  const src = await eaFile("MEEGO_AI_EA.mq5").catch(() => null);
  if (src) return sendFile(chatId, "MEEGO_AI_EA.mq5", src, "🛠 <b>Admin only · MEEGO_AI_EA.mq5</b> (source code)\nEdit it in MetaEditor (F4) and press Compile (F7). Customers only ever get the .ex5.");
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
  await welcome(u.chat_id, `🎉 Welcome to <b>MEEGO AI</b>! Your <b>${tier}</b> plan is active until <b>${end}</b>.\n\nYou'll get new signals here automatically. Tap ⚡ Scalping, 📈 Intraday or ⭐ Swing to see what's running.`, { reply_markup: MENU });
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
  const [kind, x, y, z] = String(q.data || "").split("|");
  if (kind === "lv") {
    if (!a.admin && !a.tier) return;
    const [{ data: row }, { data: sig }] = await Promise.all([
      db.from("tg_live").select("*").eq("chat_id", chatId).eq("message_id", msgId).maybeSingle(),
      db.from("signals").select("id,data").eq("id", x).maybeSingle(),
    ]);
    if (!sig) return;
    const s = { id: sig.id, ...sig.data };
    return editLive(row ?? { chat_id: chatId, message_id: msgId, title: kindOf(s.kind).title, created_at: new Date().toISOString() }, s, {});
  }
  if (kind === "plans") return showPlans(chatId);
  if (kind === "buy") return startPayment(chatId, x);
  if (!a.admin) return;
  if (kind === "pa" || kind === "pr") return decidePayment(chatId, msgId, x, kind === "pa");
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
  if (cmd === "/setbank" || cmd === "/addbank") {
    const body = text.replace(/^\/(setbank|addbank)(@\S+)?\s*/i, "");
    const [bank, name, acc] = body.split("|").map((x) => x.trim());
    if (!bank || !name || !acc || digitsOf(acc).length < 6) return send(chatId, `Format: <code>${cmd} Bank name | Account holder name | Account number</code>\nExample: <code>${cmd} Maybank | YOUR FULL NAME | 1234 5678 9012</code>\n\n/setbank replaces all accounts · /addbank adds another one`);
    const list = cmd === "/addbank" ? [...((await bankInfo()) ?? []).filter((b) => digitsOf(b.acc) !== digitsOf(acc)), { bank, name, acc }] : [{ bank, name, acc }];
    await db.from("app_settings").upsert({ key: "pay_bank", value: JSON.stringify(list) });
    return send(chatId, `✅ Saved. Customers will see ${list.length > 1 ? `${list.length} accounts` : "this account"}:\n${list.map((b, i) => `\n🏦 ${list.length > 1 ? `${i + 1}. ` : ""}<b>${esc(b.bank)}</b>\n👤 ${esc(b.name)}\n🔢 <code>${esc(b.acc)}</code>`).join("\n")}\n\nMEEGO AI checks every receipt against these names and account numbers.`);
  }
  if (cmd === "/setprice") {
    const tier = TIERS.find((x) => x.toLowerCase() === String(parts[1] || "").toLowerCase()), rm = Number(parts[2]), days = Number(parts[3] || 30);
    if (!tier || !(rm > 0) || !(days > 0)) return send(chatId, "Format: <code>/setprice Pro 35 30</code> (plan, RM, days)");
    const cfg = await settings();
    let p = {}; try { p = cfg.plan_prices ? JSON.parse(cfg.plan_prices) : {}; } catch (_) { p = {}; }
    p[tier] = { rm, days };
    await db.from("app_settings").upsert({ key: "plan_prices", value: JSON.stringify(p) });
    const pr = await prices();
    return send(chatId, `✅ Prices now:\n${TIERS.map((x) => `• ${x} · RM${pr[x].rm} / ${pr[x].days} days`).join("\n")}`);
  }
  if (cmd === "/payments") {
    const { data } = await db.from("tg_payments").select("*").order("created_at", { ascending: false }).limit(15);
    const mark = { waiting: "⏳", review: "🔎", approved: "✅", rejected: "❌" };
    const bank = await bankInfo();
    return send(chatId, [`<b>Payments</b> (latest 15)`, ...(bank ? bank.map((b) => `🏦 <b>${esc(b.bank)}</b> · ${esc(b.name)} · <code>${esc(b.acc)}</code>`) : ["⚠️ Bank not set (/setbank)"]), "",
      ...((data ?? []).map((x) => `${mark[x.status] || "•"} ${new Date(new Date(x.created_at).getTime() + 8 * 3600000).toISOString().slice(5, 16).replace("T", " ")} · <code>${x.chat_id}</code> · ${esc(x.tier)} RM${x.amount} · ${esc(x.status)}`)),
      ...((data ?? []).length ? [] : ["No payments yet."]),
      "", "⏳ waiting for receipt · 🔎 waiting for your Approve · ✅ approved · ❌ rejected"].join("\n"));
  }
  if (cmd === "/admin") {
    return send(chatId, [
      "<b>Customers</b> (no typing needed)",
      "Tap <b>➕ Add customer</b> → send their @username → tap the plan → tap how many days. Done.",
      "Tap <b>👥 Customers</b> to renew, change or end someone's plan.",
      "",
      "<b>Signals</b>",
      "MEEGO AI finds and posts setups by itself, and closes them at TP/SL. <code>/autoscan</code> to switch it on/off or change pairs.",
      "Post your own too:",
      "<code>/post BUY XAUUSD 4040 4080 3990</code> intraday signal (entry, TP, SL)",
      "<code>/post BUY XAUUSD 4040 4048 4034 scalp</code> scalping signal",
      "<code>/post SELL XAUUSD 4129 4119 4140 swing Sell area, wait for price</code> swing (Ultimate only) with a note",
      "<code>/close tp</code> · <code>/close sl</code> · <code>/close be</code> closes the latest running signal (add a pair to choose: <code>/close tp XAUUSD</code>)",
      "",
      "<b>Payments</b>",
      "<code>/setbank Bank | Account holder name | Account number</code> where customers transfer (replaces all)",
      "<code>/addbank Bank | Account holder name | Account number</code> add another account",
      "<code>/setprice Pro 35 30</code> change a plan's price (RM) and days",
      "<code>/payments</code> latest payments. New receipts come to you with ✅ Approve / ❌ Reject.",
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
  if (cmd === "/autoscan") {
    const opt = (parts[1] || "").toLowerCase();
    if (opt === "on" || opt === "off") await db.from("app_settings").upsert({ key: "auto_scan", value: opt });
    if (opt === "pairs" && parts[2]) {
      const list = parts.slice(2).join(",").toUpperCase().split(",").map((p) => p.trim()).filter((p) => /^[A-Z0-9]{3,10}$/.test(p));
      if (list.length) await db.from("app_settings").upsert({ key: "scan_pairs", value: list.join(",") });
    }
    const cfg = await settings();
    return send(chatId, `🤖 <b>MEEGO AI auto setups</b>: <b>${cfg.auto_scan === "off" ? "OFF" : "ON"}</b>\nPairs: <b>${esc(cfg.scan_pairs || "XAUUSD")}</b>\n\n<code>/autoscan on</code> · <code>/autoscan off</code>\n<code>/autoscan pairs XAUUSD,BTCUSD</code>`);
  }
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
    const extra = !row.data.tps ? {} : st === "tp" ? { tpHit: 3 } : st === "be" ? { sl: row.data.entry } : { sl: row.data.sl0 ?? row.data.sl, tpHit: 0 };
    const { error } = await db.from("signals").update({ data: { ...row.data, ...extra, status: st, closedAt: Date.now() }, updated_at: new Date().toISOString() }).eq("id", row.id);
    return send(chatId, error ? "Couldn't update: " + esc(error.message) : `✅ ${esc(row.data.sym)} marked ${st.toUpperCase()}. Members are being notified.`);
  }
  if (cmd === "/announce") {
    const body = text.replace(/^\/announce(@\S+)?\s*/i, "").trim();
    if (!body) return send(chatId, "Format: <code>/announce Your message</code>");
    const list = await activeMembers();
    // also refreshes everyone's button menu (so new buttons like 📰 News appear)
    for (const u of list) {
      await send(u.chat_id, `📣 <b>Announcement</b>\n\n${esc(body)}`, { reply_markup: u.is_admin ? ADMIN_MENU : MENU });
      await new Promise((r) => setTimeout(r, 60));
    }
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
      const sig = { id: ev.record.id, ...s };
      const title = s.nine ? "🕘 9:59 AM SETUP" : s.news === "pre" ? "📰 NEWS SIGNAL" : s.news === "recovery" ? "🔁 RECOVERY SETUP (after news spike)" : kindOf(s.kind).fresh;
      for (const c of chats) { await sendLive(c, sig, title); await new Promise((r) => setTimeout(r, 60)); }
      return;
    }
    const label = `${s.dir > 0 ? "BUY" : "SELL"}${s.order === "limit" ? " LIMIT" : ""} <b>${esc(s.sym)}</b>`;
    if (ev.op === "UPDATE" && old?.pending && s.status === "running" && !s.pending) {
      // the full signal card again (entry, zone, TPs, SL, lot guide), kept live like a new signal
      const sig = { id: ev.record.id, ...s }, title = `⚡ ENTRY TRIGGERED · ${kindOf(s.kind).title.replace(/^\S+\s/, "")}`;
      for (const c of chats) { await sendLive(c, sig, title); await new Promise((r) => setTimeout(r, 60)); }
      return refreshLive();
    }
    if (ev.op === "UPDATE" && old && old.status !== s.status && s.status === "cancelled") {
      await broadcast(chats, `🚫 <b>CANCELLED</b> · ${label}\n${kindOf(s.kind).label} · entry price not reached`);
      return refreshLive();
    }
    if (ev.op === "UPDATE" && old && s.status === "running" && s.tps && (s.tpHit || 0) > (old.tpHit || 0)) {
      const n = s.tpHit, p = pipsBetween(s.tps[n - 1], s.entry, s.sym);
      await broadcast(chats, `✅ <b>TP${n} HIT</b> · ${label}\n${kindOf(s.kind).label} · <b>+${p} pips</b>\nClose 1/3 of the lot · move SL to <b>${n === 1 ? "entry (breakeven)" : "TP1"}</b> <code>${px(s.sl, s.sym)}</code>`);
      return refreshLive();
    }
    if (ev.op === "UPDATE" && old && old.status !== s.status && ["tp", "sl", "be", "closed"].includes(s.status)) {
      const p = sigPips(s);
      const head = s.tps ? resultLine(s).split(" · <b>")[0] + (s.status === "closed" ? " (time limit)" : "")
        : s.status === "tp" ? "✅ <b>HIT TP</b>" : s.status === "sl" ? "❌ <b>HIT SL</b>" : s.status === "closed" ? "⏹ <b>CLOSED</b> (time limit)" : "➖ <b>BREAKEVEN</b>";
      await broadcast(chats, `${head} · ${label}\n${kindOf(s.kind).label} · <b>${p > 0 ? "+" : ""}${p} pips</b>${s.tps ? " (avg of 3 TPs)" : ""}`);
      return refreshLive(); // mark the earlier signal messages as closed
    }
    return;
  }
  if (ev.event === "news") {
    await nineSetup().catch((e) => console.error("9:59 setup failed", e));
    return newsAlert().catch((e) => console.error("news alert failed", e));
  }
  if (ev.event === "scan") {
    await autoScan().catch((e) => console.error("auto scan failed", e));
    if (new Date().getUTCMinutes() < 5) await newsWeek(55).catch((e) => console.error("news refresh failed", e));
    return refreshLive();
  }
  if (ev.event === "daily") {
    const { data } = await db.from("telegram_users").select("*").not("tier", "is", null);
    const soon = addDays(today(), 3), yesterday = addDays(today(), -1);
    const admins = (await db.from("telegram_users").select("chat_id").eq("is_admin", true)).data ?? [];
    const expiring = [];
    for (const u of data ?? []) {
      const renew = { reply_markup: { inline_keyboard: [[{ text: "💳 Renew now", callback_data: "plans" }]] } };
      if (u.plan_end === soon) { await send(u.chat_id, `⏰ Your <b>${esc(u.tier)}</b> plan ends on <b>${u.plan_end}</b>. Renew to keep receiving signals.`, renew); expiring.push(u); }
      if (u.plan_end === yesterday) await send(u.chat_id, `Your <b>${esc(u.tier)}</b> plan has ended. Tap below to renew.`, renew);
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
  if (!a.admin && !t.startsWith("/start")) {
    const st = await getState(chatId);
    if (st?.step?.startsWith("pay|") && Date.now() - new Date(st.updated_at).getTime() < 24 * 3600000) {
      if (msg.photo?.length || msg.document) return handleReceipt(chatId, a, msg, st.step.slice(4));
      if (!a.tier) return send(chatId, "Send the <b>receipt screenshot</b> of your transfer here, or tap /start to choose another plan.");
    }
  }

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
    if (!a.rawTier) return showPlans(chatId, "🤖 <b>Welcome to MEEGO AI</b>\nAI gold signals, delivered here on Telegram.\n\n💳 <b>Choose a plan</b>");
  }

  if (t.startsWith("/start")) {
    if (a.admin) return welcome(chatId, "👑 Welcome back, admin. Tap <b>➕ Add customer</b> to give someone a plan, or send /admin for everything else.", { reply_markup: ADMIN_MENU });
    if (a.tier) return welcome(chatId, `Welcome back to <b>MEEGO AI</b>! Your <b>${esc(a.tier)}</b> plan is active${a.end ? ` until <b>${a.end}</b>` : ""}.\n\nUse the buttons below, or send a chart screenshot for an AI scan.`, kb(a));
    return showPlans(chatId, `Your <b>${esc(a.rawTier)}</b> plan has ended.\n\n💳 <b>Renew your plan</b>`);
  }
  if (msg.photo && msg.photo.length) return scanPhoto(chatId, a, msg);
  if (/^\/(admin|activate|renew|remove|customers|post|close|announce|members|autoscan|setbank|addbank|setprice|payments)\b/.test(t)) return cmdAdmin(chatId, a, text);
  if (t === "/ea" || t.startsWith("/ea ") || t.startsWith("/ea@") || t.includes("mt5")) return cmdEA(chatId, a, t);
  if (t.startsWith("/scanner") || t.includes("chart scanner")) {
    if (!a.admin && !a.tier) return send(chatId, noPlan(a));
    return send(chatId, "🖼 <b>MEEGO AI · Chart Scanner</b>\n\nSend a <b>screenshot of your chart</b> here (MT4/MT5/TradingView).\n\nTips for the best result:\n• Show the price scale on the right\n• One pair, one timeframe\n• Add the pair in the caption, e.g. <code>XAUUSD M15</code>\n\nMEEGO AI will read it and reply with direction, entry, TP and SL.", kb(a));
  }
  if (t.startsWith("/scalp") || t.includes("scalp")) return cmdSignal(chatId, a, "Scalping");
  if (t.startsWith("/intraday") || t.startsWith("/signal") || t.includes("intraday") || (t.includes("signal") && !t.includes("swing"))) return cmdSignal(chatId, a, "Intraday");
  if (t.startsWith("/swing") || t.includes("swing")) return cmdSignal(chatId, a, "Swing");
  if (t.startsWith("/direction") || t.includes("direction")) return cmdDirection(chatId, a);
  if (t.startsWith("/history") || t.includes("history")) return cmdHistory(chatId, a);
  if (t.startsWith("/news") || t.includes("news")) return cmdNews(chatId, a);
  if (t.startsWith("/plan") || t.includes("my plan")) return cmdPlan(chatId, a);
  return send(chatId, [
    "<b>MEEGO AI</b>",
    "⚡ /scalping scalping signals",
    "📈 /intraday intraday signals",
    "⭐ /swing Priority Swing (Ultimate)",
    "🧭 /direction today's direction",
    "📊 /history wins and pips",
    "📰 /news this week's important USD news",
    "👤 /plan your plan and MEEGO ID",
    "🖼 /scanner send a chart screenshot for an AI scan",
    "🤖 /ea MT5 EA that copies the signals into MT5",
  ].join("\n"), kb(a));
}

/* ---------- entry point ---------- */
Deno.serve(async (req) => {
  if (req.method === "GET") {
    const ea = new URL(req.url).searchParams.get("ea");
    if (ea !== null) return eaFeed(ea).catch((e) => { console.error("ea feed failed", e); return new Response("ERR|server", { status: 500 }); });
  }
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
      { command: "scanner", description: "AI chart scanner" },
      { command: "history", description: "Wins and pips" },
      { command: "news", description: "Important USD news this week" },
      { command: "plan", description: "Your plan and MEEGO ID" },
      { command: "ea", description: "MT5 EA (auto-copy signals)" },
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
