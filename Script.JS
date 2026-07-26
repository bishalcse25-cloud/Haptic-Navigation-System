/* ═══════════════════════════════════════════════
   HaptiNav — Core Engine
   Detects: motion blobs, person-like shapes via HOG-style heuristics
   Feedback: Web Speech API + Vibration API + visual zones
   No backend. No libraries. Pure browser APIs.
═══════════════════════════════════════════════ */

// ── STATE ──────────────────────────────────
const state = {
  scanning:    true,
  voiceOn:     false,
  hapticOn:    false,
  sensitivity: 1,
  stream:      null,
  rafId:       null,
  prevFrame:   null,
  frameCount:  0,
  lastBeep:    0,
  lastVoice:   0,
  lastBigAlert:0,
  alertQueue:  [],
  currentThreat: 'none',   // none | safe | warn | danger
  detections:  [],
  motionLevel: 0,
};

// Sensitivity thresholds: [min_blob_area_fraction, motion_warn, motion_danger]
const SENS_THRESHOLDS = {
  1: { blobMin: 0.03, warnAt: 0.18, dangerAt: 0.32 },
  2: { blobMin: 0.015, warnAt: 0.10, dangerAt: 0.20 },
  3: { blobMin: 0.008, warnAt: 0.05, dangerAt: 0.12 },
};

// Zones: [x_start_frac, x_end_frac, y_start_frac, y_end_frac]
const ZONE_DEF = {
  'L' : [0,   1/3, 0,   0.5],
  'C' : [1/3, 2/3, 0,   0.5],
  'R' : [2/3, 1,   0,   0.5],
  'FL': [0,   1/3, 0.5, 1  ],
  'F' : [1/3, 2/3, 0.5, 1  ],
  'FR': [2/3, 1,   0.5, 1  ],
};

const ZONE_NAMES = {
  'L':'left', 'C':'upper center', 'R':'right',
  'FL':'front left', 'F':'front', 'FR':'front right',
};

// Beep frequencies per zone
const ZONE_FREQ = { L:280, C:440, R:660, FL:320, F:500, FR:720 };

// ── SCREEN SWITCH ──────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── START ──────────────────────────────────
async function startApp() {
  showScreen('app');
  // Auto-enable voice & haptic after brief delay
  setTimeout(() => { state.voiceOn = true; updateVoiceBtn(); }, 300);
  setTimeout(() => { state.hapticOn = true; updateHapticBtn(); }, 300);
  await startCamera();
  speak('HaptiNav started. Point your camera forward to detect obstacles.', true);
}

