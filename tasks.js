/* Aufgaben – Ansicht (aus dem früheren Dashboard). Daten: Store.recs mit "task:<id>" und "taskAreas" {list}.
   Daneben Navigation zwischen den Reitern Aufgaben und Üben. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  const FALLBACK_AREAS = [
    { id: "msam", name: "MSAM", order: 1, hue: 200, sections: [] },
    { id: "allgemein", name: "Allgemein", order: 2, hue: 150, sections: [] },
    { id: "vereine", name: "Vereine", order: 3, hue: 40, sections: [] },
    { id: "hkb", name: "HKB", order: 4, hue: 280, sections: [] },
    { id: "klassenbuch", name: "Klassenbuch", order: 5, hue: 15, sections: [] }
  ];

  let areas = FALLBACK_AREAS.slice();
  const tasks = new Map();
  let loaded = false, openId = null, pendingRender = false;
  let filter = store.get("aufgaben.filter", "all");
  let collapsed = store.get("aufgaben.collapsed", {});

  // ---------- Reiter ----------
  const TABS = { briefing: "Briefing", planer: "Planer", aufgaben: "Aufgaben", ueben: "Üben" };
  const VIEWS = { briefing: "view-briefing", planer: "view-planer", aufgaben: "view-tasks", ueben: "view-ueben" };
  function fitFrames() {
    document.querySelectorAll(".view:not([hidden]) .frame").forEach((f) => {
      const top = f.getBoundingClientRect().top + window.scrollY;
      f.style.height = Math.max(420, window.innerHeight - top - 4) + "px";
    });
  }
  function route() {
    const h = location.hash.slice(1);
    let tab = h === "neu" ? "aufgaben" : TABS[h] ? h : store.get("app.tab", "aufgaben");
    if (!TABS[tab]) tab = "aufgaben";
    store.set("app.tab", tab);
    for (const [k, id] of Object.entries(VIEWS)) $(id).hidden = k !== tab;
    const frame = tab === "briefing" || tab === "planer";
    document.body.classList.toggle("framed", frame);
    $("stats").hidden = tab !== "aufgaben"; $("pstats").hidden = tab !== "ueben";
    $("title").textContent = TABS[tab];
    document.querySelectorAll(".tab").forEach((a) => { if (a.getAttribute("href") === "#" + tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    if (frame) { const f = $(VIEWS[tab]).querySelector(".frame"); if (!f.src) f.src = f.dataset.src; window.scrollTo(0, 0); requestAnimationFrame(fitFrames); setTimeout(fitFrames, 120); }
    if (h === "neu") { history.replaceState(null, "", "#aufgaben"); setTimeout(() => $("new-title").focus(), 80); }
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", fitFrames);
  document.querySelectorAll(".frame").forEach((f) => f.addEventListener("load", fitFrames));

  // ---------- Daten ----------
  function load() {
    tasks.clear();
    const a = Store.recs.get("taskAreas");
    areas = (a && a.list && a.list.length ? a.list : FALLBACK_AREAS).slice().sort((x, y) => (x.order ?? 99) - (y.order ?? 99));
    for (const [k, v] of Store.recs) if (k.startsWith("task:")) tasks.set(k.slice(5), { ...v, _id: k.slice(5) });
  }
  const changed = () => window.dispatchEvent(new CustomEvent("store:change", { detail: { from: "tasks" } }));
  const saveTask = (t) => { const { _id, ...doc } = t; Store.set("task:" + _id, doc); changed(); };

  // ---------- Datum ----------
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const todayStr = () => iso(new Date());
  const dayDiff = (s) => Math.round((parse(s) - parse(todayStr())) / 86400000);
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }
  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  function dueLabel(s) {
    const n = dayDiff(s), d = parse(s);
    if (n === 0) return "Heute";
    if (n === 1) return "Morgen";
    if (n === -1) return "Gestern";
    const base = `${WD[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
    return d.getFullYear() !== new Date().getFullYear() ? base + String(d.getFullYear()).slice(2) : base;
  }
  function endOfWeekStr() { const d = new Date(); const day = d.getDay() || 7; d.setDate(d.getDate() + (7 - day)); return iso(d); }
  function renderHeader() {
    const d = new Date();
    $("eyebrow").textContent = `${d.toLocaleDateString("de-CH", { weekday: "long", day: "numeric", month: "long" })} · KW ${isoWeek(d)}`;
  }

  // ---------- Bereiche ----------
  const areaById = (id) => areas.find((a) => a.id === id);
  const areaName = (id) => areaById(id)?.name || id;
  const hueOf = (id) => areaById(id)?.hue ?? 160;
  function areaOptions(selected, emptyLabel) {
    let html = `<option value="">${esc(emptyLabel)}</option>`;
    for (const a of areas) {
      html += `<optgroup label="${esc(a.name)}"><option value="${esc(a.id)}::">${esc(a.name)}</option>`;
      for (const s of a.sections || []) html += `<option value="${esc(`${a.id}::${s.name}`)}">${esc(a.name)} · ${esc(s.name)}</option>`;
      html += `</optgroup>`;
    }
    return html.replace(`value="${esc(selected)}"`, `value="${esc(selected)}" selected`);
  }
  const splitArea = (v) => { if (!v) return { area: null, section: null }; const [a, s] = v.split("::"); return { area: a || null, section: s || null }; };
  const joinArea = (t) => (t.area ? `${t.area}::${t.section || ""}` : "");

  function suggest(title) {
    const text = ` ${title.toLowerCase()} `;
    let best = null, score = 0;
    const hit = (kw) => kw && text.includes(kw.toLowerCase());
    for (const a of areas) {
      for (const kw of [a.name, ...(a.keywords || [])]) if (hit(kw) && score < 1) { best = { area: a.id, section: null }; score = 1; }
      for (const s of a.sections || []) for (const kw of [s.name, ...(s.keywords || [])]) if (hit(kw) && score < 2) { best = { area: a.id, section: s.name }; score = 2; }
    }
    return best;
  }

  // ---------- Darstellung ----------
  const visible = (t) => filter === "all" || (filter === "inbox" ? !t.area : t.area === filter);

  function taskRow(t, opts = {}) {
    const done = t.status === "done";
    const p = t.priority && t.priority <= 2 ? ` p${t.priority}` : "";
    const meta = [];
    if (t.due && opts.showDue !== false) {
      const n = dayDiff(t.due);
      meta.push(`<span class="due${n < 0 && !done ? " overdue" : n === 0 ? " today" : ""}">${esc(dueLabel(t.due))}</span>`);
    }
    if (t.area && opts.showArea !== false) meta.push(`<span class="tag"><span class="dot" style="--h:${hueOf(t.area)}"></span>${esc(areaName(t.area))}${t.section ? " · " + esc(t.section) : ""}</span>`);
    if (t.source === "gmail") {
      const url = t.sourceUrl || (t.sourceRef ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(t.sourceRef)}` : null);
      meta.push(url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Mail öffnen</a>` : `<span>aus Mail</span>`);
    }
    if (t.delegatedTo) {
      const when = t.delegatedAt ? " · " + esc(new Date(t.delegatedAt).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit" })) : "";
      const to = { klassenbuch: "Klassenbuch", "pa-leonie": "PA Musiklehrer" }[t.delegatedTo] || t.delegatedTo;
      meta.push(`<span class="badge kb">An ${esc(to)} übergeben${when}</span>`);
    }
    const notes = t.notes && openId !== t._id ? `<div class="notes-preview">${esc(t.notes)}</div>` : "";
    const assign = opts.assign && !done ? `<div class="assign"><select data-assign="${esc(t._id)}" aria-label="Bereich zuordnen">${areaOptions("", "Bereich zuordnen …")}</select></div>` : "";
    return `<div class="task${done ? " done" : ""}${p}" data-id="${esc(t._id)}">
      <button class="check" data-toggle="${esc(t._id)}" aria-label="${done ? "Wieder öffnen" : "Erledigt"}: ${esc(t.title)}"></button>
      <div class="body">
        <button class="title" data-open="${esc(t._id)}" aria-expanded="${openId === t._id}">${esc(t.title)}</button>
        ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
        ${notes}${assign}
        ${openId === t._id ? editorHtml(t) : ""}
      </div>
    </div>`;
  }

  function editorHtml(t) {
    return `<form class="editor" data-edit="${esc(t._id)}">
      <label class="full">Titel<input id="ed-title" name="title" value="${esc(t.title)}" required></label>
      <label>Bereich<select name="area">${areaOptions(joinArea(t), "Inbox (ohne Bereich)")}</select></label>
      <label>Datum<input type="date" name="due" value="${esc(t.due || "")}"></label>
      <label>Priorität<select name="priority">
        ${[1, 2, 3, 4].map((n) => `<option value="${n}"${(t.priority || 4) === n ? " selected" : ""}>${["", "P1 · dringend", "P2 · hoch", "P3 · mittel", "P4 · normal"][n]}</option>`).join("")}
      </select></label>
      <label class="full">Notiz<textarea name="notes">${esc(t.notes || "")}</textarea></label>
      <div class="actions">
        <button class="btn" type="submit">Speichern</button>
        <button class="btn ghost" type="button" data-cancel>Abbrechen</button>
        <span class="spacer"></span>
        <button class="btn danger" type="button" data-delete="${esc(t._id)}">Löschen</button>
      </div>
    </form>`;
  }

  const byDueThenPrio = (a, b) => (a.due || "").localeCompare(b.due || "") || (a.priority || 4) - (b.priority || 4) || (a.createdAt || "").localeCompare(b.createdAt || "");
  const byPrioThenCreated = (a, b) => (a.priority || 4) - (b.priority || 4) || (a.createdAt || "").localeCompare(b.createdAt || "");

  function render() {
    if (document.activeElement?.closest?.("#view-tasks .editor")) { pendingRender = true; return; }
    pendingRender = false;
    renderHeader();
    const all = [...tasks.values()];
    const open = all.filter((t) => t.status !== "done");
    const today = todayStr(), eow = endOfWeekStr();

    const overdue = open.filter((t) => t.due && t.due < today).length;
    const dueToday = open.filter((t) => t.due === today).length;
    const doneToday = all.filter((t) => t.status === "done" && (t.completedAt || "").slice(0, 10) === today);
    $("stats").innerHTML = [["offen", open.length, false], ["heute fällig", dueToday, false], ["überfällig", overdue, overdue > 0], ["heute erledigt", doneToday.length, false]]
      .map(([l, n, a]) => `<div class="stat${a ? " alert" : ""}"><b>${n}</b><span class="label">${l}</span></div>`).join("");

    const inboxCount = open.filter((t) => !t.area).length;
    const chips = [{ id: "all", name: "Alle" }, ...areas.map((a) => ({ id: a.id, name: a.name, hue: a.hue }))];
    if (inboxCount) chips.push({ id: "inbox", name: `Inbox (${inboxCount})`, none: true });
    if (!chips.some((c) => c.id === filter)) filter = "all";
    $("filters").innerHTML = chips.map((c) => `<button class="filter" data-filter="${esc(c.id)}" aria-pressed="${filter === c.id}">${c.hue != null ? `<span class="dot" style="--h:${c.hue}"></span>` : c.none ? `<span class="dot none"></span>` : ""}${esc(c.name)}</button>`).join("");

    const vis = open.filter(visible);
    const inbox = vis.filter((t) => !t.area).sort(byDueThenPrio);
    $("inbox").hidden = !inbox.length;
    $("inbox-list").innerHTML = inbox.map((t) => taskRow(t, { assign: true })).join("");

    const dated = vis.filter((t) => t.area && t.due).sort(byDueThenPrio);
    const groups = [
      ["Überfällig", dated.filter((t) => t.due < today), "overdue"],
      ["Heute", dated.filter((t) => t.due === today), ""],
      ["Diese Woche", dated.filter((t) => t.due > today && t.due <= eow), ""],
      ["Später", dated.filter((t) => t.due > eow), ""]
    ].filter(([, l]) => l.length);
    $("mid-count").textContent = `${dated.length} mit Datum`;
    $("mid").innerHTML = groups.length
      ? groups.map(([name, list, cls]) => `<div class="group ${cls}"><div class="label"><span>${name}</span><span>${list.length}</span></div><div class="list">${list.map((t) => taskRow(t)).join("")}</div></div>`).join("")
      : `<p class="empty">${loaded ? "Keine Aufgaben mit Datum." : ""}</p>`;

    const undated = vis.filter((t) => t.area && !t.due);
    $("long-count").textContent = `${undated.length} ohne Datum`;
    $("long").innerHTML = areas.map((a) => {
      const list = undated.filter((t) => t.area === a.id);
      if (!list.length) return "";
      const bySection = new Map();
      for (const t of list.sort(byPrioThenCreated)) { const k = t.section || ""; if (!bySection.has(k)) bySection.set(k, []); bySection.get(k).push(t); }
      const order = ["", ...(a.sections || []).map((s) => s.name)];
      const keys = [...bySection.keys()].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
      const inner = keys.map((k) => `${k ? `<div class="section-name">${esc(k)}</div>` : ""}<div class="list">${bySection.get(k).map((t) => taskRow(t, { showArea: false })).join("")}</div>`).join("");
      return `<details class="area" data-area="${esc(a.id)}"${collapsed[a.id] ? "" : " open"}><summary><span class="dot" style="--h:${a.hue}"></span>${esc(a.name)}<span class="count">${list.length}</span></summary>${inner}</details>`;
    }).join("") || `<p class="empty">${loaded ? "Keine Aufgaben ohne Datum." : ""}</p>`;

    $("done-wrap").hidden = !doneToday.length;
    $("done-sum").textContent = `Heute erledigt (${doneToday.length})`;
    $("done-list").innerHTML = doneToday.map((t) => taskRow(t)).join("");

    const st = $("status");
    if (!loaded) { st.hidden = false; st.textContent = "Wird geladen …"; }
    else if (!all.length) { st.hidden = false; st.textContent = Store.account() ? "Noch keine Aufgaben. Schreib oben die erste hinein." : "Noch keine Aufgaben auf diesem Gerät. Unter «Einstellungen» anmelden, dann erscheinen sie hier."; }
    else st.hidden = true;

    const sel = $("new-area"); const v = sel.value;
    const sig = JSON.stringify(areas.map((a) => [a.id, a.name, (a.sections || []).map((s) => s.name)]));
    if (sel.dataset.sig !== sig) { sel.innerHTML = areaOptions("", "Inbox (ohne Bereich)"); sel.value = v; sel.dataset.sig = sig; }
  }

  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
    document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  }
  const newId = () => "d-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- Eingabe ----------
  $("capture").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("new-title").value.trim(); if (!title) return;
    const { area, section } = splitArea($("new-area").value);
    const id = newId();
    const t = { _id: id, title, notes: "", area, section, due: $("new-due").value || null, priority: 4, status: "open", source: "app", sourceRef: null, createdAt: new Date().toISOString(), completedAt: null };
    tasks.set(id, t); saveTask(t);
    $("new-title").value = ""; $("new-due").value = ""; $("new-area").value = ""; updateHint(); render();
    toast(area ? "Gespeichert" : "In der Inbox – Claude ordnet zu");
    $("new-title").focus();   // gleich die nächste Aufgabe
  });

  function updateHint() {
    const title = $("new-title").value.trim();
    const s = !$("new-area").value && title.length > 2 ? suggest(title) : null;
    $("hint").innerHTML = s
      ? `Vorschlag: <button type="button" class="chip-suggest" data-suggest="${esc(s.area + "::" + (s.section || ""))}">${esc(areaName(s.area))}${s.section ? " · " + esc(s.section) : ""} übernehmen</button>`
      : "Ohne Bereich landet die Aufgabe in der Inbox, Claude ordnet sie zu. Ohne Datum kommt sie in die Langzeitliste.";
  }
  $("new-title").addEventListener("input", updateHint);
  $("new-area").addEventListener("change", updateHint);
  $("hint").addEventListener("click", (e) => {
    const b = e.target.closest("[data-suggest]"); if (!b) return;
    $("new-area").value = b.dataset.suggest; updateHint(); $("new-title").focus();
  });

  $("filters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]"); if (!b) return;
    filter = b.dataset.filter; store.set("aufgaben.filter", filter); render();
  });
  document.addEventListener("toggle", (e) => {
    const d = e.target; if (!(d instanceof HTMLDetailsElement) || !d.dataset.area) return;
    collapsed[d.dataset.area] = !d.open; store.set("aufgaben.collapsed", collapsed);
  }, true);

  const view = $("view-tasks");
  view.addEventListener("click", (e) => {
    const tg = e.target.closest("[data-toggle]");
    if (tg) {
      const t = tasks.get(tg.dataset.toggle); if (!t) return;
      const done = t.status !== "done";
      Object.assign(t, { status: done ? "done" : "open", completedAt: done ? new Date().toISOString() : null }); saveTask(t); render();
      return;
    }
    const op = e.target.closest("[data-open]");
    if (op) { openId = openId === op.dataset.open ? null : op.dataset.open; render(); return; }
    if (e.target.closest("[data-cancel]")) { openId = null; document.activeElement?.blur(); render(); return; }
    const del = e.target.closest("[data-delete]");
    if (del) {
      if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Wirklich löschen?"; return; }
      const id = del.dataset.delete; tasks.delete(id); Store.set("task:" + id, null); changed(); openId = null; document.activeElement?.blur(); render();
    }
  });
  view.addEventListener("change", (e) => {
    const s = e.target.closest("[data-assign]"); if (!s || !s.value) return;
    const t = tasks.get(s.dataset.assign); if (!t) return;
    Object.assign(t, splitArea(s.value)); saveTask(t); render();
  });
  view.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-edit]"); if (!f) return;
    e.preventDefault();
    const t = tasks.get(f.dataset.edit); if (!t) return;
    const fd = new FormData(f);
    Object.assign(t, { title: String(fd.get("title")).trim() || t.title, notes: String(fd.get("notes") || ""), ...splitArea(fd.get("area")), due: fd.get("due") || null, priority: Number(fd.get("priority")) || 4 });
    saveTask(t); openId = null; document.activeElement?.blur(); render();
  });
  document.addEventListener("focusout", () => setTimeout(() => { if (pendingRender && !document.activeElement?.closest?.("#view-tasks .editor")) render(); }, 0));

  // ---------- Start ----------
  route(); render();
  window.addEventListener("store:ready", () => { load(); loaded = true; render(); });
  window.addEventListener("store:change", (e) => { if (e.detail && e.detail.from === "tasks") return; load(); render(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });
  setInterval(() => { if (!openId) render(); }, 5 * 60 * 1000); // Tageswechsel
})();
