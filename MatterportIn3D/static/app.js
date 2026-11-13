/* Matterport In3D — frontend
 *
 * - Načte Matterport Showcase do iframe (s applicationKey, je-li nastaven)
 * - Připojí se přes Showcase SDK (mpSdk)
 * - Poslouchá WebSocket /ws a provádí přesuny kamery (Sweep.moveTo + Camera.lookAt)
 * - Ruční formulář posílá pozice přes POST /move (stejná cesta jako cizí systém)
 * - Omezuje vstupy formuláře na rozměry modelu (bounding box pozic sweepů)
 */
'use strict';

// ---------------------------------------------------------------------------
// Konfigurace injektovaná serverem do index.html
// ---------------------------------------------------------------------------
const CONFIG = JSON.parse(document.getElementById('mp-config').textContent);

// Remote režim — appka otevřená ne přes localhost (např. přes IP na serveru):
// bez Matterport SDK (origin by vyžadoval licenci), místo 3D QA snímky.
const remoteMode = (() => {
  const h = location.hostname;
  return !(h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '0.0.0.0');
})();

const SDK_BOOTSTRAP = 'https://api.matterport.com/sdk/bootstrap/3.0.0-0-g0517b8d76c/sdk.es6.js';
const SHOWCASE_URL = 'https://my.matterport.com/show';

const $ = (id) => document.getElementById(id);
const iframe = $('showcase');

// ---------------------------------------------------------------------------
// Stav
// ---------------------------------------------------------------------------
let mpSdk = null;
const sweeps = new Map();      // id -> Sweep.ObservableSweepData
let bounds = null;             // {x: [min,max], y: [...], z: [...]}
let latestTarget = null;        // poslední přijatá pozice (starší se zahazují)
let busy = false;               // probíhá přesun kamery

// ---------------------------------------------------------------------------
// Pomůcky UI
// ---------------------------------------------------------------------------
function setDot(el, state, title) {
  el.classList.remove('ok', 'err', 'warn');
  el.classList.add(state);
  if (title) el.parentElement.title = title;
}

function setStatus(msg) {
  $('lastMsg').textContent = msg;
}

// ---------------------------------------------------------------------------
// Načtení Showcase + připojení SDK
// ---------------------------------------------------------------------------
async function initShowcase() {
  if (remoteMode) {
    await setupRemote();   // remote režim — bez iframe/SDK, QA snímky místo 3D
    return;
  }
  const params = new URLSearchParams({ m: CONFIG.modelId, play: '1' });
  if (CONFIG.applicationKey) {
    params.set('applicationKey', CONFIG.applicationKey);
  }
  // ?capture=1 = režim pro sběr snímků (tools/capture_sweeps.py) — v něm se
  // lišta Matterportu ořezává, tady jen schováme vlastní panel.
  iframe.src = `${SHOWCASE_URL}?${params}`;

  try {
    const sdkUrl = CONFIG.applicationKey
      ? `${SDK_BOOTSTRAP}?applicationKey=${encodeURIComponent(CONFIG.applicationKey)}`
      : SDK_BOOTSTRAP;
    const { connect } = await import(sdkUrl);
    mpSdk = await connect(iframe);
    setDot($('sdkDot'), 'ok', 'Matterport SDK připojeno');
    await setupSweeps();
    await updateBounds();
  } catch (e) {
    console.error(e);
    const hasKey = Boolean(CONFIG.applicationKey);
    // klíč v URL chybové hlášky maskujeme
    const errText = String(e).replace(/(applicationKey=)[^&\s]+/g, '$1…');
    setDot($('sdkDot'), 'err', errText);
    const host = location.hostname;
    const domainHint =
      host && host !== 'localhost'
        ? ` Doména „${host}" není u klíče povolená — doplňte ji v Matterport Cloud`
          + ` (Settings → Developer Tools → SDK keys → upravit klíč), nebo stránku`
          + ` otevřete přes http://localhost:${location.port || 80}/.`
        : '';
    setStatus(
      hasKey
        ? `Chyba připojení SDK: ${errText}.${domainHint}`
        : 'Chyba připojení SDK — pravděpodobně chybí applicationKey (nastav MP_APPLICATION_KEY nebo matterport_api_key v .env).'
    );
  }
}

// ---------------------------------------------------------------------------
// Sweep data — pozice skanů -> rozměry modelu pro omezení formuláře
// ---------------------------------------------------------------------------
async function setupSweeps() {
  await mpSdk.Sweep.data.subscribe({
    onAdded: (_i, item) => {
      sweeps.set(item.id, item);
    },
    onRemoved: (_i, item) => {
      sweeps.delete(item.id);
      updateBounds();
    },
    onUpdated: (_i, item) => {
      sweeps.set(item.id, item);
    },
    onCollectionUpdated: () => {
      updateBounds();
    },
  });
}

function updateBounds() {
  if (sweeps.size === 0) return;
  const bb = {
    x: [Infinity, -Infinity],
    y: [Infinity, -Infinity],
    z: [Infinity, -Infinity],
  };
  for (const s of sweeps.values()) {
    for (const axis of ['x', 'y', 'z']) {
      const v = Number(s.position?.[axis]);
      if (!Number.isFinite(v)) continue;
      bb[axis][0] = Math.min(bb[axis][0], v);
      bb[axis][1] = Math.max(bb[axis][1], v);
    }
  }
  bounds = bb;

  for (const id of ['fx', 'fy', 'fz', 'flx', 'fly', 'flz']) {
    const el = $(id);
    const axis = id[1] === 'l' ? id[2] : id[1];
    if (!bounds[axis]) continue;
    el.min = bounds[axis][0].toFixed(2);
    el.max = bounds[axis][1].toFixed(2);
    el.disabled = false;
  }
  $('jumpBtn').disabled = false;
  $('boundsWarn').style.display = 'none';
  $('boundsInfo').textContent =
    `Rozměry modelu (m): X ${fmt(bounds.x)} · Y ${fmt(bounds.y)} · Z ${fmt(bounds.z)}` +
    ` — ${sweeps.size} skanů`;
  $('boundsInfo').title = $('boundsInfo').textContent;
}

