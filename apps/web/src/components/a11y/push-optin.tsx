'use client';

import { useEffect, useState } from 'react';
import { useAnnouncer } from './announcer';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** "Tell me on this phone": delivery, refund and helper updates as notifications. */
export function PushOptIn({ vapidKey }: { vapidKey: string | null }) {
  const { announce } = useAnnouncer();
  const [state, setState] = useState<'unsupported' | 'off' | 'on' | 'blocked' | 'working'>('off');

  useEffect(() => {
    if (!vapidKey || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') setState('blocked');
    navigator.serviceWorker.getRegistration('/sw.js').then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      if (sub) setState('on');
    });
  }, [vapidKey]);

  const enable = async () => {
    if (!vapidKey) return;
    setState('working');
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState('blocked');
        announce('Notifications are blocked in this browser. You can allow them in the browser settings.', { source: 'settings' });
        return;
      }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource });
      const res = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
      if (!res.ok) throw new Error();
      setState('on');
      announce("Done. I'll tell you on this device when a parcel arrives, a refund lands or your helper answers.", { source: 'settings' });
    } catch {
      setState('off');
      announce('I could not turn on notifications. Nothing changed.', { politeness: 'assertive', source: 'settings' });
    }
  };

  const disable = async () => {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/subscribe', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
    setState('off');
    announce('Notifications on this device are off.', { source: 'settings' });
  };

  if (state === 'unsupported') return <p className="hint">This browser can’t show notifications from the app. Updates are read out when you open it.</p>;
  if (state === 'blocked') return <p className="hint">Notifications are blocked in this browser. You can allow them in the browser’s site settings.</p>;
  return state === 'on' ? (
    <button type="button" className="btn" onClick={disable}>
      Stop notifications on this device
    </button>
  ) : (
    <button type="button" className="btn" onClick={enable} aria-disabled={state === 'working' || undefined}>
      {state === 'working' ? 'Turning on…' : 'Tell me on this device'}
    </button>
  );
}