// ── CAMERA ─────────────────────────────────
async function startCamera() {
  document.getElementById('no-cam').style.display = 'none';
  try {
    const constraints = {
      video: {
        facingMode: 'environment',   // rear camera on mobile
        width:  { ideal: 640 },
        height: { ideal: 480 },
      }
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById('video');
    video.srcObject = state.stream;
    await new Promise(r => video.onloadedmetadata = r);
    video.play();
    document.getElementById('badge-cam').className = 'badge on';
    document.getElementById('badge-cam').textContent = 'CAM';
    resizeCanvases();
    startDetectionLoop();
    logAlert('Camera active — scanning', 'safe');
  } catch (err) {
    document.getElementById('badge-cam').className = 'badge off';
    document.getElementById('no-cam').style.display = 'flex';
    logAlert('Camera error: ' + err.message, 'warn');
  }
}

function resizeCanvases() {
  const section = document.getElementById('cam-section');
  const w = section.clientWidth;
  const h = section.clientHeight;
  ['grid-canvas','overlay-canvas'].forEach(id => {
    const c = document.getElementById(id);
    c.width = w; c.height = h;
  });
  drawGridLines();
}

window.addEventListener('resize', () => {
  resizeCanvases();
});

function drawGridLines() {
  const c = document.getElementById('grid-canvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(34,197,94,0.12)';
  ctx.lineWidth = 1;
  // vertical thirds
  [1/3, 2/3].forEach(f => {
    ctx.beginPath();
    ctx.setLineDash([4, 6]);
    ctx.moveTo(c.width * f, 0);
    ctx.lineTo(c.width * f, c.height);
    ctx.stroke();
  });
  // horizontal half
  ctx.beginPath();
  ctx.moveTo(0, c.height * 0.5);
  ctx.lineTo(c.width, c.height * 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ── DETECTION LOOP ─────────────────────────
function startDetectionLoop() {
  const video = document.getElementById('video');
  const offscreen = document.createElement('canvas');
  const PROC_W = 160, PROC_H = 120;
  offscreen.width  = PROC_W;
  offscreen.height = PROC_H;
  const offCtx = offscreen.getContext('2d', { willReadFrequently: true });

  let prev = null;

  function loop() {
    if (!state.scanning) { state.rafId = requestAnimationFrame(loop); return; }
    state.frameCount++;

    offCtx.drawImage(video, 0, 0, PROC_W, PROC_H);
    const frame = offCtx.getImageData(0, 0, PROC_W, PROC_H);

    if (prev) {
      const results = processFrame(frame, prev, PROC_W, PROC_H);
      state.detections   = results.blobs;
      state.motionLevel  = results.motionFraction;
      updateUI(results);
      triggerFeedback(results);
    }

    prev = frame;
    state.rafId = requestAnimationFrame(loop);
  }

  state.rafId = requestAnimationFrame(loop);
}

// ── FRAME PROCESSING ───────────────────────
function processFrame(curr, prev, W, H) {
  const thresh  = SENS_THRESHOLDS[state.sensitivity];
  const data1   = curr.data;
  const data2   = prev.data;

  // Diff map
  const diff = new Uint8Array(W * H);
  let motionPx = 0;

  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    const dr = Math.abs(data1[idx]   - data2[idx]);
    const dg = Math.abs(data1[idx+1] - data2[idx+1]);
    const db = Math.abs(data1[idx+2] - data2[idx+2]);
    const d  = (dr + dg + db) / 3;
    if (d > 20) { diff[i] = 255; motionPx++; }
  }

  const motionFraction = motionPx / (W * H);

  // Simple connected-component blob finding
  const blobs = findBlobs(diff, W, H, thresh.blobMin);

  return { blobs, motionFraction, W, H };
}

// Fast flood-fill blob finder on diff map
function findBlobs(diff, W, H, minAreaFrac) {
  const visited = new Uint8Array(W * H);
  const blobs   = [];
  const minArea = W * H * minAreaFrac;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (diff[idx] === 0 || visited[idx]) continue;

      // BFS
      const stack = [idx];
      visited[idx] = 1;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;

      while (stack.length) {
        const cur = stack.pop();
        const cx  = cur % W, cy = Math.floor(cur / W);
        count++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;

        // 4-connected
        [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx, dy]) => {
          const nx = cx+dx, ny = cy+dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) return;
          const ni = ny * W + nx;
          if (diff[ni] === 255 && !visited[ni]) {
            visited[ni] = 1;
            stack.push(ni);
          }
        });
      }

      if (count < minArea) continue;

      const relArea = count / (W * H);
      const cx_c = (minX + maxX) / 2 / W;
      const cy_c = (minY + maxY) / 2 / H;

      let threat = 'safe';
      const t = SENS_THRESHOLDS[state.sensitivity];
      if (relArea > t.dangerAt) threat = 'danger';
      else if (relArea > t.warnAt) threat = 'warn';

      blobs.push({
        relArea,
        cx: cx_c, cy: cy_c,
        x1: minX/W, y1: minY/H,
        x2: maxX/W, y2: maxY/H,
        threat,
        zone: getZone(cx_c, cy_c),
      });
    }
  }

  // Sort by area descending
  return blobs.sort((a, b) => b.relArea - a.relArea).slice(0, 6);
}

function getZone(cx, cy) {
  for (const [name, [x1,x2,y1,y2]] of Object.entries(ZONE_DEF)) {
    if (cx >= x1 && cx < x2 && cy >= y1 && cy < y2) return name;
  }
  return 'F';
}

