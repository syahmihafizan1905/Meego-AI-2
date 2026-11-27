// MEEGO AI Telegram bot (Supabase Edge Function "telegram") - works on its own, no website needed.
// Secrets: TELEGRAM_BOT_TOKEN (from @BotFather), ANTHROPIC_API_KEY (for chart scans).
// "Verify JWT" must be OFF for this function. Open the function URL once in a browser to connect the bot.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Resvg, initWasm } from "npm:@resvg/resvg-wasm@2.6.2";

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
  SOP: { title: "🧭 PR SOP SIGNAL", fresh: "📢 NEW PR SOP SIGNAL", label: "PR SOP", none: "No PR SOP signal right now." },
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
// Auto signals of these kinds go to the admin only while they are being tested (news signals, the 9:59 AM setup and /post are not affected).
// To send them to customers again, take the kind out of this list.
const TRIAL = ["Scalping", "Intraday", "Swing"];
const off = (k) => TRIAL.includes(k);
const trialText = TRIAL.join(", ").replace(/, ([^,]*)$/, " and $1");
const canSeeSignal = (a, s) => canSee(a, s.kind) && (a.admin || !s.trial);
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
// Swing targets follow the stop: TP1 1.5x the risk (at least 100 pips), TP2 2x, TP3 3x
const SWING_TP = [[1.5, 100, Infinity], [2, 100, Infinity], [3, 100, Infinity]];
// Intraday (S&D): held for at least 100 pips. 41 signals in 2 months: +8.6R, TP1 hit 51% (with the 50-100 pip TP1: +4.7R, 66%)
const INTRADAY_TP = [[1, 100, Infinity], [2, 150, Infinity], [3, 200, Infinity]];
function tpPlan(sym, dir, entry, sl, plan = TP_PLAN) {
  const rp = Math.abs(entry - sl) / pip(sym), gold = /^XAU/.test(sym), d = digits(sym);
  const tps = plan.map(([k, lo, hi]) => Number((entry + dir * (gold ? Math.min(hi, Math.max(lo, k * rp)) : k * rp) * pip(sym)).toFixed(d)));
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
  if (s.status === "cancelled") return s.kind === "SOP" ? "🚫 <b>CANCELLED</b> · dashboard didn't line up within 60 minutes" : "🚫 <b>CANCELLED</b> · entry price not reached";
  const p = sigPips(s), n = s.tpHit || 0;
  const head = s.tps && s.status !== "closed"
    ? (n >= 3 ? "🏆 <b>ALL TP HIT</b>" : n === 2 ? "✅ <b>TP2 HIT</b> · rest closed at TP1" : n === 1 ? "✅ <b>TP1 HIT</b> · rest closed at entry" : "❌ <b>HIT SL</b>")
    : s.status === "tp" ? "✅ <b>HIT TP</b>" : s.status === "sl" ? "❌ <b>HIT SL</b>" : s.status === "closed" ? "⏹ <b>CLOSED</b>" : "➖ <b>BREAKEVEN</b>";
  return `${head} · <b>${p > 0 ? "+" : ""}${p} pips</b>${s.tps ? " (avg of 3 TPs)" : ""}`;
}
// Entry zone: from the entry toward the SL (a better price), at most 40 pips and never more than 30% of the risk
const ZONE_PIPS = 40;
function entryZone(s) {
  if (Array.isArray(s.zone) && s.zone.length === 2) {
    const lo = Math.min(s.zone[0], s.entry), hi = Math.max(s.zone[1], s.entry);
    return `Entry zone: <code>${px(lo, s.sym)}</code> – <code>${px(hi, s.sym)}</code> (${pipsBetween(hi, lo, s.sym)} pips)`;
  }
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
    signalsOf(kind).then((l) => l.filter((s) => s.status === "running" && canSeeSignal(a, s)).sort((x, y) => y.time - x.time)),
    scanAnimation(chatId, kind),
  ]);
  if (!list.length) return send(chatId, TRIAL.includes(kind) && !a.admin ? `No ${kind.toLowerCase()} signal right now. Auto ${kind.toLowerCase()} signals are paused while we re-test the setup.${kind === "Scalping" ? " News signals still come here." : kind === "Intraday" ? " The 9:59 AM setup still comes here." : ""}` : kindOf(kind).none);
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
// Malaysia date of a time, e.g. "Wed, 25 Nov 2026"
const myDay = (t, o = { weekday: "short", day: "numeric", month: "short", year: "numeric" }) => new Date(t + 8 * 3600000).toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
// Results for today, this week (from Monday) and this month, in Malaysia time
function historyStats(list, now = Date.now()) {
  const MY = 8 * 3600000, d = new Date(now + MY);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - MY;
  const weekStart = dayStart - ((d.getUTCDay() + 6) % 7) * 86400000;
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - MY;
  const block = (name, from, when) => {
    name = `${name} · ${when}`;
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
  return [
    block("📅 Today", dayStart, myDay(dayStart, { weekday: "long", day: "numeric", month: "short", year: "numeric" })),
    block("🗓 This week", weekStart, `${myDay(weekStart, { weekday: "short", day: "numeric", month: "short" })} – ${myDay(weekStart + 6 * 86400000).replace(",", "")}`),
    block("📆 This month", monthStart, myDay(monthStart, { month: "long", year: "numeric" })),
  ].join("\n\n");
}
async function cmdHistory(chatId, a) {
  if (!a.admin && !a.tier) return send(chatId, noPlan(a));
  const kinds = (canSee(a, "Swing") ? ["Swing", "Intraday", "Scalping"] : ["Intraday", "Scalping"]);
  const all = [];
  await Promise.all([
    (async () => { for (const k of kinds) all.push(...(await signalsOf(k)).filter((s) => canSeeSignal(a, s) && !s.test)); })(),
    playVideo(chatId, "history", "📊 <b>MEEGO AI</b> · loading signal history…", "✅ <b>MEEGO AI</b> · results ready", 3700),
  ]);
  const closed = all.filter((s) => ["tp", "sl", "closed", "be"].includes(s.status)).sort((x, y) => (y.closedAt || y.time) - (x.closedAt || x.time));
  const running = all.filter((s) => s.status === "running").length;
  const rows = [];
  let lastDay = "";
  for (const s of closed.slice(0, 10)) {
    const t = s.closedAt || s.time, day = myDay(t, { weekday: "long", day: "numeric", month: "short", year: "numeric" }), p = sigPips(s);
    if (day !== lastDay) rows.push(...(rows.length ? [""] : []), `🗓 <b>${day}</b>`);
    lastDay = day;
    rows.push(`${isWin(s) ? "✅" : p < 0 ? "❌" : "➖"}${s.tps ? ` TP${s.tpHit || 0}` : ""} ${new Date(t + 8 * 3600000).toISOString().slice(11, 16)} ${s.dir > 0 ? "BUY" : "SELL"} ${esc(s.sym)} · ${esc(s.setup === "SNR" ? "SNR " + s.kind : s.kind)} <b>${p > 0 ? "+" : ""}${p}</b> pips`);
  }
  return send(chatId, [
    "📊 <b>MEEGO AI · Signal history</b> (Malaysia time)",
    "",
    historyStats(closed),
    "",
    `⏳ Running now: <b>${running}</b>`,
    ...(rows.length ? ["", "<b>Last 10 closed</b> (closing time)", ...rows] : []),
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
  const list = Array.isArray(j.candles) ? j.candles : [];
  return /^XAU/.test(sym) && interval !== "1min" ? list.filter((x) => goldOpen(x.t)) : list; // drop weekend / daily-break candles
}
// The current price. Candles only include finished minutes, so their last close is 1-2 minutes old (plus up to 3 minutes of cache):
// on 24 Nov 2026 a SELL went out 50 pips below the market, 3 pips from its stop. Every new signal is checked against this first.
async function livePrice(sym) {
  const r = await fetch(`${SB_URL}/functions/v1/${CANDLES_FN}?symbol=${sym}&interval=price`, { headers: { Authorization: `Bearer ${SB_SERVICE}`, apikey: SB_SERVICE } });
  const j = await r.json().catch(() => ({}));
  return r.ok && Number.isFinite(j.price) && j.price > 0 ? j.price : null;
}
const MAX_SLIP = 0.2; // skip the signal when price has moved more than this part of the stop distance since the setup
// Re-prices setup s at the market; false = too late (or no price), so don't send it
async function reprice(s, sym) {
  const live = await livePrice(sym).catch(() => null), risk = Math.abs(s.entry - s.sl);
  if (live === null || !risk || (live - s.sl) * s.dir <= 0 || Math.abs(live - s.entry) > MAX_SLIP * risk) {
    console.log("signal skipped, price moved or unavailable", sym, s.dir, s.entry, s.sl, live);
    return false;
  }
  s.entry = live;
  return true;
}
// Gold trades Sunday 18:00 to Friday 17:00 New York time, with a break 17:00-18:00 every day
function goldOpen(t) {
  const y = new Date(t).getUTCFullYear(), sun = (mo, n) => { const d = new Date(Date.UTC(y, mo, 1)); return Date.UTC(y, mo, 1 + ((7 - d.getUTCDay()) % 7) + 7 * (n - 1)); };
  const summer = t >= sun(2, 2) + 7 * 3600000 && t < sun(10, 1) + 6 * 3600000, d = new Date(t - (summer ? 4 : 5) * 3600000), w = d.getUTCDay(), h = d.getUTCHours();
  return !(w === 6 || h === 17 || (w === 5 && h > 17) || (w === 0 && h < 17));
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
  Scalping: { tf: "m5", ema: 20, look: 3, need: ["m15"], bonus: ["m5", "h1"], min: 4, floor: 2, step: 2, buf: 0.2, rr: 1.5, life: 3, cool: 0.5, max: 5, open: 1, maxPips: 100 },
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
/* ---------- Intraday: the admin's two setups (gold) ---------- */
// 66 days of 5-min gold, 4 pips spread: about break-even when the real scanner is replayed (102 trades, -0.4R to +7.8R depending on price delay). On trial.
// ---- Intraday setup 1: trend pullback + supply/demand · setup 2: trendline / SNR break + retest (the admin's own rules) ----
const IX = { pivH1: 2, imp: 1.3, base: 0.7, zoneAge: 96, touch: 8, brk: 24, near: 0.35, slBuf: 0.25, minPips: 30, maxPips: 200 };
// H1 structure: +1 = higher highs and higher lows, -1 = lower highs and lower lows, 0 = neither
function structure(h1) {
  const c = h1.slice(-80), p = pivots(c, IX.pivH1), H = p.hi.slice(-2), L = p.lo.slice(-2);
  if (H.length < 2 || L.length < 2) return 0;
  const last = c[c.length - 1].c;
  if (H[1].v > H[0].v && L[1].v > L[0].v && last > L[1].v) return 1;
  if (H[1].v < H[0].v && L[1].v < L[0].v && last < H[1].v) return -1;
  return 0;
}
// Fresh M30 zones: a small base candle followed by a strong move away (1 or 2 candles), not revisited before
function zones30(m30, dir, a) {
  const out = [], n = m30.length;
  for (let i = n - 3; i >= Math.max(1, n - IX.zoneAge); i--) {
    const b = m30[i], m1 = m30[i + 1], m2 = m30[i + 2];
    if (Math.abs(b.c - b.o) > IX.base * a) continue;
    if (Math.max((m1.c - m1.o) * dir, (m2.c - m1.o) * dir) < IX.imp * a) continue;
    const top = dir > 0 ? Math.max(b.o, b.c) : b.h, bot = dir > 0 ? b.l : Math.min(b.o, b.c);
    if (top - bot < 0.1 * a || top - bot > 2 * a) continue;
    out.push({ top, bot, t: b.t, from: m2.t + 1800000 });
  }
  return out;
}
const pinOrEngulf = (c, dir) => c.length > 2 && rejectionCandle(c, dir);
// M15 change of character: closed beyond the last small swing against the pullback
function choch(m15, dir) {
  const c = m15.slice(-24), p = pivots(c, 2), s = (dir > 0 ? p.hi : p.lo).filter((x) => x.i < c.length - 2).slice(-1)[0];
  return !!s && (c[c.length - 1].c - s.v) * dir > 0 && (c[c.length - 2].c - s.v) * dir <= 0.2 * atr(m15);
}
function setupPullback(d) { // setup 1
  const dir = structure(d.h1);
  if (!dir) return null;
  const a30 = atr(d.m30), a15 = atr(d.m15), m5 = d.m5, m15 = d.m15;
  if ((m5[m5.length - 1].c - m5[m5.length - 1].o) * dir <= 0 || !confirmCandle(m5, dir, atr(m5))) return null; // M5 confirmation
  for (const z of zones30(d.m30, dir, a30)) {
    const after = m15.filter((x) => x.t >= z.from);
    if (after.length < 2) continue;
    const inZone = (x) => (dir > 0 ? x.l <= z.top : x.h >= z.bot), broke = (x) => (dir > 0 ? x.c < z.bot : x.c > z.top);
    const first = after.findIndex(inZone);
    if (first < 0 || first < after.length - IX.touch || after.some(broke)) continue; // must be the first visit, recent, and still holding
    const rej = after.slice(Math.max(first, after.length - 3)).some((x) => { const k = m15.indexOf(x); return pinOrEngulf(m15.slice(0, k + 1), dir); });
    const ch = choch(m15, dir);
    if (!rej && !ch) continue;
    const ext = dir > 0 ? Math.min(z.bot, ...after.slice(first).map((x) => x.l), m5[m5.length - 1].l) : Math.max(z.top, ...after.slice(first).map((x) => x.h), m5[m5.length - 1].h);
    return { dir, key: "P" + z.t, sl: ext - dir * IX.slBuf * a15, why: (dir > 0 ? "H1 HH+HL · M30 demand" : "H1 LH+LL · M30 supply") + " · M15 " + (rej ? "rejection" : "CHoCH") + " · M5 confirmation" };
  }
  return null;
}
// H1 trendline through the last two falling highs (dir +1) or rising lows (dir -1); value at time t
function trendline(h1, dir) {
  const c = h1.slice(-80), p = pivots(c, 3), s = (dir > 0 ? p.hi : p.lo).slice(-2);
  if (s.length < 2 || (dir > 0 ? s[1].v >= s[0].v : s[1].v <= s[0].v)) return null;
  const A = c[s[0].i], B = c[s[1].i], m = (s[1].v - s[0].v) / (B.t - A.t);
  return (t) => s[0].v + m * (t - A.t);
}
function setupBreak(d) { // setup 2
  const a30 = atr(d.m30), a = atr(d.m15), m15 = d.m15, m5 = d.m5, n = m15.length, lastM5 = m5[m5.length - 1];
  for (const dir of [1, -1]) {
    if ((lastM5.c - lastM5.o) * dir <= 0 || !pinOrEngulf(m5, dir)) continue; // M5 rejection / pin bar / engulfing
    const c30 = d.m30.slice(-120), pv = pivots(c30, 3), lv = (dir > 0 ? pv.hi : pv.lo).filter((x) => x.i < c30.length - 4).map((x) => ({ at: () => x.v, name: dir > 0 ? "M30 resistance" : "M30 support", key: "S" + Math.round(x.v * 10) }));
    const tl = trendline(d.h1, dir);
    if (tl) lv.push({ at: tl, name: "H1 trendline", key: "T" + Math.round(tl(0) / 1e3) });
    let best = null;
    for (const L of lv) {
      let k = -1;
      for (let i = n - 2; i >= Math.max(1, n - IX.brk); i--) if ((m15[i].c - L.at(m15[i].t)) * dir > 0.1 * a && (m15[i - 1].c - L.at(m15[i - 1].t)) * dir <= 0) { k = i; break; }
      if (k < 0) continue; // M15 closed beyond the level
      const post = m15.slice(k + 1);
      if (!post.length || post.some((x) => (x.c - L.at(x.t)) * dir < -0.3 * a)) continue; // still holding
      if (!post.some((x) => (x.h - L.at(x.t)) * dir > 0.5 * a || (dir < 0 && (L.at(x.t) - x.l) > 0.5 * a)) && (m15[k].c - L.at(m15[k].t)) * dir < 0.4 * a) continue; // it must have moved away first
      const lv5 = L.at(lastM5.t), touch = m5.slice(-4).some((x) => ((dir > 0 ? x.l : x.h) - lv5) * dir <= IX.near * a);
      if (!touch || (lastM5.c - lv5) * dir <= 0) continue; // retest, closed back on the right side
      const ext = dir > 0 ? Math.min(lv5, ...m5.slice(-6).map((x) => x.l)) : Math.max(lv5, ...m5.slice(-6).map((x) => x.h));
      const s = { dir, key: L.key + dir, sl: ext - dir * IX.slBuf * a, why: `${L.name} break (M15 close) · retest · M5 rejection` };
      if (!best || Math.abs(lastM5.c - s.sl) < Math.abs(lastM5.c - best.sl)) best = s;
    }
    if (best) return best;
  }
  return null;
}
// Setup 1 first, then setup 2. Uses only finished candles; null when the stop is outside 30-200 pips or the zone/level was already traded.
function intradaySetup(d, price, used) {
  if (d.m5.length < 40 || d.m15.length < 60 || d.m30.length < 60 || d.h1.length < 60) return null;
  for (const [fn, name] of [[setupPullback, "Setup 1 · Trend pullback + SND"], [setupBreak, "Setup 2 · Break + retest"]]) {
    const s = fn(d);
    if (!s || used.has(s.key)) continue;
    const pips = ((price - s.sl) * s.dir) / pip("XAUUSD");
    if (pips < IX.minPips || pips > IX.maxPips) continue;
    return { dir: s.dir, entry: price, sl: s.sl, zkey: s.key, order: "instant", note: `🤖 MEEGO AI · ${name}: ${s.why}` };
  }
  return null;
}
/* ---------- Swing: the admin's two setups (gold) ---------- */
// 19 clean months of hourly gold, 4 pips spread: 31 trades, 56% win, +15.7R with targets 1.5R / 2R / 3R and a 5-day limit (random entries +3.8R). On trial.
// ---- Swing setup 1: reversal at a major level · setup 2: trend continuation (the admin's own rules) ----
const SX = { near: 0.5, brk: 18, retest: 0.4, touch: 8, slBuf: 0.25, imp: 1.3, base: 0.7, minPips: 60, maxPips: 600, revDays: 8, life: 120 };
// days start 22:00 UTC (the gold session), so Sunday evening belongs to Monday
const groupShift = (c, min, shift) => group(c.map((x) => ({ ...x, t: x.t + shift })), min).map((x) => ({ ...x, t: x.t - shift }));
const dayBars = (h1) => groupShift(h1, 1440, 2 * 3600000);
const weekBars = (d1) => { const out = []; for (const x of d1) { const k = Math.floor((x.t + 2 * 3600000 + 3 * 86400000) / 604800000), l = out[out.length - 1]; if (l && l.k === k) { l.h = Math.max(l.h, x.h); l.l = Math.min(l.l, x.l); l.c = x.c; } else out.push({ k, t: x.t, o: x.o, h: x.h, l: x.l, c: x.c }); } return out; };
// supply / demand zones: small base candle, then a strong move away in 1-2 candles; not closed through since
function sndZones(c, dir, a, age) {
  const out = [], n = c.length;
  for (let i = n - 3; i >= Math.max(1, n - age); i--) {
    const b = c[i], m1 = c[i + 1], m2 = c[i + 2];
    if (Math.abs(b.c - b.o) > SX.base * a || Math.max((m1.c - m1.o) * dir, (m2.c - m1.o) * dir) < SX.imp * a) continue;
    const top = dir > 0 ? Math.max(b.o, b.c) : b.h, bot = dir > 0 ? b.l : Math.min(b.o, b.c);
    if (top - bot < 0.1 * a || top - bot > 2 * a) continue;
    if (c.slice(i + 3).some((x) => (dir > 0 ? x.c < bot : x.c > top))) continue;
    out.push({ top, bot, t: b.t, i });
  }
  return out;
}
const hhhl = (c, k) => { const p = pivots(c, k), H = p.hi.slice(-2), L = p.lo.slice(-2); if (H.length < 2 || L.length < 2) return 0; const e = c[c.length - 1].c; return H[1].v > H[0].v && L[1].v > L[0].v && e > L[1].v ? 1 : H[1].v < H[0].v && L[1].v < L[0].v && e < H[1].v ? -1 : 0; };
const pinEng = (c, dir) => c.length > 2 && rejectionCandle(c, dir);
// setup 1: reversal from a major daily/weekly level
function swingReversal(d) {
  const { d1, w1, h4, h1 } = d, aD = atr(d1), a4 = atr(h4), L = h1[h1.length - 1];
  if (d1.length < 25 || h4.length < 60) return null;
  for (const dir of [1, -1]) {
    if ((L.c - L.o) * dir <= 0 || !confirmCandle(h1, dir, atr(h1))) continue; // 6) H1 confirmation
    // the reversal extreme: lowest low (highest high) of the last days
    const rec = d1.slice(-SX.revDays), ext = dir > 0 ? Math.min(...rec.map((x) => x.l)) : Math.max(...rec.map((x) => x.h)), er = rec.findIndex((x) => (dir > 0 ? x.l : x.h) === ext);
    const before = d1.slice(0, d1.length - SX.revDays), pv = pivots(before, 2);
    const levels = (dir > 0 ? pv.lo : pv.hi).map((x) => x.v).concat(w1.slice(0, -1).slice(-8).map((x) => (dir > 0 ? x.l : x.h)).filter((v) => before.some((x) => (dir > 0 ? x.l : x.h) === v)));
    const zones = sndZones(before, dir, aD, 60);
    const atLevel = levels.find((v) => Math.abs(ext - v) <= SX.near * aD), atZone = zones.find((z) => (dir > 0 ? ext <= z.top + 0.1 * aD && ext >= z.bot - SX.near * aD : ext >= z.bot - 0.1 * aD && ext <= z.top + SX.near * aD));
    if (atLevel === undefined && !atZone) continue; // 1) major level
    const base = d1.length - SX.revDays;
    const rej = rec.some((x, k) => k >= er && pinEng(d1.slice(0, base + k + 1), dir)), swp = atLevel !== undefined && rec.some((x) => (dir > 0 ? x.l < atLevel && x.c > atLevel : x.h > atLevel && x.c < atLevel));
    if (!rej && !swp) continue; // 2) daily rejection or sweep
    // 3+4) H4 closes through the last lower high (higher low for a sell) before the extreme
    const k0 = h4.findLastIndex((x) => (dir > 0 ? x.l : x.h) === ext);
    if (k0 < 12) continue;
    const pre = h4.slice(Math.max(0, k0 - 40), k0 + 3), p4 = pivots(pre, 2), sw = (dir > 0 ? p4.hi : p4.lo).filter((x) => x.i < pre.length - 3).slice(-1)[0];
    if (!sw) continue;
    let b = -1; for (let i = k0 + 1; i < h4.length; i++) if ((h4[i].c - sw.v) * dir > 0) { b = i; break; }
    if (b < 0 || h4.length - 1 - b > SX.brk || b - k0 > 30) continue;
    const post = h4.slice(b + 1);
    if (post.some((x) => (x.c - sw.v) * dir < -0.5 * a4)) continue;
    // 5) retest of the broken level or of the H4 zone that launched the move
    const legZone = sndZones(h4.slice(Math.max(0, k0 - 3), b + 1), dir, a4, 40)[0];
    const t0 = h4[b].t + 4 * 3600000, rt = h1.filter((x) => x.t >= t0).slice(-SX.touch), hitL = rt.some((x) => (dir > 0 ? x.l : x.h) && ((dir > 0 ? x.l : x.h) - sw.v) * dir <= SX.retest * a4 && (dir > 0 ? x.l : x.h) !== undefined && ((dir > 0 ? x.l : x.h) - sw.v) * dir > -1.2 * a4), hitZ = legZone && rt.some((x) => (dir > 0 ? x.l <= legZone.top && x.c > legZone.bot : x.h >= legZone.bot && x.c < legZone.top));
    if (!rt.length || (!hitL && !hitZ)) continue;
    return { dir, key: "R" + Math.round(sw.v * 10) + dir, sl: ext - dir * SX.slBuf * a4, why: `${atLevel !== undefined ? "major " + (dir > 0 ? "support" : "resistance") : "daily " + (dir > 0 ? "demand" : "supply")} · daily ${rej ? "rejection" : "sweep"} · H4 CHoCH (closed through the last ${dir > 0 ? "lower high" : "higher low"}) · retest · H1 confirmation` };
  }
  return null;
}
// setup 2: trend continuation from an H4 zone
function swingContinuation(d) {
  const { d1, w1, h4, h1 } = d, a4 = atr(h4), aD = atr(d1), L = h1[h1.length - 1];
  if (d1.length < 25 || h4.length < 60 || w1.length < 6) return null;
  const wc = w1.map((x) => x.c), we = ema(wc, 5), last = wc.length - 1, wk = wc[last] > we[last] && wc[last] > wc[last - 3] ? 1 : wc[last] < we[last] && wc[last] < wc[last - 3] ? -1 : 0;
  const dir = wk; // 1) weekly direction
  if (!dir || hhhl(d1.slice(-40), 2) !== dir) return null; // 2) daily HH+HL / LH+LL
  if ((L.c - L.o) * dir <= 0) return null;
  const dz = sndZones(d1, dir, aD, 40).find((z) => (dir > 0 ? z.bot < L.c : z.top > L.c)); // 3) an unbroken daily zone
  if (!dz) return null;
  const p = pivots(h1.slice(-24), 2), s = (dir > 0 ? p.lo : p.hi).slice(-2), hl = s.length === 2 && (s[1].v - s[0].v) * dir > 0;
  if (!pinEng(h1, dir) && !(hl && (L.c - h1[h1.length - 2].c) * dir > 0)) return null; // 6) H1 engulfing / rejection or higher low
  for (const z of sndZones(h4, dir, a4, 90)) {
    const after = h4.slice(z.i + 3), inZ = (x) => (dir > 0 ? x.l <= z.top : x.h >= z.bot), f = after.findIndex(inZ);
    if (f < 0 || f < after.length - 6) continue; // 4) first return to the H4 zone, recent
    const rej = after.slice(f).some((x) => { const k = h4.indexOf(x); return pinEng(h4.slice(0, k + 1), dir); });
    const sw = pivots(h4.slice(-18), 1), sp = (dir > 0 ? sw.hi : sw.lo).filter((x) => x.i < 16).slice(-1)[0], ch = !!sp && (h4[h4.length - 1].c - sp.v) * dir > 0;
    if (!rej && !ch) continue; // 5) H4 rejection or CHoCH
    const e = dir > 0 ? Math.min(z.bot, ...after.slice(f).map((x) => x.l), L.l) : Math.max(z.top, ...after.slice(f).map((x) => x.h), L.h);
    return { dir, key: "C" + z.t, sl: e - dir * SX.slBuf * a4, why: `weekly ${dir > 0 ? "bullish" : "bearish"} · daily ${dir > 0 ? "HH+HL" : "LH+LL"} · H4 ${dir > 0 ? "demand" : "supply"} · H4 ${rej ? "rejection" : "CHoCH"} · H1 confirmation` };
  }
  return null;
}
// Weekly, daily, H4 and H1 bars of finished candles only. now = start of the H1 candle still forming
function swingSetup(h1, now, price, used) {
  const days = dayBars(h1), d = { h1, h4: group(h1, 240).filter((x) => x.t + 14400000 <= now), d1: days.slice(0, -1), w1: weekBars(days).slice(0, -1) };
  if (h1.length < 400 || price <= 0) return null;
  for (const [fn, name] of [[swingReversal, "Setup 1 · Reversal"], [swingContinuation, "Setup 2 · Trend continuation"]]) {
    const s = fn(d);
    if (!s || used.has(s.key)) continue;
    const pips = ((price - s.sl) * s.dir) / pip("XAUUSD");
    if (pips < SX.minPips || pips > SX.maxPips) continue;
    return { dir: s.dir, entry: price, sl: s.sl, zkey: s.key, order: "instant", life: SX.life, note: `🤖 MEEGO AI · Swing ${name}: ${s.why}` };
  }
  return null;
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
      if (s.wait) { await setStatus(s, "cancelled"); continue; } // an old PR SOP signal that was still waiting
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
  const price = await livePrice("XAUUSD").catch(() => null), a = atr(m15.slice(0, -1));
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
    dir && !price ? "The live price isn't available right now, so no news signal this time." : dir ? "📰 News signal below. Spreads widen at news time: use a small lot." : conf.startsWith("Skip") ? "The news and the chart point different ways, so MEEGO AI skips this one. Wait for the spike to finish." : "No clear bias, so no news signal this time. Wait for the spike to finish.",
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
    const live = await livePrice(s.sym).catch(() => null);
    if (live === null) continue;
    const dir = -s.dir, price = live;
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
  const last = await livePrice("XAUUSD").catch(() => null);
  if (last === null || Math.abs(last - price) > MAX_SLIP * risk) {
    console.log("9:59 signal skipped, price moved or unavailable", price, last);
    return broadcast(chats, "⏰ <b>9:59 AM SETUP</b>\nNo entry today: price has already moved too far from the setup.");
  }
  const entry = Number(last.toFixed(dg)), sl = Number((last - dir * risk).toFixed(dg));
  await db.from("signals").insert({ id: crypto.randomUUID(), data: {
    kind: "Intraday", sym: "XAUUSD", dir, entry, sl, ...tpPlan("XAUUSD", dir, entry, sl, INTRADAY_TP), order: "instant", nine: true, life: NINE.life,
    note: "🤖 MEEGO AI · 9:59 AM setup: the 9-10 AM candle and the H1 trend agree · closes after 6 hours",
    status: "running", auto: true, time: Date.now(), closedAt: null } });
}
/* ---------- S&D setup for Scalping, Intraday and Swing (gold), the admin's rules ---------- */
// Must have: a valid unbroken S&D zone, not against a strong trend, room of 1.5R to the next swing, one entry confirmation (engulfing, rejection or CHoCH).
// Optional, shown on the signal: sweep, CHoCH, BOS, engulfing, rejection, FVG, SNR.
// Backtest, 4 pips spread: Intraday 41 signals +4.7R and Scalping 28 signals -9.8R in 2 months, Swing 87 signals +2.3R in 19 clean months. On trial.
// To go back to the earlier setups (intradaySetup, swingSetup, findSetup), set SND to false.
const SND = true;
const KX = {
  Scalping: { st: 60, zt: 15, ct: 5, min: 20, max: 100, life: 3, cool: 0.5, day: 5 }, // enters on the zone touch, see touchSetup
  Intraday: { st: 60, zt: 15, ct: 5, min: 30, max: 200, life: 24, cool: 1, day: 3 },
  Swing: { st: 240, zt: 60, ct: 60, min: 60, max: 600, life: 120, cool: 4, day: 2 },
};
const SM = { base: 0.7, imp: 1.3, age: 96, touch: 8, near: 0.5, look: 40, win: 24, pre: 4, buf: 0.25, rr: 1.5, snr: 2 };
function smStruct(c) {
  const x = c.slice(-80), p = pivots(x, 2), H = p.hi.slice(-2), L = p.lo.slice(-2);
  if (H.length < 2 || L.length < 2) return null;
  const cl = x[x.length - 1].c, pt = (q) => ({ t: x[q.i].t, v: q.v });
  if (H[1].v > H[0].v && L[1].v > L[0].v && cl > L[1].v) return { dir: 1, H: H.map(pt), L: L.map(pt) };
  if (H[1].v < H[0].v && L[1].v < L[0].v && cl < H[1].v) return { dir: -1, H: H.map(pt), L: L.map(pt) };
  return null;
}
function smZones(c, dir) {
  const a = atr(c), n = c.length, out = [];
  for (let i = n - 3; i >= Math.max(20, n - SM.age); i--) {
    const b = c[i];
    if (Math.abs(b.c - b.o) > SM.base * a) continue;
    let k = -1;
    for (let j = i + 1; j <= Math.min(n - 1, i + 3); j++) if ((c[j].c - b.c) * dir >= SM.imp * a) { k = j; break; }
    if (k < 0) continue;
    let lv = null;
    const pre = c.slice(Math.max(0, i - 40), i + 1), p = pivots(pre, 2), q = (dir > 0 ? p.hi : p.lo).at(-1);
    if (q) for (let j = i + 1; j <= Math.min(n - 1, i + 6); j++) if ((c[j].c - q.v) * dir > 0) { lv = { v: q.v, t: pre[q.i].t, bt: c[j].t }; break; }
    let fvg = null;
    for (let j = i; j <= k - 1 && j + 2 < n; j++) if (dir > 0 ? c[j + 2].l > c[j].h : c[j + 2].h < c[j].l) { fvg = dir > 0 ? { t: c[j + 1].t, lo: c[j].h, hi: c[j + 2].l } : { t: c[j + 1].t, lo: c[j + 2].h, hi: c[j].l }; break; }
    const same = p.hi.concat(p.lo).filter((x) => x.i < pre.length - 3 && x.v >= b.l - 0.25 * a && x.v <= b.h + 0.25 * a).length;
    const bot = b.l, top = b.h, aft = c.slice(k + 1);
    if (top - bot < 0.05 * a) continue; // a flat candle is not a zone
    if (aft.some((x) => (dir > 0 ? x.c < bot : x.c > top))) continue;
    const f = aft.findIndex((x) => (dir > 0 ? x.l <= top : x.h >= bot));
    out.push({ t: b.t, kt: c[k].t, bot, top, f: f < 0 ? null : aft[f].t, fage: f < 0 ? 0 : aft.length - f, bos: lv, fvg, same });
  }
  return out;
}

function smStrong(c) { // strong trend: structure AND price beyond a sloping EMA50
  const s = smStruct(c); if (!s || c.length < 70) return 0;
  const e = ema(c.slice(-300).map((x) => x.c), 50), v = e[e.length - 1], o = e[e.length - 6], cl = c[c.length - 1].c;
  return (cl - v) * s.dir > 0 && (v - o) * s.dir > 0 ? s.dir : 0;
}
function smc(kind, G, used) {
  const k = KX[kind], S = G(k.st), Z = G(k.zt), C = G(k.ct);
  if (C.length < 60 || Z.length < 60) return null;
  const z15 = atr(Z), ac = atr(C), n = C.length, s = smStruct(S), strong = smStrong(S);
  let best = null;
  for (const dir of [1, -1]) {
    if (strong === -dir) continue; // not against a strong trend
    const L = C[n - 1], P = C[n - 2];
    if ((L.c - L.o) * dir <= 0) continue;
    const body = Math.abs(L.c - L.o), range = L.h - L.l || 1e-9, wick = dir > 0 ? Math.min(L.o, L.c) - L.l : L.h - Math.max(L.o, L.c);
    const pin = wick >= 2 * body && wick >= 0.5 * range, eng = (P.c - P.o) * dir < 0 && body > Math.abs(P.c - P.o) && (L.c - P.o) * dir > 0;
    for (const z of smZones(Z, dir)) {
      if ((z.f && z.fage > SM.touch) || used.has("Z" + z.t + dir)) continue;
      const ft = C.findIndex((x) => x.t >= z.kt + k.zt * 6e4 && (dir > 0 ? x.l <= z.top : x.h >= z.bot));
      if (ft < 0 || n - ft > SM.win) continue;
      const rec = C.slice(ft), ext = dir > 0 ? Math.min(...rec.map((x) => x.l)) : Math.max(...rec.map((x) => x.h)), e = rec.findLastIndex((x) => (dir > 0 ? x.l : x.h) === ext);
      if (dir > 0 ? !(ext <= z.top && ext >= z.bot - SM.near * z15) : !(ext >= z.bot && ext <= z.top + SM.near * z15)) continue;
      if ((L.c - (dir > 0 ? z.bot : z.top)) * dir <= 0 || rec.some((x) => (dir > 0 ? x.c < z.bot : x.c > z.top))) continue;
      const old = Z.filter((x) => x.t + k.zt * 6e4 <= rec[e].t).slice(-SM.look), p = pivots(old, 2);
      const cand = (dir > 0 ? p.lo : p.hi).map((q) => ({ v: q.v, t: old[q.i].t })).filter((q) => (q.v - ext) * dir > 0.05 * z15 && (q.v - ext) * dir < 1.5 * z15 && !old.slice(0, old.length - SM.pre).some((x) => x.t > q.t && (dir > 0 ? x.c < q.v : x.c > q.v)));
      let lv = cand.sort((x, y) => (x.v - y.v) * dir)[0] || null;
      if (lv && (L.c - lv.v) * dir <= 0) lv = null;
      const b = n - rec.length + e, pre = C.slice(Math.max(0, b - 20), b + 2), ph = pivots(pre, 2), hs = (dir > 0 ? ph.hi : ph.lo).filter((x) => x.i < pre.length - 1).at(-1);
      const ch = hs && (L.c - hs.v) * dir > 0 && b < n - 1 ? { v: hs.v, t: pre[hs.i].t } : null;
      if (!(pin || eng || ch)) continue; // at least one entry confirmation
      const opt = []; if (lv) opt.push("Sweep"); if (ch) opt.push("CHoCH"); if (z.bos) opt.push("BOS"); if (eng) opt.push("Engulfing"); if (pin) opt.push("Rejection"); if (z.fvg) opt.push("FVG"); if (z.same >= SM.snr) opt.push("SNR");
      const sl = (dir > 0 ? Math.min(ext, z.bot) : Math.max(ext, z.top)) - dir * SM.buf * z15, risk = Math.abs(L.c - sl);
      // room: the nearest opposite swing must be at least rr x the risk away
      const zp = pivots(Z.slice(-80), 3), opp = (dir > 0 ? zp.hi : zp.lo).map((x) => x.v).filter((v) => (v - L.c) * dir > 0).sort((x, y) => (x - y) * dir)[0];
      const room = opp === undefined ? 9 : Math.abs(opp - L.c) / risk;
      if (room < SM.rr) continue;
      const rp = risk / pip("XAUUSD");
      if (rp < k.min || rp > k.max) continue;
      if (!best || opt.length > best.opt.length) best = { dir, key: "Z" + z.t + dir, entry: L.c, sl, z, opt };
    }
  }
  return best;
}
// Finished candles of every timeframe. m1 is fresh; m15 and h1 may be a few minutes old, so their newest candles are completed from m1.
function sndCandles(sym, m1, m15, h1) {
  const upTo = m1[m1.length - 1].t, g = m1.filter((x) => !/^XAU/.test(sym) || goldOpen(x.t)), done = (c, min) => c.filter((x) => x.t + min * 60000 <= upTo);
  const first = g.length ? g[0].t : 0;
  const join = (old, min) => { const fresh = done(group(g, min), min).filter((x) => x.t >= first), o = done(old.slice(0, -1), min), last = o.length ? o[o.length - 1].t : 0; return o.concat(fresh.filter((x) => x.t > last)).slice(-400); };
  const H1 = join(h1, 60), by = { 5: done(group(g, 5), 5).filter((x) => x.t >= first).slice(-400), 15: join(m15, 15), 60: H1, 240: done(group(done(h1.slice(0, -1), 60).concat(H1.filter((x) => !h1.slice(0, -1).some((y) => y.t === x.t))), 240), 240).slice(-400) };
  return (min) => by[min];
}
function sndSetup(kind, G, price, used) {
  const s = smc(kind, G, used);
  if (!s) return null;
  const tf = (x) => (x >= 240 ? "H4" : x >= 60 ? "H1" : "M" + x), k = KX[kind];
  return { dir: s.dir, entry: s.entry, sl: s.sl, zkey: s.key, zone: [Number(s.z.bot.toFixed(2)), Number(s.z.top.toFixed(2))], order: "instant", ...(kind === "Swing" ? { life: k.life } : {}),
    note: `🤖 MEEGO AI · ${s.dir > 0 ? "Demand" : "Supply"} zone ${tf(k.zt)} ${s.z.bot.toFixed(2)} - ${s.z.top.toFixed(2)} · ${s.opt.join(" + ")}` };
}
// Scalping: price comes into a strong, fresh M15 zone (price left it by 2x ATR or more) -> signal at once, no confirmation candle.
// 2 months of 5-min gold, 4 pips spread, this scanner: stops up to 80 pips 93-97 signals -5.1R to -7.1R, up to 100 pips (in use) 101-106 signals +1.3R to -3.1R, up to 120 pips 110-114 signals +1.8R to +6.7R. M5 zones lost 35R.
const TOUCH = { imp: 2, fresh: 2, over: 0.1, near: 1 };
function touchZones(G, price, used) { // strong zones close to price
  const k = KX.Scalping, Z = G(k.zt), a = atr(Z), strong = smStrong(G(k.st)), out = [];
  if (Z.length < 60 || !a) return out;
  for (const dir of [1, -1]) {
    if (strong === -dir) continue; // not against a strong trend
    for (const z of smZones(Z, dir)) {
      if ((z.f && z.fage > TOUCH.fresh) || used.has("Z" + z.t + dir)) continue; // first visit only
      const b = Z.findIndex((x) => x.t === z.t), imp = Math.max(...Z.slice(b + 1, b + 5).map((x) => (x.c - Z[b].c) * dir)) / a;
      if (imp < TOUCH.imp || (price - (dir > 0 ? z.top : z.bot)) * dir > TOUCH.near * a) continue;
      out.push({ dir, z, imp, a, sl: (dir > 0 ? z.bot : z.top) - dir * SM.buf * a });
    }
  }
  return out;
}
function touchSetup(zones, live) {
  const k = KX.Scalping, hit = zones.filter(({ dir, z, a, sl }) => {
    const pips = Math.abs(live - sl) / pip("XAUUSD");
    return (dir > 0 ? live <= z.top + TOUCH.over * a && live >= z.bot : live >= z.bot - TOUCH.over * a && live <= z.top) && pips >= k.min && pips <= k.max;
  }).sort((x, y) => y.imp - x.imp)[0];
  if (!hit) return null;
  const { dir, z, sl, imp } = hit, opt = [z.bos && "BOS", z.fvg && "FVG", z.same >= SM.snr && "SNR"].filter(Boolean);
  return { dir, entry: live, sl, zkey: "Z" + z.t + dir, zone: [Number(z.bot.toFixed(2)), Number(z.top.toFixed(2))], order: "instant",
    note: `🤖 MEEGO AI · ${dir > 0 ? "Demand" : "Supply"} zone M15 ${z.bot.toFixed(2)} - ${z.top.toFixed(2)} · strong zone (${imp.toFixed(1)}x ATR)${opt.length ? " · " + opt.join(" + ") : ""} · price entered the zone` };
}
async function scalpTouch(sym, G, price, used) {
  const zones = touchZones(G, price, used);
  if (!zones.length) return null; // nothing near: no price call
  const live = await livePrice(sym).catch(() => null);
  return live === null ? null : touchSetup(zones, live);
}
/* ---------- SNR breakout + retest (gold): levels on a higher timeframe, break, retest and confirmation on a lower one ---------- */
// Level: 2+ swing points (level timeframe) within tol x ATR. Break: a strong candle (break timeframe) closes through a level price had been respecting.
// Retest: price comes back to the level within `win` candles without closing back through it; the last candle confirms (closes away from the level).
// Posted with setup "SNR" (admin only, trial) and their own limits per kind. Backtests, MT5 gold, 3 pips spread, the kind's own TPs, SL to entry after TP1:
//   Scalping (M15 levels, M5 break), 6 months: 176 signals, TP1 57%, +23.4R (Jun-Aug +7.9R, Sep-Nov +16.5R)
//   Intraday (H1 levels, M15 break), 6 months: 56 signals, TP1 59%, +11.8R (Jun-Aug +9.2R, Sep-Nov +2.6R)
//   Swing (H4 levels, H1 break), 17 months: 36 signals, TP1 44%, +5.7R (weak: Mar-Nov 2026 +0.3R)
const SNRB = { look: 160, piv: 3, tol: 0.3, touches: 2, clean: 24, body: 0.5, beyond: 0.1, win: 16, near: 0.2, back: 0.15, far: 0.6, buf: 0.25 };
// lt: level timeframe, bt: break timeframe (minutes); min/max: stop in pips; open/cool(h)/day: limits; life: hours
const SNRK = {
  Scalping: { lt: 15, bt: 5, clean: 36, min: 20, max: 100, open: 1, cool: 0.5, day: 5, life: 3 },
  Intraday: { lt: 60, bt: 15, min: 30, max: 150, open: 1, cool: 1, day: 3, life: 24 },
  Swing: { lt: 240, bt: 60, min: 60, max: 300, open: 1, cool: 4, day: 2, life: 120 },
};
function snrLevels(H, P = SNRB) {
  const x = H.slice(-P.look), a = atr(x), p = pivots(x, P.piv), pts = p.hi.concat(p.lo).map((q) => ({ v: q.v, t: x[q.i].t })).sort((u, w) => u.v - w.v), out = [];
  for (let i = 0; i < pts.length; ) {
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].v - pts[i].v <= P.tol * a) j++;
    if (j - i + 1 >= P.touches) { const g = pts.slice(i, j + 1); out.push({ v: g.reduce((s, q) => s + q.v, 0) / g.length, n: g.length, last: Math.max(...g.map((q) => q.t)) }); }
    i = j + 1;
  }
  return { levels: out, a };
}
function snrBreak(H, M, used, k) {
  const P = { ...SNRB, ...k };
  if (H.length < 60 || M.length < 60) return null;
  const { levels, a } = snrLevels(H, P), n = M.length, L = M[n - 1], strong = smStrong(H);
  if (!a) return null;
  let best = null;
  for (const lv of levels) {
    for (const dir of [1, -1]) {
      if (strong === -dir) continue; // not against a strong trend on the level timeframe
      // the break: a strong close through the level, within the last `win` candles, after the level held for `clean` candles
      let b = -1;
      for (let i = n - 2; i >= Math.max(P.clean, n - 1 - P.win); i--) {
        const x = M[i], body = Math.abs(x.c - x.o);
        if ((x.c - lv.v) * dir > P.beyond * a && (M[i - 1].c - lv.v) * dir <= 0 && (x.c - x.o) * dir > 0 && body >= P.body * (x.h - x.l)) { b = i; break; }
      }
      if (b < 0 || lv.last >= M[b].t) continue;
      if (M.slice(b - P.clean, b).some((x) => (x.c - lv.v) * dir > 0)) continue; // it was a real level before the break
      const key = "B" + M[b].t + dir;
      if (used.has(key)) continue;
      const after = M.slice(b + 1);
      if (after.some((x) => (x.c - lv.v) * dir < -P.back * a)) continue; // closed back through: failed breakout
      // the retest: came back to the level after the break (in the last 3 candles), and the last candle closes away from it
      const r = after.findIndex((x) => (dir > 0 ? x.l : x.h) * dir <= (lv.v + dir * P.near * a) * dir);
      if (r < 0 || after.length - r > 3) continue;
      if ((L.c - L.o) * dir <= 0 || (L.c - lv.v) * dir <= 0 || (L.c - lv.v) * dir > P.far * a) continue;
      const ext = dir > 0 ? Math.min(...after.slice(r).map((x) => x.l)) : Math.max(...after.slice(r).map((x) => x.h));
      const sl = (dir > 0 ? Math.min(ext, lv.v) : Math.max(ext, lv.v)) - dir * P.buf * a, risk = Math.abs(L.c - sl), rp = risk / pip("XAUUSD");
      if (rp < P.min || rp > P.max) continue;
      if (!best || lv.n > best.lv.n) best = { dir, key, entry: L.c, sl, lv, a, bt: M[b].t };
    }
  }
  return best;
}
const TFN = (m) => (m >= 240 ? "H4" : m >= 60 ? "H1" : "M" + m);
async function snrScan(sym, G, all, kind) {
  const k = SNRK[kind], mine = all.filter((s) => s.setup === "SNR" && s.kind === kind && s.sym === sym && !s.test);
  if (mine.filter((s) => s.status === "running").length >= k.open) return;
  if (Date.now() - Math.max(0, ...mine.map((s) => s.closedAt || s.time)) < k.cool * 3600000) return;
  if (mine.filter((s) => s.time >= Date.now() - 86400000).length >= k.day) return;
  const b = snrBreak(G(k.lt), G(k.bt), new Set(mine.map((x) => x.zkey).filter(Boolean)), k);
  if (!b) return;
  const lo = b.lv.v - SNRB.near * b.a, hi = b.lv.v + SNRB.near * b.a, d = digits(sym);
  // the broken level (now support for a BUY, resistance for a SELL) and the other levels, for the chart and the EA
  const lvls = snrLevels(G(k.lt), { ...SNRB, ...k }).levels.map((l) => [Number(l.v.toFixed(d)), l.n]);
  const s = { dir: b.dir, entry: b.entry, sl: b.sl, zkey: b.key, zone: [Number(lo.toFixed(2)), Number(hi.toFixed(2))], order: "instant", setup: "SNR", life: k.life, level: Number(b.lv.v.toFixed(d)), levels: lvls,
    note: `🤖 MEEGO AI · SNR breakout + retest · ${TFN(k.lt)} ${b.dir > 0 ? "resistance" : "support"} ${b.lv.v.toFixed(2)} (${b.lv.n} touches) broken on ${TFN(k.bt)} → ${b.dir > 0 ? "RBS (resistance became support)" : "SBR (support became resistance)"}, retested and holding` };
  if (!(await reprice(s, sym))) return;
  const rp = Math.abs(s.entry - s.sl) / pip(sym);
  if (rp < k.min || rp > k.max) return;
  for (const f of ["entry", "sl"]) s[f] = Number(s[f].toFixed(d));
  Object.assign(s, tpPlan(sym, s.dir, s.entry, s.sl, kind === "Swing" ? SWING_TP : kind === "Intraday" ? INTRADAY_TP : TP_PLAN));
  await db.from("signals").insert({ id: crypto.randomUUID(), data: { kind, sym, ...s, status: "running", auto: true, trial: true, time: Date.now(), closedAt: null } });
}
// Last saved copy of the candles (no API call); asks for new ones when it is over 20 minutes old
async function savedCandles(sym, interval) {
  const { data } = await db.from("price_cache").select("data,fetched_at").eq("key", `${sym.slice(0, 3)}/${sym.slice(3)}|${interval}`).maybeSingle();
  const list = data?.data?.candles;
  if (!Array.isArray(list) || Date.now() - new Date(data.fetched_at).getTime() > 20 * 60000) return candles(sym, interval);
  return /^XAU/.test(sym) ? list.filter((x) => goldOpen(x.t)) : list;
}
async function autoScan() {
  const cfg = await settings();
  if (cfg.auto_scan === "off") return;
  const { data } = await db.from("signals").select("id,data").order("updated_at", { ascending: false }).limit(300);
  const all = (data ?? []).map((r) => ({ id: r.id, ...r.data })).filter((s) => s && s.sym);
  const running = all.filter((s) => s.status === "running" && s.auto);
  if (running.length) await watchSignals(running);
  const now = new Date();
  const quarter = now.getUTCMinutes() % 15 < 5; // other setups are looked for every 15 minutes, the gold S&D setups every 5
  if (!quarter && !SND) return;
  const pairs = String(cfg.scan_pairs || "XAUUSD").split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);
  for (const sym of pairs) {
    const snd = SND && /^XAU/.test(sym);
    if (!marketOpen(now, sym) || (!quarter && !snd)) continue;
    const m1 = await candles(sym, "1min");
    if (!m1.length || Date.now() - m1[m1.length - 1].t > 20 * 60000) continue; // no fresh prices (holiday)
    const load = quarter ? candles : savedCandles, m15 = await load(sym, "15min"), h1 = await load(sym, "1h");
    const price = m1[m1.length - 1].c;
    const sndG = snd ? sndCandles(sym, m1, m15, h1) : null;
    const closed = (c) => c.slice(0, -1); // drop the candle that is still forming
    const d = { sym, m5: closed(group(m1, 5)), m15: closed(m15), h1: closed(h1), h4: closed(group(h1, 240)), d1: closed(group(h1, 1440)) };
    d.trend = { m5: tfTrend(d.m5), m15: tfTrend(d.m15), h1: tfTrend(d.h1), h4: tfTrend(d.h4), d1: tfTrend(d.d1) };
    // finished candles only, for the Intraday setups: m1 is cached for up to 3 minutes, so "finished" is judged by its last candle
    const upTo = m1[m1.length - 1].t, up15 = m15.length ? m15[m15.length - 1].t : 0;
    const ix = { m5: group(m1.filter((x) => !/^XAU/.test(sym) || goldOpen(x.t)), 5).filter((x) => x.t + 300000 <= upTo), m15: m15.filter((x) => x.t < up15), m30: group(m15.filter((x) => x.t < up15), 30).filter((x) => x.t + 1800000 <= up15), h1: d.h1 };
    for (const kind of ["Swing", "Intraday", "Scalping"]) {
      const mine = all.filter((s) => s.kind === kind && s.sym === sym && s.auto && !s.nine && !s.test && !s.setup);
      if (mine.filter((s) => s.status === "running").length >= AUTO[kind].open) continue;
      const lastEnd = Math.max(0, ...mine.map((s) => s.closedAt || s.time));
      if (Date.now() - lastEnd < AUTO[kind].cool * 3600000) continue;
      if (mine.filter((s) => s.time >= Date.now() - 86400000).length >= AUTO[kind].max) continue;
      // The longer it's been quiet today, the lower the score needed (so there's at least one a day)
      const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
      const quiet = (Date.now() - Math.max(dayStart, ...mine.map((s) => s.time))) / 3600000;
      const own = snd || (kind !== "Scalping" && /^XAU/.test(sym)), used = new Set(mine.map((x) => x.zkey).filter(Boolean));
      const touch = snd && kind === "Scalping"; // already priced at the live price
      const s = touch ? await scalpTouch(sym, sndG, price, used) : snd ? sndSetup(kind, sndG, price, used) : !own ? findSetup(kind, d, price, relaxDrop(kind, quiet)) : kind === "Intraday" ? intradaySetup(ix, price, used) : swingSetup(d.h1, h1.length ? h1[h1.length - 1].t : 0, price, used);
      if (!s || !(touch || (await reprice(s, sym)))) continue;
      const nowPips = Math.abs(s.entry - s.sl) / pip(sym);
      if (snd && nowPips < (KX[kind]?.min ?? 0)) continue;
      if (/^XAU/.test(sym) && nowPips > (kind === "Scalping" ? AUTO.Scalping.maxPips : kind === "Intraday" ? IX.maxPips : SX.maxPips)) continue; // the stop must still be within its limit
      // Sharp entry: when the stop is far (gold Intraday/Swing over LIMIT.pips), wait for a pullback with a limit order
      const risk = Math.abs(s.entry - s.sl);
      if (!own && kind !== "Scalping" && /^XAU/.test(sym) && risk / pip(sym) > LIMIT.pips) {
        s.entry -= s.dir * LIMIT.k * risk;
        s.tp = s.entry + s.dir * AUTO[kind].rr * Math.abs(s.entry - s.sl);
        Object.assign(s, { order: "limit", pending: true });
      } else s.order = "instant";
      for (const k of ["entry", "sl"]) s[k] = Number(s[k].toFixed(digits(sym)));
      Object.assign(s, tpPlan(sym, s.dir, s.entry, s.sl, own && kind === "Swing" ? SWING_TP : snd && kind === "Intraday" ? INTRADAY_TP : TP_PLAN));
      await db.from("signals").insert({ id: crypto.randomUUID(), data: { kind, sym, ...s, status: "running", auto: true, ...(TRIAL.includes(kind) ? { trial: true } : {}), time: Date.now(), closedAt: null } });
    }
    if (snd) for (const kind of ["Swing", "Intraday", "Scalping"]) await snrScan(sym, sndG, all, kind).catch((e) => console.error("SNR breakout failed", kind, e));
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
// Entry zone of a chart scan: the AI's own zone when it makes sense, else 30% of the way from entry towards the SL
function scanZone(r, dir, sym) {
  let lo = Number(r.zone_low), hi = Number(r.zone_high);
  if (lo > hi) [lo, hi] = [hi, lo];
  const e = Number(r.entry), sl = Number(r.sl);
  if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo <= e && e <= hi && (dir > 0 ? lo > sl : hi < sl))) {
    const far = e - dir * 0.3 * Math.abs(e - sl);
    [lo, hi] = [Math.min(e, far), Math.max(e, far)];
  }
  return `Entry zone: <code>${px(lo, sym)}</code> – <code>${px(hi, sym)}</code>`;
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
Also give the entry zone (zone_low, zone_high): the price area where entering still makes sense, usually the supply/demand or support/resistance area around the entry; it must contain the entry and stay on the entry side of the SL.
Reply with ONLY one JSON object:
"pair" must be ONLY the short ticker read from the chart itself, e.g. "XAUUSD", "BTCUSD", "EURUSD" (no spaces, no explanation). If the user's caption names a different pair than the chart shows, silently use the chart's ticker. Do not mention the caption or any mismatch anywhere.
{"pair":"TICKER or null","direction":"BUY|SELL|WAIT","confidence":0-100,"timeframe":"text or null","entry":number|null,"zone_low":number|null,"zone_high":number|null,"sl":number|null,"tp":number|null,"reason":"2-4 sentences in English","invalidation":"text"}
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
      `Entry: <code>${px(r.entry, sym)}</code>`, scanZone(r, d === "BUY" ? 1 : -1, sym), `TP: <code>${px(r.tp, sym)}</code>`, `SL: <code>${px(r.sl, sym)}</code>`, `Risk-to-reward 1:${rr.toFixed(2)}`);
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
    `All plans: ${off("Scalping") ? "" : "⚡ Scalping, "}${off("Intraday") ? "" : "📈 Intraday, "}📰 News signals, 🕘 9:59 AM setup, 🧭 Direction, 🖼 Chart Scanner, 📊 History.`,
    ...(off("Swing") ? [] : ["⭐ <b>Priority Swing</b> signals are for <b>Ultimate</b> only."]),
    ...(TRIAL.length ? [`🧪 Auto ${trialText} signals are being re-tested, so they're not included right now.`] : []),
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
// One line per signal: S|id|kind|news|sym|dir|order|status|pending|entry|sl|tp1|tp2|tp3|tpHit|slNow|time|expireH|filled|zoneLow|zoneHigh|lifeH|ready
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
  const rows = (data ?? []).map((r) => ({ id: r.id, ...r.data })).filter((x) => x && x.sym && (x.status === "running" || (x.closedAt || x.time) >= since) && canSeeSignal(a, x));
  const lines = rows.map((x) => ["S", x.id, x.kind, x.news || "", x.sym, x.dir, x.order || "instant", x.status, x.pending ? 1 : 0, n(x.entry), n(x.sl0 ?? x.sl),
    ...(x.tps ? x.tps.map(n) : [n(x.tp), "0", "0"]), x.tpHit || 0, n(x.sl), Math.round(x.time || 0), x.expire ?? LIMIT.expire, Math.round(x.filled || 0), n(x.zone?.[0]), n(x.zone?.[1]), n(x.life ?? AUTO[x.kind]?.life), x.wait ? 0 : 1, x.setup || "", n(x.level ?? (x.setup === "SNR" && x.zone ? (x.zone[0] + x.zone[1]) / 2 : 0))].join("|"));
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
async function saveEaFile(chatId, msg) {
  const doc = msg.document, ext = doc.file_name.split(".").pop().toLowerCase(), name = "MEEGO_AI_EA." + ext, all = /\ball\b/i.test(String(msg.caption || ""));
  if (doc.file_size > 5 * 1024 * 1024) return send(chatId, "That file is too big for an EA.");
  const f = await tg("getFile", { file_id: doc.file_id });
  if (!f.ok) return send(chatId, "Couldn't download that file. Try sending it again.");
  const bytes = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`)).arrayBuffer());
  if (ext === "ex5" && bytes.length < 1000) return send(chatId, "That doesn't look like a compiled EA (.ex5).");
  const b64 = toBase64(bytes), version = ext === "mq5" ? (new TextDecoder().decode(bytes).match(/#property\s+version\s+"([^"]+)"/) || [])[1] : null;
  const rows = [{ name: "admin/" + name, b64, updated_at: new Date().toISOString() }].concat(all ? [{ name, b64, updated_at: new Date().toISOString() }] : []);
  const { error } = await db.from("ea_files").upsert(rows);
  if (error) return send(chatId, "Couldn't save the EA file: " + esc(error.message));
  return send(chatId, `✅ <b>${name}</b> saved${version ? ` (version ${esc(version)})` : ""}, ${Math.round(bytes.length / 1024)} KB.\n${all ? "Everyone now gets this file from 🤖 MT5 EA / /ea." : "Only you get it from 🤖 MT5 EA / /ea. Send it again with the caption <b>all</b> to give it to customers too."}`);
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
  const bin = (a.admin ? await eaFile("admin/MEEGO_AI_EA.ex5").catch(() => null) : null) ?? (await eaFile("MEEGO_AI_EA.ex5").catch(() => null));
  if (!bin) return send(chatId, "Couldn't attach the EA file right now. Try /ea again in a minute.");
  await sendFile(chatId, "MEEGO_AI_EA.ex5", bin, "📎 <b>MEEGO_AI_EA.ex5</b> · put it in MQL5 → Experts");
  if (!a.admin) return;
  // Admin only: the editable source code (customers get the compiled .ex5 only)
  const src = (await eaFile("admin/MEEGO_AI_EA.mq5").catch(() => null)) ?? (await eaFile("MEEGO_AI_EA.mq5").catch(() => null));
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
  await welcome(u.chat_id, `🎉 Welcome to <b>MEEGO AI</b>! Your <b>${tier}</b> plan is active until <b>${end}</b>.\n\nYou'll get new signals here automatically. Tap ⚡ Scalping, 📈 Intraday or ⭐ Swing to see what's running.${TRIAL.length ? ` Auto ${trialText} signals are being re-tested and aren't sent right now; news signals and the 9:59 AM setup are.` : ""}`, { reply_markup: MENU });
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
      "<code>/testsignal buy|sell scalping|intraday|swing [limit]</code> EA test signal (only you get it) · <code>/testend</code> closes it",
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
  // A made-up signal at the current price, only for the admin, to check the EA (zone lines, entry, TPs). Not counted anywhere.
  if (cmd === "/testsignal") {
    const words = parts.slice(1).map((w) => w.toLowerCase()), dir = words.includes("sell") ? -1 : 1, limit = words.includes("limit");
    const kind = words.some((w) => /^swing/.test(w)) ? "Swing" : words.some((w) => /^intra/.test(w)) ? "Intraday" : "Scalping";
    const live = marketOpen(new Date(), "XAUUSD") ? await livePrice("XAUUSD").catch(() => null) : null;
    if (live === null) return send(chatId, "No gold price right now (market closed or price not available). Try again later.");
    // the nearest real S&D zone on the chart (M15, Swing H1) that price hasn't broken: inside it = instant entry, away from it = limit at its edge
    const tf = kind === "Swing" ? "1h" : "15min", Z = (await candles("XAUUSD", tf)).slice(0, -1).slice(-400), a = atr(Z), r2 = (x) => Number(x.toFixed(2));
    const zs = Z.length > 60 && a ? smZones(Z, dir).filter((q) => (dir > 0 ? q.bot < live : q.top > live)).sort((x, y) => Math.abs((dir > 0 ? x.top : x.bot) - live) - Math.abs((dir > 0 ? y.top : y.bot) - live)) : [];
    const zq = zs[0];
    if (!zq) return send(chatId, `No unbroken ${dir > 0 ? "demand" : "supply"} zone on ${tf === "1h" ? "H1" : "M15"} right now. Try ${dir > 0 ? "sell" : "buy"} or another type.`);
    const inZone = live >= zq.bot && live <= zq.top, useLimit = limit || !inZone, edge = dir > 0 ? zq.top : zq.bot;
    const e = useLimit ? edge : live, entry = r2(e), sl = r2((dir > 0 ? zq.bot : zq.top) - dir * 0.25 * a), z = [r2(zq.bot), r2(zq.top)], zkey = "Z" + zq.t + dir;
    const { error } = await db.from("signals").insert({ id: crypto.randomUUID(), data: { kind, sym: "XAUUSD", dir, entry, sl, ...tpPlan("XAUUSD", dir, entry, sl, kind === "Swing" ? SWING_TP : kind === "Intraday" ? INTRADAY_TP : TP_PLAN), zone: z, zkey,
      order: useLimit ? "limit" : "instant", ...(useLimit ? { pending: true, expire: 1 } : {}), life: 1, test: true, trial: true, auto: true,
      note: `EA TEST · real ${dir > 0 ? "demand" : "supply"} zone ${tf === "1h" ? "H1" : "M15"} ${z[0].toFixed(2)} - ${z[1].toFixed(2)} (price left it by ${((Math.max(...Z.slice(Z.findIndex((x) => x.t === zq.t) + 1, Z.findIndex((x) => x.t === zq.t) + 5).map((x) => (x.c - Z.find((y) => y.t === zq.t).c) * dir))) / a).toFixed(1)}x ATR) · not a full setup, no confirmation · closes after 1 hour`, status: "running", time: Date.now(), closedAt: null } });
    return send(chatId, error ? "Couldn't save the test signal: " + esc(error.message) : `🧪 Test ${kind} ${dir > 0 ? "BUY" : "SELL"}${useLimit ? " LIMIT" : ""} sent on a real zone ${z[0]} - ${z[1]}. The EA should react within about 30 seconds. Send /testend to close it.`);
  }
  if (cmd === "/testend") {
    const { data } = await db.from("signals").select("id,data").order("updated_at", { ascending: false }).limit(100);
    const open = (data ?? []).map((r) => ({ id: r.id, ...r.data })).filter((x) => x.test && x.status === "running"), live = open.length ? await livePrice("XAUUSD").catch(() => null) : null;
    for (const x of open) await setStatus(x, "closed", live ?? x.entry);
    return send(chatId, open.length ? `🧪 Closed ${open.length} test signal${open.length > 1 ? "s" : ""}. The EA closes its test trades within about 30 seconds.` : "No test signal is running.");
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

/* ---------- signal chart picture: candles, zone, entry, SL, TPs ---------- */
// Signal chart as SVG: candles, zone, entry, SL, TPs (Malaysia time)
// Signal chart as SVG: candles, zone, entry, SL, TPs (Malaysia time)
function chartSvg(o) {
  const { candles, title, sub, dir, entry, sl, tps = [], zone = null, zoneFrom = 0, tf = 15, digits = 2, signalT = 0, marks = [], ribbon = null, dash = null, vline = null, snr = null } = o;
  const baseI = zoneFrom ? candles.findIndex((c) => c.t === zoneFrom) : -1;
  const W = 1000, H = 600, L = 14, R = 112, T = 62, B = 46, n = candles.length;
  const C = { bg: "#0f1115", grid: "#20242c", text: "#c9ced8", mut: "#7c8492", up: "#26a69a", dn: "#ef5350", zone: dir > 0 ? "#26a69a" : "#ef5350", entry: "#e6e8ee", sl: "#ef5350", tp: "#26a69a" };
  const vals = candles.flatMap((x) => [x.h, x.l]).concat([entry, sl], tps.length ? [tps[0]] : [], zone || []);
  let hi = Math.max(...vals), lo = Math.min(...vals); const pad = (hi - lo) * 0.06 || 1; hi += pad; lo -= pad;
  const RB = ribbon ? 14 : 0;
  const pw = W - L - R, ph = H - T - B - RB, step = pw / Math.max(n, 1), y = (v) => T + ((hi - v) / (hi - lo)) * ph, x = (i) => L + i * step + step / 2;
  const f = (v) => Number(v).toFixed(digits), esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const my = (t) => new Date(t + 8 * 3600000), hm = (t) => my(t).toISOString().slice(11, 16), dm = (t) => my(t).toISOString().slice(5, 10).split("-").reverse().join("/");
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans"><rect width="${W}" height="${H}" fill="${C.bg}"/>`;
  // price grid
  const raw = (hi - lo) / 6, mag = Math.pow(10, Math.floor(Math.log10(raw))), gs = [1, 2, 5, 10].map((k) => k * mag).find((k) => k >= raw);
  for (let v = Math.ceil(lo / gs) * gs; v <= hi; v += gs) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/><text x="${W - R + 8}" y="${y(v) + 4}" font-size="12" fill="${C.mut}">${f(v)}</text>`;
  // time labels
  const every = Math.max(1, Math.round(n / 6)); // (time labels stay under the ribbon)
  for (let i = 0; i < n; i += every) s += `<line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}" stroke="${C.grid}"/><text x="${x(i)}" y="${H - B + 18}" font-size="12" fill="${C.mut}" text-anchor="middle">${hm(candles[i].t)}</text><text x="${x(i)}" y="${H - B + 33}" font-size="11" fill="${C.mut}" text-anchor="middle">${dm(candles[i].t)}</text>`;
  // zone (its label is drawn last, over the lines)
  let zl = "";
  if (zone) {
    let i0 = candles.findIndex((c) => c.t >= zoneFrom); if (i0 < 0 || !zoneFrom) i0 = 0;
    const zx = x(i0) - step / 2, zy = y(Math.max(...zone)), zh = Math.max(2, y(Math.min(...zone)) - zy);
    s += `<rect x="${zx}" y="${zy}" width="${W - R - zx}" height="${zh}" fill="${C.zone}" fill-opacity="0.16" stroke="${C.zone}" stroke-opacity="0.7"/>`;
    const zt = `${dir > 0 ? "DEMAND ZONE" : "SUPPLY ZONE"} ${f(Math.min(...zone))} - ${f(Math.max(...zone))}`, tw = zt.length * 7.6, tx = Math.min(zx + 4, W - R - tw - 6), ty = dir > 0 ? zy + zh + 17 : zy - 7;
    zl = `<rect x="${tx - 3}" y="${ty - 13}" width="${tw + 6}" height="18" rx="3" fill="${C.bg}" fill-opacity="0.85"/><text x="${tx}" y="${ty}" font-size="13" fill="${C.zone}">${zt}</text>`;
  }
  // SNR: horizontal lines, red = resistance (above the price), blue = support (below); the broken level is thick, in its new role
  if (snr) {
    const RED = "#ef5350", BLUE = "#2196f3", seen = [];
    // besides the broken level: the 2 nearest resistances above the entry and the 2 nearest supports below, at least 4% of the chart apart
    const ok = (snr.levels || []).filter(([v]) => v >= lo && v <= hi && Math.abs(v - snr.key) > (hi - lo) * 0.04);
    const up = ok.filter(([v]) => v > Math.max(entry, snr.key)).sort((p, q) => p[0] - q[0]), dn = ok.filter(([v]) => v < Math.min(entry, snr.key)).sort((p, q) => q[0] - p[0]);
    const pick = (a) => a.reduce((out, l) => (out.length < 2 && out.every((o) => Math.abs(o[0] - l[0]) > (hi - lo) * 0.04) ? [...out, l] : out), []);
    for (const [v, nT] of [...pick(up), ...pick(dn)]) {
      const col = v > entry ? RED : BLUE;
      s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${col}" stroke-width="1.2" stroke-opacity="0.8" stroke-dasharray="10 5"/>`;
      zl += `<text x="${L + 4}" y="${y(v) - 4}" font-size="11" fill="${col}">${v > entry ? "RESISTANCE" : "SUPPORT"} ${f(v)} (${nT}x)</text>`;
    }
    const col = dir > 0 ? BLUE : RED, kt = `${dir > 0 ? "RBS" : "SBR"} ${f(snr.key)} · ${dir > 0 ? "resistance became support" : "support became resistance"}`, tw = kt.length * 7.6;
    s += `<line x1="${L}" x2="${W - R}" y1="${y(snr.key)}" y2="${y(snr.key)}" stroke="${col}" stroke-width="3"/>`;
    const ty = dir > 0 ? y(snr.key) + 18 : y(snr.key) - 8;
    zl += `<rect x="${L + 1}" y="${ty - 13}" width="${tw + 6}" height="18" rx="3" fill="${C.bg}" fill-opacity="0.85"/><text x="${L + 4}" y="${ty}" font-size="13" font-weight="bold" fill="${col}">${kt}</text>`;
  }
  // the base candle of the zone and the strong move away from it
  if (baseI >= 0) {
    const b = candles[baseI], mv = candles.slice(baseI + 1, baseI + 5), far = dir > 0 ? Math.max(...mv.map((c) => c.h)) : Math.min(...mv.map((c) => c.l)), j = baseI + 1 + mv.findIndex((c) => (dir > 0 ? c.h : c.l) === far);
    s += `<rect x="${x(baseI) - step * 0.7}" y="${y(b.h) - 4}" width="${step * 1.4}" height="${y(b.l) - y(b.h) + 8}" fill="none" stroke="#f5c542" stroke-width="2"/>`;
    if (mv.length) s += `<path d="M${x(baseI)} ${dir > 0 ? y(b.l) + 18 : y(b.h) - 18} L${x(j)} ${dir > 0 ? y(far) - 10 : y(far) + 10}" stroke="#f5c542" stroke-width="2" stroke-dasharray="5 4" fill="none"/>`;
    zl += `<text x="${Math.max(L + 2, x(baseI) - 18)}" y="${dir > 0 ? y(b.l) + 34 : y(b.h) - 24}" font-size="12" fill="#f5c542">BASE</text>`;
  }
  // PR SOP: ribbon (trend of every candle), vertical line on the candle after the signal, BUY/SELL/BUY+/SELL+ labels
  if (ribbon) for (let i = 0; i < n; i++) s += `<rect x="${x(i) - step / 2}" y="${H - B - RB + 2}" width="${step + 0.5}" height="${RB - 4}" fill="${ribbon[i] > 0 ? C.up : ribbon[i] < 0 ? C.dn : C.mut}"/>`;
  if (vline) { const vi = candles.findIndex((c) => c.t >= vline.t); if (vi >= 0) s += `<line x1="${x(vi)}" x2="${x(vi)}" y1="${T}" y2="${H - B}" stroke="${vline.dir > 0 ? "#29b6f6" : "#ff9800"}" stroke-width="1.5" stroke-dasharray="7 5"/><text x="${x(vi) > W - R - 120 ? x(vi) - 6 : x(vi) + 6}" y="${T + 14}" font-size="12" fill="${vline.dir > 0 ? "#29b6f6" : "#ff9800"}" text-anchor="${x(vi) > W - R - 120 ? "end" : "start"}">${esc(vline.text)}</text>`; }
  for (const mk of marks) {
    const i = candles.findIndex((c) => c.t === mk.t); if (i < 0) continue;
    const c = candles[i], up = mk.dir > 0, plus = mk.text.endsWith("+"), bg = up ? (plus ? "#0e6b7d" : "#1b6e2a") : plus ? "#a3580f" : "#8e1c1c", tw = mk.text.length * 8 + 12;
    const yy = up ? y(c.l) + 10 : y(c.h) - 10 - 20;
    s += `<rect x="${x(i) - tw / 2}" y="${yy}" width="${tw}" height="20" rx="3" fill="${bg}"/><text x="${x(i)}" y="${yy + 14}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">${esc(mk.text)}</text>`;
  }
  // candles
  const w = Math.max(1.5, step * 0.66);
  for (let i = 0; i < n; i++) {
    const c = candles[i], col = c.c >= c.o ? C.up : C.dn;
    s += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(c.h)}" y2="${y(c.l)}" stroke="${col}"/><rect x="${x(i) - w / 2}" y="${Math.min(y(c.o), y(c.c))}" width="${w}" height="${Math.max(1, Math.abs(y(c.o) - y(c.c)))}" fill="${col}"/>`;
  }
  // levels, labels on the right
  const lv = [[entry, "ENTRY", C.entry, ""], [sl, "SL", C.sl, "6 4"], ...tps.map((t, i) => [t, "TP" + (i + 1), C.tp, "6 4"])].filter(([v]) => v >= lo && v <= hi);
  const lab = lv.map(([v, name, col, dash]) => { s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${col}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`; return { yy: y(v), v, name, col }; }).sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < lab.length; i++) if (lab[i].yy - lab[i - 1].yy < 20) lab[i].yy = lab[i - 1].yy + 20;
  for (const l of lab) s += `<rect x="${W - R + 2}" y="${l.yy - 10}" width="${R - 4}" height="20" rx="3" fill="${l.col}"/><text x="${W - R + 7}" y="${l.yy + 5}" font-size="12" font-weight="bold" fill="${C.bg}">${l.name} ${f(l.v)}</text>`;
  // the signal candle: a triangle under it (BUY) or over it (SELL)
  let k = n - 1;
  if (signalT) { k = candles.findLastIndex((c) => c.t <= signalT); if (k < 0) k = n - 1; }
  if (k < n - 1) s += `<line x1="${x(k)}" x2="${x(k)}" y1="${T}" y2="${H - B}" stroke="${C.entry}" stroke-opacity="0.5" stroke-dasharray="3 4"/><text x="${x(k) + 5}" y="${T + 14}" font-size="12" fill="${C.text}">SIGNAL</text>`;
  const tip = dir > 0 ? y(candles[k].l) + 8 : y(candles[k].h) - 8, d = dir > 0 ? 12 : -12;
  s += `<path d="M${x(k)} ${tip} L${x(k) - 7} ${tip + d} L${x(k) + 7} ${tip + d} Z" fill="${dir > 0 ? C.up : C.dn}" stroke="${C.entry}" stroke-width="1"/>`;
  s += zl;
  if (dash) { // MTF dashboard, bottom left
    const bx = L + 6, by = H - B - RB - 18 * (dash.length + 1) - 8;
    s += `<rect x="${bx}" y="${by}" width="168" height="${18 * (dash.length + 1) + 4}" rx="4" fill="#1c1d21" stroke="#363a45"/><text x="${bx + 8}" y="${by + 14}" font-size="12" fill="${C.text}">Timeframe</text><text x="${bx + 84}" y="${by + 14}" font-size="12" fill="${C.text}">Trend</text>`;
    dash.forEach(([name, d], k) => { const yy = by + 18 * (k + 1) + 2; s += `<text x="${bx + 8}" y="${yy + 13}" font-size="12" fill="${C.text}">${name}</text><rect x="${bx + 80}" y="${yy}" width="82" height="16" rx="2" fill="${d > 0 ? "#459948" : d < 0 ? "#d42e3e" : "#5f5e5a"}"/><text x="${bx + 121}" y="${yy + 12}" font-size="11" fill="#ffffff" text-anchor="middle">${d > 0 ? "BULLISH" : d < 0 ? "BEARISH" : "NEUTRAL"}</text>`; });
  }
  s += `<text x="${L}" y="26" font-size="20" font-weight="bold" fill="${dir > 0 ? C.up : C.dn}">${esc(title)}</text><text x="${L}" y="48" font-size="13" fill="${C.text}">${esc(sub.length > 112 ? sub.slice(0, 110) + "…" : sub)}</text>`;
  s += `<text x="${W - R}" y="26" font-size="13" fill="${C.mut}" text-anchor="end">MEEGO AI</text></svg>`;
  return s;
}
const RESVG_WASM = "https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm";
const FONTS = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map((f) => `https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/${f}`);
let resvgReady = null;
function resvgFonts() {
  resvgReady ??= (async () => {
    await initWasm(fetch(RESVG_WASM));
    return await Promise.all(FONTS.map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer())));
  })().catch((e) => { resvgReady = null; throw e; });
  return resvgReady;
}
async function signalChart(s) {
  const tf = s.kind === "Swing" ? "1h" : "15min", min = tf === "1h" ? 60 : 15;
  const list = (await candles(s.sym, tf)).filter((x) => x.t <= s.time).slice(-70);
  if (list.length < 20) return null;
  const word = s.dir > 0 ? "BUY" : "SELL", my = new Date(s.time + 8 * 3600000), zt = Number((String(s.zkey || "").match(/^Z(\d{13})/) || [])[1] || 0);
  const why = String(s.note || "").replace(/^🤖 MEEGO AI · /, "").replace(/^(Demand|Supply) zone \S+ [\d.]+ - [\d.]+ · /, "");
  const label = s.test ? "EA TEST" : s.setup === "SNR" ? "SNR " + s.kind.toUpperCase() : s.nine ? "9:59 AM SETUP" : s.news === "pre" ? "NEWS" : s.news === "recovery" ? "RECOVERY" : s.kind.toUpperCase();
  const opts = {
    candles: list, dir: s.dir, entry: s.entry, sl: s.sl0 ?? s.sl, tps: s.tps || [s.tp], zone: Array.isArray(s.zone) && s.setup !== "SNR" ? s.zone : null, zoneFrom: zt, tf: min, digits: digits(s.sym),
    snr: s.setup === "SNR" && Array.isArray(s.zone) ? { key: s.level ?? (s.zone[0] + s.zone[1]) / 2, levels: s.levels || [] } : null,
    title: `${label} ${word} ${s.sym}`, sub: `${min === 60 ? "H1" : "M15"} · ${my.toISOString().slice(0, 10).split("-").reverse().join("/")} ${my.toISOString().slice(11, 16)} MYT${why ? " · " + why.slice(0, 90) : ""}`,
  };
  const svg = chartSvg(opts);
  const fontBuffers = await resvgFonts();
  return new Resvg(svg, { font: { fontBuffers, defaultFontFamily: "DejaVu Sans", loadSystemFonts: false }, fitTo: { mode: "width", value: 1000 } }).render().asPng();
}
// Sends the chart to every chat: uploaded once, then re-sent by file_id
async function sendChart(chats, s) {
  if (!chats.length) return;
  const png = await signalChart(s);
  if (!png) return;
  const caption = `📈 ${s.dir > 0 ? "BUY" : "SELL"} ${esc(s.sym)} · ${esc(s.kind)} · entry <code>${px(s.entry, s.sym)}</code>`;
  let fileId = null;
  for (const c of chats) {
    if (fileId) await tg("sendPhoto", { chat_id: c, photo: fileId, caption, parse_mode: "HTML" });
    else {
      const fd = new FormData();
      fd.append("chat_id", String(c)); fd.append("caption", caption); fd.append("parse_mode", "HTML");
      fd.append("photo", new Blob([png], { type: "image/png" }), "signal.png");
      const r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd })).json().catch(() => ({}));
      fileId = r.result?.photo?.at(-1)?.file_id ?? null;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

