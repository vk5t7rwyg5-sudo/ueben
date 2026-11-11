/* Üben – Speicher: Gerät (IndexedDB) + verschlüsselter Sync über den Klassenbuch-Server.
   Eigenes Konto (Salt «ueben-v1:<email>»), getrennt vom Klassenbuch. Der Server sieht nur verschlüsselte Daten. */
const Store = (() => {
  const API = "https://www.adrianpopp.ch/_functions/kb/";
  const PART = 300000, MAXITEMS = 60;
  let idb = null, acc = null, cfg = { since: 0, outbox: [] };
  let syncing = false, again = false, timer = null, onChange = () => {}, onStatus = () => {};
  const recs = new Map(); // key → value

  /* --- IndexedDB --- */
  const open = () => new Promise((ok, no) => {
    const r = indexedDB.open("ueben", 1);
    r.onupgradeneeded = () => { const d = r.result; ["rec", "cfg"].forEach((s) => d.objectStoreNames.contains(s) || d.createObjectStore(s)); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  const req = (store, mode, fn) => new Promise((ok, no) => { const t = idb.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => ok(r && r.result); t.onerror = t.onabort = () => no(t.error); });
  const get = (s, k) => req(s, "readonly", (o) => o.get(k));
  const put = (s, k, v) => req(s, "readwrite", (o) => o.put(v, k));
  const del = (s, k) => req(s, "readwrite", (o) => o.delete(k));
  const all = (s) => new Promise((ok, no) => { const out = {}; const r = idb.transaction(s).objectStore(s).openCursor(); r.onsuccess = () => { const c = r.result; if (c) { out[c.key] = c.value; c.continue(); } else ok(out); }; r.onerror = () => no(r.error); });
  const saveCfg = () => put("cfg", "sync", cfg);

  /* --- Krypto (wie Klassenbuch, eigener Salt) --- */
  const te = new TextEncoder(), td = new TextDecoder();
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  async function kdf(secret, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", te.encode(secret), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: te.encode(salt), iterations }, base, 512));
  }
  async function derive(email, pw) {
    email = email.trim().toLowerCase();
    const bits = await kdf(pw, "ueben-v1:" + email, 600000);
    return { email, acct: hex(await crypto.subtle.digest("SHA-256", te.encode("ueben-v1:" + email))).slice(0, 40), auth: hex(bits.slice(0, 32)), kek: bits.slice(32) };
  }
  async function deriveRk(email, rk) { const bits = await kdf(rk, "ueben-rk-v1:" + email.trim().toLowerCase(), 100000); return { rauth: hex(bits.slice(0, 32)), kek: bits.slice(32) }; }
  async function wrap(dek, kek) { const k = await crypto.subtle.importKey("raw", kek, "AES-GCM", false, ["encrypt"]); const iv = crypto.getRandomValues(new Uint8Array(12)); const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, dek)); const o = new Uint8Array(12 + c.length); o.set(iv); o.set(c, 12); return b64(o); }
  async function unwrap(w, kek) { const k = await crypto.subtle.importKey("raw", kek, "AES-GCM", false, ["decrypt"]); const u = unb64(w); return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.subarray(0, 12) }, k, u.subarray(12))); }
  const RKA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const genRk = () => "UB-" + [...crypto.getRandomValues(new Uint8Array(32))].map((x) => RKA[x & 31]).join("").match(/.{4}/g).join("-");
  const normRk = (s) => { s = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); if (s.length === 34 && s.startsWith("UB")) s = s.slice(2); return s.length === 32 ? s : null; };
  async function useAcc(a) { acc = { ...a, key: await crypto.subtle.importKey("raw", unb64(a.raw), "AES-GCM", false, ["encrypt", "decrypt"]) }; }
  async function enc(o) { const iv = crypto.getRandomValues(new Uint8Array(12)); const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, acc.key, te.encode(JSON.stringify(o)))); const u = new Uint8Array(12 + c.length); u.set(iv); u.set(c, 12); return b64(u); }
  async function dec(s) { const u = unb64(s); return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.subarray(0, 12) }, acc.key, u.subarray(12)))); }

  async function api(action, body) {
    const r = await fetch(API + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acct: acc?.acct, auth: acc?.auth, ...body }) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const e = new Error(j.error || "http " + r.status); e.code = j.error || r.status; throw e; }
    return j;
  }

  /* --- Datensätze --- */
  async function set(key, v) {
    if (v == null) { recs.delete(key); await del("rec", key); } else { recs.set(key, v); await put("rec", key, { v, rev: 0 }); }
    if (acc) { if (!cfg.outbox.includes(key)) cfg.outbox.push(key); await saveCfg(); soon(1200); }
    status();
  }

  /* --- Sync --- */
  function soon(ms) { clearTimeout(timer); timer = setTimeout(sync, ms || 0); }
  function status(t) { onStatus(t || (acc ? (cfg.outbox.length ? "Wird synchronisiert …" : "Synchronisiert") : "Nur auf diesem Gerät")); }
  async function push() {
    while (cfg.outbox.length) {
      const items = [], done = [];
      for (const key of cfg.outbox) {
        const r = await get("rec", key);
        const add = [];
        if (!r) add.push({ key, part: 0, parts: 1, del: true });
        else { const data = await enc(r.v); const n = Math.max(1, Math.ceil(data.length / PART)); for (let p = 0; p < n; p++) add.push({ key, part: p, parts: n, data: data.slice(p * PART, (p + 1) * PART) }); }
        if (items.length && items.length + add.length > MAXITEMS) break;
        items.push(...add); done.push(key);
        if (items.reduce((a, x) => a + (x.data ? x.data.length : 0), 0) > PART) break;
      }
      if (items.length) await api("push", { items });
      cfg.outbox = cfg.outbox.filter((k) => !done.includes(k)); await saveCfg();
    }
  }
  async function sync() {
    if (!acc) return status();
    if (!navigator.onLine) return status("Offline – wird später synchronisiert");
    if (syncing) { again = true; return; }
    syncing = true;
    try {
      status("Wird synchronisiert …");
      await push();
      let since = Math.max(0, (cfg.since || 0) - 120000 * 1000), maxRev = cfg.since || 0, changed = false;
      const local = await all("rec"), got = {};
      for (;;) {
        const r = await api("pull", { since, snap: 1 });
        for (const it of r.items) {
          since = Math.max(since, it.rev); maxRev = Math.max(maxRev, it.rev);
          const g = (got[it.key] ||= { parts: it.parts, p: {}, del: false, rev: 0 });
          if (g.parts !== it.parts) { g.parts = it.parts; g.p = {}; }
          g.p[it.part] = it.data; g.del = it.del; g.rev = Math.max(g.rev, it.rev);
        }
        if (!r.more) break;
      }
      for (const [key, g] of Object.entries(got)) {
        if (cfg.outbox.includes(key)) continue;
        const cur = local[key];
        if (cur && cur.rev >= g.rev) continue;
        if (g.del) { if (cur) { await del("rec", key); recs.delete(key); changed = true; } continue; }
        if (Object.keys(g.p).length !== g.parts) continue;
        let v; try { v = await dec(Array.from({ length: g.parts }, (_, i) => g.p[i]).join("")); } catch (e) { continue; }
        await put("rec", key, { v, rev: g.rev }); recs.set(key, v); changed = true;
      }
      cfg.since = maxRev; await saveCfg();
      status();
      if (changed) onChange();
    } catch (e) {
      if (e.code === "rate") { status("Server ausgelastet – geht gleich weiter"); syncing = false; soon(65000); return; }
      if (e.code === "auth") status("Bitte neu anmelden (Einstellungen)");
      else { status("Sync fehlgeschlagen – neuer Versuch folgt"); soon(30000); }
    }
    syncing = false;
    if (again) { again = false; soon(400); }
  }

  /* --- Konto --- */
  async function afterLogin(d, dek) {
    const a = { email: d.email, acct: d.acct, auth: d.auth, raw: b64(dek) };
    await put("cfg", "account", a); await useAcc(a);
    cfg = { since: 0, outbox: [...recs.keys()] }; await saveCfg();
    await sync();
  }
  async function register(email, pw, invite) {
    const d = await derive(email, pw), dek = crypto.getRandomValues(new Uint8Array(32)), rk = genRk(), r = await deriveRk(email, normRk(rk));
    await api("register", { acct: d.acct, auth: d.auth, rauth: r.rauth, wrapPw: await wrap(dek, d.kek), wrapRk: await wrap(dek, r.kek), invite });
    await afterLogin(d, dek);
    return rk;
  }
  async function login(email, pw) {
    const d = await derive(email, pw);
    const j = await api("login", { acct: d.acct, auth: d.auth });
    await afterLogin(d, await unwrap(j.wrapPw, d.kek));
  }
  async function recover(email, rk, pw) {
    const n = normRk(rk); if (!n) throw Object.assign(new Error("rk"), { code: "rk" });
    const d = await derive(email, pw), r = await deriveRk(email, n);
    const j = await api("recover", { acct: d.acct, rauth: r.rauth });
    const dek = await unwrap(j.wrapRk, r.kek);
    await api("rekey", { acct: d.acct, rauth: r.rauth, newAuth: d.auth, newWrapPw: await wrap(dek, d.kek) });
    await afterLogin(d, dek);
  }
  async function logout() {
    acc = null; await del("cfg", "account"); cfg = { since: 0, outbox: [] }; await saveCfg();
    for (const k of [...recs.keys()]) { recs.delete(k); await del("rec", k); }
    status(); onChange();
  }

  async function start(handlers) {
    onChange = handlers.onChange || onChange; onStatus = handlers.onStatus || onStatus;
    idb = await open();
    try { navigator.storage?.persist?.(); } catch (e) {}
    cfg = Object.assign({ since: 0, outbox: [] }, (await get("cfg", "sync")) || {});
    const a = await get("cfg", "account"); if (a) await useAcc(a);
    for (const [k, r] of Object.entries(await all("rec"))) recs.set(k, r.v);
    status();
    if (acc) soon(100);
    window.addEventListener("online", () => soon(300));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") soon(200); });
    setInterval(() => { if (document.visibilityState === "visible") sync(); }, 60000);
  }

  return { start, set, recs, sync: () => soon(0), register, login, recover, logout, account: () => (acc ? acc.email : null) };
})();
