// Study any reference film on YouTube from inside the browser (no downloads; works where yt-dlp is blocked).
// How: open the watch page in the browser pane, emulate a 1920x1080 viewport, then with the page's JS tool:
//   1. paste this whole file once and run it (it stores itself in sessionStorage so later pages only need
//      `eval(sessionStorage.__lib)` after each navigation);
//   2. `await __prep()`        -> title, length (waits out / skips ads)
//   3. `await __sheet(0,45,16)`-> a 4x4 contact sheet of 0-45 s shown full-screen: take a screenshot
//      (run it again with other ranges for the middle and the end)
//   4. `await __startAn(4)`    -> plays the film at 4x, silently, measuring audio bands + picture motion
//      (poll `__an.done`; a JS call times out after ~45 s, so wait in several calls)
//   5. `__summ()`              -> cuts, average shot, loudness, bass ("kick" 35-110 Hz = music bed), voice band,
//      air (6-14 kHz), beat-strength + tempo guess, silence share, brightness, and a 3-second timeline.
// Reading it: a steady kick band near the voice band = music bed under narration; kick ~25 dB under voice = no
// music; beatStrength > 1.25 = a clear beat; motionMax ~0 for long stretches = static holds; lum > 200 = white look.
// The transcript (when the film has captions): click "Show transcript" under the description and read
// ytd-transcript-segment-renderer elements. Numbers are relative (measured through the browser at 4x), so compare
// films with each other, not with LUFS targets.
(() => {
const lib = `
window.__prep = async () => { await new Promise(r=>setTimeout(r,3000)); const pr=window.ytInitialPlayerResponse; const L=+pr.videoDetails.lengthSeconds; for(let k=0;k<60;k++){ const v=document.querySelector('video'); if(!document.querySelector('.ad-showing') && v && Math.abs(v.duration-L)<3) break; document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button')?.click(); if(v){v.muted=true; if(document.querySelector('.ad-showing')) try{v.currentTime=v.duration-0.1}catch(e){}} await new Promise(r=>setTimeout(r,1000)); } return {title:pr.videoDetails.title, author:pr.videoDetails.author, len:L, views:pr.videoDetails.viewCount}; };
window.__sheet = async (t0, t1, n=16) => { const v=document.querySelector('video'); v.muted=true; v.pause(); const W=480,H=270,cols=4; const c=document.createElement('canvas'); c.width=W*cols; c.height=H*Math.ceil(n/cols); const g=c.getContext('2d'); for(let i=0;i<n;i++){ const t=t0+(t1-t0)*i/(n-1); await new Promise(res=>{const h=()=>{v.removeEventListener('seeked',h);setTimeout(res,450)}; v.addEventListener('seeked',h); v.currentTime=t; setTimeout(res,4000);}); const x=(i%cols)*W,y=Math.floor(i/cols)*H; g.drawImage(v,x,y,W,H); g.fillStyle='rgba(0,0,0,.7)'; g.fillRect(x,y,70,26); g.fillStyle='#ff0'; g.font='bold 18px sans-serif'; g.fillText(t.toFixed(1)+'s',x+5,y+19);} document.getElementById('__ov')?.remove(); const o=document.createElement('div'); o.id='__ov'; o.style.cssText='position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;background:#000'; const im=document.createElement('img'); im.src=c.toDataURL('image/jpeg',0.8); im.style.cssText='width:100vw;height:100vh;object-fit:contain;display:block'; o.appendChild(im); document.body.appendChild(o); return 'sheet'; };
window.__startAn = async (rate=4) => {
 const v=document.querySelector('video'); v.pause(); document.getElementById('__ov')?.remove();
 const ctx=new AudioContext(); const src=ctx.createMediaElementSource(v);
 const an=ctx.createAnalyser(); an.fftSize=4096; an.smoothingTimeConstant=0;
 const g=ctx.createGain(); g.gain.value=0; src.connect(an); an.connect(g); g.connect(ctx.destination);
 await ctx.resume();
 const fb=new Float32Array(an.frequencyBinCount), tb=new Float32Array(an.fftSize);
 const cv=document.createElement('canvas'); cv.width=48; cv.height=27; const cg=cv.getContext('2d',{willReadFrequently:true});
 let prev=null; const rows=[]; const binHz=ctx.sampleRate/an.fftSize;
 const band=(lo,hi)=>{let s=0,n=0; for(let i=Math.floor(lo/binHz);i<Math.min(fb.length,hi/binHz);i++){s+=Math.pow(10,fb[i]/10);n++} return 10*Math.log10(s/Math.max(1,n)+1e-15)};
 v.currentTime=0; v.playbackRate=rate; v.muted=false; v.volume=1; await v.play();
 window.__an={rows, done:false, rate};
 const tick=()=>{ if(v.ended || v.currentTime>=v.duration-0.3){window.__an.done=true; v.pause(); return;}
   an.getFloatFrequencyData(fb); an.getFloatTimeDomainData(tb);
   let rms=0; for(let i=0;i<tb.length;i++) rms+=tb[i]*tb[i]; rms=Math.sqrt(rms/tb.length);
   cg.drawImage(v,0,0,48,27); const d=cg.getImageData(0,0,48,27).data; let diff=0,lum=0,sat=0;
   for(let i=0;i<d.length;i+=4){const r=d[i],gg=d[i+1],b=d[i+2]; if(prev) diff+=Math.abs(r-prev[i])+Math.abs(gg-prev[i+1])+Math.abs(b-prev[i+2]); lum+=(r+gg+b)/3; const mx=Math.max(r,gg,b),mn=Math.min(r,gg,b); sat+=mx?(mx-mn)/mx:0;}
   prev=d.slice(); const np=d.length/4;
   rows.push([v.currentTime, 20*Math.log10(rms+1e-9), band(35,110),band(110,300),band(300,3000),band(3000,6000),band(6000,14000), diff/np/3, lum/np, sat/np]);
   setTimeout(tick, 12);
 };
 tick(); return 'started';
};
window.__summ = () => {
 const R=window.__an.rows; const D=R[R.length-1][0]; const per={};
 for(const r of R){const k=Math.floor(r[0]/3)*3; (per[k]=per[k]||[]).push(r);}
 const avg=(a,i)=>a.reduce((s,r)=>s+r[i],0)/a.length;
 const lines=Object.keys(per).map(Number).sort((a,b)=>a-b).map(k=>{const a=per[k]; return [k, avg(a,1).toFixed(0), avg(a,2).toFixed(0), avg(a,4).toFixed(0), avg(a,6).toFixed(0), Math.max(...a.map(r=>r[7])).toFixed(0), avg(a,8).toFixed(0), avg(a,9).toFixed(2)].join(' ')});
 const cuts=[]; for(let i=1;i<R.length;i++){ if(R[i][7]>38 && (!cuts.length || R[i][0]-cuts[cuts.length-1]>0.5)) cuts.push(+R[i][0].toFixed(1)); }
 const on=[]; for(let i=1;i<R.length;i++){ on.push(Math.max(0,R[i][2]-R[i-1][2])+Math.max(0,R[i][6]-R[i-1][6])); }
 const dt=(R[R.length-1][0]-R[0][0])/R.length; let best=[0,0], tot=0, cnt=0;
 for(let lagS=0.33; lagS<=1.0; lagS+=0.01){const L=Math.round(lagS/dt); if(L<1) continue; let s=0; for(let i=L;i<on.length;i++) s+=on[i]*on[i-L]; s/=(on.length-L); tot+=s; cnt++; if(s>best[0]) best=[s,lagS];}
 const qs=(i,p)=>{const a=R.map(r=>r[i]).sort((x,y)=>x-y); return a[Math.floor(p*(a.length-1))].toFixed(0)};
 const quiet=R.filter(r=>r[1]<-45).length/R.length;
 return {dur:D.toFixed(1), cuts:cuts.length, avgShot:(D/(cuts.length+1)).toFixed(1), cutTimes:cuts.join(','), bpmGuess:(60/best[1]).toFixed(0), beatStrength:(best[0]/(tot/cnt)).toFixed(2), loud_p10_50_90:[qs(1,.1),qs(1,.5),qs(1,.9)].join('/'), kick_p10_50_90:[qs(2,.1),qs(2,.5),qs(2,.9)].join('/'), voice_p50:qs(4,.5), air_p10_50_90:[qs(6,.1),qs(6,.5),qs(6,.9)].join('/'), silentFrac:quiet.toFixed(2), lum_p50:qs(8,.5), per3s:'t loud kick voice air motionMax lum sat\\n'+lines.join('\\n')};
};`;
sessionStorage.__lib = lib; eval(lib); return 'film analyzer loaded';
})();
