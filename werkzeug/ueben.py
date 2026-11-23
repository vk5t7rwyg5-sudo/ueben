#!/usr/bin/env python3
"""ueben.py – Python-Version des Mac-Werkzeugs `ueben` für Cloud-Läufe (Linux).

Liest und schreibt die Ende-zu-Ende-verschlüsselten Daten der App «Zentrale».
Zugangsdaten nur aus Umgebungsvariablen: UEBEN_EMAIL, UEBEN_PASSWORD.
Benötigt: pip install cryptography

  ueben.py pull [ziel.json]       → {tasks, taskAreas, meta, plans, briefs, areas, pieces, practice, proben}
  ueben.py patch <felder.json>    → {"task:<id>": {feld: wert}, "del": ["task:<id>"]} in aktuelle Datensätze mischen
  ueben.py push <änderungen.json> → {"set": {...}, "del": [...]} ganze Datensätze schreiben
"""
import base64, hashlib, json, os, sys, unicodedata, urllib.error, urllib.request
from datetime import datetime, timezone

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    sys.exit("Modul «cryptography» fehlt: pip install cryptography")

API = "https://www.adrianpopp.ch/_functions/kb/"
PART = 300000


def fail(m):
    sys.stderr.write(m + "\n")
    sys.exit(1)


def call(action, body, allow401=False):
    req = urllib.request.Request(API + action, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "ueben-werkzeug"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        if e.code == 401 and allow401:
            return None
        if e.code == 429:
            fail("Server ausgelastet (rate). In einer Minute nochmals.")
        fail(f"Server-Fehler {e.code}")
    except Exception as e:  # Netzwerk
        fail(f"Server nicht erreichbar: {e}")


def gcm_open(b64, key):
    d = base64.b64decode(b64)
    return AESGCM(key).decrypt(d[:12], d[12:], None)


def gcm_seal(data, key):
    n = os.urandom(12)
    return base64.b64encode(n + AESGCM(key).encrypt(n, data, None)).decode()


email = os.environ.get("UEBEN_EMAIL", "").strip().lower()
pw = os.environ.get("UEBEN_PASSWORD", "")
if not email or not pw:
    fail("Anmeldung fehlgeschlagen: UEBEN_EMAIL / UEBEN_PASSWORD nicht gesetzt.")
salt = "ueben-v1:" + email
acct = hashlib.sha256(salt.encode()).hexdigest()[:40]

found = None
variants = []
bases = [pw, pw.strip()]
if len(pw.strip()) > 1 and pw.strip()[0] == pw.strip()[-1] and pw.strip()[0] in "\"'":
    bases.append(pw.strip()[1:-1])
for base in bases:
    for v in (base, unicodedata.normalize("NFC", base), unicodedata.normalize("NFD", base)):
        if v not in variants:
            variants.append(v)
for v in variants:
    b = hashlib.pbkdf2_hmac("sha256", v.encode(), salt.encode(), 600000, 64)
    a = b[:32].hex()
    r = call("login", {"acct": acct, "auth": a}, allow401=True)
    if r and r.get("wrapPw"):
        found = (a, b[32:], r["wrapPw"])
        break
if not found:
    hints = [f"Konto-ID {acct[:8]}… (aus UEBEN_EMAIL)"]
    if pw != pw.strip(): hints.append("Passwort hat Leerzeichen am Rand")
    if pw.strip()[:1] in "\"'<": hints.append("Passwort beginnt mit Anführungszeichen oder <")
    fail("Anmeldung fehlgeschlagen: E-Mail/Passwort passen zu keinem Konto. " + "; ".join(hints))
auth, kek, wrap = found
try:
    KEY = gcm_open(wrap, kek)
except Exception:
    fail("Schlüssel konnte nicht geöffnet werden.")
CRED = {"acct": acct, "auth": auth}


def allowed(k):
    return k in ("areas", "taskAreas", "proben") or k.startswith(("piece:", "day:", "task:", "meta:", "plan:", "brief:"))


def pull_all():
    since, groups = 0, {}
    while True:
        r = call("pull", {**CRED, "since": since, "snap": 1})
        for it in r.get("items") or []:
            k, parts, part, rev = it["key"], it.get("parts") or 1, it.get("part") or 0, it.get("rev") or 0
            since = max(since, rev)
            g = groups.get(k) or {"parts": parts, "p": {}, "del": False, "rev": 0}
            if g["parts"] != parts:
                g = {"parts": parts, "p": {}, "del": False, "rev": g["rev"]}
            g["p"][part] = it.get("data")
            g["del"] = bool(it.get("del"))
            g["rev"] = max(g["rev"], rev)
            groups[k] = g
        if r.get("more") is not True:
            break
    recs = {}
    for k, g in groups.items():
        if g["del"] or len(g["p"]) != g["parts"]:
            continue
        try:
            recs[k] = json.loads(gcm_open("".join(g["p"].get(i) or "" for i in range(g["parts"])), KEY))
        except Exception:
            pass
    return recs


def push_all(set_, dels):
    items = []
    for k, v in set_.items():
        if not allowed(k):
            fail(f"Unbekannter Schlüssel: {k}")
        enc = gcm_seal(json.dumps(v, ensure_ascii=False).encode(), KEY)
        n = max(1, -(-len(enc) // PART))
        for p in range(n):
            items.append({"key": k, "part": p, "parts": n, "data": enc[p * PART:(p + 1) * PART]})
    for k in dels:
        if not allowed(k):
            fail(f"Unbekannter Schlüssel: {k}")
        items.append({"key": k, "part": 0, "parts": 1, "del": True})
    if not items:
        fail("Keine Änderungen.")
    for i in range(0, len(items), 40):
        call("push", {**CRED, "items": items[i:i + 40]})


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            j = json.load(f)
        assert isinstance(j, dict)
        return j
    except Exception:
        fail(f"Datei nicht lesbar oder kein JSON-Objekt: {path}")


args = sys.argv
cmd = args[1] if len(args) > 1 else ""
if cmd == "pull":
    out = {"pulledAt": datetime.now(timezone.utc).isoformat(), "areas": None, "pieces": {}, "practice": {},
           "taskAreas": None, "tasks": {}, "meta": {}, "plans": {}, "briefs": {}, "proben": None}
    for k, v in pull_all().items():
        if k == "proben": out["proben"] = (v or {}).get("list")
        elif k == "areas": out["areas"] = (v or {}).get("list")
        elif k == "taskAreas": out["taskAreas"] = (v or {}).get("list")
        else:
            for pre, f in (("piece:", "pieces"), ("day:", "practice"), ("task:", "tasks"), ("meta:", "meta"), ("plan:", "plans"), ("brief:", "briefs")):
                if k.startswith(pre):
                    out[f][k[len(pre):]] = v
                    break
    data = json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True)
    if len(args) > 2:
        with open(args[2], "w", encoding="utf-8") as f:
            f.write(data)
        print(f"{len(out['tasks'])} Aufgaben, {len(out['pieces'])} Stücke, {len(out['practice'])} Übetage → {args[2]}")
    else:
        print(data)
elif cmd == "push":
    if len(args) < 3: fail("Aufruf: ueben.py push <änderungen.json>")
    j = read_json(args[2])
    s, d = j.get("set") or {}, j.get("del") or []
    push_all(s, d)
    print(f"{len(s)} gespeichert, {len(d)} gelöscht.")
elif cmd == "patch":
    if len(args) < 3: fail("Aufruf: ueben.py patch <felder.json>")
    j, recs = read_json(args[2]), pull_all()
    s, created = {}, 0
    for k, fields in j.items():
        if k == "del": continue
        if not isinstance(fields, dict): fail(f"{k}: erwartet ein Objekt mit Feldern")
        cur = recs.get(k)
        if not isinstance(cur, dict):
            cur, created = {}, created + 1
        cur.update(fields)
        s[k] = cur
    d = j.get("del") or []
    push_all(s, d)
    print(f"{len(s) - created} geändert, {created} neu, {len(d)} gelöscht.")
else:
    fail("Aufruf: ueben.py pull [datei.json] | patch <felder.json> | push <änderungen.json>")
