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
  let sortMode = pref.get("ueben.sort", "area");
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

  // ---------- Proben aus TimeTree (meta:timetree → Datensatz «proben») ----------
  // Probe = eigener TimeTree-Termin mit Uhrzeit, Titel enthält «prob». Verein aus dem Titel.
  const VEREINE = [
    { re: /liberty|\blbb\b/i, id: "liberty" },
    { re: /stadtmusik|\bsma\b|arbon/i, id: "sma" },
    { re: /\bjbo\b|jugendblas/i, id: "jbo" },
    { re: /gugge/i, name: "Gugge", hue: 330 },
    { re: /milmusik|militär/i, name: "Militärmusik", hue: 120 },
    { re: /bischof+szell/i, name: "Bischofszell", hue: 75 },
  ];
  const isProbe = (t) => /prob/i.test(t || "") && !/probelektion|schnupper/i.test(t);
  function vereinOf(t) {
    const v = VEREINE.find((x) => x.re.test(t));
    if (v) return v.id ? { id: v.id, name: areaById(v.id)?.name || v.id, hue: hue(v.id) } : { id: v.name, name: v.name, hue: v.hue };
    const rest = t.replace(/\b\w*prob\w*\b/gi, "").replace(/\s+/g, " ").trim() || "Andere";
    return { id: rest, name: rest, hue: 200 };
  }
  const probenRec = () => Store.recs.get("proben")?.list || {};
  function syncProben() {
    const tt = Store.recs.get("meta:timetree"); if (!tt || !Array.isArray(tt.events)) return;
    const cur = probenRec(), next = { ...cur }, today = todayStr(), seen = new Set();
    for (const e of tt.events) {
      if (!e || !e.id || e.ad || e.s == null || e.e == null || !isProbe(e.t)) continue;
      const v = vereinOf(e.t); seen.add(e.id);
      next[e.id] = { d: e.d, s: e.s, min: Math.max(0, e.e - e.s), title: e.t, verein: v.id };
    }
    // abgesagte künftige Proben (im Abgleich-Zeitraum, nicht mehr in TimeTree) entfernen
    for (const [id, p] of Object.entries(cur)) if (!seen.has(id) && p.d >= today && p.d >= (tt.from || "") && p.d <= (tt.to || "")) delete next[id];
    if (JSON.stringify(next) !== JSON.stringify(cur)) Store.set("proben", { list: next });
  }
  // nur vergangene Proben zählen
  function probenOn(d) {
    const today = todayStr(), now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
    return Object.values(probenRec()).filter((p) => p.d === d && (d < today || (d === today && p.s + p.min <= nm)));
  }
  const probeMinOn = (d) => probenOn(d).reduce((a, p) => a + p.min, 0);
  function vereinStats(days30) {
    const m = new Map();
    for (const d of days30) for (const p of probenOn(d)) {
      const v = vereinOf(p.title), x = m.get(v.id) || { ...v, n: 0, min: 0 };
      x.n++; x.min += p.min; m.set(v.id, x);
    }
    return [...m.values()].sort((a, b) => b.min - a.min);
  }
  const hrs = (min) => (min / 60).toLocaleString("de-CH", { maximumFractionDigits: 1 }) + " h";
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
    const week = weekDays(), today = todayStr();
    if (selDay !== today && !week.includes(selDay)) selDay = today;
    const weekTotal = week.reduce((a, d) => a + minutesOn(d), 0);
    if (ready) syncProben();
    const weekProbe = week.reduce((a, d) => a + probeMinOn(d), 0);
    $("pstats").innerHTML = [["Min. diese Woche", weekTotal], ["Proben diese Woche", hrs(weekProbe)], ["Tage Serie", streak()], ["heute geübt", minutesOn(today)]]
      .map(([l, n]) => `<div class="stat"><b>${n}</b><span class="label">${l}</span></div>`).join("");

    $("gear").setAttribute("aria-pressed", showSettings);
    $("settings").hidden = !showSettings;
    if (showSettings) renderSettings();

    renderTimer();

    const act = active();
    if (!act.length) {
      $("plan").innerHTML = `<li class="plan-why" style="padding-top:10px">${ready ? "Füge unten dein erstes Stück mit Termin hinzu – oder hol unter «Einstellungen» deine Daten (anmelden oder importieren)." : "Wird geladen …"}</li>`;
      $("plan-total").textContent = "";
    } else {
      const top = act.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s).slice(0, 3);
      $("plan").innerHTML = top.map(({ p }) => {
        const m = sessMinFor(p), ideas = goalIdeas(p).slice(0, 3);
        return `<li class="plan-item"><div class="plan-min">${m}<small>MIN</small></div><div><span class="dot" style="--h:${hue(p.area)};display:inline-block;margin-right:6px"></span><b style="font-weight:500">${esc(p.title)}</b><div class="plan-why">${esc(reasons(p) || areaName(p.area))}</div><ul class="plan-goals">${ideas.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div><div class="plan-acts"><button class="btn small" type="button" data-sess="${esc(p._id)}" data-min="${m}">Session starten</button><button class="btn ghost small" type="button" data-plog-quick="${esc(p._id)}" data-min="${m}">Schon geübt</button></div></li>`;
      }).join("");
      $("plan-total").textContent = "Einzelne Sessions, kein Tagesplan – nimm eine, wenn es passt. Reihenfolge nach Termin, letzter Übezeit, Phase und offenen Baustellen.";
    }

    const max = Math.max(30, ...week.map((d) => minutesOn(d) + probeMinOn(d)));
    $("bars").innerHTML = week.map((d) => {
      const m = minutesOn(d), pm = probeMinOn(d), h = Math.round((m / max) * 100), ph = Math.round((pm / max) * 100);
      const tip = `${fmt(d)}: ${m} Min. geübt${pm ? `, ${pm} Min. Probe` : ""} – Einträge anzeigen`;
      return `<button type="button" class="bar${d === today ? " today" : ""}${m || pm ? "" : " zero"}${d === selDay ? " sel" : ""}" data-day="${d}" aria-pressed="${d === selDay}" title="${esc(tip)}"><em>${m + pm || ""}</em>${pm ? `<u style="height:${Math.max(ph, 4)}%"></u>` : ""}<i style="height:${m ? Math.max(h, 4) : pm ? 0 : 2}%"></i><span>${WD[parse(d).getDay()]}</span></button>`;
    }).join("");
    const last30 = Array.from({ length: 30 }, (_, i) => { const x = new Date(); x.setDate(x.getDate() - i); return iso(x); });
    const vsW = vereinStats(week), vs30 = vereinStats(last30), wk = new Map(vsW.map((v) => [v.id, v]));
    const cell = (v) => v ? `<span class="n">${v.n}×</span><span class="m">${hrs(v.min)}</span>` : `<span class="n"></span><span class="m muted">–</span>`;
    $("pvereine").innerHTML = `<div class="vrow vhead"><span class="dot" style="visibility:hidden"></span><span class="label t">Proben nach Verein</span><span class="label c">Diese Woche</span><span class="label c">30 Tage</span></div>` +
      (vs30.length
        ? vs30.map((v) => `<div class="vrow"><span class="dot" style="--h:${v.hue}"></span><span class="t">${esc(v.name)}</span><span class="c">${cell(wk.get(v.id))}</span><span class="c">${cell(v)}</span></div>`).join("") +
          `<div class="vrow vsum"><span class="dot" style="visibility:hidden"></span><span class="t">Total</span><span class="c">${cell(vsW.length ? vsW.reduce((a, v) => ({ n: a.n + v.n, min: a.min + v.min }), { n: 0, min: 0 }) : null)}</span><span class="c">${cell(vs30.reduce((a, v) => ({ n: a.n + v.n, min: a.min + v.min }), { n: 0, min: 0 }))}</span></div>`
        : `<div class="vrow muted">Noch keine – Proben aus TimeTree erscheinen hier, sobald sie vorbei sind.</div>`);

    const ents = days.get(selDay)?.entries || [], prs = probenOn(selDay);
    $("daylog").innerHTML = `<div class="label">${selDay === today ? "Heute" : esc(fmt(selDay))} · ${ents.length ? ents.reduce((a, e) => a + (e.min || 0), 0) + " Min." : "nichts eingetragen"}${prs.length ? ` · ${prs.reduce((a, p) => a + p.min, 0)} Min. Probe` : ""}</div>` +
      prs.map((p) => { const v = vereinOf(p.title); return `<div class="entry probe"><span class="m">${p.min}′</span><span class="t"><span class="dot" style="--h:${v.hue};display:inline-block;margin-right:6px"></span>${esc(p.title)}<small class="goal-sum">Probe · ${esc(v.name)} · aus TimeTree</small></span></div>`; }).join("") +
      ents.map((e, i) => `<div class="entry"><span class="m">${e.min}′</span><span class="t">${esc(pieces.get(e.piece)?.title || e.title || "Stück")}${e.goals ? `<small class="goal-sum">${e.goals.filter((g) => g.done).length}/${e.goals.length} Ziele${e.goals.length ? ": " + e.goals.map((g) => (g.done ? "✓ " : "○ ") + esc(g.text)).join(" · ") : ""}</small>` : ""}</span>${confirmIdx === i ? `<button type="button" data-entry-del="${i}" style="color:var(--danger);border-color:var(--danger)">Entfernen?</button>` : `<button type="button" data-entry-ask="${i}" aria-label="Eintrag entfernen">Entfernen</button>`}</div>`).join("");

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
    out.tasks = {}; for (const [k, v] of Store.recs) if (k.startsWith("task:")) out.tasks[k.slice(5)] = v;
    out.taskAreas = Store.recs.get("taskAreas")?.list || null;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    a.download = `ueben-sicherung-${todayStr()}.json`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importData(file) {
    try {
      const j = JSON.parse(await file.text());
      if (!j || typeof j !== "object" || (!j.pieces && !j.practice && !j.tasks)) throw new Error("format");
      if (Array.isArray(j.taskAreas) && j.taskAreas.length) await Store.set("taskAreas", { list: j.taskAreas });
      let k = 0; for (const [id, doc] of Object.entries(j.tasks || {})) if (doc && doc.title) { await Store.set("task:" + id, doc); k++; }
      if (Array.isArray(j.areas) && j.areas.length) await Store.set("areas", { list: j.areas.filter((a) => a && a.id && a.name) });
      let n = 0, m = 0;
      for (const [id, doc] of Object.entries(j.pieces || {})) if (doc && doc.title) { await Store.set("piece:" + id, doc); n++; }
      for (const [d, doc] of Object.entries(j.practice || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && doc) { await Store.set("day:" + d, doc); m++; }
      load(); render(); toast(`${k} Aufgaben, ${n} Stücke und ${m} Übetage übernommen`); window.dispatchEvent(new Event("store:change"));
    } catch (e) { toast("Diese Datei konnte nicht gelesen werden."); }
  }

  // ---------- Schreiben ----------
  const newId = () => "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // id = Stück oder null (freies Üben / Einspielen)
  function logPractice(id, min, goals) {
    const p = id ? pieces.get(id) : null; if (id && !p) return;
    const d = todayStr(); const cur = days.get(d) || { date: d, entries: [], total: 0 };
    const entry = { piece: p ? id : null, title: p ? p.title : "Freies Üben", min, at: new Date().toISOString() };
    if (goals && goals.length) entry.goals = goals.map((g) => ({ text: g.text, done: !!g.done }));
    const next = { date: d, entries: [...(cur.entries || []), entry], total: (cur.total || 0) + min };
    days.set(d, next); saveDay(d, next);
    if (p) {
      Object.assign(p, { lastPracticed: d, totalMinutes: (p.totalMinutes || 0) + min });
      const reached = new Set((goals || []).filter((g) => g.done).map((g) => g.text.trim().toLowerCase()));
      if (reached.size) p.spots = (p.spots || []).map((sp) => (reached.has(sp.text.trim().toLowerCase()) ? { ...sp, done: true } : sp));
      savePiece(p);
    }
    const ok = entry.goals ? ` · ${entry.goals.filter((g) => g.done).length}/${entry.goals.length} Ziele` : "";
    logId = null; selDay = d; render(); toast(`${min} Min. eingetragen${p ? " · " + p.title : ""}${ok}`);
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
    const so = t.closest("[data-sort]"); if (so) { sortMode = so.dataset.sort; pref.set("ueben.sort", sortMode); render(); return; }
    const dy = t.closest("[data-day]"); if (dy) { selDay = dy.dataset.day; confirmIdx = null; render(); return; }
    const ea = t.closest("[data-entry-ask]"); if (ea) { confirmIdx = Number(ea.dataset.entryAsk); render(); return; }
    const ed = t.closest("[data-entry-del]"); if (ed) { removeEntry(selDay, Number(ed.dataset.entryDel)); return; }
    const ss = t.closest("[data-sess]"); if (ss) { const p = pieces.get(ss.dataset.sess); if (T.phase === "work") { toast("Es läuft schon eine Session"); return; } T = { ...T, piece: ss.dataset.sess, sessMin: Number(ss.dataset.min), prefill: goalIdeas(p).slice(0, 3) }; tGoals(); $("timer").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
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
  // Phasen: idle → goals (3 Ziele) → work → ready («Session geschafft»). Keine Runden/Pausen: jede Session steht für sich.
  const tcfg = Object.assign({ work: 30, brk: 10, focus: false, startName: "Üben Start", endName: "Üben Ende" }, pref.get("ueben.timerCfg", {}));
  let T = Object.assign({ phase: "idle", endsAt: 0, left: 0, paused: false, piece: "", round: 0, workMin: 30, goals: [] }, pref.get("ueben.timer", {}));
  if (T.phase === "brk") T.phase = "ready";
  if (T.day !== todayStr()) { if (T.phase === "ready") T.phase = "idle"; T.round = T.phase === "work" ? T.round : 0; } T.day = todayStr();
  let tEdit = false, wake = null, actx = null;
  const saveT = () => pref.set("ueben.timer", T), saveCfg = () => pref.set("ueben.timerCfg", tcfg);
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const leftMs = () => (T.paused ? T.left : T.endsAt - Date.now());
  const sessMinFor = (p) => { const dd = p.deadline ? dayDiff(p.deadline) : 999; return dd >= 0 && dd <= 7 ? 30 : 20; };
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

  // Vorschläge für erreichbare Ziele aus dem Stück
  function goalIdeas(p) {
    const out = [];
    if (p) {
      for (const sp of (p.spots || []).filter((x) => !x.done)) out.push(sp.text);
      if (p.tempoTarget && p.tempoCurrent && p.tempoCurrent < p.tempoTarget) out.push(`Tempo ♩ ${p.tempoCurrent} → ${Math.min(p.tempoTarget, p.tempoCurrent + 4)} sauber`);
      if ((p.stage || 0) >= 2) out.push("Einmal ganz durch ohne Stopp");
      else out.push("Einen Abschnitt langsam und fehlerfrei");
      out.push("Schwierigste Stelle 5× hintereinander sauber");
    } else out.push("Rudiments 10 Min. mit Metronom", "Tonleitern auf Mallets", "Blattspiel: 1 neue Seite");
    return [...new Set(out)].slice(0, 6);
  }
  function tGoals() {
    // Klick = Nutzergeste: Ton freischalten
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume?.(); } catch (e) {}
    const keep = T.phase === "ready" ? T.round : 0;
    T = { ...T, phase: "goals", piece: T.piece || suggestPiece(), round: keep, goals: [], sessMin: T.sessMin || tcfg.work }; saveT(); render();
    setTimeout(() => document.querySelector("[data-goal-in]")?.focus(), 50);
  }
  function tStart(goals) {
    const min = T.sessMin || tcfg.work;
    T = { phase: "work", endsAt: Date.now() + min * 60000, left: 0, paused: false, piece: T.piece || "", round: (T.round || 0) + 1, workMin: min, goals };
    saveT(); keepAwake(true); document.activeElement?.blur(); render();
  }
  function tPause() {
    if (T.paused) { T.endsAt = Date.now() + T.left; T.paused = false; keepAwake(true); }
    else { T.left = Math.max(0, T.endsAt - Date.now()); T.paused = true; }
    saveT(); render();
  }
  function tStop() {
    if (T.phase === "brk") { T = { ...T, phase: "ready", paused: false }; saveT(); keepAwake(false); render(); return; }
    if (T.phase === "goals") { T = { ...T, phase: T.round ? "ready" : "idle", goals: [], sessMin: 0, prefill: null }; saveT(); render(); return; }
    const done = Math.round((T.workMin * 60000 - leftMs()) / 60000), piece = T.piece || null, goals = T.goals || [];
    const r = done >= 5 ? T.round : Math.max(0, (T.round || 1) - 1);
    T = { ...T, phase: r ? "ready" : "idle", round: r, paused: false, goals: [], sessMin: 0, prefill: null }; saveT(); keepAwake(false); document.title = "Zentrale";
    if (done >= 5) logPractice(piece, done, goals); else render();
  }
  // Prüft Phasenwechsel, auch rückwirkend (App war im Hintergrund)
  function tCheck() {
    if (!ready) return false;   // erst wenn die Daten geladen sind (sonst geht der Eintrag verloren)
    if (T.paused || (T.phase !== "work" && T.phase !== "brk")) return false;
    if (Date.now() < T.endsAt) return false;
    if (T.phase === "work") {
      const piece = T.piece || null, min = T.workMin, goals = T.goals || [];
      T.phase = "ready"; T.sessMin = 0; T.prefill = null; saveT(); keepAwake(false);   // zuerst Phase wechseln, dann eintragen (render ruft tCheck)
      chime(3); logPractice(piece, min, goals); return true;
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
    const label = { idle: "Übe-Session", goals: "3 erreichbare Ziele für diese Session", work: "Session läuft", brk: "Pause", ready: `Session geschafft${T.round > 1 ? ` · ${T.round} heute` : ""}` }[T.phase];
    const total = (T.phase === "brk" ? tcfg.brk : T.workMin) * 60000;
    const pct = running ? Math.min(100, Math.max(0, 100 - (leftMs() / total) * 100)) : 0;
    let main;
    const goalList = (T.goals || []).length ? `<ul class="t-goals">${T.goals.map((g, i) => `<li><label><input type="checkbox" data-t="goal" data-i="${i}"${g.done ? " checked" : ""}> <span>${esc(g.text)}</span></label></li>`).join("")}</ul>` : "";
    if (T.phase === "goals") {
      const p = pieces.get(T.piece);
      const sm = T.sessMin || tcfg.work, pf = T.prefill || [];
      main = `<div class="t-sub">${esc(p ? p.title : "Freies Üben")} · <span class="seg t-len">${[15, 20, 30, 45].map((m) => `<button type="button" data-t="len" data-v="${m}" aria-pressed="${sm === m}">${m}′</button>`).join("")}</span><br>Klein und konkret – was ist in dieser Zeit sicher schaffbar?</div>
        <div class="form t-goal-form">${[0, 1, 2].map((i) => `<input data-goal-in="${i}" placeholder="Ziel ${i + 1}" autocomplete="off" enterkeyhint="${i < 2 ? "next" : "go"}" value="${esc(pf[i] || "")}">`).join("")}</div>
        <div class="t-ideas"><span class="label">Ideen</span>${goalIdeas(p).map((g) => `<button class="chip" type="button" data-t="idea" data-v="${esc(g)}">${esc(g)}</button>`).join("")}</div>
        <div class="err" id="t-goal-err" hidden>Bitte alle 3 Ziele ausfüllen.</div>
        <div class="row"><button class="btn" type="button" data-t="go">Los – ${sm}′ starten</button><button class="btn ghost" type="button" data-t="stop">Abbrechen</button></div>`;
    } else if (running) {
      main = `<div class="t-time mono" id="t-time">${mmss(leftMs())}</div>
        <div class="t-bar"><i id="t-bar" style="width:${pct}%"></i></div>
        <div class="t-sub">${T.phase === "work" ? `${esc(pieces.get(T.piece)?.title || "Freies Üben")} · ${T.workMin}′` : "Aufstehen, trinken, Hände lockern"}${T.paused ? " · angehalten" : ""}</div>
        ${T.phase === "work" ? goalList : ""}
        <div class="row"><button class="btn" type="button" data-t="pause">${T.paused ? "Weiter" : "Anhalten"}</button><button class="btn ghost" type="button" data-t="stop">${T.phase === "work" ? "Beenden" : "Pause überspringen"}</button></div>`;
    } else {
      main = `<div class="t-time mono">${tcfg.work}:00</div>
        <div class="t-sub">Eine Session: ${tcfg.work}′ mit 3 Zielen. Wann die nächste kommt, entscheidest du.</div>
        <label class="t-piece">Stück <select data-t="piece">${opts}</select></label>
        <div class="row"><button class="btn" type="button" data-t="start">${T.phase === "ready" ? "Neue Session" : "Start"}</button>${T.phase === "ready" ? `<button class="btn ghost" type="button" data-t="reset">Ausblenden</button>` : ""}<button class="linkish" type="button" data-t="edit">${tEdit ? "Schliessen" : "Anpassen"}</button></div>`;
    }
    const edit = tEdit && !running ? `<div class="t-edit">
        <div class="row"><span class="label">Standardlänge</span><div class="seg">${[15, 20, 25, 30, 45].map((m) => `<button type="button" data-t="work" data-v="${m}" aria-pressed="${tcfg.work === m}">${m}′</button>`).join("")}</div></div>
      </div>` : "";
    if (!running) document.title = "Zentrale";
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
    if (a === "start") { T.sessMin = 0; T.prefill = null; tGoals(); }
    else if (a === "idea") { const ins = [...document.querySelectorAll("[data-goal-in]")]; const free = ins.find((x) => !x.value.trim()); if (free) { free.value = b.dataset.v; b.disabled = true; } }
    else if (a === "go") {
      const goals = [...document.querySelectorAll("[data-goal-in]")].map((x) => ({ text: x.value.trim(), done: false }));
      if (goals.some((g) => !g.text)) { $("t-goal-err").hidden = false; document.querySelector("[data-goal-in]:placeholder-shown")?.focus(); return; }
      tStart(goals);
    }
    else if (a === "pause") tPause();
    else if (a === "stop") tStop();
    else if (a === "reset") { T = { ...T, phase: "idle", round: 0 }; saveT(); document.title = "Zentrale"; render(); }
    else if (a === "edit") { tEdit = !tEdit; render(); }
    else if (a === "work") { tcfg.work = Number(b.dataset.v); saveCfg(); render(); }
    else if (a === "len") { T.sessMin = Number(b.dataset.v); T.prefill = [...document.querySelectorAll("[data-goal-in]")].map((x) => x.value); saveT(); render(); }
  });
  $("timer").addEventListener("keydown", (e) => {
    const inp = e.target.closest("[data-goal-in]"); if (!inp || e.key !== "Enter") return;
    e.preventDefault(); const i = Number(inp.dataset.goalIn);
    if (i < 2) document.querySelector(`[data-goal-in="${i + 1}"]`)?.focus(); else document.querySelector('[data-t="go"]')?.click();
  });
  $("timer").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.t === "piece") { T.piece = t.value; saveT(); }
    if (t.dataset.t === "goal") { const g = T.goals[Number(t.dataset.i)]; if (g) { g.done = t.checked; saveT(); } }
  });

  // ---------- Start ----------
  render();
  Store.start({
    onChange: () => { load(); render(); window.dispatchEvent(new Event("store:change")); },
    onStatus: (t) => { $("sync").textContent = t; }
  }).then(() => { load(); ready = true; render(); window.__storeReady = true; window.dispatchEvent(new Event("store:ready")); })
    .catch(() => { ready = true; $("sync").textContent = "Speicher nicht verfügbar"; render(); });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => { const w = reg.installing; w && w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) toast("Neue Version geladen – beim nächsten Öffnen aktiv."); }); });
    }).catch(() => {});
  }
})();
