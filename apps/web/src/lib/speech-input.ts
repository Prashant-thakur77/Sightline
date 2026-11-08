'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Speech to text. Uses Deepgram streaming when the server can mint a short-lived token, and the
 * browser's own speech recognition otherwise. Push-to-talk: start() on key/button down,
 * stop() on release; the final transcript is delivered through onFinal.
 */

type Engine = 'deepgram' | 'browser' | 'none';

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function browserRecognizer(): SpeechRecognitionLike | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return C ? new C() : null;
}

export interface SpeechInput {
  engine: Engine;
  listening: boolean;
  interim: string;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

export function useSpeechInput(onFinal: (text: string) => void, onError?: (message: string) => void): SpeechInput {
  const [engine, setEngine] = useState<Engine>('none');
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const finalText = useRef('');
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const media = useRef<{ stream: MediaStream; recorder: MediaRecorder } | null>(null);
  const cancelled = useRef(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    let alive = true;
    fetch('/api/voice/token', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { engine?: string } | null) => {
        if (!alive) return;
        if (j?.engine === 'deepgram') setEngine('deepgram');
        else setEngine(browserRecognizer() ? 'browser' : 'none');
      })
      .catch(() => alive && setEngine(browserRecognizer() ? 'browser' : 'none'));
    return () => {
      alive = false;
    };
  }, []);

  const finish = useCallback(() => {
    setListening(false);
    const text = finalText.current.trim();
    finalText.current = '';
    setInterim('');
    if (!cancelled.current && text) onFinalRef.current(text);
  }, []);

  const startBrowser = useCallback(() => {
    const r = browserRecognizer();
    if (!r) {
      onError?.('Voice input is not available in this browser. You can type instead.');
      return;
    }
    rec.current = r;
    r.lang = document.documentElement.lang || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let fin = '';
      let mid = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) fin += res[0]!.transcript;
        else mid += res[0]!.transcript;
      }
      finalText.current = fin;
      setInterim((fin + ' ' + mid).trim());
      if (mid) finalText.current = (fin + ' ' + mid).trim();
    };
    r.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') onError?.('I could not hear the microphone. Check its permission, or type instead.');
    };
    r.onend = finish;
    r.start();
    setListening(true);
  }, [finish, onError]);

  const startDeepgram = useCallback(async () => {
    const res = await fetch('/api/voice/token', { method: 'POST' });
    const j = (await res.json()) as { engine: string; token?: string; url?: string };
    if (j.engine !== 'deepgram' || !j.token || !j.url) return startBrowser();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const socket = new WebSocket(j.url, ['bearer', j.token]);
    ws.current = socket;
    socket.onmessage = (m) => {
      try {
        const data = JSON.parse(String(m.data)) as { channel?: { alternatives?: { transcript?: string }[] }; is_final?: boolean };
        const t = data.channel?.alternatives?.[0]?.transcript ?? '';
        if (!t) return;
        if (data.is_final) finalText.current = `${finalText.current} ${t}`.trim();
        setInterim(data.is_final ? finalText.current : `${finalText.current} ${t}`.trim());
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = finish;
    socket.onerror = () => onError?.('Voice input dropped. You can type instead.');
    socket.onopen = () => {
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(ev.data);
      };
      recorder.start(200);
      media.current = { stream, recorder };
      setListening(true);
    };
  }, [finish, onError, startBrowser]);

  const start = useCallback(async () => {
    if (listening) return;
    cancelled.current = false;
    finalText.current = '';
    setInterim('');
    try {
      if (engine === 'deepgram') await startDeepgram();
      else startBrowser();
    } catch {
      onError?.('I could not start the microphone. You can type instead.');
    }
  }, [engine, listening, onError, startBrowser, startDeepgram]);

  const stop = useCallback(() => {
    if (rec.current) {
      rec.current.stop();
      rec.current = null;
    }
    if (media.current) {
      media.current.recorder.stop();
      media.current.stream.getTracks().forEach((t) => t.stop());
      media.current = null;
      setTimeout(() => {
        if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: 'CloseStream' }));
      }, 250);
    }
  }, []);

  const cancel = useCallback(() => {
    cancelled.current = true;
    stop();
    ws.current?.close();
    setListening(false);
    setInterim('');
  }, [stop]);

  return { engine, listening, interim, start, stop, cancel };
}