function fmt(b) {
  return `${b[0].toFixed(2)}…${b[1].toFixed(2)}`;
}

function clampToBounds(value, axis) {
  if (!bounds || !bounds[axis]) return value;
  const [lo, hi] = bounds[axis];
  return Math.min(hi, Math.max(lo, value));
}

// ---------------------------------------------------------------------------
// Přesun kamery — fronta „vždy nejnovější pozice"
// ---------------------------------------------------------------------------
function handleMessage(msg) {
  // Zpráva typu {"type":"goto","point":{...}} = skok na uložený bod
  if (msg.type === 'goto' && msg.point) {
    const point = msg.point;
    $('lastMsg').textContent = `Zpráva: přesun na uložený bod „${point.name}"`;
    busy = true;
    goToPoint(point)
      .catch((e) => setStatus(`Chyba přesunu na bod: ${e}`))
      .finally(() => {
        busy = false;
        pump();
      });
    return;
  }

  // Zpráva {"type":"goto-instance","instance":{...}} = skok k fyzickému objektu
  if (msg.type === 'goto-instance' && msg.instance) {
    const inst = msg.instance;
    $('lastMsg').textContent = `Zpráva: skok k instanci „${inst.label}"`;
    busy = true;
    jumpToInstance(inst)
      .catch((e) => setStatus(`Chyba přesunu na instanci: ${e}`))
      .finally(() => {
        busy = false;
        pump();
        markActiveInstance(inst.id);
      });
    return;
  }

  $('lastMsg').textContent =
    `Poslední zpráva: pos=(${msg.position.x.toFixed(2)}, ${msg.position.y.toFixed(2)}, ` +
    `${msg.position.z.toFixed(2)}) view=${msg.view.mode} mode=${msg.mode}`;

  // Remote režim — pozice se mapuje na nejbližší sken → QA snímek místo SDK přesunu
  if (remoteMode) {
    remoteMapPosition(msg);
    return;
  }

  const target = {
    position: {
      x: Number(msg.position.x),
      y: Number(msg.position.y),
      z: Number(msg.position.z),
    },
    view: msg.view,
    mode: msg.mode === 'instant' ? 'instant' : 'smooth',
  };
  // Přijatá pozice se ořízne na rozměry modelu (stejně jako formulář)
  for (const axis of ['x', 'y', 'z']) {
    target.position[axis] = clampToBounds(target.position[axis], axis);
  }
  latestTarget = target;
  pump();
}

function pump() {
  if (busy || !latestTarget || !mpSdk) return;
  const target = latestTarget;
  latestTarget = null;
  busy = true;
  performMove(target)
    .catch((e) => {
      console.error(e);
      setStatus(`Chyba přesunu kamery: ${e}`);
    })
    .finally(() => {
      busy = false;
      pump();
    });
}

