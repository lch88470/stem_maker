// Utility: API wrapper and toasts
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(await res.text() || 'Request failed');
  return res.json();
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

// Theme: default to OS; allow override
const themeToggle = document.getElementById('themeToggle');
(function initTheme(){
  const osLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const saved = localStorage.getItem('themeOverride');
  const theme = saved || (osLight ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);
  if (themeToggle) themeToggle.checked = theme === 'light';
  if (!saved && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', (e) => {
      if (!localStorage.getItem('themeOverride')) {
        const next = e.matches ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        if (themeToggle) themeToggle.checked = next === 'light';
      }
    });
  }
})();
if (themeToggle) {
  themeToggle.addEventListener('change', () => {
    const theme = themeToggle.checked ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('themeOverride', theme);
    uiClick(300);
  });
}

// UI audio clicks
let uiSoundEnabled = true;
let uiCtx;
function ensureUICtx() { if (!uiCtx) uiCtx = new (window.AudioContext || window.webkitAudioContext)(); }
function uiClick(freq = 220) {
  if (!uiSoundEnabled) return;
  ensureUICtx();
  const o = uiCtx.createOscillator(); const g = uiCtx.createGain();
  o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.03;
  o.connect(g).connect(uiCtx.destination); o.start(); o.stop(uiCtx.currentTime + 0.08);
}
function uiChime() {
  if (!uiSoundEnabled) return;
  ensureUICtx();
  const o = uiCtx.createOscillator(); const g = uiCtx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(660, uiCtx.currentTime); o.frequency.linearRampToValueAtTime(990, uiCtx.currentTime + 0.12);
  g.gain.value = 0.03; o.connect(g).connect(uiCtx.destination); o.start(); o.stop(uiCtx.currentTime + 0.18);
}
function uiError() {
  if (!uiSoundEnabled) return;
  ensureUICtx();
  const o = uiCtx.createOscillator(); const g = uiCtx.createGain();
  o.type = 'sawtooth'; o.frequency.value = 120; g.gain.value = 0.04;
  o.connect(g).connect(uiCtx.destination); o.start(); o.stop(uiCtx.currentTime + 0.2);
}

// UI controls
const accentPicker = document.getElementById('accentPicker');
const uiSoundToggle = document.getElementById('uiSoundToggle');
accentPicker.addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--accent', e.target.value);
  uiClick(250);
  const any = Object.keys(channels)[0]; if (any) renderWaveform(channels[any].buffer);
});
uiSoundToggle.addEventListener('change', (e) => { uiSoundEnabled = e.target.checked; uiClick(300); });

// Transport elements
const btnPlay = document.getElementById('btnPlay');
const btnStop = document.getElementById('btnStop');
const btnLoop = document.getElementById('btnLoop');
const btnRecord = document.getElementById('btnRecord');
const timeDisplay = document.getElementById('timeDisplay');

// Timeline elements
const waveCanvas = document.getElementById('waveCanvas');
const playheadEl = document.getElementById('playhead');
const loopShade = document.getElementById('loopShade');
const loopStartEl = document.getElementById('loopStart');
const loopEndEl = document.getElementById('loopEnd');
const jog = document.getElementById('jog');

// Sidebar elements
const libraryList = document.getElementById('libraryList');
const snapList = document.getElementById('snapList');
const snapName = document.getElementById('snapName');
const saveSnap = document.getElementById('saveSnap');
const masterVU = document.getElementById('masterVU');
const spectrum = document.getElementById('spectrum');
const masterGainEl = document.getElementById('masterGain');
const zipAll = document.getElementById('zipAll');

// Search
const openSearch = document.getElementById('openSearch');
const closeSearch = document.getElementById('closeSearch');
const searchDrawer = document.getElementById('searchDrawer');
const queryEl = document.getElementById('query');
const searchBtn = document.getElementById('searchBtn');
const resultsEl = document.getElementById('results');

// Processing modal
const processingModal = document.getElementById('processingModal');
const processFill = document.getElementById('processFill');
const stepFetch = document.getElementById('step-fetch');
const stepSep = document.getElementById('step-sep');
const stepFinal = document.getElementById('step-final');
const rackMarquee = document.getElementById('rackMarquee');

// Hotkeys
const btnHotkeys = document.getElementById('btnHotkeys');
const hotkeys = document.getElementById('hotkeys');
const closeHotkeys = document.getElementById('closeHotkeys');
btnHotkeys.addEventListener('click', () => { hotkeys.classList.toggle('hidden'); });
closeHotkeys.addEventListener('click', () => { hotkeys.classList.add('hidden'); });

// Audio graph
let audioCtx;
let master = {
  gain: null,
  comp: null,
  analyser: null,
  spectrumAnalyser: null,
  mediaDest: null,
  rec: null,
  recChunks: [],
  recActive: false
};
let auxA = { convolver: null, size: 1.6, return: null }; // Reverb
let auxB = { delay: null, feedback: null, hiCut: null, return: null }; // Delay

let songId = null;
let songTitle = '';
let stemsList = [];
let channels = {}; // stemName -> state

// Transport state
let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;
let duration = 0;
let loopEnabled = false;
let loopIn = 0;
let loopOut = 0; // 0 means not set