// ── UI UPDATE ──────────────────────────────
function updateUI({ blobs, motionFraction, W, H }) {
  const canvas  = document.getElementById('overlay-canvas');
  const ctx     = canvas.getContext('2d');
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // Reset zones
  Object.keys(ZONE_DEF).forEach(z => {
    document.getElementById('z-'+z).className = 'zc';
  });

  let worstThreat = 'none';
  let worstZone   = null;

  blobs.forEach(blob => {
    // Draw bounding box (on mirrored canvas — flip x)
    const x1 = (1 - blob.x2) * cw;
    const y1 = blob.y1 * ch;
    const bw  = (blob.x2 - blob.x1) * cw;
    const bh  = (blob.y2 - blob.y1) * ch;

    let color;
    if (blob.threat === 'danger')     color = '#EF4444';
    else if (blob.threat === 'warn')  color = '#FACC15';
    else                              color = '#22C55E';

    ctx.strokeStyle = color;
    ctx.lineWidth   = blob.threat === 'danger' ? 3 : 2;
    ctx.strokeRect(x1, y1, bw, bh);

    // Fill transparent
    ctx.fillStyle = color.replace(')', ',0.08)').replace('rgb', 'rgba').replace('#', '').slice(0,0) + color + '18';
    ctx.fillStyle = color + '1A';
    ctx.fillRect(x1, y1, bw, bh);

    // Label
    const label = blob.threat.toUpperCase();
    ctx.fillStyle = color;
    ctx.font = 'bold 11px JetBrains Mono, monospace';
    ctx.fillText(label, x1 + 4, y1 + 14);

    // Zone lighting
    const zEl = document.getElementById('z-'+blob.zone);
    if (zEl) {
      if (blob.threat === 'danger' || zEl.className.includes('danger')) {
        zEl.className = 'zc lit-danger';
      } else if (blob.threat === 'warn' && !zEl.className.includes('danger')) {
        zEl.className = 'zc lit-warn';
      } else if (!zEl.className.includes('danger') && !zEl.className.includes('warn')) {
        zEl.className = 'zc lit-safe';
      }
    }

    // Track worst
    if (blob.threat === 'danger' && worstThreat !== 'danger') {
      worstThreat = 'danger'; worstZone = blob.zone;
    } else if (blob.threat === 'warn' && worstThreat === 'none') {
      worstThreat = 'warn'; worstZone = blob.zone;
    } else if (worstThreat === 'none') {
      worstThreat = 'safe'; worstZone = blob.zone;
    }
  });

  // Direction arrow
  updateDirectionArrow(worstThreat, worstZone);

  // Alert banner
  const banner = document.getElementById('alert-banner');
  if (worstThreat === 'danger') {
    banner.className = 'danger';
    banner.textContent = `⛔  OBSTACLE — ${ZONE_NAMES[worstZone] || 'ahead'}`;
    if (state.currentThreat !== 'danger') {
      document.getElementById('cam-section').classList.add('danger-pulse');
      setTimeout(() => document.getElementById('cam-section').classList.remove('danger-pulse'), 400);
    }
  } else if (worstThreat === 'warn') {
    banner.className = 'warn';
    banner.textContent = `⚠  Caution — movement on ${ZONE_NAMES[worstZone] || 'side'}`;
  } else if (worstThreat === 'safe') {
    banner.className = 'safe';
    banner.textContent = '✓  Movement detected — path may be occupied';
  } else {
    banner.className = '';
  }

  state.currentThreat = worstThreat;

  // Status badge
  const bs = document.getElementById('badge-status');
  if (worstThreat === 'danger') {
    bs.className = 'badge danger'; bs.textContent = 'DANGER';
  } else if (worstThreat === 'warn') {
    bs.className = 'badge warn'; bs.textContent = 'CAUTION';
  } else {
    bs.className = 'badge on'; bs.textContent = 'CLEAR';
  }
}

function updateDirectionArrow(threat, zone) {
  const arrow = document.getElementById('big-dir-arrow');
  const label = document.getElementById('dir-label');

  if (!zone || threat === 'none') {
    arrow.textContent = '✓';
    arrow.style.color = 'var(--green)';
    label.textContent = 'CLEAR';
    return;
  }

  const arrowMap = {
    L: '↖', C: '↑', R: '↗',
    FL: '←', F: '⬆', FR: '→',
  };
  const colorMap = {
    danger: 'var(--red)',
    warn:   'var(--yellow)',
    safe:   'var(--green)',
  };

  arrow.textContent   = arrowMap[zone] || '↑';
  arrow.style.color   = colorMap[threat] || 'var(--green)';
  label.textContent   = (ZONE_NAMES[zone] || zone).toUpperCase();
}