function nearestSweep(pos) {
  let best = null;
  let bestD = Infinity;
  for (const s of sweeps.values()) {
    const dx = s.position.x - pos.x;
    const dy = s.position.y - pos.y;
    const dz = s.position.z - pos.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// SDK odmítne nový přechod, dokud běží předchozí (typicky úvodní animace po
// načtení modelu) — zkusíme to znovu s rostoucím odstupem.
async function withTransitionRetry(fn, attempt = 0) {
  try {
    return await fn();
  } catch (e) {
    const conflict = /transition/i.test(String(e));
    if (conflict && attempt < 6) {
      setStatus(`Čekám na dokončení animace modelu… (pokus ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return withTransitionRetry(fn, attempt + 1);
    }
    throw e;
  }
}

async function performMove(target) {
  const sweep = nearestSweep(target.position);
  if (!sweep) {
    setStatus('Žádné skany modelu — nelze se přesunout.');
    return;
  }

  const opts = {
    transition:
      target.mode === 'instant'
        ? mpSdk.Camera.TransitionType.INSTANT
        : mpSdk.Camera.TransitionType.FLY,
    transitionTime: target.mode === 'instant' ? 0 : 1500,
  };

  if (target.view.mode === 'angles') {
    opts.rotation = {
      x: Number(target.view.pitch ?? 0),
      y: Number(target.view.yaw),
    };
  }

  await withTransitionRetry(async () => {
    await mpSdk.Sweep.moveTo(sweep.id, opts);

    if (target.view.mode === 'lookAt') {
      await mpSdk.Camera.lookAt({
        x: Number(target.view.x),
        y: Number(target.view.y),
        z: Number(target.view.z),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Uložené body — skok na přesný sken a prohlídka mezi body
// ---------------------------------------------------------------------------
let points = [];
let tour = null; // { timer, index }

async function goToPoint(point) {
  if (remoteMode) {
    remoteGoHint();
    return;
  }
  if (!mpSdk) {
    setStatus('SDK není připojeno — nelze skočit na uložený bod.');
    return;
  }
  const rot = point.rotation || { x: 0, y: 0 };
  const pos = point.position || {};
  const zero = Math.abs(pos.x || 0) + Math.abs(pos.y || 0) + Math.abs(pos.z || 0) < 1e-6;
  if (!point.sweep && zero) {
    setStatus(`Bod „${point.name}" nemá platnou pozici (model se při ukládání ještě načítal).`);
    return;
  }
  const opts = {
    transition: mpSdk.Camera.TransitionType.FLY,
    transitionTime: 1200,
    rotation: { x: Number(rot.x ?? 0), y: Number(rot.y ?? 0) },
  };

  if (point.sweep) {
    await withTransitionRetry(() => mpSdk.Sweep.moveTo(point.sweep, opts));
  } else {
    // bod bez skenu (např. z dollhouse pohledu) — vezmi nejbližší sken
    await performMove({
      position: point.position,
      view: { mode: 'angles', yaw: Number(rot.y ?? 0), pitch: Number(rot.x ?? 0) },
      mode: 'smooth',
    });
  }

  setStatus(`Přesun na bod „${point.name}".`);
  markActivePoint(point.id);
}

function markActivePoint(id) {
  for (const li of $('pointsList').querySelectorAll('li[data-id]')) {
    li.classList.toggle('active', li.dataset.id === id);
  }
}

function renderPoints() {
  const ul = $('pointsList');
  ul.innerHTML = '';
  $('pointsCount').textContent = points.length ? `(${points.length})` : '';
  $('tourBtn').disabled = points.length < 1;

  if (points.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Zatím žádné body.';
    ul.append(li);
    return;
  }

  for (const point of points) {
    const li = document.createElement('li');
    li.dataset.id = point.id;

    const name = document.createElement('span');
    name.className = 'pt-name';
    name.textContent = point.name;
    name.title = `${point.name} — sweep ${point.sweep || '—'}`;

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'pt-btn';
    go.textContent = 'Jdi';
    go.addEventListener('click', () => {
      goToPoint(point).catch((e) => setStatus(`Chyba přesunu: ${e}`));
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pt-btn';
    del.textContent = '×';
    del.title = 'Smazat bod';
    del.addEventListener('click', () => deletePoint(point.id));

    li.append(name, go, del);
    ul.append(li);
  }
}

async function loadPoints() {
  try {
    const res = await fetch('/points');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    points = (await res.json()).points || [];
    renderPoints();
  } catch (e) {
    setStatus(`Body se nepodařilo načíst: ${e}`);
  }
}

/**
 * Vrátí pose kamery, ale počká, až se model přestane přemisťovat — uložit bod
 * uprostřed animace nebo dřív, než se kamera usadí, by dalo nesmyslnou pozici
 * bez sweepu (např. 0,0,0).
 */
async function getSettledPose() {
  const isZero = (p) =>
    !p || (Math.abs(p.x) < 1e-6 && Math.abs(p.y) < 1e-6 && Math.abs(p.z) < 1e-6);
  let pose = await mpSdk.Camera.getPose();
  for (let i = 0; i < 40; i++) {
    const moving = /transitioning/i.test(pose.mode || '');
    const unplaced = isZero(pose.position) && !pose.sweep;
    if (!moving && !unplaced) break;
    setStatus('Čekám, až se kamera usadí…');
    await new Promise((r) => setTimeout(r, 500));
    pose = await mpSdk.Camera.getPose();
  }
  return pose;
}

async function savePoint() {
  if (!mpSdk) {
    setStatus('SDK není připojeno — nelze uložit pozici.');
    return;
  }
  try {
    const pose = await getSettledPose();
    const position = pose.position || { x: 0, y: 0, z: 0 };
    const placed =
      Boolean(pose.sweep) ||
      Math.abs(position.x) + Math.abs(position.y) + Math.abs(position.z) > 1e-6;
    if (!placed) {
      setStatus('Model se ještě načítá (kamera nemá pozici) — zkuste to za chvíli.');
      return;
    }

    const rotation = pose.rotation || { x: 0, y: 0 };
    // Úhly bereme z pose; když je kamera v dollhouse/floorplan režimu, sweep
    // chybí a bod se při skoku dohledá jako nejbližší sken.
    const name = $('ptName').value.trim() || `Bod ${points.length + 1}`;
    const res = await fetch('/points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        sweep: pose.sweep || '',
        position,
        rotation: { x: rotation.x ?? 0, y: rotation.y ?? 0 },
        mode: pose.mode || '',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    $('ptName').value = '';
    await loadPoints();
    markActivePoint(body.id);
    setStatus(
      `Bod „${body.name}" uložen (${body.sweep ? 'sweep ' + body.sweep : 'bez sweepu — dollhouse'}).`
    );
  } catch (e) {
    setStatus(`Bod se nepodařilo uložit: ${e}`);
  }
}

async function deletePoint(id) {
  try {
    const res = await fetch(`/points/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPoints();
    setStatus('Bod smazán.');
  } catch (e) {
    setStatus(`Bod se nepodařilo smazat: ${e}`);
  }
}

function startTour() {
  if (points.length === 0) return;
  const delay = Math.max(1, Number($('tourDelay').value) || 5) * 1000;
  tour = { timer: null, index: 0, delay };
  $('tourBtn').textContent = 'Zastavit prohlídku';
  tourStep();
}

async function tourStep() {
  if (!tour) return;
  const point = points[tour.index % points.length];
  tour.index += 1;
  try {
    await goToPoint(point);
  } catch (e) {
    setStatus(`Prohlídka: chyba u bodu „${point.name}" (${e}).`);
  }
  if (!tour) return;
  tour.timer = setTimeout(tourStep, tour.delay);
}

function stopTour() {
  if (tour?.timer) clearTimeout(tour.timer);
  tour = null;
  $('tourBtn').textContent = 'Projít body';
  setStatus('Prohlídka zastavena.');
}

// ---------------------------------------------------------------------------
// WebSocket — živý proud pozic s automatickým reconnectem
// ---------------------------------------------------------------------------
let ws = null;
let wsRetry = 0;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    wsRetry = 0;
    setDot($('wsDot'), 'ok', 'Připojeno k serveru');
  };
  ws.onclose = () => {
    setDot($('wsDot'), 'err', 'Server odpojen');
    const delay = Math.min(10000, 500 * 2 ** wsRetry++);
    setTimeout(connectWs, delay);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    try {
      handleMessage(JSON.parse(ev.data));
    } catch (e) {
      console.error('Špatná zpráva ze serveru:', ev.data, e);
    }
  };
}

// ---------------------------------------------------------------------------
// Ruční formulář
// ---------------------------------------------------------------------------
const AXIS_FIELDS = { x: 'fx', y: 'fy', z: 'fz' };
const LOOK_FIELDS = { x: 'flx', y: 'fly', z: 'flz' };

function cloudToModelLocal(pos) {
  // Zrcadlení serverové kalibrace — jen pro zobrazení ve formuláři
  const out = {};
  for (const axis of ['x', 'y', 'z']) {
    const src = (CONFIG.axisMap && CONFIG.axisMap[axis]) || axis;
    const off = (CONFIG.coordOffset && CONFIG.coordOffset[axis]) || 0;
    out[axis] = Number(pos[src] || 0) + off;
  }
  return out;
}

function updateConversion() {
  const cloud = {
    x: Number($('fx').value || 0),
    y: Number($('fy').value || 0),
    z: Number($('fz').value || 0),
  };
  const m = cloudToModelLocal(cloud);
  $('convOut').textContent = `model: x=${m.x.toFixed(2)}  y=${m.y.toFixed(2)}  z=${m.z.toFixed(2)}`;
}

function bindClamp(inputId, axis) {
  const el = $(inputId);
  el.addEventListener('change', () => {
    if (el.value === '') return;
    const v = Number(el.value);
    const clamped = clampToBounds(v, axis);
    if (clamped !== v) {
      el.value = clamped.toFixed(2);
      el.classList.add('invalid');
      setTimeout(() => el.classList.remove('invalid'), 800);
    }
    updateConversion();
  });
  el.addEventListener('input', updateConversion);
}

$('viewMode').addEventListener('change', () => {
  const mode = $('viewMode').value;
  $('lookAtFields').style.display = mode === 'lookAt' ? '' : 'none';
  $('anglesFields').style.display = mode === 'angles' ? '' : 'none';
});

$('jumpForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const mode = $('viewMode').value;
  const body = {
    position: {
      x: Number($('fx').value || 0),
      y: Number($('fy').value || 0),
      z: Number($('fz').value || 0),
    },
    view:
      mode === 'lookAt'
        ? {
            mode,
            x: Number($('flx').value || 0),
            y: Number($('fly').value || 0),
            z: Number($('flz').value || 0),
          }
        : {
            mode,
            yaw: Number($('fyaw').value || 0),
            pitch: Number($('fpitch').value || 0),
          },
    mode: document.querySelector('input[name="motion"]:checked').value,
  };
  try {
    const res = await fetch('/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setStatus(`Server odmítl pozici: ${JSON.stringify(err)}`);
    }
  } catch (e) {
    setStatus(`Server nedostupný: ${e}`);
  }
});

// ---------------------------------------------------------------------------
// Měření aktuální pozice kamery (kalibrace)
// ---------------------------------------------------------------------------
$('measureBtn').addEventListener('click', async () => {
  if (!mpSdk) {
    setStatus('SDK není připojeno — nelze změřit pozici.');
    return;
  }
  try {
    const pose = await mpSdk.Camera.getPose();
    const out = {
      position: pose.position,
      rotation: pose.rotation, // x = pitch [-90..90], y = yaw [-360..360]
      mode: pose.mode,
      sweep: pose.sweep,
    };
    const el = $('poseOut');
    el.style.display = 'block';
    el.textContent = JSON.stringify(out, (_k, v) => v, 2);
    setStatus(
      `Pozice kamery změřena — porovnejte ji se stejným místem v mraku ` +
      `(rozdíl = COORD_OFFSET, případně AXIS_MAP v app/config.py).`
    );
  } catch (e) {
    setStatus(`Měření pozice selhalo: ${e}`);
  }
});

// ---------------------------------------------------------------------------
// Záložky panelu — Body | Objekty | Inventář
// ---------------------------------------------------------------------------
let activeTab = 'points';
function switchTab(name) {
  activeTab = name;
  for (const btn of document.querySelectorAll('.tabs button[data-tab]')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.tab-panel[data-tab]')) {
    panel.hidden = panel.dataset.tab !== name;
  }
  if (name === 'objects') renderObjects(objectsSweep);
  if (name === 'inventory') loadInventory();
}
for (const btn of document.querySelectorAll('.tabs button[data-tab]')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}

// ---------------------------------------------------------------------------
// Panel zobrazit/skrýt
// ---------------------------------------------------------------------------
$('toggleHud').addEventListener('click', () => {
  const hud = $('hud');
  hud.style.display = hud.style.display === 'none' ? '' : 'none';
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
for (const [axis, id] of Object.entries(AXIS_FIELDS)) bindClamp(id, axis);
for (const [axis, id] of Object.entries(LOOK_FIELDS)) bindClamp(id, axis);
['fyaw', 'fpitch'].forEach((id) => {
  const el = $(id);
  el.addEventListener('change', () => {
    const lo = id === 'fyaw' ? -360 : -90;
    const hi = id === 'fyaw' ? 360 : 90;
    const v = Number(el.value);
    if (Number.isFinite(v)) el.value = Math.min(hi, Math.max(lo, v));
  });
});

// ---------------------------------------------------------------------------
// Uložené body — ovládání
// ---------------------------------------------------------------------------
$('savePtBtn').addEventListener('click', savePoint);
$('tourBtn').addEventListener('click', () => (tour ? stopTour() : startTour()));
$('ptName').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    savePoint();
  }
});

// ---------------------------------------------------------------------------
// Objekty rozpoznané v tomto skenu (data z objects.json → GET /objects)
// ---------------------------------------------------------------------------
let objectsIndex = null; // výstup GET /objects — {sweeps: {...}, counts: {...}}
let objectsSweep = '';   // sweep, pro který je sekce právě vykreslena

async function loadObjects() {
  try {
    const res = await fetch('/objects');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    objectsIndex = await res.json();
    if (!objectsIndex.sweep_count) objectsIndex = null; // detekce neproběhla
  } catch {
    objectsIndex = null;
  }
}

async function goToTag(sweepId, bearing) {
  if (remoteMode) {
    remoteGoHint();
    return;
  }
  if (!mpSdk) {
    setStatus('SDK není připojeno — nelze se otočit na objekt.');
    return;
  }
  await waitCameraLanded();  // úvodní přelet — viz jumpToInstance (E2E ruling)
  try {
    await withTransitionRetry(() =>
      mpSdk.Sweep.moveTo(sweepId, {
        transition: mpSdk.Camera.TransitionType.FLY,
        transitionTime: 1200,
        rotation: { x: 0, y: Number(bearing) },
      })
    );
  } catch (e) {
    setStatus(`Otočení na objekt selhalo: ${e}`);
    return;
  }
  setStatus(`Otočeno na objekt (${Number(bearing).toFixed(0)}°).`);
}

function renderObjects(sweepId) {
  objectsSweep = sweepId || '';
  const ul = $('objectsList');
  ul.innerHTML = '';
  const entry = objectsIndex?.sweeps?.[objectsSweep];
  $('objectsCount').textContent = entry?.tags?.length ? `(${entry.tags.length})` : '';

  if (!objectsIndex) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Objekty nejsou rozpoznány — spusťte tools/detect_objects.py.';
    ul.append(li);
    return;
  }
  if (!entry) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Zde nebyl rozpoznán žádný objekt.';
    ul.append(li);
    return;
  }

  const needle = $('objFilter').value.trim().toLowerCase();
  const tags = entry.tags.filter(
    (t) => !needle || t.label.toLowerCase().includes(needle) || t.category.includes(needle)
  );

  for (const tag of tags) {
    const li = document.createElement('li');
    li.className = 'obj';

    const icon = document.createElement('span');
    icon.className = 'obj-icon';
    icon.textContent = tag.icon || '❓';

    const label = document.createElement('span');
    label.className = 'pt-name obj-label';
    label.textContent = tag.label;
    label.title = `${tag.label} — ${tag.category}, jistota ${Math.round(tag.conf * 100)} %`;

    const meta = document.createElement('span');
    meta.className = 'hint';
    meta.textContent = `${Math.round(tag.conf * 100)} %` + (tag.hits > 1 ? ` · ${tag.hits}×` : '');

    // Link tagu → globální instance („tatáž věc viděná z více skenů")
    const instMatch = findInstanceByLabel(tag.label);
    if (instMatch) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'pt-btn';
      link.textContent = '↗';
      link.title =
        `Globální instance — tatáž věc viděná z ${instMatch.sweeps?.length || 0} skenů ` +
        `(hits ${instMatch.hits}); klik = skok k ní`;
      link.addEventListener('click', () => gotoInstance(instMatch));
      li.append(link);
    }

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'pt-btn';
    go.textContent = 'Jdi';
    go.title = `Otočit kameru na ${tag.label}`;
    go.addEventListener('click', () => goToTag(objectsSweep, tag.bearing));

    li.append(icon, label, meta, go);
    ul.append(li);
  }
  if (!tags.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = needle ? 'Nic neodpovídá filtru.' : 'Zde nebyl rozpoznán žádný objekt.';
    ul.append(li);
  }
}

// Sledování, kde kamera stojí — sekce se překreslí po skoku jinam.
async function watchSweep() {
  if (!mpSdk) return;
  try {
    const pose = await mpSdk.Camera.getPose();
    if ((pose.sweep || '') !== objectsSweep) renderObjects(pose.sweep);
  } catch {
    /* model se teď neusadil — zkusíme znovu za chvíli */
  }
}

// ---------------------------------------------------------------------------
// Remote režim — bez SDK (appka přes IP): QA snímky + tlačítko 3D náhled
// ---------------------------------------------------------------------------
let remoteSweeps = null;   // {sid: {position, rotation}} z /objects — pro mapu pozic

function remoteHint() {
  return CONFIG.remoteHint ||
    'Spusťte appku u sebe: docker compose up -d, nebo ssh -N -L 8017:localhost:8017 <server>';
}

function remoteGoHint() {
  setStatus('Remote režim — skok proveďte v 3D náhledu na localhost (tlačítko níže).');
}

async function remoteMapPosition(msg) {
  // pozice (mrak) → nejbližší sken → QA snímek + status „kamera stojí na <sid>, yaw <y>°"
  if (!remoteSweeps) remoteSweeps = {};
  if (!Object.keys(remoteSweeps).length && objectsIndex && objectsIndex.sweeps) {
    remoteSweeps = objectsIndex.sweeps;
  }
  let sid = null;
  let bestD = Infinity;
  for (const [sidKey, entry] of Object.entries(remoteSweeps)) {
    const p = entry.position || {};
    const d = Math.hypot(
      (p.x ?? 0) - msg.position.x, (p.y ?? 0) - msg.position.y, (p.z ?? 0) - msg.position.z
    );
    if (d < bestD) { bestD = d; sid = sidKey; }
  }
  if (!sid) {
    setStatus('Remote režim — bez objektového indexu neumím mapovat pozici na sken.');
    return;
  }
  const entry = remoteSweeps[sid] || {};
  const yaw = Number((entry.rotation || {}).y ?? 0);
  $('remoteWhere').textContent = `Kamera stojí na skenu ${sid.slice(0, 8)}…, yaw ${yaw.toFixed(0)}°`;
  const img = $('remoteSnapshot');
  const next = `/captures/${sid}/qa_yaw000.jpg`;
  // qa_*.jpg vytváří až tools/qa_overlay.py (volitelný krok) — čerstvý prostor
  // z registru overlay nemá: fallback na surový snímek + status
  img.onerror = () => {
    img.onerror = null;
    img.src = `/captures/${sid}/yaw000.jpg`;
    setStatus('Kamera stojí… — QA overlay chybí, ukazuji surový snímek (spusťte tools/qa_overlay.py)');
  };
  if (img.src !== location.origin + next) img.src = next;
  setStatus(`Kamera stojí na skenu ${sid.slice(0, 8)}…`);
}

async function setupRemote() {
  iframe.hidden = true;
  $('remoteView').hidden = false;
  setDot($('sdkDot'), 'err', 'SDK vypnuto (remote režim — bez Matterport licence)');
  setStatus('Remote režim — 3D běží jen na localhostu; zde se ukazují QA snímky.');
  $('remote3dBtn').addEventListener('click', async () => {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 3000);
      const res = await fetch('http://localhost:8017/health', { signal: ctl.signal });
      clearTimeout(to);
      if (res.ok) {
        window.open('http://localhost:8017/', '_blank');
        setStatus('3D náhled: localhost otevřen.');
        return;
      }
      setStatus(`3D náhled nedostupný (HTTP ${res.status}) — ${remoteHint()}`);
    } catch {
      setStatus(`3D náhled nedostupný — ${remoteHint()}`);
    }
  });
}

