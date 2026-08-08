/* ============================================================
   Visitas — CRM de voz (versión web / PWA)
   ============================================================ */

// Sube este número en cada cambio: sirve para saber qué versión tiene el móvil.
// OJO: al subir este número hay que subir también el ?v= de index.html
// (styles.css y app.js) y el CACHE de sw.js.
const APP_VERSION = 13;

// ---------------- Utilidades ----------------
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtMillis(ms) {
  const t = Math.floor((ms || 0) / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}

// ---------------- Almacenamiento ----------------
// Datos (clientes/visitas) -> localStorage. Audios (blobs) -> IndexedDB.
const LS_CLIENTS = 'visitasvoz.clients';
const LS_VISITS = 'visitasvoz.visits';

const DB = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      const req = indexedDB.open('visitas-voz', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('audios');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return this._p;
  },
  async put(key, blob) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('audios', 'readwrite');
      tx.objectStore('audios').put(blob, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = db.transaction('audios', 'readonly').objectStore('audios').get(key);
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => rej(req.error);
    });
  },
  async del(key) {
    const db = await this.open();
    return new Promise((res) => {
      const tx = db.transaction('audios', 'readwrite');
      tx.objectStore('audios').delete(key);
      tx.oncomplete = res;
      tx.onerror = res;
    });
  },
};

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
}
function saveJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

// ---------------- Estado ----------------
let clients = loadJSON(LS_CLIENTS);
let visits = loadJSON(LS_VISITS);
let pending = null;          // grabación esperando cliente
let tab = 'grabar';
let openClientId = null;
let openVisitId = null;
let chatMessages = [];
let chatLoading = false;

// Marca de tiempo: al fusionar con la nube gana la versión más reciente
const ahora = () => new Date().toISOString();

function persistClients() { saveJSON(LS_CLIENTS, clients); }
function persistVisits() { saveJSON(LS_VISITS, visits); }
function clientName(id) {
  const c = clients.find((x) => x.id === id);
  return c ? c.nombre : 'Sin cliente';
}

// ---------------- IA (Groq) ----------------
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const LS_KEY = 'visitasvoz.groqkey';

// La clave NO está en el código: vive solo en este dispositivo.
function getKey() {
  return (localStorage.getItem(LS_KEY) || '').trim();
}
function requireKey() {
  const k = getKey();
  if (!k) throw new Error('Falta tu clave de Groq. Ve a Ajustes y pégala para activar la IA.');
  return k;
}

function extFor(mime) {
  if (!mime) return 'm4a';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  return 'm4a';
}

async function transcribeAudio(blob) {
  const key = requireKey();
  const form = new FormData();
  form.append('file', blob, `audio.${extFor(blob.type)}`);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'es');
  form.append('response_format', 'json');

  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcripción falló (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return (data.text || '').trim();
}

