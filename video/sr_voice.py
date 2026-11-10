#!/usr/bin/env python3
"""The screen reader's own voice: eSpeak NG (the engine NVDA ships with), driven through libespeak-ng, reading the
app's real announcements word for word (taken from the live capture's Speech Viewer, data/live.json or the app copy).
Played in the film after the narrator stops, never over her, and labelled "Screen reader voice: eSpeak NG".

  python3 video/sr_voice.py   -> video/narration/sr/<id>.wav (22.05 kHz mono)
"""
import ctypes
import json
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
LINES = {
    # the app's own announcement after "yeah, probably fine" (captured in C3's Speech Viewer)
    "sr_refuse": "Okay, I'll wait. Nothing is paid. Say 'confirm purchase' when you're ready.",
    # the verdict heading the check page announces (live.json "verdict", first sentence)
    "sr_check": None,
}
live = json.loads((HERE / "data" / "live.json").read_text())
LINES["sr_check"] = live["verdict"].split(". ")[0].rstrip(".") + "."

lib = ctypes.CDLL("libespeak-ng.so.1")
SR = lib.espeak_Initialize(1, 500, None, 0)  # AUDIO_OUTPUT_RETRIEVAL
buf: list[bytes] = []
CB = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)


def cb(wav, n, events):
    if n > 0:
        buf.append(ctypes.string_at(wav, n * 2))
    return 0


cbf = CB(cb)
lib.espeak_SetSynthCallback(cbf)
lib.espeak_SetVoiceByName(b"en-us")
lib.espeak_SetParameter(1, 235, 0)   # espeakRATE (words per minute): brisk, like a screen reader, still followable
lib.espeak_SetParameter(3, 50, 0)    # pitch
out = HERE / "narration" / "sr"
out.mkdir(parents=True, exist_ok=True)
for k, text in LINES.items():
    buf.clear()
    t = text.encode()
    lib.espeak_Synth(t, len(t) + 1, 0, 0, 0, 0x1000, None, None)  # espeakCHARS_AUTO|... synchronous retrieval
    lib.espeak_Synchronize()
    with wave.open(str(out / f"{k}.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(buf))
    print(k, f"{sum(len(b) for b in buf) / 2 / SR:.2f}s", text)
(out / "lines.json").write_text(json.dumps(LINES, indent=1))