initShowcase();
// Režim sběru snímků (?capture=1): nepřipojujeme WebSocket — broadcasty cizích
// klientů (skoky jinam) by přesunuly kameru a pokazily by fotky.
const captureMode = new URLSearchParams(location.search).get('capture') === '1';
if (!captureMode) connectWs();
loadPoints();
loadObjects();
if (!captureMode) setInterval(watchSweep, 1500);

$('objFilter').addEventListener('input', () => renderObjects(objectsSweep));

// ---------------------------------------------------------------------------
// Inventář globálních instancí (data z objects.json → GET /inventory)
// ---------------------------------------------------------------------------
let inventory = null;      // výstup GET /inventory — {counts: {...}, instances: [...]}
let invCategory = '';      // aktivní kategorie (chip) — filtr seznamu
let invTour = null;        // {timer, index, delay}

async function loadInventory() {
  try {
    const res = await fetch('/inventory');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    inventory = data.instances?.length ? data : null;
    if (!inventory) {
      $('inventoryChips').innerHTML = '';
      $('inventoryCount').textContent = '';
      const ul = $('inventoryList');
      ul.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Inventář je prázdný — spusťte tools/merge_objects.py.';
      ul.append(li);
      return;
    }
    renderInventoryChips();
    renderInventory();
  } catch (e) {
    // Selhání fetch nesmí vyhodit už načtený katalog (druhé volání na přepnutí
    // tabu: pokud dojde k chybě, UI nespadne na „prázdný" — nechám stará data).
    setStatus(`Načtení inventáře selhalo (${e}) — nechám naposledy načtená data.`);
  }
}