async function structureSummary(transcript, hoy) {
  const key = requireKey();
  const system =
    'Eres un asistente que organiza notas de visitas comerciales. A partir de la ' +
    'transcripción de una nota de voz que un comercial graba tras una reunión, ' +
    'extraes la información clave. Respondes SOLO con JSON válido.';

  const user =
    `Fecha de hoy: ${hoy}.\n` +
    `Transcripción de la nota de voz del comercial:\n"""${transcript}"""\n\n` +
    `Devuelve un objeto JSON con EXACTAMENTE estos campos:\n` +
    `{\n` +
    `  "resumen": "2-3 frases con lo esencial de la visita",\n` +
    `  "puntosClave": ["punto relevante 1", "punto 2"],\n` +
    `  "proximosPasos": ["acción pendiente 1", "acción 2"],\n` +
    `  "fechaSeguimiento": "fecha YYYY-MM-DD si se menciona o deduce un seguimiento ` +
    `(calcula fechas relativas tipo 'en dos semanas' a partir de hoy), o null"\n` +
    `}\n` +
    `Si un campo no tiene información usa [] o null. Todo en español.`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Resumen falló (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const p = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  return {
    resumen: p.resumen || '',
    puntosClave: Array.isArray(p.puntosClave) ? p.puntosClave : [],
    proximosPasos: Array.isArray(p.proximosPasos) ? p.proximosPasos : [],
    fechaSeguimiento: p.fechaSeguimiento || null,
  };
}

function buildContext() {
  const lines = [`CLIENTES (${clients.length}):`];
  clients.forEach((c) => lines.push(`- ${c.nombre}${c.empresa ? ` (${c.empresa})` : ''}`));
  lines.push('', `VISITAS (${visits.length}), más recientes primero:`);
  visits.forEach((v) => {
    const parts = [`[${new Date(v.fecha).toISOString().slice(0, 10)}] Cliente: ${clientName(v.clientId)}`];
    if (v.resumen) parts.push(`Resumen: ${v.resumen}`);
    if (v.puntosClave?.length) parts.push(`Puntos clave: ${v.puntosClave.join('; ')}`);
    if (v.proximosPasos?.length) parts.push(`Próximos pasos: ${v.proximosPasos.join('; ')}`);
    if (v.fechaSeguimiento) parts.push(`Fecha de seguimiento: ${v.fechaSeguimiento}`);
    lines.push(parts.join(' | '));
  });
  return lines.join('\n');
}

async function askAboutData(historial) {
  const key = requireKey();
  const hoy = new Date().toISOString().slice(0, 10);
  const system =
    'Eres el asistente personal de una comercial. Respondes preguntas sobre sus ' +
    'visitas y clientes usando EXCLUSIVAMENTE los datos de abajo. Si un dato no ' +
    'aparece, dilo con claridad en vez de inventarlo. Cuenta y filtra por fechas ' +
    'cuando te lo pidan (formato YYYY-MM-DD). Responde en español, breve y directo. ' +
    `Hoy es ${hoy}.\n\n===== DATOS =====\n${buildContext()}`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, ...historial],
    }),
  });
  if (!res.ok) throw new Error(`Consulta falló (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// ---------------- Grabación ----------------
let mediaRecorder = null;
let chunks = [];
let stream = null;
let startTime = 0;
let timerInterval = null;
let isRecording = false;

function pickMime() {
  const opts = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  for (const t of opts) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Este navegador no permite grabar audio. Recuerda que Safari exige HTTPS para usar el micrófono.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert('No se pudo acceder al micrófono: ' + (e.message || e));
    return;
  }
  const mime = pickMime();
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.start();

  isRecording = true;
  startTime = Date.now();
  $('record-btn').classList.add('recording');
  $('record-hint').textContent = 'Grabando… pulsa para parar';
  $('timer').classList.add('active');
  timerInterval = setInterval(() => {
    $('timer').textContent = fmtMillis(Date.now() - startTime);
  }, 200);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  isRecording = false;
  clearInterval(timerInterval);
  $('record-btn').classList.remove('recording');
  $('record-hint').textContent = 'Toca el círculo';
  $('timer').classList.remove('active');
}

async function onRecordingStopped() {
  const duracion = Date.now() - startTime;
  const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/mp4' });
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('timer').textContent = '00:00';

  const id = String(Date.now());
  await DB.put(id, blob);
  pending = { id, duracion, fecha: new Date().toISOString() };
  openAssign();
}

// ---------------- Reproducción ----------------
let currentAudio = null;
async function playVisit(id) {
  const blob = await DB.get(id);
  if (!blob) { alert('No se encontró el audio de esta visita.'); return; }
  if (currentAudio) { currentAudio.pause(); URL.revokeObjectURL(currentAudio.src); }
  currentAudio = new Audio(URL.createObjectURL(blob));
  currentAudio.play().catch((e) => alert('No se pudo reproducir: ' + e.message));
}

// ---------------- Procesar visita con IA ----------------
async function procesarVisita(id) {
  updateVisit(id, { estado: 'procesando', errorMsg: '' });
  try {
    const blob = await DB.get(id);
    if (!blob) throw new Error('No se encontró el audio guardado.');
    const transcripcion = await transcribeAudio(blob);
    const hoy = new Date().toISOString().slice(0, 10);
    const est = await structureSummary(transcripcion, hoy);
    updateVisit(id, { transcripcion, ...est, estado: 'listo' });
  } catch (e) {
    updateVisit(id, { estado: 'error', errorMsg: String(e.message || e) });
  }
}

function updateVisit(id, patch) {
  visits = visits.map((v) =>
    (v.id === id ? { ...v, ...patch, actualizadoEn: ahora() } : v));
  persistVisits();
  render();
  sincronizarSuave();
}

async function eliminarVisita(id) {
  if (!confirm('¿Eliminar esta visita y su audio? No se puede deshacer.')) return;
  await DB.del(id);
  visits = visits.filter((v) => v.id !== id);
  persistVisits();
  openVisitId = null;
  render();
  Nube.borrar('visitas', id);
}

// ---------------- Sincronización con la nube ----------------
let sincronizando = false;
let ultimaSync = null;
let avisoSync = '';
let temporizadorSync = null;

// Sincroniza sin molestar: si no hay cuenta o falla la red, no pasa nada.
// Se agrupa con un pequeño retardo para no llamar en cada tecla.
function sincronizarSuave() {
  if (!Nube.configurada() || !Nube.sesion()) return;
  clearTimeout(temporizadorSync);
  temporizadorSync = setTimeout(() => sincronizar(false), 1500);
}

async function sincronizar(mostrarErrores) {
  if (sincronizando || !Nube.configurada() || !Nube.sesion()) return;
  sincronizando = true;
  avisoSync = '';
  renderAjustes();
  const r = await Nube.sincronizar(clients, visits);
  if (r.ok) {
    clients = r.clientes;
    visits = r.visitas;
    persistClients();
    persistVisits();
    ultimaSync = new Date();
    avisoSync = '';
  } else if (r.motivo === 'error') {
    avisoSync = mostrarErrores ? r.error : 'Sin conexión: se guardó en el móvil.';
  }
  sincronizando = false;
  render();
}

// ---------------- Modal asignar ----------------
function openAssign() {
  $('assign-sub').textContent = `Grabación de ${fmtMillis(pending.duracion)}`;
  $('assign-search').value = '';
  $('new-nombre').value = '';
  $('new-empresa').value = '';
  $('assign-create-btn').disabled = true;
  setAssignMode(clients.length === 0 ? 'create' : 'pick');
  $('assign-overlay').hidden = false;
  renderAssignList();
}

function setAssignMode(mode) {
  $('assign-pick').hidden = mode !== 'pick';
  $('assign-create').hidden = mode !== 'create';
  $('assign-back-btn').hidden = clients.length === 0;
}

function renderAssignList() {
  const q = $('assign-search').value.trim().toLowerCase();
  const f = clients.filter((c) => c.nombre.toLowerCase().includes(q));
  $('assign-list').innerHTML = f.length
    ? f.map((c) => `
        <div class="pick-row" data-assign="${esc(c.id)}">
          <div class="avatar">${esc(c.nombre.charAt(0).toUpperCase())}</div>
          <div>${esc(c.nombre)}${c.empresa ? ' · ' + esc(c.empresa) : ''}</div>
        </div>`).join('')
    : '<p class="empty">Sin coincidencias</p>';
}

function asignarVisita(clientId) {
  if (!pending) return;
  visits = [{
    id: pending.id,
    clientId,
    fecha: pending.fecha,
    duracion: pending.duracion,
    estado: 'procesando',
    transcripcion: '', resumen: '',
    puntosClave: [], proximosPasos: [],
    fechaSeguimiento: null, errorMsg: '',
    actualizadoEn: ahora(),
  }, ...visits];
  persistVisits();
  const id = pending.id;
  pending = null;
  $('assign-overlay').hidden = true;
  render();
  procesarVisita(id);
}

async function descartarPending() {
  if (pending) await DB.del(pending.id);
  pending = null;
  $('assign-overlay').hidden = true;
}

// ---------------- Render ----------------
function badge(v) {
  if (v.estado === 'procesando') return '<span class="badge proc">Procesando…</span>';
  if (v.estado === 'error') return '<span class="badge err">Error</span>';
  return '';
}

function visitRow(v, titulo, sub) {
  return `
    <div class="row" data-visit="${esc(v.id)}">
      <div class="info">
        <div class="name">${esc(titulo)}</div>
        <div class="meta">${esc(sub)}</div>
      </div>
      ${badge(v)}
      <span class="chev">›</span>
    </div>`;
}

function render() {
  // Qué pantalla mostrar
  const showVisit = !!openVisitId;
  const showClient = !showVisit && !!openClientId;
  $('screen-visita').hidden = !showVisit;
  $('screen-cliente').hidden = !showClient;
  $('screen-grabar').hidden = showVisit || showClient || tab !== 'grabar';
  $('screen-clientes').hidden = showVisit || showClient || tab !== 'clientes';
  $('screen-preguntar').hidden = showVisit || showClient || tab !== 'preguntar';
  $('screen-ajustes').hidden = showVisit || showClient || tab !== 'ajustes';
  $('tabbar').hidden = showVisit || showClient;

  // Avisos: falta la clave de IA / los datos no están en la nube
  $('no-key-bar').hidden = !!getKey();
  const sinNube = Nube.configurada() && !Nube.sesion();
  $('no-cloud-bar').hidden = !sinNube;
  renderAjustes();

  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));

  // --- Grabar: últimas visitas ---
  const recientes = visits.slice(0, 8);
  $('recent-list').innerHTML = recientes.length
    ? recientes.map((v) => visitRow(
        v,
        clientName(v.clientId),
        v.estado === 'listo' && v.resumen
          ? v.resumen
          : `${fmtDate(v.fecha)} · ${fmtMillis(v.duracion)}`
      )).join('')
    : '<p class="empty">Aún no hay visitas guardadas</p>';

  // --- Clientes ---
  $('clientes-count').textContent =
    `${clients.length} ${clients.length === 1 ? 'cliente' : 'clientes'}`;
  $('clients-list').innerHTML = clients.length
    ? clients.map((c) => {
        const n = visits.filter((v) => v.clientId === c.id).length;
        return `
          <div class="row" data-client="${esc(c.id)}">
            <div class="avatar">${esc(c.nombre.charAt(0).toUpperCase())}</div>
            <div class="info">
              <div class="name">${esc(c.nombre)}</div>
              <div class="meta">${c.empresa ? esc(c.empresa) + ' · ' : ''}${n} ${n === 1 ? 'visita' : 'visitas'}</div>
            </div>
            <span class="chev">›</span>
          </div>`;
      }).join('')
    : '<p class="empty">Todavía no hay clientes. Graba una visita y crea el primero.</p>';

  // --- Detalle de cliente ---
  if (showClient) {
    const c = clients.find((x) => x.id === openClientId);
    if (c) {
      const vs = visits.filter((v) => v.clientId === c.id)
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      $('cliente-nombre').textContent = c.nombre;
      $('cliente-empresa').textContent = c.empresa || '';
      $('cliente-visitas-title').textContent = `Visitas (${vs.length})`;
      $('cliente-visitas').innerHTML = vs.length
        ? vs.map((v) => visitRow(
            v, fmtDate(v.fecha),
            v.estado === 'listo' && v.resumen ? v.resumen : `Duración ${fmtMillis(v.duracion)}`
          )).join('')
        : '<p class="empty">Este cliente no tiene visitas todavía</p>';
    }
  }

  // --- Detalle de visita ---
  if (showVisit) renderVisitDetail();

  // --- Chat ---
  renderChat();
}

function renderVisitDetail() {
  const v = visits.find((x) => x.id === openVisitId);
  if (!v) { openVisitId = null; return; }
  $('visita-cliente').textContent = clientName(v.clientId);
  $('visita-fecha').textContent = fmtDate(v.fecha);

  let html = `
    <div class="play-bar" data-play="${esc(v.id)}">
      <div class="play-circle">▶</div>
      <div>Escuchar audio · ${fmtMillis(v.duracion)}</div>
    </div>`;

  if (v.estado === 'procesando') {
    html += `<div class="proc-box"><span class="sub">Transcribiendo y resumiendo con IA…</span></div>`;
  } else if (v.estado === 'error') {
    html += `
      <div class="err-box">
        <strong>No se pudo procesar</strong>
        <p class="msg">${esc(v.errorMsg)}</p>
        <button class="primary" data-retry="${esc(v.id)}">Reintentar</button>
      </div>`;
  } else if (v.estado === 'listo') {
    if (v.resumen) {
      html += `<div class="section"><h3>Resumen</h3><p class="body-text">${esc(v.resumen)}</p></div>`;
    }
    if (v.puntosClave?.length) {
      html += `<div class="section"><h3>Puntos clave</h3>${
        v.puntosClave.map((p) => `<p class="bullet">• ${esc(p)}</p>`).join('')}</div>`;
    }
    if (v.proximosPasos?.length) {
      html += `<div class="section"><h3>Próximos pasos</h3>${
        v.proximosPasos.map((p) => `<p class="bullet">☐ ${esc(p)}</p>`).join('')}</div>`;
    }
    if (v.fechaSeguimiento) {
      html += `<div class="section"><h3>Seguimiento</h3><p class="seguimiento">📅 ${esc(fmtDay(v.fechaSeguimiento))}</p></div>`;
    }
    if (v.transcripcion) {
      html += `
        <button class="trans-toggle" id="trans-toggle">▸ Ver transcripción completa</button>
        <p class="trans-text" id="trans-text" hidden>${esc(v.transcripcion)}</p>`;
    }
  }

  html += `<button class="delete-btn" data-delete="${esc(v.id)}">Eliminar visita</button>`;
  $('visita-body').innerHTML = html;

  const tt = $('trans-toggle');
  if (tt) tt.onclick = () => {
    const p = $('trans-text');
    p.hidden = !p.hidden;
    tt.textContent = p.hidden ? '▸ Ver transcripción completa' : '▾ Ocultar transcripción';
  };
}

function renderAjustes() {
  const k = getKey();
  const st = $('key-state');
  if (!st) return; // HTML antiguo en caché: evitamos romper el resto

  const input = $('key-input');
  const guardar = $('key-save');
  const ver = $('key-show');

  if (k) {
    st.textContent = `✓ Clave guardada (termina en …${k.slice(-4)})`;
    st.className = 'key-state ok';
    $('key-clear').hidden = false;
    // Con una clave guardada no hay nada que escribir: se bloquea el campo
    // para no tocarla sin querer. Para cambiarla, primero hay que borrarla.
    input.value = '';
    input.disabled = true;
    input.type = 'password';
    input.placeholder = 'Clave configurada · bórrala para cambiarla';
    guardar.disabled = true;
    ver.checked = false;
    ver.disabled = true;
  } else {
    st.textContent = '✗ Sin clave: transcripción y resúmenes desactivados';
    st.className = 'key-state ko';
    $('key-clear').hidden = true;
    input.disabled = false;
    input.placeholder = 'gsk_…';
    guardar.disabled = false;
    ver.disabled = false;
  }
  const nv = visits.length;
  const nc = clients.length;
  $('stats-text').textContent =
    `${nc} ${nc === 1 ? 'cliente' : 'clientes'} y ${nv} ${nv === 1 ? 'visita' : 'visitas'} ` +
    `guardados en este móvil.`;
  const vt = $('version-text');
  if (vt) vt.textContent = `Versión ${APP_VERSION}`;
  renderCuenta();
}

// Estado de la cuenta y de la copia en la nube
function renderCuenta() {
  const fuera = $('cuenta-fuera');
  const dentro = $('cuenta-dentro');
  if (!fuera || !dentro) return;

  const u = Nube.usuario();
  fuera.hidden = !!u;
  dentro.hidden = !u;

  if (u) {
    $('cuenta-quien').textContent = `✓ Copia activa · ${u.email}`;
    const btn = $('cuenta-sync');
    btn.disabled = sincronizando;
    btn.textContent = sincronizando ? 'Sincronizando…' : 'Sincronizar ahora';
    if (avisoSync) {
      $('cuenta-estado').textContent = `⚠️ ${avisoSync}`;
    } else if (ultimaSync) {
      $('cuenta-estado').textContent =
        'Última sincronización: ' +
        ultimaSync.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    } else {
      $('cuenta-estado').textContent =
        'Tus clientes y visitas se guardan también en la nube. Los audios se quedan en este móvil.';
    }
  }
}

const EJEMPLOS = [
  '¿Cuántas visitas hice este mes?',
  '¿Qué seguimientos tengo pendientes?',
  '¿Qué clientes están preocupados por el precio?',
];

function renderChat() {
  const log = $('chat-log');
  if (!chatMessages.length && !chatLoading) {
    log.innerHTML = '<p class="empty">Prueba a preguntar:</p>' +
      EJEMPLOS.map((e) => `<button class="ejemplo" data-ej="${esc(e)}">${esc(e)}</button>`).join('');
    return;
  }
  log.innerHTML =
    chatMessages.map((m) =>
      `<div class="bubble ${m.role === 'user' ? 'user' : 'bot'}">${esc(m.content)}</div>`).join('') +
    (chatLoading ? '<div class="bubble bot">…</div>' : '');
  log.scrollTop = log.scrollHeight;
}

async function enviarPregunta(texto) {
  const q = (texto ?? $('chat-input').value).trim();
  if (!q || chatLoading) return;
  chatMessages.push({ role: 'user', content: q });
  $('chat-input').value = '';
  chatLoading = true;
  renderChat();
  try {
    const r = await askAboutData(chatMessages);
    chatMessages.push({ role: 'assistant', content: r });
  } catch (e) {
    chatMessages.push({ role: 'assistant', content: '⚠️ ' + (e.message || e) });
  }
  chatLoading = false;
  renderChat();
}

// ---------------- Eventos ----------------
$('record-btn').onclick = () => (isRecording ? stopRecording() : startRecording());

document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => { tab = b.dataset.tab; openClientId = null; openVisitId = null; render(); };
});

document.querySelectorAll('[data-back]').forEach((b) => {
  b.onclick = () => { openClientId = null; render(); };
});
$('visita-back').onclick = () => { openVisitId = null; render(); };

// Delegación de clics en listas
document.addEventListener('click', (e) => {
  const visit = e.target.closest('[data-visit]');
  if (visit) { openVisitId = visit.dataset.visit; render(); return; }

  const client = e.target.closest('[data-client]');
  if (client) { openClientId = client.dataset.client; render(); return; }

  const playEl = e.target.closest('[data-play]');
  if (playEl) { playVisit(playEl.dataset.play); return; }

  const del = e.target.closest('[data-delete]');
  if (del) { eliminarVisita(del.dataset.delete); return; }

  const retry = e.target.closest('[data-retry]');
  if (retry) { procesarVisita(retry.dataset.retry); return; }

  const assign = e.target.closest('[data-assign]');
  if (assign) { asignarVisita(assign.dataset.assign); return; }

  const ej = e.target.closest('[data-ej]');
  if (ej) { enviarPregunta(ej.dataset.ej); return; }
});

// Modal
$('assign-search').oninput = renderAssignList;
$('assign-new-btn').onclick = () => setAssignMode('create');
$('assign-back-btn').onclick = () => setAssignMode('pick');
$('new-nombre').oninput = () => {
  $('assign-create-btn').disabled = !$('new-nombre').value.trim();
};
$('assign-create-btn').onclick = () => {
  const nombre = $('new-nombre').value.trim();
  if (!nombre) return;
  const nuevo = {
    id: 'c' + Date.now(), nombre,
    empresa: $('new-empresa').value.trim(),
    actualizadoEn: ahora(),
  };
  clients = [nuevo, ...clients];
  persistClients();
  asignarVisita(nuevo.id);
};
$('assign-discard').onclick = descartarPending;

// ---------------- Cuenta ----------------
$('no-cloud-bar').onclick = () => { tab = 'ajustes'; render(); };

function datosCuenta() {
  const email = $('cuenta-email').value.trim();
  const pass = $('cuenta-pass').value;
  if (!email || !pass) {
    $('cuenta-msg').textContent = 'Escribe tu correo y tu contraseña.';
    $('cuenta-msg').className = 'key-state ko';
    return null;
  }
  return { email, pass };
}

async function accionCuenta(boton, accion) {
  const d = datosCuenta();
  if (!d) return;
  const textoOriginal = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Un momento…';
  $('cuenta-msg').textContent = '';
  try {
    const aviso = await accion(d.email, d.pass);
    $('cuenta-pass').value = '';
    if (aviso) {
      $('cuenta-msg').textContent = aviso;
      $('cuenta-msg').className = 'key-state ko';
    } else {
      $('cuenta-email').value = '';
      render();
      await sincronizar(true);
    }
  } catch (e) {
    $('cuenta-msg').textContent = String(e.message || e);
    $('cuenta-msg').className = 'key-state ko';
  } finally {
    boton.disabled = false;
    boton.textContent = textoOriginal;
  }
}

$('cuenta-entrar').onclick = (e) =>
  accionCuenta(e.target, async (email, pass) => {
    await Nube.entrar(email, pass);
    return null;
  });

$('cuenta-registrar').onclick = (e) =>
  accionCuenta(e.target, async (email, pass) => {
    const r = await Nube.registrarse(email, pass);
    return r.entrado ? null : r.aviso;
  });

$('cuenta-sync').onclick = () => sincronizar(true);

$('cuenta-salir').onclick = () => {
  if (!confirm('¿Cerrar sesión? Tus datos siguen en este móvil y en la nube.')) return;
  Nube.salir();
  ultimaSync = null;
  avisoSync = '';
  render();
};

// Ajustes
$('no-key-bar').onclick = () => { tab = 'ajustes'; render(); };
$('key-show').onchange = (e) => {
  $('key-input').type = e.target.checked ? 'text' : 'password';
};
$('key-save').onclick = () => {
  const v = $('key-input').value.trim();
  if (!v) { alert('Pega tu clave antes de guardar.'); return; }
  if (!v.startsWith('gsk_')) {
    if (!confirm('Esa clave no empieza por "gsk_". ¿Guardarla de todos modos?')) return;
  }
  localStorage.setItem(LS_KEY, v);
  $('key-input').value = '';
  $('key-show').checked = false;
  $('key-input').type = 'password';
  render();
  alert('Clave guardada en este móvil.');
};
$('key-clear').onclick = () => {
  if (!confirm('¿Borrar la clave de este dispositivo?')) return;
  localStorage.removeItem(LS_KEY);
  render();
};

// Chat
$('chat-send').onclick = () => enviarPregunta();
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); enviarPregunta(); }
});

// El teclado de iOS no debe tapar el cuadro de escritura
if (window.visualViewport) {
  const vv = window.visualViewport;
  const adjust = () => {
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    // Solo es teclado si el hueco es grande. Diferencias pequeñas vienen del
    // área segura del iPhone y no deben mover la interfaz.
    const teclado = overlap > 120 ? overlap : 0;
    document.getElementById('app').style.paddingBottom = teclado + 'px';
    if (teclado > 0) $('tabbar').hidden = true;
    else if (!openVisitId && !openClientId) $('tabbar').hidden = false;
  };
  vv.addEventListener('resize', adjust);
  vv.addEventListener('scroll', adjust);
}

// Botón "Buscar actualización": borra lo guardado y recarga desde el servidor.
// Se comprueba que exista por si el móvil tuviera cacheado un HTML antiguo:
// un fallo aquí dejaría sin ejecutar todo lo que viene después.
const btnUpdate = $('force-update');
if (btnUpdate) {
  btnUpdate.onclick = async () => {
    btnUpdate.disabled = true;
    btnUpdate.textContent = 'Actualizando…';
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      // 'reload' obliga a ir a la red y refresca también la caché del
      // navegador, que es la que dejaba la app anclada a la versión vieja.
      await fetch('index.html', { cache: 'reload' });
    } catch (e) {}
    // Dirección única: el documento no puede venir de ninguna copia guardada
    location.replace(location.pathname + '?v=' + Date.now());
  };
}

// Service worker (permite abrirla sin conexión una vez cargada)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update())
      .catch(() => {});
  });
}

render();

// Al abrir la app, si hay cuenta, se trae y se sube lo que haya cambiado.
// Sin cobertura no pasa nada: se trabaja en local y ya sincronizará después.
sincronizar(false);
