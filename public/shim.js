/* MEEGO AI website bridge.
   The app was written against a small "claude.use(name)" interface (db, user, sample).
   This file provides the same interface on top of Supabase (login + database + server
   functions), so the app code runs unchanged on your own website. */
(function () {
  "use strict";
  const cfg = window.MEEGO_CONFIG || {};
  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY));
  const sb = configured && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  const FN = configured ? cfg.SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/" : null;
  window.MEEGO_WEB = true;

  let session = null, profile = null;
  const ready = (async () => {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (session) {
      const r = await sb.from("profiles").select("id,email,name,role").eq("id", session.user.id).maybeSingle();
      profile = r.data || { id: session.user.id, email: session.user.email, role: "member" };
    }
    sb.auth.onAuthStateChange((ev, s) => { if (ev === "SIGNED_OUT" || (ev === "SIGNED_IN" && !session)) location.reload(); session = s; });
    return session;
  })();

  /* ---------------- sign-in screen ---------------- */
  function gate(message) {
    const wrap = document.createElement("div");
    wrap.id = "meegoGate";
    wrap.innerHTML = `
      <div class="g-card" role="dialog" aria-modal="true" aria-labelledby="gTitle">
        <div class="g-brand"><div class="g-mark">M</div><div><b id="gTitle">MEEGO <span>AI</span></b><small>Market analysis terminal</small></div></div>
        <div class="g-tabs" role="tablist"><button type="button" data-m="in" aria-selected="true">Sign in</button><button type="button" data-m="up" aria-selected="false">Create account</button></div>
        <form id="gForm" novalidate>
          <label class="g-name" hidden>Name<input id="gName" autocomplete="name" placeholder="Your name"></label>
          <label>Email<input id="gEmail" type="email" autocomplete="email" placeholder="you@email.com" required></label>
          <label>Password<input id="gPass" type="password" autocomplete="current-password" placeholder="At least 8 characters" required></label>
          <button class="g-go" type="submit" id="gGo">Sign in</button>
          <p class="g-msg" id="gMsg" role="status"></p>
          <button type="button" class="g-link" id="gForgot">Forgot password?</button>
        </form>
        <p class="g-foot">${(cfg.SUPPORT_TEXT || "").replace(/[<>]/g, "")}</p>
        <button type="button" class="g-link" id="gGuest">Continue without signing in</button>
      </div>`;
    document.body.append(wrap);
    let mode = "in";
    const $ = (id) => document.getElementById(id), msg = (t, ok) => { $("gMsg").textContent = t; $("gMsg").className = "g-msg " + (ok ? "ok" : "err"); };
    if (message) msg(message, false);
    wrap.querySelectorAll(".g-tabs button").forEach((b) => b.onclick = () => {
      mode = b.dataset.m;
      wrap.querySelectorAll(".g-tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
      wrap.querySelector(".g-name").hidden = mode !== "up";
      $("gGo").textContent = mode === "up" ? "Create account" : "Sign in";
      $("gPass").autocomplete = mode === "up" ? "new-password" : "current-password";
      msg("", true);
    });
    $("gForm").onsubmit = async (e) => {
      e.preventDefault();
      const email = $("gEmail").value.trim(), password = $("gPass").value;
      if (!/^\S+@\S+\.\S+$/.test(email)) return msg("Enter a valid email address.");
      if (password.length < 8) return msg("Password must be at least 8 characters.");
      if (!sb) return msg("The website isn't connected to its database yet. Fill in config.js.");
      $("gGo").disabled = true;
      try {
        if (mode === "up") {
          const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name: $("gName").value.trim() } } });
          if (error) throw error;
          if (!data.session) { msg("Account created. Check your email to confirm it, then sign in.", true); return; }
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
        location.reload();
      } catch (err) { msg(err && err.message ? err.message : "Sign-in failed. Try again."); }
      finally { $("gGo").disabled = false; }
    };
    $("gForgot").onclick = async () => {
      const email = $("gEmail").value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return msg("Type your email above first.");
      if (!sb) return;
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      msg(error ? error.message : "Password reset link sent. Check your email.", !error);
    };
    $("gGuest").onclick = () => { try { sessionStorage.setItem("meego_guest", "1"); } catch (e) {} wrap.remove(); };
    setTimeout(() => $("gEmail").focus(), 50);
  }

  function addAccountButton() {
    const bar = document.querySelector(".topbar");
    if (!bar || document.getElementById("acctBtn")) return;
    const b = document.createElement("button");
    b.id = "acctBtn"; b.className = "btn"; b.type = "button";
    b.textContent = session ? "Sign out" : "Sign in";
    b.title = session ? (session.user.email || "") : "";
    b.onclick = async () => { if (session) { await sb.auth.signOut(); location.reload(); } else { try { sessionStorage.removeItem("meego_guest"); } catch (e) {} gate(); } };
    bar.append(b);
  }

  function webTweaks() {
    const live = document.getElementById("srcLive"); if (live) live.hidden = true;
    const demo = document.getElementById("srcDemo"); if (demo) demo.textContent = "Live";
    const pos = document.getElementById("posBody"); if (pos && pos.closest(".card")) pos.closest(".card").hidden = true; // MT5 positions: PC app only
    addAccountButton();
  }

  // password-reset links land here with a recovery session: ask for a new password
  if (sb) sb.auth.onAuthStateChange(async (ev) => {
    if (ev !== "PASSWORD_RECOVERY") return;
    const box = document.createElement("div"); box.id = "meegoGate";
    box.innerHTML = `<form class="g-card" id="gReset"><div class="g-brand"><div class="g-mark">M</div><div><b>Set a new password</b></div></div>
      <label>New password<input id="gNew" type="password" autocomplete="new-password" placeholder="At least 8 characters"></label>
      <button class="g-go" type="submit">Save password</button><p class="g-msg" id="gRMsg"></p></form>`;
    document.body.append(box);
    document.getElementById("gReset").onsubmit = async (e) => {
      e.preventDefault(); const v = document.getElementById("gNew").value, m = document.getElementById("gRMsg");
      if (v.length < 8) { m.textContent = "Password must be at least 8 characters."; m.className = "g-msg err"; return; }
      const { error } = await sb.auth.updateUser({ password: v });
      m.textContent = error ? error.message : "Password saved."; m.className = "g-msg " + (error ? "err" : "ok");
      if (!error) setTimeout(() => location.replace(location.pathname), 900);
    };
  });

  document.addEventListener("DOMContentLoaded", async () => {
    await ready;
    webTweaks();
    let guest = false; try { guest = sessionStorage.getItem("meego_guest") === "1"; } catch (e) {}
    if (!session && !guest) gate(configured ? "" : "Website setup isn't finished: fill in config.js with your Supabase details.");
  });

  /* ---------------- database (Firestore-like on Supabase tables) ---------------- */
  const TABLES = new Set(["signals", "mail", "customers", "members"]);
  const dbErr = (e) => ({ code: e && /row-level|permission|42501/i.test(e.message + (e.code || "")) ? "invalid_argument" : "unavailable", message: (e && e.message) || "Database error" });
  const snapDoc = (id, data) => ({ id, exists: data !== undefined, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });

  function docRef(table, id) {
    const known = TABLES.has(table);
    return {
      id, path: table + "/" + id,
      async get() { if (!known) return snapDoc(id); const { data, error } = await sb.from(table).select("data").eq("id", id).maybeSingle(); if (error) throw dbErr(error); return snapDoc(id, data ? data.data : undefined); },
      async set(data) { if (!known) return; const { error } = await sb.from(table).upsert({ id, data, updated_at: new Date().toISOString() }); if (error) throw dbErr(error); },
      async update(patch) {
        if (!known) return;
        const cur = await this.get(); if (!cur.exists) throw { code: "invalid_argument", message: "Document does not exist" };
        const next = Object.assign({}, cur.data());
        for (const k in patch) { if (patch[k] && patch[k].__delete__) delete next[k]; else next[k] = patch[k]; }
        await this.set(next);
      },
      async delete() { if (!known) return; const { error } = await sb.from(table).delete().eq("id", id); if (error) throw dbErr(error); },
      onSnapshot(next, err) {
        if (!known) { setTimeout(() => next(snapDoc(id)), 0); return () => {}; }
        const pull = () => this.get().then(next, (e) => err && err(e));
        pull();
        const ch = sb.channel("doc-" + table + "-" + id + "-" + Math.random().toString(36).slice(2))
          .on("postgres_changes", { event: "*", schema: "public", table, filter: "id=eq." + id }, pull).subscribe();
        return () => sb.removeChannel(ch);
      },
      collection() { throw new TypeError("Subcollections aren't used on the website."); }
    };
  }
  function colRef(table) {
    const known = TABLES.has(table);
    const q = {
      path: table,
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      doc(id) { return docRef(table, id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2))); },
      async add(data) { const r = q.doc(); await r.set(data); return r; },
      async get() {
        if (!known) return { docs: [], size: 0, empty: true, metadata: { fromCache: false }, docChanges: () => [] };
        const { data, error } = await sb.from(table).select("id,data").order("updated_at", { ascending: false }).limit(1000);
        if (error) throw dbErr(error);
        const docs = (data || []).map((r) => snapDoc(r.id, r.data));
        return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [] };
      },
      onSnapshot(next, err) {
        const pull = () => q.get().then(next, (e) => err && err(e));
        pull();
        if (!known) return () => {};
        let t = null;
        const ch = sb.channel("col-" + table + "-" + Math.random().toString(36).slice(2))
          .on("postgres_changes", { event: "*", schema: "public", table }, () => { clearTimeout(t); t = setTimeout(pull, 250); }).subscribe();
        return () => sb.removeChannel(ch);
      }
    };
    return q;
  }
  const db = {
    collection: (path) => colRef(String(path).split("/")[0]),
    doc: (path) => { const p = String(path).split("/"); return docRef(p[0], p.slice(1).join("/")); }
  };

  /* ---------------- user ---------------- */
  const user = {
    async isOwner() { await ready; return !!profile && profile.role === "owner"; },
    async canEdit() { await ready; return !!profile && (profile.role === "owner" || profile.role === "admin"); },
    async can() { return null; },
    async id() { await ready; return session ? session.user.id : null; },
    async me() { await ready; return { id: session ? session.user.id : null, name: profile ? profile.name || "" : "", email: session ? session.user.email : null, avatarUrl: "", color: "#d9b44a", isOwner: await user.isOwner(), canEdit: await user.canEdit() }; },
    async profiles(ids) {
      ids = [].concat(ids || []); const out = {};
      ids.forEach((id) => out[id] = { id, name: "", email: null, avatarUrl: "", color: "#d9b44a", isMe: session && id === session.user.id, guest: false });
      if (!sb || !ids.length) return out;
      const { data } = await sb.from("profiles").select("id,email,name").in("id", ids);
      (data || []).forEach((p) => { out[p.id].name = p.name || p.email || ""; out[p.id].email = p.email; });
      return out;
    },
    async search(qs) {
      if (!sb || !(await user.canEdit())) return [];
      let req = sb.from("profiles").select("id,email,name").limit(8);
      const s = String(qs || "").trim().replace(/[%,()]/g, "");
      if (s) req = req.or(`email.ilike.%${s}%,name.ilike.%${s}%`);
      const { data } = await req;
      return (data || []).map((p) => ({ id: p.id, name: p.name || p.email, email: p.email, avatarUrl: "", color: "#d9b44a", isMe: session && p.id === session.user.id, guest: false }));
    }
  };

  /* ---------------- AI (server function "ai") ---------------- */
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.86);
    return { media_type: "image/jpeg", data: url.split(",")[1] };
  }
  function parseJSON(text) {
    const t = String(text).trim();
    try { return JSON.parse(t); } catch (e) {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (e) {} }
    const a = Math.min(...["{", "["].map((ch) => { const i = t.indexOf(ch); return i < 0 ? Infinity : i; }));
    const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a < Infinity && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    throw { code: "invalid_json", message: "Answer wasn't JSON", text: t };
  }
  async function callAI(input, opts) {
    opts = opts || {};
    if (!session) throw { code: "not_granted", message: "Sign in to use AI." };
    const prompt = typeof input === "string" ? input : input.map((m) => m.content).join("\n\n");
    let image = null;
    if (opts.images) { const list = opts.images instanceof Blob ? [opts.images] : Array.from(opts.images); if (list[0]) image = await shrinkImage(list[0]); }
    const { data: s } = await sb.auth.getSession();
    const res = await fetch(FN + (cfg.AI_FUNCTION || "ai"), { method: "POST", signal: opts.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.session.access_token, apikey: cfg.SUPABASE_ANON_KEY }, body: JSON.stringify({ prompt, image }) })
      .catch((e) => { throw { code: e && e.name === "AbortError" ? "cancelled" : "upstream_error", message: "Network error" }; });
    let j = {}; try { j = await res.json(); } catch (e) {}
    if (!res.ok && j.code === "upstream_error" && j.error) throw { code: j.error, message: j.error }; // show the server's reason
    if (!res.ok) throw { code: j.code || (res.status === 401 ? "session_expired" : res.status === 403 ? "not_granted" : res.status === 429 ? "rate_limited" : "upstream_error"), message: j.error || "AI error" };
    if (opts.onText) opts.onText({ text: j.text, delta: j.text });
    return { text: j.text, truncated: !!j.truncated, modelTierApplied: "default" };
  }
  const sample = (input, opts) => callAI(input, opts);
  sample.json = async (input, opts) => parseJSON((await callAI(input, opts)).text);
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 1, maxInputBytes: 20000000, mediaTypes: ["image/png", "image/jpeg", "image/webp"] } });

  /* ---------------- market data (server function "candles") ---------------- */
  const memo = {};
  async function candles(symbol, interval) {
    const key = symbol + "|" + interval, hit = memo[key];
    if (hit && Date.now() - hit.at < (interval === "15min" ? 120e3 : 600e3)) return hit.data;
    const { data: s } = await sb.auth.getSession();
    const token = s.session ? s.session.access_token : cfg.SUPABASE_ANON_KEY;
    const res = await fetch(FN + (cfg.CANDLES_FUNCTION || "candles") + "?symbol=" + encodeURIComponent(symbol) + "&interval=" + interval, { headers: { Authorization: "Bearer " + token, apikey: cfg.SUPABASE_ANON_KEY } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(j.candles) || j.candles.length < 30) throw new Error(j.error || "No market data for " + symbol + ".");
    memo[key] = { at: Date.now(), data: j };
    return j;
  }
  function group(cs, keyFn) {
    const out = []; let cur = null, curKey = null;
    for (const c of cs) {
      const k = keyFn(c.t);
      if (k !== curKey) { if (cur) out.push(cur); cur = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }; curKey = k; }
      else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; }
    }
    if (cur) out.push(cur);
    return out;
  }
  window.MEEGO_MARKET = configured ? async function (symbol) {
    const m15 = await candles(symbol, "15min");
    const h1 = await candles(symbol, "1h");
    const M15 = m15.candles, H1 = h1.candles;
    const data = {
      M15, M30: group(M15, (t) => Math.floor(t / 1800e3)),
      H1, H4: group(H1, (t) => Math.floor(t / 14400e3)),
      D1: group(H1, (t) => Math.floor(t / 86400e3))
    };
    return { data, price: M15[M15.length - 1].c, at: Math.max(m15.at || 0, h1.at || 0) || Date.now() };
  } : null;

  /* ---------------- the interface the app uses ---------------- */
  window.claude = {
    async use(name) {
      await ready;
      if (name === "db") return sb && session ? db : null;
      if (name === "user") return user;
      if (name === "sample") return sb && session ? sample : null;
      return null; // no MetaTrader on the website
    }
  };
})();
