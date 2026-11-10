#!/usr/bin/env python3
"""Mix VO + music + SFX into one master, ducked and loudness-normalised.

  python mix.py mix.json            -> master.wav (48 kHz stereo, -14 LUFS, -1.5 dBTP)
  python mix.py mix.json --mux video.mp4 final.mp4

mix.json:
{
  "duration": 182.5,
  "vo": "vo_fitted/vo_full.wav",
  "music": [
    {"file": "audio/music/bed.mp3", "start": 0, "in": 0, "gain_db": -6,
     "fade_in": 1.5, "fade_out": 3, "end": 182.5}
  ],
  "sfx": [{"file": "audio/sfx_track.wav", "at": 0, "gain_db": 0}],   # ONE track from sfx_synth.py track

  "duck": {"threshold": 0.03, "ratio": 8, "attack": 20, "release": 400},
  "target_lufs": -14
}

Music sits around -20 to -24 LUFS under speech after ducking; speech peaks stay on top.
Swells (no VO) let the music come back up on its own because the ducker only acts when VO plays.
"""
import json, subprocess, sys, re


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode:
        sys.exit(p.stderr[-3000:])
    return p.stderr


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    m = json.load(open(sys.argv[1]))
    D = float(m["duration"])
    inputs, chains, mus, fx = [], [], [], []
    idx = 0

    inputs += ["-i", m["vo"]]
    vo = idx; idx += 1
    chains.append(f"[{vo}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                  f"highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,"
                  f"apad=whole_dur={D},atrim=0:{D},asplit=2[vo_mix][vo_key]")

    for k, t in enumerate(m.get("music", [])):
        inputs += ["-ss", str(t.get("in", 0)), "-i", t["file"]]
        end = t.get("end", D)
        length = end - t.get("start", 0)
        f = (f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{length},asetpts=PTS-STARTPTS,"
             f"volume={t.get('gain_db', -6)}dB,afade=t=in:d={t.get('fade_in', 1)},"
             f"afade=t=out:st={max(0, length - t.get('fade_out', 2))}:d={t.get('fade_out', 2)},"
             f"adelay={int(t.get('start', 0) * 1000)}:all=1[mu{k}]")
        chains.append(f); mus.append(f"[mu{k}]"); idx += 1

    for k, s in enumerate(m.get("sfx", [])):
        inputs += ["-i", s["file"]]
        chains.append(f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                      f"volume={s.get('gain_db', -10)}dB,adelay={int(s['at'] * 1000)}:all=1[fx{k}]")
        fx.append(f"[fx{k}]"); idx += 1

    d = m.get("duck", {})
    if mus:
        chains.append(f"{''.join(mus)}amix=inputs={len(mus)}:normalize=0,apad=whole_dur={D},atrim=0:{D}[music]")
        chains.append(f"[music][vo_key]sidechaincompress=threshold={d.get('threshold', 0.03)}:ratio={d.get('ratio', 8)}:"
                      f"attack={d.get('attack', 20)}:release={d.get('release', 400)}:makeup=1[ducked]")
        bus = ["[vo_mix]", "[ducked]"] + fx
    else:
        chains.append("[vo_key]anullsink")
        bus = ["[vo_mix]"] + fx
    chains.append(f"{''.join(bus)}amix=inputs={len(bus)}:normalize=0,atrim=0:{D}[pre]")
    graph = ";".join(chains)

    run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", graph, "-map", "[pre]",
         "-ar", "48000", "-c:a", "pcm_s24le", "premaster.wav"])

    tgt = m.get("target_lufs", -14)
    st = run(["ffmpeg", "-hide_banner", "-i", "premaster.wav", "-af",
              f"loudnorm=I={tgt}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"])
    js = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", st, re.S).group(0))
    run(["ffmpeg", "-y", "-v", "error", "-i", "premaster.wav", "-af",
         f"loudnorm=I={tgt}:TP=-1.5:LRA=11:measured_I={js['input_i']}:measured_TP={js['input_tp']}:"
         f"measured_LRA={js['input_lra']}:measured_thresh={js['input_thresh']}:offset={js['target_offset']}:linear=true",
         "-ar", "48000", "-c:a", "pcm_s24le", "master.wav"])
    print(f"master.wav  (was {js['input_i']} LUFS -> {tgt})")

    if "--mux" in sys.argv:
        i = sys.argv.index("--mux")
        video, out = sys.argv[i + 1], sys.argv[i + 2]
        run(["ffmpeg", "-y", "-v", "error", "-i", video, "-i", "master.wav", "-map", "0:v", "-map", "1:a",
             "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", out])
        print(f"muxed -> {out}")


if __name__ == "__main__":
    main()
