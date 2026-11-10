#!/usr/bin/env node
// Scripted, crisp screen capture of a web app, with a smooth fake cursor and a click log
// that the Remotion <ScreenShot> component turns into zoom-to-action camera moves.
//
//   npm i -D playwright && npx playwright install chromium   (once)
//   node capture.mjs shots.json [--only S3,S4] [--headed]
// Run it from the project: copy it to video/ and `npm i -D playwright` there (imports resolve from the script's folder).
// CHROME_PATH=/usr/bin/google-chrome to use a system Chrome. Optional keys: "dpr": 1.25 with "viewport": [1920,1080]
// records a 1536x864 CSS layout at exactly 1920x1080 px; "fakeMic": "line.wav" feeds a user line to getUserMedia.
//
// shots.json
// {
//   "base": "http://localhost:3000",
//   "viewport": [1920, 1080],
//   "colorScheme": "dark",
//   "shots": [
//     {"id": "S2", "steps": [
//       {"goto": "/"}, {"hold": 1200},
//       {"click": "text=Run attestation"},
//       {"type": ["input[name=q]", "late payments from Q3"]},
//       {"hover": "[data-demo=proof-card]"},
//       {"scroll": 600},
//       {"waitFor": "text=Stored on chain", "timeout": 180000},
//       {"zoom": "[data-demo=result]"},          // log a zoom target without clicking
//       {"hold": 2500}
//     ]}
//   ]
// }
//
// Output: captures/<id>.mp4 (30 fps CFR, H.264) + captures/<id>.events.json
// events: [{t, type: "click"|"type"|"hover"|"zoom"|"scroll", x, y, box:{x,y,w,h}}], t in seconds from clip start.
//
// Things this cannot film (wallet extensions, OS dialogs, phones, hardware): put them in the
// human shot plan instead (see references/capture.md).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const cfgPath = process.argv[2];
if (!cfgPath) { console.error("usage: node capture.mjs shots.json [--only S1,S2] [--headed]"); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const [W, H] = cfg.viewport || [1920, 1080];
const OUT = cfg.out || "captures";
fs.mkdirSync(OUT, { recursive: true });

const CURSOR = `
(() => {
  if (window.__cursor) return;
  const mk = () => {
    const c = document.createElement('div');
    c.id = '__democursor';
    c.innerHTML = '<svg width="46" height="46" viewBox="0 0 28 28"><path d="M4 2 L4 22 L9.5 17 L13 25 L16.5 23.5 L13 15.8 L20.5 15.8 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {position:'fixed', left:'0', top:'0', zIndex:2147483647, pointerEvents:'none',
      transform:'translate(-200px,-200px)', transition:'transform 0ms', filter:'drop-shadow(0 2px 3px rgba(0,0,0,.35))'});
    document.documentElement.appendChild(c);
    let p = JSON.parse(sessionStorage.getItem('__cur') || '[-200,-200]');
    c.style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px)';
    window.__cursor = {
      move(x, y, ms) {
        c.style.transition = 'transform ' + ms + 'ms cubic-bezier(.22,.9,.24,1)';
        c.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)';
        sessionStorage.setItem('__cur', JSON.stringify([x - 4, y - 2]));
      },
      click(x, y) {
        const r = document.createElement('div');
        Object.assign(r.style, {position:'fixed', left:(x-18)+'px', top:(y-18)+'px', width:'36px', height:'36px',
          borderRadius:'50%', border:'3px solid rgba(255,255,255,.95)', boxShadow:'0 0 0 2px rgba(0,0,0,.25)',
          zIndex:2147483646, pointerEvents:'none', transform:'scale(.3)', opacity:'1',
          transition:'transform 450ms cubic-bezier(.2,.8,.2,1), opacity 450ms'});
        document.documentElement.appendChild(r);
        requestAnimationFrame(() => { r.style.transform = 'scale(1.4)'; r.style.opacity = '0'; });
        setTimeout(() => r.remove(), 600);
      }
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mk); else mk();
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GPU in headless Chrome: SwiftShader drags heavy pages to ~10 fps; ANGLE/GL gives 50-60.
const browser = await chromium.launch({ headless: !process.argv.includes("--headed"), executablePath: process.env.CHROME_PATH || undefined,
  args: ["--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars",
    ...(cfg.fakeMic ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${path.resolve(cfg.fakeMic)}%noloop`] : [])] });

