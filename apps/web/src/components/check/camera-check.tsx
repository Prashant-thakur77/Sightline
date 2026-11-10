'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';
import { analyzeFrame, AutoCapture, GuidanceCoach, modeForShot, type GuidanceCode } from '@/lib/quality';
import { cue } from '@/lib/feedback';
import { readPhotoFile } from '@/lib/photo-file';

export type ShotKind = 'item' | 'label' | 'damage';

export interface Shot {
  kind: ShotKind;
  title: string;
  prompt: string;
  optional?: boolean;
}

export const SHOTS: Shot[] = [
  {
    kind: 'item',
    title: 'The whole item',
    prompt: 'Lay the item flat on a table or bed. Hold the phone about an arm’s length above it, screen facing you.',
  },
  {
    kind: 'label',
    title: 'The size tag',
    prompt: 'Find the size tag, usually inside the collar or on a side seam. Hold it about a hand’s width from the phone.',
  },
  {
    kind: 'damage',
    title: 'Any damage',
    prompt: 'If you feel a tear, a stain or a broken part, show it now. If not, press Skip this shot.',
    optional: true,
  },
];

export interface CapturedShot {
  kind: ShotKind;
  blob: Blob;
  url: string;
  source: 'camera' | 'upload' | 'demo';
}

type Phase = 'intro' | 'starting' | 'live' | 'review' | 'denied';

/** Frames are analysed at this size (long side × short side), about five times a second. */
const SAMPLE_LONG = 160;
const SAMPLE_SHORT = 120;
/** After a photo, a skip or the start, guidance and auto-capture wait while the next step is read out. */
const QUIET_MS = 3000;