/** Instance daného štítku — tag v sekci Objekty odkazuje na „tatáž věc". */
function findInstanceByLabel(label) {
  if (!inventory) return null;
  return (inventory.instances || []).find((i) => i.label === label) || null;
}

function renderInventoryChips() {
  const box = $('inventoryChips');
  box.innerHTML = '';
  const counts = inventory?.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  $('inventoryCount').textContent = total ? `(${total})` : '';
  // tour jen když jsou instance — jinak tlačítko zůstává zakázané (jako „Projít body")
  $('invTourBtn').disabled = !(inventory && (inventory.instances || []).length);
  const chipAll = document.createElement('button');
  chipAll.type = 'button';
  chipAll.className = 'chip' + (invCategory ? '' : ' active');
  chipAll.textContent = 'všechny';
  chipAll.addEventListener('click', () => { invCategory = ''; renderInventoryChips(); renderInventory(); });
  box.append(chipAll);
  for (const cat of Object.keys(counts).sort()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (cat === invCategory ? ' active' : '');
    chip.title = `Jen kategorie „${cat}"`;
    const name = document.createElement('span');
    name.textContent = cat;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = counts[cat];
    chip.append(name, n);
    chip.addEventListener('click', () => { invCategory = cat; renderInventoryChips(); renderInventory(); });
    box.append(chip);
  }
}