for (const shot of cfg.shots) {
  if (only && !only.includes(shot.id)) continue;
  // dpr lets a 1536x864 desktop layout fill exactly 1920x1080 ("viewport": [1920,1080], "dpr": 1.25)
  const dpr = cfg.dpr || 1;
  const ctx = await browser.newContext({ viewport: { width: Math.round(W / dpr), height: Math.round(H / dpr) }, deviceScaleFactor: dpr,
    colorScheme: cfg.colorScheme || "dark", reducedMotion: "no-preference" });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const dir = path.join(OUT, `${shot.id}_frames`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const f = path.join(dir, `${String(frames.length).padStart(6, "0")}.jpg`);
    fs.writeFileSync(f, Buffer.from(data, "base64"));
    frames.push({ f, t: metadata.timestamp });
    try { await cdp.send("Page.screencastFrameAck", { sessionId }); } catch {}
  });

  const events = [];
  let t0 = null;
  const now = () => Date.now() / 1000 - (t0 ?? Date.now() / 1000);
  let cur = [W * 0.8, H * 0.85];
  const glide = async (x, y, ms = 650) => {
    await page.evaluate(([x, y, ms]) => window.__cursor && window.__cursor.move(x, y, ms), [x, y, ms]);
    await page.mouse.move(x, y, { steps: Math.max(8, Math.round(ms / 25)) });
    await sleep(ms + 60);
    cur = [x, y];
  };
  const boxOf = async (sel) => {
    const el = page.locator(sel).first();
    await el.waitFor({ state: "visible", timeout: 30000 });
    await el.evaluate((n) => n.scrollIntoView({ behavior: "smooth", block: "center" }));
    // aim only once smooth scrolling has settled (position unchanged between two reads)
    let b = await el.boundingBox(), prev = null;
    for (let i = 0; i < 40 && (!prev || Math.abs(prev.y - b.y) > 0.5); i++) { prev = b; await sleep(60); b = await el.boundingBox(); }
    return { el, b, x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  let started = false;
  for (const step of shot.steps) {
    if (step.goto) {
      await page.goto(new URL(step.goto, cfg.base).toString(), { waitUntil: "networkidle" }).catch(() => {});
      await page.evaluate(([x, y]) => window.__cursor && window.__cursor.move(x, y, 0), cur);
      if (!started) {
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
        t0 = Date.now() / 1000; started = true;
      }
      continue;
    }
    if (!started) {
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
      t0 = Date.now() / 1000; started = true;
    }
    if (step.hold) await sleep(step.hold);
    if (step.wait) await sleep(step.wait);
    if (step.waitFor) await page.locator(step.waitFor).first().waitFor({ state: "visible", timeout: step.timeout || 60000 });
    if (step.scroll) { await page.mouse.wheel(0, step.scroll); events.push({ t: now(), type: "scroll", dy: step.scroll }); await sleep(step.scrollMs || 900); }
    if (step.hover || step.zoom) {
      const { b, x, y } = await boxOf(step.hover || step.zoom);
      if (step.hover) await glide(x, y, step.ms);
      events.push({ t: now(), type: step.hover ? "hover" : "zoom", x, y, box: { x: b.x, y: b.y, w: b.width, h: b.height } });
      await sleep(step.after ?? 500);
    }
    if (step.click) {
      const { el, b, x, y } = await boxOf(step.click);
      await glide(x, y, step.ms);
      events.push({ t: now(), type: "click", x, y, box: { x: b.x, y: b.y, w: b.width, h: b.height } });
      await page.evaluate(([x, y]) => window.__cursor.click(x, y), [x, y]);
      await el.click();
      await sleep(step.after ?? 700);
    }
    if (step.type) {
      const [sel, text] = step.type;
      const { el, b, x, y } = await boxOf(sel);
      await glide(x, y, step.ms);
      await el.click();
      events.push({ t: now(), type: "type", x, y, box: { x: b.x, y: b.y, w: b.width, h: b.height }, text });
      await page.keyboard.type(text, { delay: step.delay ?? 42 });
      await sleep(step.after ?? 500);
    }
    if (step.press) { await page.keyboard.press(step.press); await sleep(step.after ?? 500); }
  }
  await sleep(300);
  await cdp.send("Page.stopScreencast").catch(() => {});
  await ctx.close();

  if (!frames.length) { console.error(`${shot.id}: no frames captured`); continue; }
  frames.sort((a, b) => a.t - b.t); // at high rates frames can arrive out of order
  // frames arrive only on repaint: hold each until the next, then resample to 30 fps CFR
  const end = Date.now() / 1000;
  const list = path.join(dir, "list.ffconcat");
  let s = "ffconcat version 1.0\n";
  frames.forEach((fr, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(fr.t + 0.5, t0 + (end - t0));
    s += `file '${path.resolve(fr.f)}'\nduration ${Math.max(0.001, next - fr.t).toFixed(4)}\n`;
  });
  s += `file '${path.resolve(frames.at(-1).f)}'\n`;
  fs.writeFileSync(list, s);
  const lead = Math.max(0, frames[0].t - t0);
  const out = path.join(OUT, `${shot.id}.mp4`);
  const tmp = path.join(OUT, `${shot.id}.part.mp4`);
  try {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `fps=30,scale=${W}:${H}:flags=lanczos:in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709`,
      "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-movflags", "+faststart", tmp]);
  } catch (e) { console.error(`${shot.id}: encode failed, frames kept in ${dir}`); continue; }
  fs.renameSync(tmp, out);
  for (const e of events) {
    e.t = +(e.t - lead).toFixed(3);
    if (dpr !== 1) { e.x *= dpr; e.y *= dpr; if (e.box) for (const k of ["x", "y", "w", "h"]) e.box[k] *= dpr; }
  }
  fs.writeFileSync(path.join(OUT, `${shot.id}.events.json`), JSON.stringify({ width: W, height: H, events }, null, 1));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${shot.id}: ${out} (${frames.length} paints, ${events.length} events)`);
}
await browser.close();