/* ---------- broadcasts (new signal, Hit TP/SL, daily reminders) ---------- */
async function audience(kind, trial = false) {
  const { data } = await db.from("telegram_users").select("*");
  return (data ?? []).filter((u) => u.is_admin || (!trial && planOf(u).tier && (kind !== "Swing" || planOf(u).tier === "Ultimate"))).map((u) => u.chat_id);
}
async function broadcast(chats, text) {
  for (const c of chats) { await send(c, text); await new Promise((r) => setTimeout(r, 60)); }
}
async function onDbEvent(ev) {
  if (ev.event === "signals") {
    const s = ev.record?.data, old = ev.old?.data;
    if (!s || !s.sym) return;
    const chats = await audience(s.kind, !!s.trial);
    if (ev.op === "INSERT" && s.status === "running") {
      const sig = { id: ev.record.id, ...s };
      const title = s.kind === "SOP" ? `🧪 PR SOP ${s.wait ? "· WAIT (EA waits)" : "· ENTRY NOW"}` : s.test ? "🧪 EA TEST (not a real setup)" : s.setup === "SNR" ? `🧪 SNR BREAKOUT ${s.kind.toUpperCase()} TEST (admin only)` : s.trial ? `🧪 ${s.kind.toUpperCase()} TEST (admin only)` : s.nine ? "🕘 9:59 AM SETUP" : s.news === "pre" ? "📰 NEWS SIGNAL" : s.news === "recovery" ? "🔁 RECOVERY SETUP (after news spike)" : kindOf(s.kind).fresh;
      for (const c of chats) { await sendLive(c, sig, title); await new Promise((r) => setTimeout(r, 60)); }
      await sendChart(chats, sig).catch((e) => console.error("signal chart failed", e));
      return;
    }
    const label = `${s.trial ? "🧪 " : ""}${s.dir > 0 ? "BUY" : "SELL"}${s.order === "limit" ? " LIMIT" : ""} <b>${esc(s.sym)}</b>`;
    if (ev.op === "UPDATE" && old?.wait && !s.wait && s.status === "running") {
      const sig = { id: ev.record.id, ...s }, title = "✅ PR SOP · ENTRY NOW (dashboard ready)";
      for (const c of chats) { await sendLive(c, sig, title); await new Promise((r) => setTimeout(r, 60)); }
      await sendChart(chats, sig).catch((e) => console.error("signal chart failed", e));
      return refreshLive();
    }
    if (ev.op === "UPDATE" && old?.pending && s.status === "running" && !s.pending) {
      // the full signal card again (entry, zone, TPs, SL, lot guide), kept live like a new signal
      const sig = { id: ev.record.id, ...s }, title = `⚡ ENTRY TRIGGERED · ${kindOf(s.kind).title.replace(/^\S+\s/, "")}`;
      for (const c of chats) { await sendLive(c, sig, title); await new Promise((r) => setTimeout(r, 60)); }
      return refreshLive();
    }
    if (ev.op === "UPDATE" && old && old.status !== s.status && s.status === "cancelled") {
      await broadcast(chats, `🚫 <b>CANCELLED</b> · ${label}\n${kindOf(s.kind).label} · ${s.kind === "SOP" ? "dashboard didn't line up within 60 minutes" : "entry price not reached"}`);
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

  // Admin: a new EA file sent to the bot (MEEGO_AI_EA.ex5 or .mq5). Kept for the admin only, unless the caption says "all".
  if (a.admin && /^MEEGO_AI_EA\.(ex5|mq5)$/i.test(String(msg.document?.file_name || ""))) return saveEaFile(chatId, msg);
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
  if (/^\/(admin|activate|renew|remove|customers|post|close|announce|members|autoscan|setbank|addbank|setprice|payments|testsignal|testend)\b/.test(t)) return cmdAdmin(chatId, a, text);
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
    off("Scalping") && !a.admin ? "⚡ /scalping (auto signals paused, being re-tested)" : "⚡ /scalping scalping signals",
    off("Intraday") && !a.admin ? "📈 /intraday (auto signals paused, being re-tested)" : "📈 /intraday intraday signals",
    off("Swing") && !a.admin ? "⭐ /swing (auto signals paused, being re-tested)" : "⭐ /swing Priority Swing (Ultimate)",
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
      { command: "scalping", description: off("Scalping") ? "Scalping (being re-tested)" : "Scalping signals" },
      { command: "intraday", description: off("Intraday") ? "Intraday (being re-tested)" : "Intraday signals" },
      { command: "swing", description: off("Swing") ? "Swing (being re-tested)" : "Priority Swing (Ultimate)" },
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