/** Pozice kamery v souřadnicích mraku (pro řazení dle vzdálenosti). */
async function cameraPosition(timeoutMs = 600) {
  if (!mpSdk) return null;
  try {
    // getPose() visí, když je panel s iframem SDK skrytý (throttling — klik na
    // jinou záložku). Řazení dle vzdálenosti je jen zkrášlení — s krátkým
    // timeoutem nenechám dotaz blokovat celý render inventáře.
    const posePromise = mpSdk.Camera.getPose().catch(() => null);
    const t = new Promise((r) => setTimeout(() => r(null), timeoutMs));
    const pose = await Promise.race([posePromise, t]);
    // Srovnávat s instancemi (souřadnice mraku) lze jen v režimu inside —
    // v dollhouse/floorplan je pozice world souřadnice kamery, ne bod v modelu.
    if (!pose || !/inside/i.test(pose.mode || '')) return null;
    const pos = pose.position || {};
    const x = Number(pos.x), y = Number(pos.y), z = Number(pos.z);
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-6) return null; // model se načítá
    return { x, y, z };
  } catch {
    return null;
  }
}

async function renderInventory() {
  const ul = $('inventoryList');
  ul.innerHTML = '';
  if (!inventory) return;

  const camPos = await cameraPosition();
  let insts = invSelection();
  if (camPos) {
    const dist = (i) => Math.hypot(
      i.pozice.x - camPos.x, i.pozice.y - camPos.y, i.pozice.z - camPos.z
    );
    insts = [...insts].sort((a, b) => dist(a) - dist(b));
  }

  for (const inst of insts) {
    const li = document.createElement('li');
    li.className = 'inst';
    li.dataset.id = inst.id;

    const icon = document.createElement('span');
    icon.className = 'obj-icon';
    icon.textContent = inst.ikona || '❓';

    const name = document.createElement('span');
    name.className = 'inst-name';
    const views = inst.sweeps?.length || 0;
    name.textContent = inst.label + (views > 1 ? ` ×${views} skenů` : '');
    name.title =
      `${inst.label} — ${inst.kategorie} · hits ${inst.hits} · jistota ${Math.round(inst.max_conf * 100)} %` +
      `\nPozice (m): x ${inst.pozice.x}, y ${inst.pozice.y}, z ${inst.pozice.z}`;

    const meta = document.createElement('span');
    meta.className = 'hint';
    meta.textContent = `${Math.round(inst.max_conf * 100)} %` + (inst.hits > 1 ? ` · ${inst.hits}×` : '');
    if (camPos) {
      const d = Math.hypot(
        inst.pozice.x - camPos.x, inst.pozice.y - camPos.y, inst.pozice.z - camPos.z
      );
      meta.textContent += ` · ${d.toFixed(1)} m`;
    }

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'pt-btn';
    go.textContent = 'Jdi';
    go.title = `Skočit k ${inst.label} (nejlepší sken + směr na objekt)`;
    go.addEventListener('click', () => gotoInstance(inst));

    li.append(icon, name, meta, go);
    ul.append(li);
  }
  if (!insts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = $('invFilter').value.trim() || invCategory
      ? 'Nic neodpovídá filtru.' : 'Inventář je prázdný.';
    ul.append(li);
  }
  // tour + „Uložit jako body" dle aktuálního výběru (chip/filtr)
  $('invTourBtn').textContent = tourButtonLabel();
  const saveLabel = invSaveLabel();
  $('invSaveBtn').disabled = !saveLabel;
  $('invSaveBtn').title = saveLabel
    ? `Uložit ${insts.length} instancí štítku „${saveLabel}" jako body (Projít body je projede)`
    : 'Jen pro jednotný štítek — zvol chip nebo filtr (např. „hasicí")';
}