// Aux UI
const auxAReturn = document.getElementById('auxAReturn');
const auxASize = document.getElementById('auxASize');
const auxBReturn = document.getElementById('auxBReturn');
const auxBTime = document.getElementById('auxBTime');
const auxBFeedback = document.getElementById('auxBFeedback');
const auxBHiCut = document.getElementById('auxBHiCut');

// Ensure audio
function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  master.gain = audioCtx.createGain(); master.gain.gain.value = parseFloat(masterGainEl.value);
  master.comp = audioCtx.createDynamicsCompressor();
  master.comp.threshold.value = -18; master.comp.knee.value = 20; master.comp.ratio.value = 3; master.comp.attack.value = 0.005; master.comp.release.value = 0.25;
  master.analyser = audioCtx.createAnalyser(); master.analyser.fftSize = 2048;
  master.spectrumAnalyser = audioCtx.createAnalyser(); master.spectrumAnalyser.fftSize = 2048;

  master.mediaDest = audioCtx.createMediaStreamDestination();

  // Aux buses
  auxA.convolver = audioCtx.createConvolver();
  auxA.return = audioCtx.createGain(); auxA.return.gain.value = parseFloat(auxAReturn.value);
  auxB.delay = audioCtx.createDelay(1.0); auxB.delay.delayTime.value = parseFloat(auxBTime.value);
  auxB.feedback = audioCtx.createGain(); auxB.feedback.gain.value = parseFloat(auxBFeedback.value);
  auxB.hiCut = audioCtx.createBiquadFilter(); auxB.hiCut.type = 'lowpass'; auxB.hiCut.frequency.value = parseFloat(auxBHiCut.value);
  auxB.return = audioCtx.createGain(); auxB.return.gain.value = parseFloat(auxBReturn.value);

  // Delay feedback loop
  auxB.delay.connect(auxB.hiCut);
  auxB.hiCut.connect(auxB.feedback);
  auxB.feedback.connect(auxB.delay);

  // Aux returns to master
  auxA.convolver.connect(auxA.return).connect(master.comp);
  auxB.delay.connect(auxB.return).connect(master.comp);

  // Master routing: comp -> gain -> speakers/rec/scope
  master.comp.connect(master.gain);
  master.gain.connect(audioCtx.destination);
  master.gain.connect(master.mediaDest);
  master.gain.connect(master.analyser);
  master.gain.connect(master.spectrumAnalyser);

  buildReverbImpulse(auxA.size);

  requestAnimationFrame(drawMasterVU);
  requestAnimationFrame(drawSpectrum);
}

function buildReverbImpulse(sizeSec) {
  const rate = audioCtx.sampleRate;
  const length = Math.floor(rate * Math.max(0.2, Math.min(3.0, sizeSec)));
  const impulse = audioCtx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5); // simple decaying noise
    }
  }
  auxA.convolver.buffer = impulse;
}

// Visuals
function drawMasterVU() {
  if (!master.analyser) return requestAnimationFrame(drawMasterVU);
  const ctx = masterVU.getContext('2d');
  const w = masterVU.width = masterVU.clientWidth;
  const h = masterVU.height = masterVU.clientHeight;
  const data = new Uint8Array(master.analyser.frequencyBinCount);
  master.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / data.length);
  const level = Math.min(1, rms * 4);
  ctx.clearRect(0,0,w,h);
  const grd = ctx.createLinearGradient(0,0,w,0);
  grd.addColorStop(0,"#28f7a0"); grd.addColorStop(0.6,"#ffb84d"); grd.addColorStop(1,"#ff6868");
  ctx.fillStyle = grd; ctx.fillRect(0,0,w*level,h);
  requestAnimationFrame(drawMasterVU);
}
function drawSpectrum() {
  if (!master.spectrumAnalyser) return requestAnimationFrame(drawSpectrum);
  const ctx = spectrum.getContext('2d');
  const w = spectrum.width = spectrum.clientWidth;
  const h = spectrum.height = 80;
  const data = new Uint8Array(master.spectrumAnalyser.frequencyBinCount);
  master.spectrumAnalyser.getByteFrequencyData(data);
  ctx.clearRect(0,0,w,h);
  const bins = 64;
  const step = Math.floor(data.length / bins);
  for (let i = 0; i < bins; i++) {
    let v = 0; for (let j = 0; j < step; j++) v += data[i*step + j] || 0;
    v /= step;
    const barH = (v/255) * h;
    ctx.fillStyle = `hsl(${180 + i*1.2}, 70%, 60%)`;
    const bw = w / bins - 2;
    ctx.fillRect(i*(bw+2), h - barH, bw, barH);
  }
  requestAnimationFrame(drawSpectrum);
}

