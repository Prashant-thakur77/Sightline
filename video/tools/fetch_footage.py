#!/usr/bin/env python3
"""Find and download real moving footage for the story (b-roll), with a licence ledger.

  python fetch_footage.py search "elderly man river monsoon india" [--src pexels,pixabay,wikimedia] [--min 5] [--max 40]
  python fetch_footage.py get 2 5 --into film/public/footage          # numbers from the last search
  python fetch_footage.py ledger

Sources (all allow use in a video without paying; check people/logos in each clip):
  pexels     PEXELS_API_KEY (free at pexels.com/api)    Pexels licence: free use, no attribution required
  pixabay    PIXABAY_API_KEY (free at pixabay.com/api)  Pixabay Content Licence: free use, no attribution required
  wikimedia  no key; CC0 / CC BY / CC BY-SA / public domain -> attribution owed for BY/BY-SA (ledger only)
Picks 1080p landscape files (falls back to the best available >= 720p). Search with the person, age, region and
action ("grandmother phone village himachal", "shopkeeper rain street india"), not abstract words.
Stock clips are stand-ins: never present a stock person as the real user (label "persona" or use the true-story note).
"""
import csv, json, os, re, sys
import requests

CACHE, LEDGER = ".footage_search.json", "footage/LICENSES.csv"
UA = {"User-Agent": "sightline-video/1.0"}


def pexels(q, mn, mx):
    k = os.environ.get("PEXELS_API_KEY")
    if not k:
        return []
    r = requests.get("https://api.pexels.com/videos/search", headers={"Authorization": k, **UA},
                     params={"query": q, "orientation": "landscape", "per_page": 20, "size": "medium"}, timeout=30)
    r.raise_for_status()
    out = []
    for v in r.json().get("videos", []):
        if not (mn <= v.get("duration", 0) <= mx):
            continue
        files = sorted([f for f in v["video_files"] if (f.get("height") or 0) >= 720 and f.get("file_type") == "video/mp4"],
                       key=lambda f: abs((f.get("height") or 0) - 1080))
        if files:
            out.append({"src": "pexels", "id": v["id"], "title": v["url"].rstrip("/").split("/")[-1], "creator": v["user"]["name"],
                        "license": "pexels", "page": v["url"], "file": files[0]["link"], "dur": v["duration"],
                        "size": f"{files[0]['width']}x{files[0]['height']}", "thumb": v.get("image")})
    return out


def pixabay(q, mn, mx):
    k = os.environ.get("PIXABAY_API_KEY")
    if not k:
        return []
    r = requests.get("https://pixabay.com/api/videos/", params={"key": k, "q": q, "per_page": 20, "safesearch": "true"}, headers=UA, timeout=30)
    r.raise_for_status()
    out = []
    for h in r.json().get("hits", []):
        if not (mn <= h.get("duration", 0) <= mx):
            continue
        vs = h["videos"]
        best = next((vs[s] for s in ("large", "medium") if vs.get(s, {}).get("url") and vs[s].get("height", 0) >= 720), None)
        if best:
            out.append({"src": "pixabay", "id": h["id"], "title": h.get("tags", ""), "creator": h.get("user"), "license": "pixabay",
                        "page": h["pageURL"], "file": best["url"], "dur": h["duration"], "size": f"{best['width']}x{best['height']}"})
    return out


def wikimedia(q, mn, mx):
    r = requests.get("https://commons.wikimedia.org/w/api.php", headers=UA, timeout=30, params={
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": 6, "gsrlimit": 20,
        "gsrsearch": f"filetype:video {q}", "prop": "imageinfo", "iiprop": "url|size|extmetadata"})
    r.raise_for_status()
    out = []
    for p in (r.json().get("query", {}).get("pages", {}) or {}).values():
        ii = (p.get("imageinfo") or [{}])[0]
        meta = ii.get("extmetadata", {})
        lic = (meta.get("LicenseShortName", {}).get("value") or "").lower()
        if not any(x in lic for x in ("cc0", "cc by", "public domain", "pd")) or "nc" in lic or "nd" in lic:
            continue
        dur = float(ii.get("duration") or 0)
        if dur and not (mn <= dur <= mx):
            continue
        if (ii.get("height") or 0) < 720:
            continue
        artist = re.sub("<[^>]+>", "", meta.get("Artist", {}).get("value", ""))[:60]
        out.append({"src": "wikimedia", "id": p["pageid"], "title": p["title"], "creator": artist, "license": lic,
                    "page": ii.get("descriptionurl"), "file": ii.get("url"), "dur": round(dur, 1), "size": f"{ii.get('width')}x{ii.get('height')}"})
    return out


def search(argv):
    q = argv[0]
    opt = lambda k, d: argv[argv.index(k) + 1] if k in argv else d
    mn, mx = float(opt("--min", 4)), float(opt("--max", 60))
    res = []
    for s in opt("--src", "pexels,pixabay,wikimedia").split(","):
        try:
            res += globals()[s](q, mn, mx)
        except Exception as e:
            print(f"[{s}] {e}", file=sys.stderr)
    json.dump(res, open(CACHE, "w"), indent=1)
    for i, r in enumerate(res, 1):
        print(f"{i:3} [{r['src']:9}] {r['dur']:>5}s {r['size']:>10}  {str(r['title'])[:48]:48}  {r['creator']}")
        print(f"      {r['page']}")
    if not res:
        print("nothing: set PEXELS_API_KEY / PIXABAY_API_KEY, or describe the shot more concretely")
    print("\nPreview the pages before choosing: look for the person, the place, the light, no logos, no watermark.")


def get(argv):
    res = json.load(open(CACHE))
    into = argv[argv.index("--into") + 1] if "--into" in argv else "footage"
    os.makedirs(into, exist_ok=True)
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    new = not os.path.exists(LEDGER)
    with open(LEDGER, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["file", "title", "creator", "license", "attribution_needed", "page", "source"])
        for n in [int(x) for x in argv if x.isdigit()]:
            r = res[n - 1]
            path = os.path.join(into, f"{r['src']}-{r['id']}.mp4")
            with requests.get(r["file"], headers=UA, stream=True, timeout=300) as d:
                d.raise_for_status()
                with open(path, "wb") as out:
                    for chunk in d.iter_content(1 << 20):
                        out.write(chunk)
            owed = r["src"] == "wikimedia" and "by" in r["license"]
            w.writerow([path, r["title"], r["creator"], r["license"], owed, r["page"], r["src"]])
            print(f"saved {path} ({r['size']}, {r['dur']}s, {r['license']})")
    print("Normalise before use: ffmpeg -i in.mp4 -vf scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30 -an -c:v libx264 -crf 17 out.mp4")


def ledger(_):
    for row in csv.DictReader(open(LEDGER)):
        if row["attribution_needed"] == "True":
            print(f"- {row['title']} by {row['creator']} ({row['license']}) {row['page']}")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("search", "get", "ledger"):
        sys.exit(__doc__)
    {"search": search, "get": get, "ledger": ledger}[sys.argv[1]](sys.argv[2:])