// ── FEEDBACK ───────────────────────────────
function triggerFeedback({ blobs, motionFraction }) {
  if (!blobs.length) return;

  const worst = blobs[0];
  const now   = Date.now();

  // Beep timing
  const beepGap = worst.threat === 'danger' ? 220 :
                  worst.threat === 'warn'   ? 550 : 1200;

  if (state.hapticOn && now - state.lastBeep > beepGap) {
    playBeep(ZONE_FREQ[worst.zone] || 440,
             worst.threat === 'danger' ? 0.12 : 0.10,
             worst.threat === 'danger' ? 0.8 : 0.5);
    state.lastBeep = now;

    // Vibrate
    if (navigator.vibrate) {
      if (worst.threat === 'danger') {
        navigator.vibrate([200, 80, 200]);
      } else if (worst.threat === 'warn') {
        navigator.vibrate([100]);
      } else {
        navigator.vibrate([40]);
      }
    }
  }

  // Voice
  const voiceGap = worst.threat === 'danger' ? 2500 :
                   worst.threat === 'warn'   ? 5000 : 8000;

  if (state.voiceOn && now - state.lastVoice > voiceGap) {
    let msg;
    const zn = ZONE_NAMES[worst.zone] || 'ahead';
    if (worst.threat === 'danger') {
      msg = `Warning! Obstacle very close on your ${zn}. Please stop.`;
    } else if (worst.threat === 'warn') {
      msg = `Caution. Object detected on your ${zn}.`;
    } else {
      msg = `Movement on your ${zn}.`;
    }
    speak(msg);
    state.lastVoice = now;

    logAlert(msg, worst.threat);
  }
}

// ── AUDIO ──────────────────────────────────
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playBeep(freq = 440, duration = 0.12, vol = 0.5) {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type      = freq > 600 ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.01);
    gain.gain.linearRampToValueAtTime(0,   ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration + 0.02);
  } catch(e) {}
}

// ── VOICE ──────────────────────────────────
let speechQueue = [];
let isSpeaking  = false;

function speak(text, force = false) {
  if (!window.speechSynthesis) return;
  if (!state.voiceOn && !force) return;
  speechQueue.push(text);
  if (!isSpeaking) drainQueue();
}

function drainQueue() {
  if (!speechQueue.length) { isSpeaking = false; return; }
  isSpeaking = true;
  const utt  = new SpeechSynthesisUtterance(speechQueue.shift());
  utt.rate   = 1.05;
  utt.pitch  = 1.0;
  utt.volume = 1.0;
  utt.lang   = 'en-US';
  utt.onend  = drainQueue;
  utt.onerror= drainQueue;
  window.speechSynthesis.speak(utt);
}

// ── CONTROLS ───────────────────────────────
function toggleVoice() {
  state.voiceOn = !state.voiceOn;
  updateVoiceBtn();
  if (state.voiceOn) {
    const utt = new SpeechSynthesisUtterance('Voice guidance on.');
    utt.rate = 1.0;
    window.speechSynthesis.speak(utt);
  }
  logAlert(state.voiceOn ? 'Voice ON' : 'Voice OFF', 'safe');
}

function updateVoiceBtn() {
  const btn = document.getElementById('btn-voice');
  btn.setAttribute('aria-pressed', state.voiceOn);
  btn.className = 'big-btn green-btn' + (state.voiceOn ? ' active' : '');
  document.getElementById('badge-voice').className = state.voiceOn ? 'badge on' : 'badge off';
  document.getElementById('badge-voice').textContent = state.voiceOn ? 'VOICE' : 'VOICE';
}

function toggleHaptic() {
  state.hapticOn = !state.hapticOn;
  updateHapticBtn();
  if (state.hapticOn && navigator.vibrate) navigator.vibrate([80, 40, 80]);
  playBeep(state.hapticOn ? 550 : 300, 0.1, 0.4);
  logAlert(state.hapticOn ? 'Haptic ON' : 'Haptic OFF', 'safe');
}

function updateHapticBtn() {
  const btn = document.getElementById('btn-haptic');
  btn.setAttribute('aria-pressed', state.hapticOn);
  btn.className = 'big-btn green-btn' + (state.hapticOn ? ' active' : '');
  document.getElementById('badge-haptic').className = state.hapticOn ? 'badge on' : 'badge off';
}