function markActiveInstance(id) {
  for (const li of $('inventoryList').querySelectorAll('li[data-id]')) {
    li.classList.toggle('active', li.dataset.id === id);
  }
}

async function gotoInstance(inst) {
  try {
    const res = await fetch(`/goto-instance/${inst.id}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Skočím k instanci „${inst.label}"…`);
  } catch (e) {
    setStatus(`Skok na instanci selhal: ${e}`);
  }
}

// Úvodní přelet modelu (intro) běží i po ready() — moveTo skok v jeho cestě
// přechodový konflikt zruší a kamera skončí na úvodní animaci. Počkat, až
// kamera přistane na nějakém skenu, teprve pak skákat (E2E ruling 2026-10).
async function waitCameraLanded(timeoutMs = 20000) {
  if (!mpSdk) return null;
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    try {
      // getPose() visí, když je panel s iframem skrytý (throttling) — stejný
      // timeout jako cameraPosition(), ať jeden pomalý dotaz nezahltí cyklus
      const pose = await Promise.race([
        mpSdk.Camera.getPose().catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 600)),
      ]);
      if (pose && pose.sweep) return pose;
    } catch (e) { /* intro — počkám na další cyklus */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function jumpToInstance(inst) {
  // Volá se z WS zprávy goto-instance — skok na sken s nejvyšší jistotou + otočení
  if (remoteMode) {
    remoteGoHint();
    return;
  }
  if (!mpSdk) {
    setStatus('SDK není připojeno — nelze skočit k instanci.');
    return;
  }
  await waitCameraLanded();
  const entry = (inst.sweeps || []).slice().sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0))[0];
  if (!entry || !entry.sweep) {
    setStatus(`Instance „${inst.label}" nemá žádný sken.`);
    return;
  }
  const bearing = Number(entry.bearing ?? 0);
  try {
    await withTransitionRetry(() =>
      mpSdk.Sweep.moveTo(entry.sweep, {
        transition: mpSdk.Camera.TransitionType.FLY,
        transitionTime: 1200,
        rotation: { x: 0, y: bearing },
      })
    );
  } catch (e) {
    setStatus(`Skok na instanci selhal: ${e}`);
    return;
  }
  setStatus(`Kameru otočím na „${inst.label}" (${bearing.toFixed(0)}°).`);
  markActiveInstance(inst.id);
}