// Reusable knob factory
function createKnob({label, min, max, step = 0.01, value, unit = '', toDisplay = (v)=>v, toArc = (v)=> (v-min)/(max-min), onChange, onCommit}) {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex'; wrap.style.flexDirection = 'column'; wrap.style.alignItems = 'center';

  const knob = document.createElement('div'); knob.className = 'knob';
  const cap = document.createElement('div'); cap.className = 'cap';
  const center = document.createElement('div'); center.className = 'center';
  knob.appendChild(cap); knob.appendChild(center);

  const lab = document.createElement('div'); lab.className = 'knob-label'; lab.textContent = label;
  const val = document.createElement('div'); val.className = 'knob-value';

  let current = value;
  function setVisual(v) {
    const ratio = Math.max(0, Math.min(1, toArc(v)));
    const angle = -140 + ratio * 280;
    knob.style.setProperty('--angle', `${angle}deg`);
    knob.style.setProperty('--arc', `${ratio*100}%`);
    val.textContent = `${toDisplay(v)}${unit}`;
  }
  function clamp(v) { return Math.min(max, Math.max(min, v)); }
  function commit() { onCommit && onCommit(current); }
  function change(v) { current = clamp(parseFloat((Math.round(v/step)*step).toFixed(4))); setVisual(current); onChange && onChange(current); }
  setVisual(current);

  let dragging = false, startY = 0, startV = current;
  knob.addEventListener('pointerdown', (e) => { dragging = true; startY = e.clientY; startV = current; knob.setPointerCapture(e.pointerId); });
  knob.addEventListener('pointermove', (e) => { if (!dragging) return; const dy = startY - e.clientY; const delta = (max - min) * (dy / 200); change(startV + delta); });
  knob.addEventListener('pointerup', () => { if (!dragging) return; dragging = false; commit(); uiClick(260); });

  knob.tabIndex = 0;
  knob.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { change(current + step); commit(); uiClick(260); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { change(current - step); commit(); uiClick(240); }
    else if (e.key === 'Home') { change(min); commit(); }
    else if (e.key === 'End') { change(max); commit(); }
  });

  wrap.appendChild(knob); wrap.appendChild(lab); wrap.appendChild(val);
  return {el: wrap, set: change, get: ()=>current};
}

// Channel creation
const mixer = document.getElementById('mixer');
function createChannel(stemName) {
  const ch = document.createElement('div'); ch.className = 'channel'; ch.tabIndex = 0; ch.dataset.stem = stemName;

  const top = document.createElement('div'); top.className = 'top';
  const name = document.createElement('div'); name.className = 'name'; name.textContent = stemName;
  const led = document.createElement('div'); led.className = 'led-dot off';
  top.appendChild(name); top.appendChild(led);

  const miniWave = document.createElement('canvas'); miniWave.className = 'mini-wave';

  const metersWrap = document.createElement('div'); metersWrap.style.display = 'flex'; metersWrap.style.gap = '6px'; metersWrap.style.alignItems='center';
  const vuWrap = document.createElement('div'); vuWrap.className = 'vu-vertical';
  const vuBar = document.createElement('div'); vuBar.className = 'bar';
  const vuClip = document.createElement('div'); vuClip.className = 'vu-clip';
  vuWrap.appendChild(vuBar); vuWrap.appendChild(vuClip);
  metersWrap.appendChild(vuWrap);

  const knobBank = document.createElement('div'); knobBank.className = 'knob-bank';
  const knobRow2 = document.createElement('div'); knobRow2.className = 'knob-row-2';

  const faderWrap = document.createElement('div'); faderWrap.className = 'fader-wrap';
  const soloBtn = document.createElement('button'); soloBtn.className = 'btn btn-xs ghost'; soloBtn.dataset.action='solo'; soloBtn.setAttribute('aria-pressed','false'); soloBtn.textContent='Solo';
  const muteBtn = document.createElement('button'); muteBtn.className = 'btn btn-xs ghost'; muteBtn.dataset.action='mute'; muteBtn.setAttribute('aria-pressed','false'); muteBtn.textContent='Mute';
  const fader = document.createElement('input'); fader.className = 'fader'; fader.type='range'; fader.min=0; fader.max=3; fader.step=0.01; fader.value=1;

  faderWrap.appendChild(soloBtn); faderWrap.appendChild(fader); faderWrap.appendChild(muteBtn);
  const dbScale = document.createElement('div'); dbScale.className = 'db-scale'; dbScale.textContent = '-∞ dB … 0 dB … +9 dB';

  const footer = document.createElement('div'); footer.className = 'footer';
  const dl = document.createElement('a'); dl.className = 'dl'; dl.href = `/download/${encodeURIComponent(songId)}/${encodeURIComponent(stemName)}`; dl.download = stemName; dl.textContent = 'Download';
  footer.appendChild(dl);

  ch.appendChild(top);
  ch.appendChild(miniWave);
  ch.appendChild(metersWrap);
  ch.appendChild(knobBank);
  ch.appendChild(knobRow2);
  ch.appendChild(faderWrap);
  ch.appendChild(dbScale);
  ch.appendChild(footer);
  mixer.appendChild(ch);

  return {ch, miniWave, vuBar, vuClip, fader, soloBtn, muteBtn, led, knobBank, knobRow2};
}

function updateLED(ledEl, mode) {
  ledEl.classList.remove('off', 'on', 'green', 'red');
  if (!mode) ledEl.classList.add('off');
  else ledEl.classList.add('on', mode);
}

function meterChannel(analyser, elBar, elClip) {
  const data = new Uint8Array(analyser.frequencyBinCount);
  let peak = 0; let lastClip = 0;
  function draw() {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 5);
    elBar.style.height = `${(level * 100).toFixed(1)}%`;

    // Simple clip detection: if any sample near full-scale recently
    const now = performance.now();
    let clipped = false;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs((data[i]-128)/128);
      if (v > 0.98) { clipped = true; break; }
    }
    if (clipped) lastClip = now;
    elClip.classList.toggle('on', now - lastClip < 500);

    requestAnimationFrame(draw);
  }
  draw();
}