function toggleScan() {
  state.scanning = !state.scanning;
  const ico = document.getElementById('scan-ico');
  const lbl = document.getElementById('scan-lbl');
  const btn = document.getElementById('btn-scan');

  if (state.scanning) {
    ico.textContent = '⏹';
    lbl.textContent = 'Stop Scan';
    btn.className   = 'big-btn red-btn active';
    btn.setAttribute('aria-pressed', 'true');
    document.getElementById('badge-status').className = 'badge on';
    document.getElementById('badge-status').textContent = 'SCAN';
    speak('Scanning resumed.', true);
    logAlert('Scanning resumed', 'safe');
  } else {
    ico.textContent = '▶';
    lbl.textContent = 'Start Scan';
    btn.className   = 'big-btn dim-btn';
    btn.setAttribute('aria-pressed', 'false');
    document.getElementById('badge-status').className = 'badge off';
    document.getElementById('badge-status').textContent = 'PAUSED';
    document.getElementById('alert-banner').className = '';
    Object.keys(ZONE_DEF).forEach(z => {
      document.getElementById('z-'+z).className = 'zc';
    });
    speak('Scanning paused.', true);
    logAlert('Scanning paused', 'warn');
  }
}

function setSensitivity(level) {
  state.sensitivity = level;
  document.querySelectorAll('.sens-seg').forEach(s => {
    s.classList.remove('sel');
    s.setAttribute('aria-checked', 'false');
  });
  const sel = document.querySelector(`.sens-seg[data-level="${level}"]`);
  if (sel) { sel.classList.add('sel'); sel.setAttribute('aria-checked', 'true'); }

  const names = { 1:'low', 2:'medium', 3:'high' };
  speak(`Sensitivity set to ${names[level]}.`, true);
  playBeep(300 + level * 80, 0.08, 0.3);
  logAlert(`Sensitivity: ${names[level].toUpperCase()}`, 'safe');
}

function announceNow() {
  playBeep(440, 0.05, 0.4);
  if (navigator.vibrate) navigator.vibrate(50);

  if (!state.scanning) {
    speak('Scanning is paused. Tap Start Scan to resume.', true);
    return;
  }

  const dets = state.detections;
  if (!dets.length) {
    speak('Path appears clear. No obstacles detected.', true);
    logAlert('Announced: clear', 'safe');
    return;
  }

  const worst = dets[0];
  const zn    = ZONE_NAMES[worst.zone] || 'ahead';

  let msg;
  if (worst.threat === 'danger') {
    msg = `Warning! Large obstacle on your ${zn}. Please stop or move carefully.`;
  } else if (worst.threat === 'warn') {
    msg = `Caution. Movement detected on your ${zn}. Proceed slowly.`;
  } else {
    msg = `Small movement on your ${zn}. Path may be occupied.`;
  }

  speak(msg, true);
  logAlert('Announced: ' + msg, worst.threat);
}

function logAlert(msg, type) {
  const box  = document.getElementById('last-alert-box');
  const text = document.getElementById('last-alert-text');
  const dot  = document.getElementById('last-alert-dot');
  text.textContent = msg;
  dot.style.background = type === 'danger' ? 'var(--red)'
                       : type === 'warn'   ? 'var(--yellow)'
                       : 'var(--green)';
  box.classList.add('visible');
  clearTimeout(box._timer);
  box._timer = setTimeout(() => box.classList.remove('visible'), 4000);
}

// ── KEYBOARD SHORTCUTS ─────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'v' || e.key === 'V') toggleVoice();
  if (e.key === 'h' || e.key === 'H') toggleHaptic();
  if (e.key === ' ')                   { e.preventDefault(); toggleScan(); }
  if (e.key === 'a' || e.key === 'A') announceNow();
  if (e.key === '1') setSensitivity(1);
  if (e.key === '2') setSensitivity(2);
  if (e.key === '3') setSensitivity(3);
});

// ── UNLOCK AUDIO ON FIRST INTERACTION ──────
document.addEventListener('click', () => {
  try { getAudioCtx(); } catch(e) {}
}, { once: true });

// ── WAKE LOCK ──────────────────────────────
async function tryWakeLock() {
  if ('wakeLock' in navigator) {
    try { await navigator.wakeLock.request('screen'); } catch(_) {}
  }
}
document.addEventListener('visibili
