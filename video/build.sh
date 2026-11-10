#!/usr/bin/env bash
# Rebuilds the Sightline film from the repo's own files. Nothing is typed by hand: numbers come from facts.py
# (evals/results) and live.py (what the live site said during capture), timing from the voice, product shots from
# capture.mjs against the live site.
#
#   video/build.sh                 numbers, voice, timeline, film.json, sound, picture, final files, checks
#   video/build.sh --capture [ids] first re-record product takes from the live site (C1..C13)
#   video/build.sh --no-render     stop before the picture (check words, timing, sound)
# Machine limits: one heavy job at a time (capture, TTS and the Remotion render never run together).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PY="${FILM_PY:-$HOME/.pyenv/versions/3.10.13/bin/python}"
OUT="${FILM_OUT:-$HOME/Videos/Sightline}"
mkdir -p "$OUT"
cd "$HERE"
CAPTURE="" ; NORENDER="" ; PICONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --capture) CAPTURE="all"; if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then CAPTURE="$2"; shift; fi ;;
    --no-render) NORENDER=1 ;;
    --picture-only) PICONLY=1 ;;   # reuse the voice, film.json and master.wav already built
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
step() { printf '\n== %s\n' "$*"; }

if [ -n "$CAPTURE" ]; then
  step "capture: $CAPTURE"
  if [ "$CAPTURE" = all ]; then node capture.mjs shots.json; else node capture.mjs shots.json --only "$CAPTURE"; fi
fi

if [ -z "$PICONLY" ]; then
step "numbers and words"
python3 facts.py
python3 live.py > /dev/null
python3 sr_voice.py
python3 narration.py

step "voice (cached: only changed lines are voiced)"
"$PY" tools/tts_takes.py narration.json --ref refs/narrator.wav --seeds 5 --out narration/takes 2>&1 | grep -v -E "Sampling|[Ww]arn" | tail -40

step "timeline and captions"
python3 make_film.py --skeleton
"$PY" tools/vo_timeline.py narration.json narration/takes --film film/film.json --write --out narration | tail -3
"$PY" tools/captions.py narration/vo_full.wav narration/script.txt --out film/public/captions | tail -1

step "the film as data"
python3 make_film.py
"$PY" tools/cues_from_film.py film/film.json --captions film/public/captions/captions.json --out sfx_cues.json | tail -1

step "sound"
python3 sfx_stamp.py > /dev/null
"$PY" tools/sfx_synth.py track sfx_cues.json audio/sfx_track.wav | tail -1
python3 music.py
python3 - <<'PY'
import json
d = json.load(open("film/film.json")); D = round(sum(s["duration"] for s in d["scenes"]), 3)
json.dump({"duration": D, "vo": "narration/vo_full.wav",
           "music": [{"file": "audio/music.wav", "start": 0, "in": 0, "gain_db": -5, "fade_in": 0.05, "fade_out": 2.5, "end": D}],
           "sfx": [{"file": "audio/sfx_track.wav", "at": 0, "gain_db": -2}],
           "duck": {"threshold": 0.02, "ratio": 3, "attack": 20, "release": 600}, "target_lufs": -14}, open("mix.json", "w"), indent=1)
PY
"$PY" tools/mix.py mix.json
[ -f master.wav ] && mv -f master.wav audio/master.wav; [ -f premaster.wav ] && mv -f premaster.wav audio/premaster.wav
[ -n "$NORENDER" ] && { echo "stopped before the picture, as asked"; exit 0; }
fi

step "picture"
cd film
npx remotion render src/index.ts Film out/film-pic.mp4 --codec=h264 --crf=16 --pixel-format=yuv420p --color-space=bt709 \
  --concurrency=2 --gl=swangle --log=error
cd "$HERE"

step "final files"
ffmpeg -y -v error -i film/out/film-pic.mp4 -i audio/master.wav -map 0:v -map 1:a -c:v copy -af volume=-0.4dB -c:a aac -b:a 256k -ar 48000 \
  -shortest -movflags +faststart "$OUT/sightline-film.part.mp4"
mv "$OUT/sightline-film.part.mp4" "$OUT/sightline-film-1080p.mp4"
ffmpeg -y -v error -i "$OUT/sightline-film-1080p.mp4" -vf "scale=-2:720:flags=lanczos,format=yuv420p" -c:v libx264 -crf 27 \
  -preset slow -c:a aac -b:a 128k -movflags +faststart "$OUT/sightline-film-720p.part.mp4"
mv "$OUT/sightline-film-720p.part.mp4" "$OUT/sightline-film-720p.mp4"
cp film/public/captions/film.srt "$OUT/sightline-film.srt"
ffmpeg -y -v error -ss 34 -i captures/C7.mp4 -frames:v 1 -vf "crop=1300:800:0:250" film/public/thumb-a.jpg
ffmpeg -y -v error -ss 14 -i captures/C4.mp4 -frames:v 1 -vf "crop=1300:800:0:200" film/public/thumb-b.jpg
(cd film && npx remotion still src/index.ts Thumbnail "$OUT/sightline-thumbnail.png" --log=error)
python3 deliverables.py > /dev/null

step "checks"
mkdir -p "$OUT/qa"
"$PY" tools/qa_video.py "$OUT/sightline-film-1080p.mp4" --limit 180 --scenes film/film.json --vo narration/vo_full.wav --sheet "$OUT/qa" \
  | tee "$OUT/qa/report.txt" || true
ls -la "$OUT"