// Load a stem
async function loadStem(stemName) {
  ensureAudio();
  const url = `/audio/${encodeURIComponent(songId)}/${encodeURIComponent(stemName)}`;
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(buf);

  const preGain = audioCtx.createGain(); preGain.gain.value = 1;
  const lowEQ = audioCtx.createBiquadFilter(); lowEQ.type = "lowshelf"; lowEQ.frequency.value = 200; lowEQ.gain.value = 0;
  const midEQ = audioCtx.createBiquadFilter(); midEQ.type = "peaking"; midEQ.frequency.value = 1000; midEQ.Q.value = 0.8; midEQ.gain.value = 0;
  const highEQ = audioCtx.createBiquadFilter(); highEQ.type = "highshelf"; highEQ.frequency.value = 3000; highEQ.gain.value = 0;
  const panner = audioCtx.createStereoPanner(); panner.pan.value = 0;
  const chGain = audioCtx.createGain(); chGain.gain.value = 1;

  // Sends
  const sendA = audioCtx.createGain(); sendA.gain.value = 0; // Reverb send
  const sendB = audioCtx.createGain(); sendB.gain.value = 0; // Delay send
  const analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024;

  // Chain and sends
  preGain.connect(lowEQ); lowEQ.connect(midEQ); midEQ.connect(highEQ); highEQ.connect(panner);
  panner.connect(chGain);
  chGain.connect(master.comp);
  chGain.connect(analyser);
  // Send taps from panner
  panner.connect(sendA); sendA.connect(auxA.convolver);
  panner.connect(sendB); sendB.connect(auxB.delay);

  const {ch, miniWave, vuBar, vuClip, fader, soloBtn, muteBtn, led, knobBank, knobRow2} = createChannel(stemName);
  meterChannel(analyser, vuBar, vuClip);

  drawMiniWave(miniWave, audioBuffer);

  // Knobs: Low, Mid, High, Mid Freq
  const lowKnob = createKnob({
    label: 'Low', min: -15, max: 15, step: 0.1, value: 0, unit: ' dB',
    toDisplay: (v)=> (v>0?`+${v.toFixed(1)}`:v.toFixed(1)),
    onChange: (v) => { lowEQ.gain.value = v; }
  });
  const midKnob = createKnob({
    label: 'Mid', min: -12, max: 12, step: 0.1, value: 0, unit: ' dB',
    toDisplay: (v)=> (v>0?`+${v.toFixed(1)}`:v.toFixed(1)),
    onChange: (v) => { midEQ.gain.value = v; }
  });
  const highKnob = createKnob({
    label: 'High', min: -15, max: 15, step: 0.1, value: 0, unit: ' dB',
    toDisplay: (v)=> (v>0?`+${v.toFixed(1)}`:v.toFixed(1)),
    onChange: (v) => { highEQ.gain.value = v; }
  });
  const midFreqKnob = createKnob({
    label: 'Mid Freq', min: 500, max: 4000, step: 1, value: 1000, unit: ' Hz',
    toDisplay: (v) => Math.round(v),
    toArc: (v) => (Math.log(v) - Math.log(500)) / (Math.log(4000) - Math.log(500)),
    onChange: (v) => { midEQ.frequency.value = v; }
  });
  knobBank.appendChild(lowKnob.el); knobBank.appendChild(midKnob.el); knobBank.appendChild(highKnob.el); knobBank.appendChild(midFreqKnob.el);

  // Pan + Sends
  const panKnob = createKnob({
    label: 'Pan', min: -1, max: 1, step: 0.01, value: 0,
    toDisplay: (v) => (Math.abs(v) < 0.05 ? 'C' : (v<0?`L${Math.round(Math.abs(v)*100)}`:`R${Math.round(v*100)}`)),
    onChange: (v) => { panner.pan.value = v; }
  });
  const sendAKnob = createKnob({
    label: 'Send A', min: 0, max: 1.0, step: 0.01, value: 0,
    toDisplay: (v)=> (v.toFixed(2)),
    onChange: (v) => { sendA.gain.value = v; }
  });
  const sendBKnob = createKnob({
    label: 'Send B', min: 0, max: 1.0, step: 0.01, value: 0,
    toDisplay: (v)=> (v.toFixed(2)),
    onChange: (v) => { sendB.gain.value = v; }
  });
  knobRow2.appendChild(panKnob.el);
  knobRow2.appendChild(sendAKnob.el);
  knobRow2.appendChild(sendBKnob.el);

  // State
  channels[stemName] = {
    buffer: audioBuffer,
    nodes: { preGain, lowEQ, midEQ, highEQ, panner, chGain, analyser, sendA, sendB },
    source: null,
    mute: false,
    solo: false,
    el: ch
  };

  duration = Math.max(duration, audioBuffer.duration);

  // Fader
  fader.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    channels[stemName].nodes.chGain.gain.value = v;
  });
  fader.addEventListener('change', () => uiClick(240));
  fader.addEventListener('dblclick', () => tweenFader(fader, channels[stemName].nodes.chGain.gain, 1.0));

  // Solo/Mute
  soloBtn.addEventListener('click', () => {
    channels[stemName].solo = !channels[stemName].solo;
    soloBtn.setAttribute('aria-pressed', String(channels[stemName].solo)); uiClick(520);
    updateSoloMute(); updateLED(led, channels[stemName].solo ? 'green' : null);
  });
  muteBtn.addEventListener('click', () => {
    channels[stemName].mute = !channels[stemName].mute;
    muteBtn.setAttribute('aria-pressed', String(channels[stemName].mute)); uiClick(180);
    updateSoloMute(); updateLED(led, channels[stemName].mute ? 'red' : null);
  });

  // Render overview waveform once
  if (!waveRenderedOnce) {
    renderWaveform(audioBuffer);
    waveRenderedOnce = true;
  }
}

