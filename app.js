/* Üben – App-Logik. Daten: Store.recs mit Schlüsseln "areas", "piece:<id>", "day:<YYYY-MM-DD>". */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pref = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const todayStr = () => iso(new Date());
  const dayDiff = (s) => Math.round((parse(s) - parse(todayStr())) / 86400000);
  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const MON = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const fmt = (s) => { const d = parse(s); return `${WD[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`; };

  const STAGES = ["Kennenlernen", "Erarbeiten", "Festigen", "Auftrittsreif"];
  const FALLBACK = [
    { id: "technik", name: "Technik", order: 1, hue: 190 },
    { id: "rezital", name: "Rezital 2027", order: 2, hue: 310 },
    { id: "duo", name: "Duo", order: 3, hue: 100 },
    { id: "liberty", name: "Liberty Brass Band", order: 4, hue: 230 },
    { id: "dirigieren", name: "Dirigieren", order: 5, hue: 15 },
    { id: "dir-einzel", name: "Einzelunterricht", parent: "dirigieren", order: 6, hue: 25 },
    { id: "dir-projekte", name: "Projekte", parent: "dirigieren", order: 7, hue: 355 },
    { id: "sma", name: "Stadtmusik Arbon", order: 8, hue: 45 },
    { id: "jbo", name: "Jugendblasorchester Thurgau", order: 9, hue: 260 }
  ];

  let ready = false, pending = false;
  let areas = FALLBACK.slice();
  const pieces = new Map(), days = new Map();
  let openId = null, logId = null, selDay = todayStr(), confirmIdx = null;
  let session = pref.get("ueben.session", 60), sortMode = pref.get("ueben.sort", "area");
  let showSettings = false, acctView = "in", acctErr = "", acctBusy = false, shownRk = null, logoutArmed = false;

  function load() {
    pieces.clear(); days.clear();
    const a = Store.recs.get("areas");
    areas = (a && a.list && a.list.length ? a.list : FALLBACK).slice().sort((x, y) => (x.order ?? 99) - (y.order ?? 99));
    for (const [k, v] of Store.recs) {
      if (k.startsWith("piece:")) pieces.set(k.slice(6), { ...v, _id: k.slice(6) });
      else if (k.startsWith("day:")) days.set(k.slice(4), v);
    }
  }
  const savePiece = (p) => { const { _id, ...doc } = p; Store.set("piece:" + _id, doc); };
  const saveDay = (d, doc) => Store.set("day:" + d, doc);

  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
    document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
  }

  // ---------- helpers ----------
  const areaById = (id) => areas.find((a) => a.id === id);
  const areaName = (id) => { const a = areaById(id); if (!a) return id || "Ohne Bereich"; const p = a.parent && areaById(a.parent); return p ? `${p.name} · ${a.name}` : a.name; };
  const hue = (id) => areaById(id)?.hue ?? 160;
  const areaOpts = (sel) => areas.map((a) => `<option value="${esc(a.id)}"${a.id === sel ? " selected" : ""}>${esc(areaName(a.id))}</option>`).join("");
  const since = (p) => (p.lastPracticed ? -dayDiff(p.lastPracticed) : null);
  const active = () => [...pieces.values()].filter((p) => !p.archived);

  function score(p) {
    const dd = p.deadline ? dayDiff(p.deadline) : 999;
    const urg = dd < 0 ? 0 : dd <= 3 ? 50 : dd <= 7 ? 36 : dd <= 14 ? 24 : dd <= 30 ? 14 : dd <= 60 ? 7 : 2;
    const s = since(p); const stale = (s == null ? 10 : Math.min(s, 10)) * 2.5;
    const stage = (3 - (p.stage || 0)) * 4;
    const openSpots = (p.spots || []).filter((x) => !x.done).length;
    return urg + stale + stage + Math.min(openSpots, 4) * 1.5;
  }
  function reasons(p) {
    const r = [];
    if (p.deadline) { const dd = dayDiff(p.deadline); if (dd >= 0 && dd <= 30) r.push(`${dd === 0 ? "Heute" : dd === 1 ? "Morgen" : `In ${dd} Tagen`}: ${p.deadlineLabel || "Termin"}`); }
    const s = since(p);
    if (s == null) r.push("noch nie geübt"); else if (s >= 3) r.push(`seit ${s} Tagen nicht geübt`);
    const spot = (p.spots || []).find((x) => !x.done);
    if (spot) r.push(`Fokus: ${spot.text}`);
    if (p.tempoTarget && p.tempoCurrent && p.tempoCurrent < p.tempoTarget) r.push(`Tempo ♩ ${p.tempoCurrent} → ${Math.min(p.tempoTarget, p.tempoCurrent + 4)}`);
    if (!spot && (p.stage || 0) < 2) r.push(`Phase: ${STAGES[p.stage || 0]}`);
    return r.join(" · ");
  }
  function weekDays() {
    const d = new Date(); const dow = d.getDay() || 7; const mon = new Date(d); mon.setDate(d.getDate() - dow + 1);
    return Array.from({ length: 7 }, (_, i) => { const x = new Date(mon); x.setDate(mon.getDate() + i); return iso(x); });
  }
  const minutesOn = (d) => days.get(d)?.total || 0;
  function streak() {
    const d = new Date(); if (!minutesOn(iso(d))) d.setDate(d.getDate() - 1);
    let n = 0; while (minutesOn(iso(d)) > 0) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  // ---------- render ----------
  function render() {
    if (document.activeElement?.closest?.(".editor, .form")) { pending = true; return; }
    pending = false;
    const now = new Date();
    $("eyebrow").textContent = `${WD[now.getDay()]} ${now.getDate()}. ${MON[now.getMonth()]}`;
    const week = weekDays(), today = todayStr();
    if (selDay !== today && !week.includes(selDay)) selDay = today;
    const weekTotal = week.reduce((a, d) => a + minutesOn(d), 0);
    $("pstats").innerHTML = [["Min. diese Woche", weekTotal], ["Tage Serie", streak()], ["Stücke aktiv", active().length], ["heute geübt", minutesOn(today)]]
      .map(([l, n]) => `<div class="stat"><b>${n}</b><span class="label">${l}</span></div>`).join("");

    $("gear").setAttribute("aria-pressed", showSettings);
    $("settings").hidden = !showSettings;
    if (showSettings) renderSettings();

    renderTimer();

    $("session").innerHTML = [30, 45, 60, 90].map((m) => `<button type="button" data-session="${m}" aria-pressed="${session === m}">${m}′</button>`).join("");

    const act = active();
    if (!act.length) {
      $("plan").innerHTML = `<li class="plan-why" style="padding-top:10px">${ready ? "Füge unten dein erstes Stück mit Termin hinzu – oder hol unter «Einstellungen» deine Daten (anmelden oder importieren)." : "Wird geladen …"}</li>`;
      $("plan-total").textContent = "";
    } else {
      let rest = session; const items = [];
      if (session >= 45) { items.push({ warm: true, min: 10 }); rest -= 10; }
      const top = act.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s).slice(0, session >= 60 ? 3 : 2);
      const sum = top.reduce((a, x) => a + x.s, 0) || 1;
      let used = 0;
      top.forEach((x, i) => {
        let m = i === top.length - 1 ? rest - used : Math.max(10, Math.round((rest * x.s) / sum / 5) * 5);
        m = Math.max(5, m); used += m; items.push({ p: x.p, min: m });
      });
      $("plan").innerHTML = items.map((it) => it.warm
        ? `<li class="plan-item"><div class="plan-min">10<small>MIN</small></div><div><b style="font-weight:500">Einspielen</b><div class="plan-why">Rudiments, Schlagtechnik, Tonleitern auf Mallets</div></div><span></span></li>`
        : `<li class="plan-item"><div class="plan-min">${it.min}<small>MIN</small></div><div><span class="dot" style="--h:${hue(it.p.area)};display:inline-block;margin-right:6px"></span><b style="font-weight:500">${esc(it.p.title)}</b><div class="plan-why">${esc(reasons(it.p) || areaName(it.p.area))}</div></div><button class="btn ghost small" type="button" data-plog-quick="${esc(it.p._id)}" data-min="${it.min}">Geübt</button></li>`
      ).join("");
      $("plan-total").textContent = `Vorschlag für ${session} Minuten · berechnet aus Termin, letzter Übezeit, Phase und offenen Baustellen`;
    }

    const max = Math.max(30, ...week.map(minutesOn));
    $("bars").innerHTML = week.map((d) => {
      const m = minutesOn(d); const h = Math.round((m / max) * 100);
      return `<button type="button" class="bar${d === today ? " today" : ""}${m ? "" : " zero"}${d === selDay ? " sel" : ""}" data-day="${d}" aria-pressed="${d === selDay}" title="${fmt(d)}: ${m} Min. – Einträge anzeigen"><em>${m || ""}</em><i style="height:${m ? Math.max(h, 4) : 2}%"></i><span>${WD[parse(d).getDay()]}</span></button>`;
    }).join("");

    const ents = days.get(selDay)?.entries || [];
    $("daylog").innerHTML = `<div class="label">${selDay === today ? "Heute" : esc(fmt(selDay))} · ${ents.length ? ents.reduce((a, e) => a + (e.min || 0), 0) + " Min." : "nichts eingetragen"}</div>` +
      ents.map((e, i) => `<div class="entry"><span class="m">${e.min}′</span><span class="t">${esc(pieces.get(e.piece)?.title || e.title || "Stück")}</span>${confirmIdx === i ? `<button type="button" data-entry-del="${i}" style="color:var(--danger);border-color:var(--danger)">Entfernen?</button>` : `<button type="button" data-entry-ask="${i}" aria-label="Eintrag entfernen">Entfernen</button>`}</div>`).join("");

    const sel = $("padd-area"); const v = sel.value; const sig = JSON.stringify(areas.map((a) => [a.id, a.name, a.parent]));
    if (sel.dataset.sig !== sig) { sel.innerHTML = areaOpts(v || areas[0]?.id); sel.dataset.sig = sig; if (v) sel.value = v; }

    $("psort").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.sort === sortMode));

    const byDate = (a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999") || a.title.localeCompare(b.title);
    let html = "";
    if (sortMode === "date") {
      const withD = act.filter((p) => p.deadline).sort(byDate), noD = act.filter((p) => !p.deadline).sort(byDate);
      if (withD.length) html += group("Mit Termin", null, withD);
      if (noD.length) html += group("Ohne Termin", null, noD);
    } else {
      for (const a of areas) { const l = act.filter((p) => p.area === a.id).sort(byDate); if (l.length) html += group(areaName(a.id), a.hue, l); }
      const orphan = act.filter((p) => !areaById(p.area)); if (orphan.length) html += group("Ohne Bereich", null, orphan);
    }
    $("plist").innerHTML = html || `<p class="empty">${ready ? "Noch keine Stücke. Trag oben ein, was du gerade übst." : ""}</p>`;

    const arch = [...pieces.values()].filter((p) => p.archived).sort((a, b) => (b.archivedAt || "").localeCompare(a.archivedAt || ""));
    $("parch-wrap").hidden = !arch.length;
    $("parch-sum").textContent = `Aufgeführt / abgeschlossen (${arch.length})`;
    $("parch").innerHTML = arch.map((p) => `<div class="piece"><div><span class="p-title" style="color:var(--muted)">${esc(p.title)}</span><span class="p-comp">${esc(p.composer || "")}</span><div class="meta"><span>${esc(areaName(p.area))}</span>${p.totalMinutes ? `<span>${p.totalMinutes} Min. geübt</span>` : ""}</div></div><div class="p-side"><button class="btn ghost small" type="button" data-prestore="${esc(p._id)}">Zurückholen</button></div></div>`).join("");
  }

  function group(title, h, list) {
    return `<div class="pgroup"><div class="label">${h != null ? `<span class="dot" style="--h:${h}"></span>` : ""}<span>${esc(title)}</span><span class="n">${list.length}</span></div>${list.map(pieceHtml).join("")}</div>`;
  }

  function pieceHtml(p) {
    const meta = [];
    if (p.deadline) {
      const dd = dayDiff(p.deadline);
      const cls = dd < 0 ? "" : dd <= 7 ? " urgent" : dd <= 21 ? " soon" : "";
      const txt = dd < 0 ? `vorbei (${fmt(p.deadline)})` : dd === 0 ? "heute" : `${dd} T. · ${fmt(p.deadline)}`;
      meta.push(`<span class="countdown${cls}">${esc(txt)}</span>${p.deadlineLabel ? `<span>${esc(p.deadlineLabel)}</span>` : ""}`);
    }
    if (p.tempoTarget) {
      const cur = p.tempoCurrent || 0; const pct = Math.min(100, Math.round((cur / p.tempoTarget) * 100));
      meta.push(`<span class="tempo" title="Aktuelles Tempo / Zieltempo">♩ ${cur || "–"}/${p.tempoTarget}<b><i style="width:${pct}%"></i></b></span>`);
    }
    const open = (p.spots || []).filter((x) => !x.done).length;
    if (open) meta.push(`<span>${open} Baustelle${open > 1 ? "n" : ""}</span>`);
    const s = since(p);
    meta.push(`<span>${s == null ? "noch nicht geübt" : s === 0 ? "heute geübt" : s === 1 ? "gestern geübt" : `vor ${s} Tagen geübt`}</span>`);
    const stage = p.stage || 0;
    return `<article class="piece" data-pid="${esc(p._id)}">
      <div style="min-width:0">
        <button class="p-title" type="button" data-popen="${esc(p._id)}" aria-expanded="${openId === p._id}">${esc(p.title)}</button>${p.composer ? `<span class="p-comp">${esc(p.composer)}</span>` : ""}
        <div class="meta">${meta.join("")}</div>
      </div>
      <div class="p-side">
        <div class="stages" role="group" aria-label="Phase">${STAGES.map((n, i) => `<button type="button" class="${i <= stage ? "on" : ""}" data-stage="${i}" data-sid="${esc(p._id)}" title="${n}" aria-label="Phase ${n}"></button>`).join("")}</div>
        <span class="stage-name">${STAGES[stage]}</span>
        <button class="btn ghost small" type="button" data-plog="${esc(p._id)}">Geübt</button>
      </div>
      ${logId === p._id ? `<div class="logger">Wie lange? ${[10, 15, 20, 30, 45, 60].map((m) => `<button class="chip" type="button" data-plog-min="${m}" data-lid="${esc(p._id)}">${m}′</button>`).join("")}</div>` : ""}
      ${openId === p._id ? editorHtml(p) : ""}
    </article>`;
  }

  function spotRow(s) {
    return `<div class="spot"><input type="checkbox" aria-label="Erledigt"${s.done ? " checked" : ""}><input type="text" value="${esc(s.text)}" aria-label="Baustelle" placeholder="z. B. T. 34–41 Läufe"><button type="button" data-spot-del aria-label="Entfernen">×</button></div>`;
  }
  function editorHtml(p) {
    return `<form class="editor" data-pedit="${esc(p._id)}">
      <label class="full">Stück<input name="title" value="${esc(p.title)}" required></label>
      <label>Komponist / Arrangeur<input name="composer" value="${esc(p.composer || "")}"></label>
      <label>Bereich<select name="area">${areaOpts(p.area)}</select></label>
      <label>Bis wann geübt<input type="date" name="deadline" value="${esc(p.deadline || "")}"></label>
      <label>Anlass<input name="deadlineLabel" value="${esc(p.deadlineLabel || "")}" placeholder="Konzert, Prüfung, Probe …"></label>
      <label>Aktuelles Tempo (♩)<input type="number" inputmode="numeric" min="20" max="300" name="tempoCurrent" value="${esc(p.tempoCurrent || "")}"></label>
      <label>Zieltempo (♩)<input type="number" inputmode="numeric" min="20" max="300" name="tempoTarget" value="${esc(p.tempoTarget || "")}"></label>
      <div class="full"><div class="label" style="padding-bottom:6px">Baustellen</div><div class="spots">${(p.spots || []).map(spotRow).join("")}</div>
        <button class="btn ghost small" type="button" data-spot-add style="margin-top:6px">+ Baustelle</button></div>
      <label class="full">Notizen<textarea name="notes" placeholder="Interpretation, Fingersätze, Aufnahme-Eindruck …">${esc(p.notes || "")}</textarea></label>
      <div class="actions">
        <button class="btn" type="submit">Speichern</button>
        <button class="btn ghost" type="button" data-pcancel>Abbrechen</button>
        <span class="spacer"></span>
        <button class="btn ghost" type="button" data-parch="${esc(p._id)}">Aufgeführt · ablegen</button>
        <button class="btn danger" type="button" data-pdel="${esc(p._id)}">Löschen</button>
      </div>
    </form>`;
  }

  // ---------- Einstellungen ----------
  function renderSettings() {
    const email = Store.account();
    let acct;
    if (shownRk) {
      acct = `<h3>Dein Wiederherstellungsschlüssel</h3>
        <p>Nur damit kommst du bei vergessenem Passwort wieder an deine Daten. Jetzt sicher aufbewahren (z. B. Passwort-Manager). Er wird nicht nochmals angezeigt.</p>
        <div class="rk" style="margin:10px 0">${esc(shownRk)}</div>
        <div class="row"><button class="btn ghost" type="button" data-a="copyRk">Kopieren</button><button class="btn" type="button" data-a="rkDone">Gesichert</button></div>`;
    } else if (email) {
      acct = `<h3>Konto</h3><p>Angemeldet als <b>${esc(email)}</b>. Deine Daten werden verschlüsselt zwischen deinen Geräten synchronisiert.</p>
        <div class="row" style="margin-top:10px"><button class="btn ghost" type="button" data-a="syncNow">Jetzt synchronisieren</button>
        <button class="btn danger${logoutArmed ? " armed" : ""}" type="button" data-a="logout">${logoutArmed ? "Abmelden und Daten vom Gerät entfernen?" : "Abmelden"}</button></div>`;
    } else {
      const v = acctView;
      acct = `<h3>${v === "up" ? "Konto erstellen" : v === "forgot" ? "Passwort vergessen" : "Anmelden"}</h3>
        <p>${v === "up" ? "Einmal auf dem ersten Gerät. Danach meldest du dich auf Handy und Laptop mit derselben E-Mail an." : v === "forgot" ? "Mit dem Wiederherstellungsschlüssel ein neues Passwort setzen." : "Mit Konto synchronisiert die App zwischen deinen Geräten. Ohne Konto bleibt alles auf diesem Gerät."}</p>
        <form class="form" id="acct-form" data-kind="${v}" style="margin-top:10px">
          <input type="email" name="email" placeholder="E-Mail" autocomplete="username" required>
          ${v === "forgot" ? `<input name="rk" placeholder="Wiederherstellungsschlüssel (UB-…)" autocomplete="off" required>` : ""}
          <input type="password" name="pw" placeholder="${v === "in" ? "Passwort" : "Neues Passwort (mind. 10 Zeichen)"}" autocomplete="${v === "in" ? "current-password" : "new-password"}" minlength="${v === "in" ? 1 : 10}" required>
          ${v === "up" ? `<input name="invite" placeholder="Einladungscode (wie beim Klassenbuch)" autocomplete="off" required>` : ""}
          ${acctErr ? `<div class="err">${esc(acctErr)}</div>` : ""}
          <div class="row"><button class="btn" type="submit"${acctBusy ? " disabled" : ""}>${acctBusy ? "Einen Moment …" : v === "up" ? "Konto erstellen" : v === "forgot" ? "Neues Passwort setzen" : "Anmelden"}</button></div>
          <div class="row">${v !== "in" ? `<button class="linkish" type="button" data-view="in">Anmelden</button>` : ""}${v !== "up" ? `<button class="linkish" type="button" data-view="up">Konto erstellen</button>` : ""}${v !== "forgot" ? `<button class="linkish" type="button" data-view="forgot">Passwort vergessen</button>` : ""}</div>
        </form>`;
    }
    $("settings").innerHTML = `<h2>Einstellungen</h2><div>${acct}</div>
      <div><h3>Daten</h3><p>Sicherung als Datei herunterladen oder eine Datei (z. B. aus dem alten Dashboard) übernehmen. Beim Import werden Stücke und Übetage ergänzt bzw. ersetzt.</p>
        <div class="row" style="margin-top:10px"><button class="btn ghost" type="button" data-a="export">Sicherung herunterladen</button><button class="btn ghost" type="button" data-a="import">Datei importieren</button></div></div>
      <div><h3>Auf den Home-Bildschirm</h3><p>iPhone: in Safari «Teilen» → «Zum Home-Bildschirm». Android/Chrome: Menü → «App installieren». Mac: Safari «Ablage» → «Zum Dock hinzufügen».</p></div>`;
  }

  async function accountSubmit(f) {
    const fd = new FormData(f), kind = f.dataset.kind;
    const email = String(fd.get("email") || "").trim(), pw = String(fd.get("pw") || "");
    acctBusy = true; acctErr = ""; document.activeElement?.blur(); render();
    try {
      if (kind === "up") { shownRk = await Store.register(email, pw, String(fd.get("invite") || "").trim()); toast("Konto erstellt"); }
      else if (kind === "forgot") { await Store.recover(email, String(fd.get("rk") || ""), pw); toast("Neues Passwort gesetzt"); }
      else { await Store.login(email, pw); toast("Angemeldet"); }
    } catch (e) {
      acctErr = { auth: "E-Mail oder Passwort stimmt nicht.", invite: "Einladungscode stimmt nicht.", exists: "Für diese E-Mail gibt es schon ein Konto. Bitte anmelden.", rk: "Der Schlüssel hat nicht das richtige Format.", rate: "Server ausgelastet. Bitte in einer Minute nochmals." }[e.code]
        || (/fetch|network|load failed/i.test(e.message || "") ? "Server nicht erreichbar." : "Das hat nicht geklappt (" + (e.message || "Fehler") + ").");
    }
    acctBusy = false; load(); render();
  }

  function exportData() {
    const out = { app: "ueben", version: 1, exportedAt: new Date().toISOString(), areas, pieces: {}, practice: {} };
    for (const [id, p] of pieces) { const { _id, ...doc } = p; out.pieces[id] = doc; }
    for (const [d, doc] of days) out.practice[d] = doc;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    a.download = `ueben-sicherung-${todayStr()}.json`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importData(file) {
    try {
      const j = JSON.parse(await file.text());
      if (!j || typeof j !== "object" || (!j.pieces && !j.practice)) throw new Error("format");
      if (Array.isArray(j.areas) && j.areas.length) await Store.set("areas", { list: j.areas.filter((a) => a && a.id && a.name) });
      let n = 0, m = 0;
      for (const [id, doc] of Object.entries(j.pieces || {})) if (doc && doc.title) { await Store.set("piece:" + id, doc); n++; }
      for (const [d, doc] of Object.entries(j.practice || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && doc) { await Store.set("day:" + d, doc); m++; }
      load(); render(); toast(`${n} Stücke und ${m} Übetage übernommen`);
    } catch (e) { toast("Diese Datei konnte nicht gelesen werden."); }
  }

  // ---------- Schreiben ----------
  const newId = () => "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // id = Stück oder null (freies Üben / Einspielen)
  function logPractice(id, min) {
    const p = id ? pieces.get(id) : null; if (id && !p) return;
    const d = todayStr(); const cur = days.get(d) || { date: d, entries: [], total: 0 };
    const next = { date: d, entries: [...(cur.entries || []), { piece: p ? id : null, title: p ? p.title : "Freies Üben", min, at: new Date().toISOString() }], total: (cur.total || 0) + min };
    days.set(d, next); saveDay(d, next);
    if (p) { Object.assign(p, { lastPracticed: d, totalMinutes: (p.totalMinutes || 0) + min }); savePiece(p); }
    logId = null; selDay = d; render(); toast(`${min} Min. eingetragen${p ? " · " + p.title : ""}`);
  }

  function removeEntry(day, idx) {
    const cur = days.get(day); if (!cur) return;
    const entries = [...(cur.entries || [])]; const [gone] = entries.splice(idx, 1); if (!gone) return;
    const next = { date: day, entries, total: entries.reduce((a, e) => a + (e.min || 0), 0) };
    days.set(day, next); saveDay(day, next); confirmIdx = null;
    const p = pieces.get(gone.piece);
    if (p) {
      let last = null;
      for (const [d, doc] of days) if ((doc.entries || []).some((e) => e.piece === p._id) && (!last || d > last)) last = d;
      Object.assign(p, { totalMinutes: Math.max(0, (p.totalMinutes || 0) - (gone.min || 0)), lastPracticed: last }); savePiece(p);
    }
    render();
  }

  // ---------- Ereignisse ----------
  $("padd").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("padd-title").value.trim(); if (!title) return;
    const id = newId();
    const p = { _id: id, title, composer: "", area: $("padd-area").value || null, deadline: $("padd-date").value || null, deadlineLabel: "", stage: 0, tempoCurrent: null, tempoTarget: null, spots: [], notes: "", lastPracticed: null, totalMinutes: 0, archived: false, createdAt: new Date().toISOString() };
    pieces.set(id, p); savePiece(p); openId = id;
    $("padd-title").value = ""; $("padd-date").value = ""; document.activeElement?.blur(); render();
  });

  $("gear").addEventListener("click", () => { showSettings = !showSettings; logoutArmed = false; render(); if (showSettings) $("settings").scrollIntoView({ block: "nearest", behavior: "smooth" }); });
  $("import-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importData(f); });

  $("settings").addEventListener("submit", (e) => { const f = e.target.closest("#acct-form"); if (!f) return; e.preventDefault(); accountSubmit(f); });
  $("settings").addEventListener("click", async (e) => {
    const t = e.target;
    const vw = t.closest("[data-view]"); if (vw) { acctView = vw.dataset.view; acctErr = ""; render(); return; }
    const a = t.closest("[data-a]")?.dataset.a; if (!a) return;
    if (a === "copyRk") { try { await navigator.clipboard.writeText(shownRk); toast("Kopiert"); } catch { toast("Bitte von Hand markieren und kopieren."); } }
    else if (a === "rkDone") { shownRk = null; render(); }
    else if (a === "syncNow") Store.sync();
    else if (a === "export") exportData();
    else if (a === "import") $("import-file").click();
    else if (a === "logout") { if (!logoutArmed) { logoutArmed = true; render(); return; } logoutArmed = false; await Store.logout(); load(); render(); toast("Abgemeldet"); }
  });

  const view = $("view-ueben");
  view.addEventListener("click", (e) => {
    const t = e.target;
    const ses = t.closest("[data-session]"); if (ses) { session = Number(ses.dataset.session); pref.set("ueben.session", session); render(); return; }
    const so = t.closest("[data-sort]"); if (so) { sortMode = so.dataset.sort; pref.set("ueben.sort", sortMode); render(); return; }
    const dy = t.closest("[data-day]"); if (dy) { selDay = dy.dataset.day; confirmIdx = null; render(); return; }
    const ea = t.closest("[data-entry-ask]"); if (ea) { confirmIdx = Number(ea.dataset.entryAsk); render(); return; }
    const ed = t.closest("[data-entry-del]"); if (ed) { removeEntry(selDay, Number(ed.dataset.entryDel)); return; }
    const q = t.closest("[data-plog-quick]"); if (q) { logPractice(q.dataset.plogQuick, Number(q.dataset.min)); return; }
    const lm = t.closest("[data-plog-min]"); if (lm) { logPractice(lm.dataset.lid, Number(lm.dataset.plogMin)); return; }
    const lg = t.closest("[data-plog]"); if (lg) { logId = logId === lg.dataset.plog ? null : lg.dataset.plog; render(); return; }
    const st = t.closest("[data-stage]");
    if (st) { const p = pieces.get(st.dataset.sid); if (!p) return; p.stage = Number(st.dataset.stage); savePiece(p); render(); return; }
    const op = t.closest("[data-popen]"); if (op) { openId = openId === op.dataset.popen ? null : op.dataset.popen; render(); return; }
    if (t.closest("[data-pcancel]")) { openId = null; document.activeElement?.blur(); render(); return; }
    if (t.closest("[data-spot-add]")) { const box = t.closest(".editor").querySelector(".spots"); box.insertAdjacentHTML("beforeend", spotRow({ text: "", done: false })); box.lastElementChild.querySelector("input[type=text]").focus(); return; }
    const sd = t.closest("[data-spot-del]"); if (sd) { sd.closest(".spot").remove(); return; }
    const ar = t.closest("[data-parch]");
    if (ar) { const p = pieces.get(ar.dataset.parch); Object.assign(p, { archived: true, archivedAt: new Date().toISOString() }); savePiece(p); openId = null; document.activeElement?.blur(); render(); return; }
    const rs = t.closest("[data-prestore]");
    if (rs) { const p = pieces.get(rs.dataset.prestore); p.archived = false; savePiece(p); render(); return; }
    const del = t.closest("[data-pdel]");
    if (del) {
      if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Wirklich löschen?"; return; }
      const id = del.dataset.pdel; pieces.delete(id); Store.set("piece:" + id, null); openId = null; document.activeElement?.blur(); render();
    }
  });
  view.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-pedit]"); if (!f) return;
    e.preventDefault();
    const p = pieces.get(f.dataset.pedit); if (!p) return;
    const fd = new FormData(f); const num = (v) => (v ? Number(v) : null);
    const spots = [...f.querySelectorAll(".spot")].map((r) => ({ text: r.querySelector("input[type=text]").value.trim(), done: r.querySelector("input[type=checkbox]").checked })).filter((s) => s.text);
    Object.assign(p, {
      title: String(fd.get("title")).trim() || p.title, composer: String(fd.get("composer") || "").trim(), area: fd.get("area") || null,
      deadline: fd.get("deadline") || null, deadlineLabel: String(fd.get("deadlineLabel") || "").trim(),
      tempoCurrent: num(fd.get("tempoCurrent")), tempoTarget: num(fd.get("tempoTarget")), spots, notes: String(fd.get("notes") || "")
    });
    savePiece(p); openId = null; document.activeElement?.blur(); render();
  });
  document.addEventListener("focusout", () => setTimeout(() => { if (pending && !document.activeElement?.closest?.(".editor, .form")) render(); }, 0));
  // Tageswechsel (App bleibt offen): neu zeichnen
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });

  // ---------- Übe-Timer ----------
  // Zustand wird mit Endzeitpunkt gespeichert, damit der Timer auch nach Hintergrund/Neuladen stimmt.
  // Phasen: idle → work → brk → ready (→ work …)
  const tcfg = Object.assign({ work: 30, brk: 10, focus: false, startName: "Üben Start", endName: "Üben Ende" }, pref.get("ueben.timerCfg", {}));
  let T = Object.assign({ phase: "idle", endsAt: 0, left: 0, paused: false, piece: "", round: 0, workMin: 30 }, pref.get("ueben.timer", {}));
  let tEdit = false, tHelp = false, wake = null, actx = null;
  const saveT = () => pref.set("ueben.timer", T), saveCfg = () => pref.set("ueben.timerCfg", tcfg);
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const leftMs = () => (T.paused ? T.left : T.endsAt - Date.now());
  const suggestPiece = () => active().map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s)[0]?.p._id || "";

  function chime(n) {
    try {
      if (!actx) return; actx.resume?.();
      for (let i = 0; i < n; i++) {
        const o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime + i * 0.45;
        o.type = "sine"; o.frequency.value = i % 2 ? 660 : 880; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
        o.start(t0); o.stop(t0 + 0.42);
      }
    } catch (e) {}
    try { navigator.vibrate?.([300, 150, 300]); } catch (e) {}
  }
  async function keepAwake(on) {
    try {
      if (on && !wake && "wakeLock" in navigator && document.visibilityState === "visible") { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); }
      if (!on && wake) { await wake.release(); wake = null; }
    } catch (e) { wake = null; }
  }
  function runShortcut(name, input) {
    if (!tcfg.focus || !name) return;
    location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(name) + (input != null ? "&input=text&text=" + encodeURIComponent(String(input)) : "");
  }

  function tStart() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume?.(); } catch (e) {}
    T = { phase: "work", endsAt: Date.now() + tcfg.work * 60000, left: 0, paused: false, piece: T.piece || suggestPiece(), round: (T.phase === "ready" ? T.round : 0) + 1, workMin: tcfg.work };
    saveT(); keepAwake(true); render();
    runShortcut(tcfg.startName, tcfg.work);
  }
  function tPause() {
    if (T.paused) { T.endsAt = Date.now() + T.left; T.paused = false; keepAwake(true); }
    else { T.left = Math.max(0, T.endsAt - Date.now()); T.paused = true; }
    saveT(); render();
  }
  function tStop() {
    if (T.phase === "brk") { T = { ...T, phase: "ready", paused: false }; saveT(); keepAwake(false); render(); return; }
    const done = Math.round((T.workMin * 60000 - leftMs()) / 60000), piece = T.piece || null;
    T = { ...T, phase: "idle", paused: false, round: 0 }; saveT(); keepAwake(false); document.title = "Üben";
    if (done >= 5) logPractice(piece, done); else render();
    runShortcut(tcfg.endName, null);
  }
  // Prüft Phasenwechsel, auch rückwirkend (App war im Hintergrund)
  function tCheck() {
    if (!ready) return false;   // erst wenn die Daten geladen sind (sonst geht der Eintrag verloren)
    if (T.paused || T.phase === "idle" || T.phase === "ready") return false;
    if (Date.now() < T.endsAt) return false;
    if (T.phase === "work") {
      const piece = T.piece || null, min = T.workMin;
      T.phase = "brk"; T.endsAt = T.endsAt + tcfg.brk * 60000; saveT();   // zuerst Phase wechseln, dann eintragen (render ruft tCheck)
      chime(3); logPractice(piece, min); return true;
    }
    if (T.phase === "brk") { T.phase = "ready"; saveT(); keepAwake(false); chime(2); return true; }
    return false;
  }

  function renderTimer() {
    tCheck();
    const box = $("timer"); if (!box) return;
    const act = active();
    if (ready && T.piece && !pieces.get(T.piece)) T.piece = "";
    const opts = `<option value="">Freies Üben</option>` + act.map((p) => `<option value="${esc(p._id)}"${p._id === (T.piece || "") ? " selected" : ""}>${esc(p.title)}</option>`).join("");
    const running = T.phase === "work" || T.phase === "brk";
    const label = { idle: "Übe-Timer", work: `Runde ${T.round} · Üben`, brk: "Pause", ready: `Pause vorbei · ${T.round} Runde${T.round === 1 ? "" : "n"} geschafft` }[T.phase];
    const total = (T.phase === "brk" ? tcfg.brk : T.workMin) * 60000;
    const pct = running ? Math.min(100, Math.max(0, 100 - (leftMs() / total) * 100)) : 0;
    let main;
    if (running) {
      main = `<div class="t-time mono" id="t-time">${mmss(leftMs())}</div>
        <div class="t-bar"><i id="t-bar" style="width:${pct}%"></i></div>
        <div class="t-sub">${T.phase === "work" ? `${esc(pieces.get(T.piece)?.title || "Freies Üben")} · danach ${tcfg.brk}′ Pause` : "Aufstehen, trinken, Hände lockern"}${T.paused ? " · angehalten" : ""}</div>
        <div class="row"><button class="btn" type="button" data-t="pause">${T.paused ? "Weiter" : "Anhalten"}</button><button class="btn ghost" type="button" data-t="stop">${T.phase === "work" ? "Beenden" : "Pause überspringen"}</button></div>`;
    } else {
      main = `<div class="t-time mono">${tcfg.work}:00</div>
        <div class="t-sub">${tcfg.work}′ üben, dann ${tcfg.brk}′ Pause${tcfg.focus ? " · Fokus «Üben» an (nur Anrufe)" : ""}</div>
        <label class="t-piece">Stück <select data-t="piece">${opts}</select></label>
        <div class="row"><button class="btn" type="button" data-t="start">${T.phase === "ready" ? "Nächste Runde" : "Start"}</button>${T.phase === "ready" ? `<button class="btn ghost" type="button" data-t="reset">Fertig für heute</button>` : ""}<button class="linkish" type="button" data-t="edit">${tEdit ? "Schliessen" : "Anpassen"}</button></div>`;
    }
    const edit = tEdit && !running ? `<div class="t-edit">
        <div class="row"><span class="label">Üben</span><div class="seg">${[20, 25, 30, 45, 60].map((m) => `<button type="button" data-t="work" data-v="${m}" aria-pressed="${tcfg.work === m}">${m}′</button>`).join("")}</div></div>
        <div class="row"><span class="label">Pause</span><div class="seg">${[5, 10, 15].map((m) => `<button type="button" data-t="brk" data-v="${m}" aria-pressed="${tcfg.brk === m}">${m}′</button>`).join("")}</div></div>
        <label class="row t-check"><input type="checkbox" data-t="focus"${tcfg.focus ? " checked" : ""}> Beim Start Fokus «Üben» einschalten (nur Anrufe kommen durch)</label>
        <button class="linkish" type="button" data-t="help">${tHelp ? "Anleitung ausblenden" : "Einrichten: Fokus + Kurzbefehl (einmalig, 3 Min.)"}</button>
        ${tHelp ? `<ol class="t-help">
          <li><b>Fokus anlegen:</b> Einstellungen → Fokus → + → Eigener → Name <b>Üben</b>. Mitteilungen erlauben von: <b>Personen: niemand</b>, <b>Apps: keine</b>. Unter Personen → <b>Anrufe von: Alle</b> erlauben.</li>
          <li><b>Kurzbefehl «${esc(tcfg.startName)}»</b> in der App Kurzbefehle: Aktion <i>Datum anpassen</i> (Aktuelles Datum + <i>Kurzbefehleingabe</i> Minuten) → Aktion <i>Fokus festlegen</i>: Üben <b>einschalten bis</b> Zeit = angepasstes Datum. Optional: <i>Timer starten</i> mit Kurzbefehleingabe Minuten (klingelt sicher, auch wenn die App im Hintergrund ist).</li>
          <li><b>Kurzbefehl «${esc(tcfg.endName)}»:</b> Aktion <i>Fokus festlegen</i>: Üben <b>ausschalten</b>.</li>
          <li>Beim Start öffnet die App kurz «Kurzbefehle». Mit «◀ Üben» oben links kommst du zurück.</li></ol>` : ""}
      </div>` : "";
    if (!running) document.title = "Üben";
    box.className = "timer" +(T.phase === "work" ? " is-work" : T.phase === "brk" ? " is-brk" : "");
    box.innerHTML = `<div class="label">${label}</div>${main}${edit}`;
  }
  function tick() {
    if (T.phase !== "work" && T.phase !== "brk") return;
    if (tCheck()) { render(); return; }
    const t = $("t-time"), b = $("t-bar"); if (!t) return;
    t.textContent = mmss(leftMs());
    const total = (T.phase === "brk" ? tcfg.brk : T.workMin) * 60000;
    b.style.width = Math.min(100, Math.max(0, 100 - (leftMs() / total) * 100)) + "%";
    document.title = `${mmss(leftMs())} · ${T.phase === "work" ? "Üben" : "Pause"}`;
  }
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && T.phase === "work" && !T.paused) keepAwake(true); });

  $("timer").addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]"); if (!b || b.tagName === "SELECT" || b.type === "checkbox") return;
    const a = b.dataset.t;
    if (a === "start") tStart();
    else if (a === "pause") tPause();
    else if (a === "stop") tStop();
    else if (a === "reset") { T = { ...T, phase: "idle", round: 0 }; saveT(); document.title = "Üben"; render(); }
    else if (a === "edit") { tEdit = !tEdit; render(); }
    else if (a === "help") { tHelp = !tHelp; render(); }
    else if (a === "work" || a === "brk") { tcfg[a] = Number(b.dataset.v); saveCfg(); render(); }
  });
  $("timer").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.t === "piece") { T.piece = t.value; saveT(); }
    if (t.dataset.t === "focus") { tcfg.focus = t.checked; saveCfg(); render(); }
  });

  // ---------- Start ----------
  render();
  Store.start({
    onChange: () => { load(); render(); },
    onStatus: (t) => { $("sync").textContent = t; }
  }).then(() => { load(); ready = true; render(); })
    .catch(() => { ready = true; $("sync").textContent = "Speicher nicht verfügbar"; render(); });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => { const w = reg.installing; w && w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) toast("Neue Version geladen – beim nächsten Öffnen aktiv."); }); });
    }).catch(() => {});
  }
})();