// Prohlídka kolem vybraných instancí (chip/filtr omezuje výběr; mechanika
// jako „Projít body" — E2E ruling: kroky tour dle aktuálního filtru)
function invSelection() {
  if (!inventory) return [];
  const needle = $('invFilter').value.trim().toLowerCase();
  return (inventory.instances || []).filter(
    (i) => (!invCategory || i.kategorie === invCategory) &&
      (!needle || i.label.toLowerCase().includes(needle) || i.kategorie.includes(needle))
  );
}

function tourButtonLabel() {
  const sel = invSelection();
  const all = (inventory?.instances || []).length;
  return sel.length === all || all === 0 ? 'Provést kolem všech' : 'Provést kolem vybraných';
}

/** Jde výběr uložit jako body? (všechny instance stejného štítku) */
function invSaveLabel() {
  const sel = invSelection();
  if (!sel.length) return null;
  const labels = new Set(sel.map((i) => i.label));
  return labels.size === 1 ? [...labels][0] : null;
}

function startInvTour() {
  if (!inventory || !(inventory.instances || []).length) return;
  const sel = invSelection();
  if (!sel.length) {
    setStatus('Prohlídka: žádná vybraná instance (filtr „všechny" = celý katalog).');
    return;
  }
  const delay = Math.max(1, Number($('invTourDelay').value) || 5) * 1000;
  invTour = { timer: null, index: 0, delay, sel };
  $('invTourBtn').textContent = 'Zastavit prohlídku';
  invTourStep();
}

async function invTourStep() {
  if (!invTour || !inventory) return;
  const sel = invTour.sel || (inventory.instances || []);
  const inst = sel[invTour.index % sel.length];
  invTour.index += 1;
  if (!inst) { stopInvTour(); return; }
  try {
    await jumpToInstance(inst);
  } catch (e) {
    setStatus(`Prohlídka: chyba u „${inst.label}" (${e}).`);
  }
  if (!invTour) return;
  invTour.timer = setTimeout(invTourStep, invTour.delay);
}

function stopInvTour() {
  if (invTour?.timer) clearTimeout(invTour.timer);
  invTour = null;
  $('invTourBtn').textContent = tourButtonLabel();
  setStatus('Prohlídka inventáře zastavena.');
}

$('invTourBtn').addEventListener('click', () => (invTour ? stopInvTour() : startInvTour()));
$('invFilter').addEventListener('input', () => renderInventory());

// „Uložit jako body" — vybrané instance štítku jako pojmenované body („<label> <n>"),
// prohlédnutelné stávajícím „Projít body"
$('invSaveBtn').addEventListener('click', async () => {
  const label = invSaveLabel();
  if (!label) {
    setStatus('„Uložit jako body" jen pro jednotný štítek — použij chip nebo filtr.');
    return;
  }
  try {
    const res = await fetch(`/inventory/save-as-points/${encodeURIComponent(label)}`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    setStatus(`Uloženo ${body.saved} bodů („${label}") — „Projít body" je projede.`);
    loadPoints();
  } catch (e) {
    setStatus(`Uložení jako body selhalo: ${e}`);
  }
});
loadInventory();

// „Export IFC" — stáhne export.ifc (IFC 4) generovaný serverem on-demand
$('invExportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/export/ifc');
    if (res.status === 404) {
      setStatus('Export IFC: inventář je prázdný — spusťte tools/merge_objects.py.');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'export.ifc';
    a.click();
    // revoke později — okamžitý revoke může v některých prohlížečích zrušit download
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus('IFC 4 export stažen (export.ifc) — import v Revit/Blender.');
  } catch (e) {
    setStatus(`Export IFC selhal: ${e}`);
  }
});

// ---------------------------------------------------------------------------
// Automatizační rozhraní (používá tools/capture_sweeps.py — sběr snímků skenů)
// ---------------------------------------------------------------------------
window.__mp = {
  sdk: () => mpSdk,
  ready: () => Boolean(mpSdk) && sweeps.size > 0,
  sweeps: () =>
    [...sweeps.values()].map((s) => ({
      id: s.id,
      position: s.position,
      rotation: s.rotation,
      neighbors: s.neighbors,
    })),
  hideUi: () => {
    $('hud').style.display = 'none';
    $('toggleHud').style.display = 'none';
  },
  go: async (sweepId, yaw) => {
    await withTransitionRetry(() =>
      mpSdk.Sweep.moveTo(sweepId, {
        transition: mpSdk.Camera.TransitionType.INSTANT,
        transitionTime: 0,
        rotation: { x: 0, y: Number(yaw) },
      })
    );
  },
  // Počká, až kamera stojí na místě (žádný přechod) — jinak je snímek rozmazaný
  // nebo z půlky cesty.
  settle: async (timeoutMs = 8000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const pose = await mpSdk.Camera.getPose();
      if (!/transitioning/i.test(pose.mode || '')) return pose;
      await new Promise((r) => setTimeout(r, 120));
    }
    return mpSdk.Camera.getPose();
  },
};