function tweenFader(slider, audioParam, target) {
  const startVal = parseFloat(slider.value);
  const startTime = performance.now();
  const dur = 200;
  function step(now) {
    const t = Math.min(1, (now - startTime)/dur);
    const v = startVal + (target - startVal) * t;
    slider.value = v.toFixed(3);
    audioParam.value = v;
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function updateSoloMute() {
  const anySolo = Object.values(channels).some(ch => ch.solo);
  for (const chName in channels) {
    const ch = channels[chName];
    const effective = (anySolo ? ch.solo : !ch.mute) ? 1 : 0;
    ch.nodes.chGain.gain.setTargetAtTime(effective * parseFloat(ch.el.querySelector('.fader').value), audioCtx.currentTime, 0.01);
  }
}

// Transport
function startSources(fromOffset) {
  const now = audioCtx.currentTime;
  for (const name in channels) {
    const ch = channels[name];
    const src = audioCtx.createBufferSource();
    src.buffer = ch.buffer;
    src.loop = loopEnabled && loopOut > loopIn;
    if (src.loop) { src.loopStart = loopIn; src.loopEnd = loopOut; }
    src.connect(ch.nodes.preGain);
    src.start(now, fromOffset);
    ch.source = src;
  }
  startTime = now - fromOffset; isPlaying = true; btnPlay.textContent = '⏸';
}
function stopSources() {
  for (const name in channels) {
    const ch = channels[name];
    if (ch.source) { try { ch.source.stop(); } catch(e){} ch.source.disconnect(); ch.source = null; }
  }
}
function getCurrentTime() { if (!isPlaying) return pauseOffset; return Math.max(0, audioCtx.currentTime - startTime); }
function playPause() {
  ensureAudio();
  if (!Object.keys(channels).length) { toast('Load a song first'); uiError(); return; }
  if (!isPlaying) { startSources(pauseOffset); uiChime(); }
  else { pauseOffset = audioCtx.currentTime - startTime; stopSources(); isPlaying = false; btnPlay.textContent = '▶'; uiClick(180); }
}
function stopAll() {
  if (!audioCtx) return;
  stopSources(); isPlaying = false; pauseOffset = 0; btnPlay.textContent = '▶'; uiClick(140);
}
btnPlay.addEventListener('click', playPause);
btnStop.addEventListener('click', stopAll);
btnLoop.addEventListener('click', () => { loopEnabled = !loopEnabled; btnLoop.setAttribute('aria-pressed', String(loopEnabled)); uiClick(loopEnabled ? 520 : 180); updateLoopUI(); if (isPlaying) { stopSources(); startSources(getCurrentTime()); } });

masterGainEl.addEventListener('input', e => { ensureAudio(); const v = parseFloat(e.target.value); master.gain.gain.value = v; });
masterGainEl.addEventListener('change', () => uiClick(220));

// Recording
btnRecord.addEventListener('click', () => {
  ensureAudio();
  if (!master.rec) {
    try {
      master.rec = new MediaRecorder(master.mediaDest.stream);
      master.rec.ondataavailable = (ev) => ev.data.size && master.recChunks.push(ev.data);
      master.rec.onstop = () => {
        const blob = new Blob(master.recChunks, { type: master.rec.mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${(songTitle || 'mix')}.webm`; a.click();
        URL.revokeObjectURL(url); master.recChunks = [];
      };
    } catch (err) { toast('Recording not supported in this browser'); return; }
  }
  master.recActive = !master.recActive;
  btnRecord.setAttribute('aria-pressed', String(master.recActive));
  if (master.recActive) { master.rec.start(); uiChime(); toast('Recording mix…'); }
  else { master.rec.stop(); uiChime(); toast('Exported mix'); }
});

// Timeline: render overview + loop region + jog
let waveRenderedOnce = false;
function renderWaveform(audioBuffer) {
  const ctx = waveCanvas.getContext('2d');
  const w = waveCanvas.width = waveCanvas.clientWidth;
  const h = waveCanvas.height = waveCanvas.clientHeight;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--panel'); ctx.fillRect(0,0,w,h);
  const data = audioBuffer.getChannelData(0);
  const step = Math.ceil(data.length / w);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  ctx.lineWidth = 1; ctx.beginPath();
  const mid = h / 2;
  for (let i = 0; i < w; i++) {
    let min = 1.0, max = -1.0;
    const start = i * step;
    for (let j = 0; j < step; j++) { const v = data[start + j] || 0; if (v < min) min = v; if (v > max) max = v; }
    ctx.moveTo(i, mid + min * mid); ctx.lineTo(i, mid + max * mid);
  }
  ctx.stroke();
  updateLoopUI();
}
function drawMiniWave(canvas, buffer) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth;
  const h = canvas.height = canvas.clientHeight;
  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / w);
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle = '#7aa0ff'; ctx.lineWidth = 1; ctx.beginPath();
  const mid = h / 2;
  for (let i = 0; i < w; i++) {
    let min = 1.0, max = -1.0;
    const start = i * step;
    for (let j = 0; j < step; j++) { const v = data[start + j] || 0; if (v < min) min = v; if (v > max) max = v; }
    ctx.moveTo(i, mid + min * mid); ctx.lineTo(i, mid + max * mid);
  }
  ctx.stroke();
}
waveCanvas.addEventListener('click', (e) => {
  if (!duration) return;
  const rect = waveCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left; const ratio = x / rect.width;
  seekTo(ratio * duration);
});
function seekTo(t) {
  if (!audioCtx) return;
  pauseOffset = Math.max(0, Math.min(duration, t));
  if (isPlaying) { stopSources(); startSources(pauseOffset); }
}
function updateLoopUI() {
  const w = waveCanvas.clientWidth;
  const hasLoop = loopEnabled && loopOut > loopIn && duration > 0;
  loopShade.style.display = hasLoop ? 'block' : 'none';
  loopStartEl.style.display = hasLoop ? 'block' : 'none';
  loopEndEl.style.display = hasLoop ? 'block' : 'none';
  if (hasLoop) {
    const x1 = (loopIn / duration) * w;
    const x2 = (loopOut / duration) * w;
    loopShade.style.left = x1 + 'px'; loopShade.style.width = (x2 - x1) + 'px';
    loopStartEl.style.left = (x1 - 5) + 'px';
    loopEndEl.style.left = (x2 - 5) + 'px';
  }
}
// Loop handle drag
function bindHandle(el, which) {
  let dragging = false;
  el.addEventListener('pointerdown', (e) => { dragging = true; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (!dragging || duration<=0) return;
    const rect = waveCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const t = (x / rect.width) * duration;
    if (which === 'start') { loopIn = Math.min(t, loopOut - 0.05); }
    else { loopOut = Math.max(t, loopIn + 0.05); }
    updateLoopUI();
  });
  el.addEventListener('pointerup', () => {
    dragging = false; uiClick(260);
    if (isPlaying) { stopSources(); startSources(getCurrentTime()); }
  });
}
bindHandle(loopStartEl, 'start'); bindHandle(loopEndEl, 'end');

// Jog wheel for micro-scrub
(function setupJog(){
  let dragging = false, lastA = 0;
  function angle(e, rect) {
    const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    return Math.atan2(e.clientY - cy, e.clientX - cx);
  }
  jog.addEventListener('pointerdown', (e) => { dragging = true; jog.setPointerCapture(e.pointerId); lastA = angle(e, jog.getBoundingClientRect()); });
  jog.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const a = angle(e, jog.getBoundingClientRect());
    const delta = a - lastA;
    lastA = a;
    const seconds = delta * 2; // scaling
    seekTo(getCurrentTime() + seconds);
  });
  jog.addEventListener('pointerup', () => { dragging = false; uiClick(260); });
})();

// Time tick
function formatTime(t) {
  const m = Math.floor(t / 60).toString().padStart(2,'0');
  const s = Math.floor(t % 60).toString().padStart(2,'0');
  const d = Math.floor((t * 10) % 10);
  return `${m}:${s}.${d}`;
}
function tick() {
  if (duration > 0) {
    const t = Math.min(duration, getCurrentTime());
    timeDisplay.textContent = formatTime(t);
    const x = (t / duration) * waveCanvas.clientWidth;
    playheadEl.style.transform = `translateX(${x}px)`;
    playheadEl.setAttribute('aria-valuemin', '0');
    playheadEl.setAttribute('aria-valuemax', duration.toFixed(1));
    playheadEl.setAttribute('aria-valuenow', t.toFixed(1));
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Library and search
async function loadLibrary() {
  try {
    const data = await api('/api/library');
    const list = data.items || [];
    libraryList.innerHTML = '';
    if (!list.length) {
      libraryList.innerHTML = '<div class="session-item"><div class="title">No separated songs yet</div></div>';
      return;
    }
    for (const item of list) {
      const el = document.createElement('div'); el.className = 'session-item';
      el.innerHTML = `<div class="title">${item.title}</div><div class="badge">${item.id}</div>`;
      el.addEventListener('click', () => { showSong(item.id, item.title, item.stems); });
      libraryList.appendChild(el);
    }
  } catch (err) { console.error(err); }
}

function openSearchDrawer() { searchDrawer.classList.remove('hidden'); searchDrawer.setAttribute('aria-hidden','false'); queryEl.focus(); uiClick(320); }
function closeSearchDrawer() { searchDrawer.classList.add('hidden'); searchDrawer.setAttribute('aria-hidden','true'); uiClick(180); }
openSearch.addEventListener('click', openSearchDrawer);
closeSearch.addEventListener('click', closeSearchDrawer);
searchBtn.addEventListener('click', doSearch);
queryEl.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const q = queryEl.value.trim();
  resultsEl.innerHTML = '';
  if (!q) return;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const results = data.results || [];
    if (!results.length) { resultsEl.innerHTML = '<div class="session-item"><div class="title">No results</div></div>'; return; }
    for (const item of results) {
      const card = document.createElement('div'); card.className = 'rack-card';
      const img = document.createElement('img'); img.src = item.thumbnail || '/static/default-thumbnail.png'; img.onerror = () => { img.src = '/static/default-thumbnail.png'; };
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.innerHTML = `<div class="title">${item.title}</div><div class="badge">${item.id}</div>`;
      const actions = document.createElement('div'); actions.className = 'actions';
      const splitBtn = document.createElement('button'); splitBtn.className = 'btn primary'; splitBtn.textContent = 'Split (Demucs)';
      splitBtn.addEventListener('click', () => splitSong(item));
      const link = document.createElement('a'); link.className = 'btn ghost'; link.textContent = 'YouTube'; link.href = item.url; link.target = '_blank';
      actions.appendChild(splitBtn); actions.appendChild(link);
      meta.appendChild(actions);
      card.appendChild(img); card.appendChild(meta);
      resultsEl.appendChild(card);
    }
  } catch (err) { console.error(err); toast('Search failed'); uiError(); }
}

// Processing rack progress
let progressTimer;
function showProcessingRack() {
  processingModal.classList.remove('hidden'); processingModal.setAttribute('aria-hidden','false');
  processFill.style.width = '0%';
  stepFetch.classList.add('active'); stepSep.classList.remove('active','done'); stepFinal.classList.remove('active','done');
  let p = 0;
  progressTimer = setInterval(() => {
    p += (p < 60) ? 2.5 : (p < 90 ? 0.7 : 0);
    processFill.style.width = `${p}%`;
    if (p > 15) { stepFetch.classList.add('done'); stepFetch.classList.remove('active'); stepSep.classList.add('active'); }
    if (p > 65) { stepSep.classList.add('done'); stepSep.classList.remove('active'); stepFinal.classList.add('active'); }
  }, 120);
}
function hideProcessingRack() {
  if (progressTimer) clearInterval(progressTimer);
  stepFinal.classList.add('done'); stepFinal.classList.remove('active');
  processFill.style.width = `100%`; rackMarquee.textContent = 'Complete ✔ Stems ready';
  setTimeout(() => {
    processingModal.classList.add('hidden'); processingModal.setAttribute('aria-hidden','true');
    rackMarquee.textContent = 'Working… high fidelity split in progress';
  }, 600);
}

async function splitSong(item) {
  closeSearchDrawer(); showProcessingRack(); uiChime();
  try {
    const res = await api('/api/process', { method: 'POST', body: JSON.stringify({ url: item.url, id: item.id, title: item.title }) });
    hideProcessingRack(); toast('Stems generated. Loading mixer…');
    await loadLibrary(); await showSong(res.song.id, res.song.title, res.stems); uiChime();
  } catch (err) { console.error(err); hideProcessingRack(); toast('Processing failed'); uiError(); }
}

// Show song: build mixer
async function showSong(id, title, stems) {
  ensureAudio();
  songId = id; songTitle = title; stemsList = stems;
  zipAll.href = `/download_zip/${encodeURIComponent(id)}`;
  mixer.innerHTML = ''; waveRenderedOnce = false; channels = {}; duration = 0; stopAll();
  const hint = document.getElementById('noSong'); if (hint) hint.remove();
  loopIn = 0; loopOut = 0; updateLoopUI();
  await Promise.all(stems.map(loadStem));
  loadSnapshotsUI();
  toast(`Loaded: ${title}`); uiChime();
}

// Snapshots (localStorage)
saveSnap.addEventListener('click', () => {
  if (!songId) return;
  const name = (snapName.value || `Mix ${new Date().toLocaleTimeString()}`).trim();
  const snap = {
    master: { gain: parseFloat(masterGainEl.value), auxA: parseFloat(auxAReturn.value), auxASize: parseFloat(auxASize.value), auxB: parseFloat(auxBReturn.value), time: parseFloat(auxBTime.value), fb: parseFloat(auxBFeedback.value), hiCut: parseFloat(auxBHiCut.value) },
    channels: Object.fromEntries(Object.entries(channels).map(([k, ch]) => {
      const fader = ch.el.querySelector('.fader');
      return [k, {
        gain: parseFloat(fader.value),
        pan: ch.nodes.panner?.pan?.value || 0,
        low: ch.nodes.lowEQ.gain.value,
        mid: ch.nodes.midEQ.gain.value,
        high: ch.nodes.highEQ.gain.value,
        midFreq: ch.nodes.midEQ.frequency.value,
        sendA: ch.nodes.sendA.gain.value,
        sendB: ch.nodes.sendB.gain.value,
        mute: ch.mute, solo: ch.solo
      }];
    }))
  };
  const key = `mixSnaps:${songId}`;
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  list.push({ name, snap }); localStorage.setItem(key, JSON.stringify(list));
  snapName.value = '';
  loadSnapshotsUI();
  toast('Snapshot saved');
});
function loadSnapshotsUI() {
  const key = `mixSnaps:${songId}`;
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  snapList.innerHTML = '';
  list.forEach((it, idx) => {
    const el = document.createElement('div'); el.className = 'session-item';
    el.innerHTML = `<div class="title">${it.name}</div><div class="badge">#${idx+1}</div>`;
    el.addEventListener('click', () => applySnapshot(it.snap));
    snapList.appendChild(el);
  });
}
function applySnapshot(snap) {
  masterGainEl.value = snap.master.gain; master.gain.gain.value = snap.master.gain;
  auxAReturn.value = snap.master.auxA; auxA.return.gain.value = snap.master.auxA;
  auxASize.value = snap.master.auxASize; auxA.size = snap.master.auxASize; buildReverbImpulse(auxA.size);
  auxBReturn.value = snap.master.auxB; auxB.return.gain.value = snap.master.auxB;
  auxBTime.value = snap.master.time; auxB.delay.delayTime.value = snap.master.time;
  auxBFeedback.value = snap.master.fb; auxB.feedback.gain.value = snap.master.fb;
  auxBHiCut.value = snap.master.hiCut; auxB.hiCut.frequency.value = snap.master.hiCut;

  for (const name in snap.channels) {
    const st = snap.channels[name]; const ch = channels[name]; if (!ch) continue;
    ch.nodes.chGain.gain.value = st.gain; ch.el.querySelector('.fader').value = st.gain;
    ch.nodes.panner.pan.value = st.pan;
    ch.nodes.lowEQ.gain.value = st.low; ch.nodes.midEQ.gain.value = st.mid; ch.nodes.highEQ.gain.value = st.high; ch.nodes.midEQ.frequency.value = st.midFreq;
    ch.nodes.sendA.gain.value = st.sendA; ch.nodes.sendB.gain.value = st.sendB;
    ch.mute = !!st.mute; ch.solo = !!st.solo;
    ch.el.querySelector('[data-action="mute"]').setAttribute('aria-pressed', String(ch.mute));
    ch.el.querySelector('[data-action="solo"]').setAttribute('aria-pressed', String(ch.solo));
  }
  updateSoloMute();
  toast('Snapshot loaded');
}

// Aux controls binding
auxAReturn.addEventListener('input', e => { ensureAudio(); auxA.return.gain.value = parseFloat(e.target.value); });
auxASize.addEventListener('input', e => { ensureAudio(); auxA.size = parseFloat(e.target.value); buildReverbImpulse(auxA.size); });
auxBReturn.addEventListener('input', e => { ensureAudio(); auxB.return.gain.value = parseFloat(e.target.value); });
auxBTime.addEventListener('input', e => { ensureAudio(); auxB.delay.delayTime.value = parseFloat(e.target.value); });
auxBFeedback.addEventListener('input', e => { ensureAudio(); auxB.feedback.gain.value = parseFloat(e.target.value); });
auxBHiCut.addEventListener('input', e => { ensureAudio(); auxB.hiCut.frequency.value = parseFloat(e.target.value); });

// Keyboard controls
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === '?') { hotkeys.classList.toggle('hidden'); return; }
  if (e.code === 'Space') { e.preventDefault(); playPause(); }
  else if (e.key.toLowerCase() === 'l') { loopEnabled = !loopEnabled; btnLoop.setAttribute('aria-pressed', String(loopEnabled)); updateLoopUI(); if (isPlaying) { stopSources(); startSources(getCurrentTime()); } }
  else if (e.key === 'ArrowRight') { seekTo(Math.min(duration, getCurrentTime() + 2)); }
  else if (e.key === 'ArrowLeft') { seekTo(Math.max(0, getCurrentTime() - 2)); }
  else if (/^[1-9]$/.test(e.key)) {
    const idx = parseInt(e.key, 10) - 1;
    const els = [...document.querySelectorAll('.channel')];
    if (els[idx]) els[idx].focus();
  } else if (e.key.toLowerCase() === 'm') {
    const el = document.activeElement.closest?.('.channel'); if (!el) return;
    const name = el.dataset.stem; const ch = channels[name]; if (!ch) return;
    ch.mute = !ch.mute; updateSoloMute();
    el.querySelector('[data-action="mute"]').setAttribute('aria-pressed', String(ch.mute));
  } else if (e.key.toLowerCase() === 's') {
    const el = document.activeElement.closest?.('.channel'); if (!el) return;
    const name = el.dataset.stem; const ch = channels[name]; if (!ch) return;
    ch.solo = !ch.solo; updateSoloMute();
    el.querySelector('[data-action="solo"]').setAttribute('aria-pressed', String(ch.solo));
  }
});

// Resize handling (waveform/minis)
window.addEventListener('resize', () => {
  const any = Object.keys(channels)[0];
  if (any) {
    renderWaveform(channels[any].buffer);
    for (const name in channels) { const ch = channels[name]; drawMiniWave(ch.el.querySelector('.mini-wave'), ch.buffer); }
  }
});

// Ensure contexts resume on first click
document.body.addEventListener('click', () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (uiCtx && uiCtx.state === 'suspended') uiCtx.resume();
}, { once: true });

// Search drawer open/close
function openSearchDrawer() { searchDrawer.classList.remove('hidden'); searchDrawer.setAttribute('aria-hidden','false'); queryEl.focus(); uiClick(320); }
function closeSearchDrawer() { searchDrawer.classList.add('hidden'); searchDrawer.setAttribute('aria-hidden','true'); uiClick(180); }

document.getElementById('openSearch').addEventListener('click', openSearchDrawer);
document.getElementById('closeSearch').addEventListener('click', closeSearchDrawer);

// Loop defaults
function setDefaultLoop() {
  loopIn = 0; loopOut = Math.max(0, duration - 0.001);
  updateLoopUI();
}

// Initial load
loadLibrary();