export function CameraCheck({
  itemName,
  onSubmit,
  demoShots,
  busy,
  focusOnMount = false,
  onRetake,
  shots: shotList = SHOTS,
  introTitle = 'Check your parcel',
  intro,
  onCancel,
  cancelLabel,
}: {
  itemName: string;
  onSubmit: (shots: CapturedShot[]) => void;
  /** Sample photos for the guided demo: clearly labelled, never used silently. */
  demoShots?: { kind: ShotKind; url: string }[];
  busy?: boolean;
  /** Focus the heading on mount: used when the person comes back from a verdict ("Check again"). */
  focusOnMount?: boolean;
  /** The photos are being taken again: anything said about the last attempt no longer applies. */
  onRetake?: () => void;
  /** The photos to take, in order (default: the whole item, the size tag, any damage). */
  shots?: Shot[];
  /** Heading and words before the camera starts. */
  introTitle?: string;
  intro?: string;
  /** Leave without taking a photo (offered before the camera starts). */
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const { announce, stop } = useAnnouncer();
  const [phase, setPhase] = useState<Phase>('intro');
  const [index, setIndex] = useState(0);
  const [shots, setShots] = useState<CapturedShot[]>([]);
  const [guidance, setGuidance] = useState<GuidanceCode | null>(null);
  /** Edges the item is cut off at, for the visible edge marks. */
  const [edges, setEdges] = useState('');
  /** The last thing said, shown on the viewfinder. */
  const [caption, setCaption] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const coach = useRef(new GuidanceCoach());
  const auto = useRef(new AutoCapture());
  const lastTick = useRef(0);
  const quietUntil = useRef(0);
  const capturing = useRef(false);
  /** Front camera: left and right are swapped in the spoken directions. */
  const mirrored = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shot = shotList[index];
  /** A touch screen (a phone or tablet), where the photo field can open the device's own camera app. */
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    setTouch(window.matchMedia('(pointer: coarse)').matches);
  }, []);

  /** A new step: say nothing and take nothing until it has been read out. */
  const quiet = useCallback(() => {
    quietUntil.current = performance.now() + QUIET_MS;
    coach.current.reset();
    auto.current.reset();
    setCaption(null);
    setProgress(0);
  }, []);

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    coach.current = new GuidanceCoach();
    auto.current.reset();
    setGuidance(null);
    setEdges('');
    setCaption(null);
    setProgress(0);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  // Move focus only when the step changes (and on mount when asked). Comparing step keys keeps
  // this idempotent, so Strict Mode's second effect run never steals focus on first load.
  const lastStep = useRef<string | null>(focusOnMount ? null : 'intro:0');
  useEffect(() => {
    const step = `${phase}:${index}`;
    if (lastStep.current === step) return;
    lastStep.current = step;
    headingRef.current?.focus();
  }, [phase, index]);

  const addShot = useCallback(
    (s: CapturedShot) => {
      setShots((prev) => [...prev.filter((p) => p.kind !== s.kind), s]);
      const next = index + 1;
      if (next >= shotList.length) {
        stopCamera();
        setPhase('review');
        announce(`${shotList.length === 1 ? 'Photo taken' : 'All photos taken'}. Review what will be sent, then check it.`, { source: 'camera' });
      } else {
        quiet();
        setIndex(next);
        announce(`Got it. Next: ${shotList[next]!.title}. ${shotList[next]!.prompt}`, { source: 'camera' });
      }
    },
    [announce, index, quiet, shotList, stopCamera],
  );

  const captureFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !shot || capturing.current) return;
    capturing.current = true;
    try {
      const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
      // Stopped while the photo was being made: keep nothing.
      if (!blob || !streamRef.current) return;
      cue('capture');
      addShot({ kind: shot.kind, blob, url: URL.createObjectURL(blob), source: 'camera' });
    } finally {
      capturing.current = false;
    }
  }, [addShot, shot]);

  // The frame loop runs for the whole camera session, so it reads the current step through a ref.
  const live = useRef({ index, announce, capture: captureFrame, list: shotList });
  useEffect(() => {
    live.current = { index, announce, capture: captureFrame, list: shotList };
  }, [index, announce, captureFrame, shotList]);

  const loop = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }
    const now = performance.now();
    if (now - lastTick.current > 200) {
      lastTick.current = now;
      const portrait = video.videoHeight > video.videoWidth;
      const w = portrait ? SAMPLE_SHORT : SAMPLE_LONG;
      const h = portrait ? SAMPLE_LONG : SAMPLE_SHORT;
      const canvas = (sampleRef.current ??= document.createElement('canvas'));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const c = canvas.getContext('2d', { willReadFrequently: true })!;
      c.drawImage(video, 0, 0, w, h);
      const { index: step, announce: say, capture, list } = live.current;
      const mode = modeForShot(list[step]!.kind);
      const a = analyzeFrame(c.getImageData(0, 0, w, h).data, w, h, mode);
      setGuidance(a.code);
      setEdges(a.code === 'CUT' || a.code === 'EDGE_ONLY' ? a.edges.join(' ') : '');
      if (now < quietUntil.current) {
        auto.current.reset();
        setProgress(0);
      } else {
        const words = coach.current.update(a, mode, now, { mirrored: mirrored.current });
        if (words) {
          setCaption(words);
          say(words, { source: 'camera guidance' });
        }
        const before = auto.current.progress(now);
        const fire = auto.current.update(a.code, now);
        const after = auto.current.progress(now);
        setProgress(after);
        if (Math.floor(after * 4) > Math.floor(before * 4)) cue('tick');
        if (fire) void capture();
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const start = useCallback(async () => {
    setPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      mirrored.current = stream.getVideoTracks()[0]?.getSettings().facingMode === 'user';
      quiet();
      setPhase('live');
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
        rafRef.current = requestAnimationFrame(loop);
      });
      announce(
        `Camera on. ${shotList[index]!.title}. ${shotList[index]!.prompt} I'll tell you which way to move, and take the photo when it looks right.`,
        { source: 'camera' },
      );
    } catch {
      setPhase('denied');
      announce('I couldn’t use the camera. You can allow it in the browser’s settings and try again, or add photos instead.', {
        politeness: 'assertive',
        source: 'camera',
      });
    }
  }, [announce, index, loop, quiet, shotList]);

  // The whole item (the first photo) is what the check compares, so only the later photos can be skipped.
  const skip = useCallback(() => {
    if (!shot || index === 0) return;
    const next = index + 1;
    announce(`Skipped ${shot.title.toLowerCase()}.`, { source: 'camera' });
    if (next >= shotList.length) {
      stopCamera();
      setPhase('review');
    } else {
      quiet();
      setIndex(next);
      announce(`Next: ${shotList[next]!.title}. ${shotList[next]!.prompt}`, { source: 'camera' });
    }
  }, [announce, index, quiet, shot, shotList, stopCamera]);

  /** Why the last added photo was refused, shown under the photo field and tied to it. */
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file || !shot || reading) return;
    // Cleared first, so choosing the same file again still fires a change.
    input.value = '';
    setReading(true);
    const read = await readPhotoFile(file);
    setReading(false);
    if (!read.ok) {
      // Focus stays on the photo field, which is described by this message; the announcer says it now.
      setUploadError(read.say);
      cue('error');
      announce(read.say, { politeness: 'assertive', source: 'camera' });
      return;
    }
    setUploadError(null);
    addShot({ kind: shot.kind, blob: read.blob, url: URL.createObjectURL(read.blob), source: 'upload' });
  };

  const useDemo = async () => {
    if (!demoShots) return;
    stopCamera();
    try {
      const loaded: CapturedShot[] = [];
      for (const d of demoShots) {
        const res = await fetch(d.url);
        if (!res.ok) throw new Error();
        loaded.push({ kind: d.kind, blob: await res.blob(), url: d.url, source: 'demo' });
      }
      setShots(loaded);
      setPhase('review');
      announce('Loaded the demo parcel photos. Review what will be sent, then check it.', { source: 'camera' });
    } catch {
      announce('The demo photos could not load. You can start the camera or upload photos instead.', { politeness: 'assertive', source: 'camera' });
    }
  };

  const restart = () => {
    onRetake?.();
    setUploadError(null);
    setShots([]);
    setIndex(0);
    setPhase('intro');
  };

  if (phase === 'review') {
    return (
      <section aria-labelledby="review-h" className="grid gap-6">
        <h2 id="review-h" ref={headingRef} tabIndex={-1} className="text-[length:var(--step-2)]">
          Ready to check
        </h2>
        <p className="max-w-[var(--measure)]">
          I’ll send {shots.length === 1 ? 'one photo' : `${shots.length} photos`} to compare against the {itemName} you ordered.
          Location data is removed first. Nothing else is sent.
        </p>
        <ul className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-label="Photos to send">
          {shots.map((s) => (
            <li key={s.kind} className="grid gap-2">
              <img
                src={s.url}
                alt={`Your photo: ${shotList.find((x) => x.kind === s.kind)?.title.toLowerCase()}${s.source === 'demo' ? ' (demo photo)' : ''}`}
                className="w-full aspect-square object-cover rounded-[var(--radius-m)] border-2 border-[var(--line)]"
              />
              <span className="font-bold">
                {shotList.find((x) => x.kind === s.kind)?.title}
                {s.source === 'demo' ? ' · demo photo' : ''}
              </span>
            </li>
          ))}
        </ul>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary btn-xl"
            onClick={() => {
              if (!busy && shots.length > 0) onSubmit(shots);
            }}
            aria-disabled={busy || shots.length === 0 || undefined}
          >
            {busy ? 'Checking…' : 'Check it now'}
          </button>
          <button
            type="button"
            className="btn btn-xl"
            onClick={() => {
              if (!busy) restart();
            }}
            aria-disabled={busy || undefined}
          >
            {shotList.length === 1 ? 'Take it again' : 'Retake photos'}
          </button>
        </div>
      </section>
    );
  }

  // Photos added or skipped already (by camera or upload): the page says which photo is next.
  const started = index > 0 || shots.length > 0;
  return (
    <section aria-labelledby="cam-h" className="grid gap-5">
      <h2 id="cam-h" ref={headingRef} tabIndex={-1} className="text-[length:var(--step-2)]">
        {phase === 'intro' && !started ? introTitle : shotList.length === 1 ? shot?.title : `Photo ${index + 1} of ${shotList.length}: ${shot?.title}`}
      </h2>
      {phase === 'intro' && (
        <div className="grid gap-4 max-w-[var(--measure)]">
          <p>
            {started
              ? shot?.prompt
              : (intro ??
                'I’ll guide you with my voice while you point the camera, then take each photo for you. Three photos: the whole item, the size tag, and any damage. The size tag and damage photos can be skipped.')}
          </p>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-xl" onClick={start}>
              Start the camera
            </button>
            {demoShots && (
              <button type="button" className="btn btn-xl" onClick={useDemo}>
                Use the demo parcel photos
              </button>
            )}
            {onCancel && (
              <button type="button" className="btn btn-xl" onClick={onCancel}>
                {cancelLabel ?? 'Go back'}
              </button>
            )}
          </div>
        </div>
      )}

      {(phase === 'live' || phase === 'starting') && shot && (
        <div className="grid gap-4">
          <p className="max-w-[var(--measure)]">{shot.prompt}</p>
          <div className="viewfinder" data-guidance={guidance ?? 'none'}>
            <video ref={videoRef} playsInline muted aria-hidden="true" className="w-full h-full object-contain" />
            <div className="viewfinder-corners" aria-hidden="true" />
            <div className="viewfinder-edges" data-edges={edges} aria-hidden="true" />
            <div className="viewfinder-progress" aria-hidden="true" style={{ ['--p' as string]: progress }} />
            <p className="viewfinder-caption" aria-hidden="true">
              {caption ?? (phase === 'starting' ? 'Starting the camera…' : 'Looking…')}
            </p>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary btn-xl"
              onClick={() => {
                if (phase === 'live') void captureFrame();
              }}
              aria-disabled={phase !== 'live' || undefined}
            >
              Capture now
            </button>
            {index > 0 && (
              <button type="button" className="btn btn-xl" onClick={skip}>
                Skip this shot
              </button>
            )}
            <button
              type="button"
              className="btn btn-xl"
              onClick={() => {
                stopCamera();
                // Drop any guidance still queued in the app's own voice.
                stop();
                setPhase('intro');
                announce('Camera stopped. You can start it again, or add photos instead.', { source: 'camera' });
              }}
            >
              Stop
            </button>
          </div>
        </div>
      )}

      {phase === 'denied' && (
        <div className="grid gap-3 max-w-[var(--measure)]">
          <p className="card-refusal">
            I couldn’t use the camera. The browser may be blocking it: allow the camera for this site in the browser’s settings, then try again. Or
            take or choose a photo instead.
          </p>
          {started && <p>{shot?.prompt}</p>}
          <p>
            <button type="button" className="btn btn-primary" onClick={start}>
              Try the camera again
            </button>
          </p>
        </div>
      )}

      {phase !== 'live' && shots.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-[length:var(--step-1)]">Photos so far</h3>
          <ul className="shots-so-far">
            {shots.map((s) => (
              <li key={s.kind}>
                <img src={s.url} alt="" />
                <span>{shotList.find((x) => x.kind === s.kind)?.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(phase === 'live' || phase === 'denied' || phase === 'intro') && shot && (
        <div className="grid gap-2 justify-items-start">
          <label htmlFor="upload" className="font-bold">
            {phase === 'intro' && touch
              ? `Or use your phone's camera app: photo of ${shot.title.toLowerCase()}`
              : `Or take or choose a photo of ${shot.title.toLowerCase()}`}
          </label>
          <input
            id="upload"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => void onUpload(e)}
            className="file-input"
            aria-invalid={uploadError ? true : undefined}
            aria-describedby={uploadError ? 'upload-error' : undefined}
          />
          {uploadError && (
            <p id="upload-error" className="field-error">
              <span aria-hidden="true">✕ </span>
              {uploadError}
            </p>
          )}
          {phase !== 'live' && index > 0 && (
            <button type="button" className="btn" onClick={skip}>
              Skip this shot
            </button>
          )}
          {phase === 'denied' && demoShots && (
            <button type="button" className="btn" onClick={useDemo}>
              Use the demo parcel photos
            </button>
          )}
        </div>
      )}
    </section>
  );
}
