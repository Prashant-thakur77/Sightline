#!/usr/bin/env python3
"""Find and download openly licensed music / SFX, and keep a license ledger.

  python fetch_audio.py search "tense ambient synth" --kind music [--max 120] [--min 30] [--src openverse,freesound,jamendo]
  python fetch_audio.py search "ui click" --kind sfx --max 2
  python fetch_audio.py get 3 7 12 --into audio/music      # numbers from the last search
  python fetch_audio.py ledger                               # print what needs attribution

Sources (no key needed for Openverse):
  openverse  api.openverse.org  - aggregates Freesound, Jamendo, ccMixter, Wikimedia; license filter
  freesound  needs FREESOUND_API_KEY (free); best for SFX; downloads the HQ preview mp3
  jamendo    needs JAMENDO_CLIENT_ID (free); full music tracks; many are NC -> flagged

License policy (safe for a public YouTube/Devpost video):
  cc0 / pdm          use freely, nothing owed
  by                 fine, attribution owed -> ledger only (the user adds credits himself)
  by-sa              fine for the audio, attribution owed; ledger
  *-nc*, *-nd*       skipped by default (--allow-nc to include); NC is risky with prize money
Everything downloaded is appended to audio/LICENSES.csv. Never put credits into the video,
description or repo yourself - the ledger is for the user.
"""
import csv, json, os, re, sys, urllib.parse
import requests

UA = {"User-Agent": "sightline-video/1.0"}
CACHE = ".audio_search.json"
LEDGER = "audio/LICENSES.csv"
OK = {"cc0", "pdm", "by", "by-sa"}


def norm_license(l):
    l = (l or "").lower()
    if "creative commons 0" in l or l in ("cc0", "zero") or "publicdomain/zero" in l:
        return "cc0"
    m = re.search(r"licenses/([a-z-]+)/", l)
    if m:
        return m.group(1)
    if "attribution noncommercial" in l:
        return "by-nc"
    if l.startswith("attribution"):
        return "by"
    return l


def openverse(q, kind, mn, mx, allow_nc):
    lic = "cc0,pdm,by,by-sa" + (",by-nc,by-nc-sa" if allow_nc else "")
    params = {"q": q, "license": lic, "page_size": 20,
              "category": "music" if kind == "music" else "sound_effect"}
    r = requests.get("https://api.openverse.org/v1/audio/", params=params, headers=UA, timeout=30)
    r.raise_for_status()
    out = []
    for a in r.json().get("results", []):
        d = (a.get("duration") or 0) / 1000
        if d and (d < mn or d > mx):
            continue
        out.append({"src": "openverse/" + (a.get("source") or ""), "id": a["id"], "title": a.get("title"),
                    "creator": a.get("creator"), "license": norm_license(a.get("license")),
                    "license_url": a.get("license_url"), "page": a.get("foreign_landing_url"),
                    "file": a.get("url"), "dur": round(d, 1)})
    return out


def freesound(q, kind, mn, mx, allow_nc):
    key = os.environ.get("FREESOUND_API_KEY")
    if not key:
        return []
    filt = f"duration:[{mn} TO {mx}]"
    params = {"query": q, "filter": filt, "page_size": 30, "token": key, "sort": "rating_desc",
              "fields": "id,name,username,license,duration,previews,url"}
    r = requests.get("https://freesound.org/apiv2/search/text/", params=params, headers=UA, timeout=30)
    r.raise_for_status()
    out = []
    for s in r.json().get("results", []):
        lic = norm_license(s.get("license"))
        out.append({"src": "freesound", "id": s["id"], "title": s["name"], "creator": s["username"],
                    "license": lic, "license_url": s.get("license"), "page": s.get("url"),
                    "file": s["previews"].get("preview-hq-mp3"), "dur": round(s.get("duration", 0), 1)})
    return out


def jamendo(q, kind, mn, mx, allow_nc):
    cid = os.environ.get("JAMENDO_CLIENT_ID")
    if not cid or kind != "music":
        return []
    params = {"client_id": cid, "format": "json", "limit": 30, "search": q, "audiodownload_allowed": "true",
              "include": "licenses", "durationbetween": f"{int(mn)}_{int(mx)}"}
    r = requests.get("https://api.jamendo.com/v3.0/tracks/", params=params, headers=UA, timeout=30)
    r.raise_for_status()
    out = []
    for t in r.json().get("results", []):
        lic = norm_license(t.get("license_ccurl"))
        out.append({"src": "jamendo", "id": t["id"], "title": t["name"], "creator": t["artist_name"],
                    "license": lic, "license_url": t.get("license_ccurl"), "page": t.get("shareurl"),
                    "file": t.get("audiodownload") or t.get("audio"), "dur": t.get("duration")})
    return out


def search(argv):
    q = argv[0]
    opt = lambda k, d: argv[argv.index(k) + 1] if k in argv else d
    kind = opt("--kind", "music")
    mn = float(opt("--min", 20 if kind == "music" else 0))
    mx = float(opt("--max", 400 if kind == "music" else 6))
    allow_nc = "--allow-nc" in argv
    srcs = opt("--src", "openverse,freesound,jamendo").split(",")
    res = []
    for name in srcs:
        try:
            res += globals()[name](q, kind, mn, mx, allow_nc)
        except Exception as e:
            print(f"[{name}] {e}", file=sys.stderr)
    res = [r for r in res if r["file"] and (allow_nc or r["license"] in OK)]
    res.sort(key=lambda r: (r["license"] != "cc0", r["license"] not in ("cc0", "pdm")))
    json.dump(res, open(CACHE, "w"), indent=1)
    for i, r in enumerate(res, 1):
        print(f"{i:3} [{r['license']:6}] {r['dur'] or '?':>6}s  {r['title'][:50]:50}  {r['creator'] or ''}  ({r['src']})")
        print(f"      {r['page']}")
    if not res:
        print("no results; broaden the query (genre + mood + instrument works best)")


def get(argv):
    res = json.load(open(CACHE))
    into = argv[argv.index("--into") + 1] if "--into" in argv else "audio"
    os.makedirs(into, exist_ok=True)
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    new = not os.path.exists(LEDGER)
    with open(LEDGER, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["file", "title", "creator", "license", "attribution_needed", "license_url", "page", "source"])
        for n in [int(x) for x in argv if x.isdigit()]:
            r = res[n - 1]
            ext = os.path.splitext(urllib.parse.urlparse(r["file"]).path)[1] or ".mp3"
            slug = re.sub(r"[^a-z0-9]+", "-", (r["title"] or str(r["id"])).lower()).strip("-")[:40]
            path = os.path.join(into, f"{slug}{ext}")
            data = requests.get(r["file"], headers=UA, timeout=120)
            data.raise_for_status()
            open(path, "wb").write(data.content)
            w.writerow([path, r["title"], r["creator"], r["license"], r["license"] not in ("cc0", "pdm"),
                        r["license_url"], r["page"], r["src"]])
            print(f"saved {path}  [{r['license']}]")


def ledger(_):
    if not os.path.exists(LEDGER):
        sys.exit("no ledger yet")
    for row in csv.DictReader(open(LEDGER)):
        if row["attribution_needed"] == "True":
            print(f"- \"{row['title']}\" by {row['creator']} ({row['license'].upper()}) {row['page']}")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("search", "get", "ledger"):
        sys.exit(__doc__)
    {"search": search, "get": get, "ledger": ledger}[sys.argv[1]](sys.argv[2:])
