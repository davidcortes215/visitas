/* ============================================================
   Nube — cuenta y sincronización con Supabase.

   Se habla con la API directamente (sin librerías externas) para que la app
   siga siendo autónoma y pueda funcionar sin cobertura: si algo falla, se
   trabaja en local y ya se sincronizará más tarde.
   ============================================================ */

const Nube = (() => {
  const LS_SESION = 'visitasvoz.sesion';
  const LS_BORRADOS = 'visitasvoz.borrados';

  const URL_BASE = () => (window.SUPABASE_URL || '').replace(/\/+$/, '');
  const CLAVE = () => window.SUPABASE_KEY || '';

  // Sin configurar (o pendiente) la app funciona igual, solo que en local
  function configurada() {
    return !!URL_BASE() && URL_BASE() !== 'PENDIENTE' && !!CLAVE();
  }

  // ---------------- Sesión ----------------
  function sesion() {
    try { return JSON.parse(localStorage.getItem(LS_SESION)); } catch { return null; }
  }
  function guardarSesion(s) {
    if (!s) { localStorage.removeItem(LS_SESION); return; }
    localStorage.setItem(LS_SESION, JSON.stringify({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      // Renovamos un minuto antes de que caduque, por si el reloj va justo
      caduca_en: Date.now() + ((s.expires_in || 3600) - 60) * 1000,
      email: s.user?.email || s.email || '',
      user_id: s.user?.id || s.user_id || '',
    }));
  }
  function usuario() {
    const s = sesion();
    return s ? { email: s.email, id: s.user_id } : null;
  }

  // ---------------- Llamadas base ----------------
  async function auth(ruta, cuerpo) {
    const res = await fetch(`${URL_BASE()}/auth/v1/${ruta}`, {
      method: 'POST',
      headers: { apikey: CLAVE(), 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(traduceError(data.error_description || data.msg || data.message || res.status));
    }
    return data;
  }

  // Mensajes de Supabase en cristiano
  function traduceError(m) {
    const t = String(m);
    if (/Invalid login credentials/i.test(t)) return 'Correo o contraseña incorrectos.';
    if (/User already registered/i.test(t)) return 'Ese correo ya tiene cuenta. Entra en vez de registrarte.';
    if (/Password should be at least/i.test(t)) return 'La contraseña debe tener al menos 6 caracteres.';
    if (/Unable to validate email/i.test(t) || /invalid format/i.test(t)) return 'Ese correo no parece válido.';
    if (/Email not confirmed/i.test(t)) return 'Falta confirmar el correo. Revisa tu bandeja de entrada.';
    return t;
  }

  async function renovarSiHaceFalta() {
    const s = sesion();
    if (!s) throw new Error('No has iniciado sesión.');
    if (Date.now() < s.caduca_en) return s.access_token;
    const data = await auth('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
    guardarSesion(data);
    return data.access_token;
  }

  // Petición a la base de datos con la sesión del usuario
  async function api(ruta, opciones = {}) {
    const token = await renovarSiHaceFalta();
    const res = await fetch(`${URL_BASE()}/rest/v1/${ruta}`, {
      ...opciones,
      headers: {
        apikey: CLAVE(),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opciones.headers || {}),
      },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Error de la nube (${res.status}): ${txt.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  // ---------------- Cuenta ----------------
  async function registrarse(email, contrasena) {
    const data = await auth('signup', { email, password: contrasena });
    // Con la confirmación por correo desactivada, el registro ya devuelve sesión
    if (data.access_token) { guardarSesion(data); return { entrado: true }; }
    return { entrado: false, aviso: 'Cuenta creada. Revisa tu correo para confirmarla y luego entra.' };
  }

  async function entrar(email, contrasena) {
    const data = await auth('token?grant_type=password', { email, password: contrasena });
    guardarSesion(data);
    return true;
  }

  function salir() {
    guardarSesion(null);
  }

  // ---------------- IA en el servidor ----------------
  // Llama a la función 'ia' de Supabase, que es quien guarda la clave de Groq.
  // Así el usuario no tiene que configurar ninguna clave en su móvil.
  async function funcionIA(accion, { cuerpo, formulario } = {}) {
    const token = await renovarSiHaceFalta();
    const opciones = {
      method: 'POST',
      headers: { apikey: CLAVE(), Authorization: `Bearer ${token}` },
    };
    if (formulario) {
      opciones.body = formulario;
    } else {
      opciones.headers['Content-Type'] = 'application/json';
      opciones.body = JSON.stringify(cuerpo || {});
    }
    const res = await fetch(`${URL_BASE()}/functions/v1/ia?accion=${accion}`, opciones);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `El servidor de IA respondió ${res.status}`);
    return data;
  }

  // ---------------- Borrados pendientes ----------------
  // Si se borra algo sin cobertura, se apunta para borrarlo en la nube después.
  function borrados() {
    try { return JSON.parse(localStorage.getItem(LS_BORRADOS)) || []; } catch { return []; }
  }
  function apuntarBorrado(tabla, id) {
    const lista = borrados();
    if (!lista.some((b) => b.tabla === tabla && b.id === id)) lista.push({ tabla, id });
    localStorage.setItem(LS_BORRADOS, JSON.stringify(lista));
  }
  function limpiarBorrados(hechos) {
    const quedan = borrados().filter(
      (b) => !hechos.some((h) => h.tabla === b.tabla && h.id === b.id)
    );
    localStorage.setItem(LS_BORRADOS, JSON.stringify(quedan));
  }

  async function borrar(tabla, id) {
    apuntarBorrado(tabla, id);
    if (!configurada() || !sesion()) return;
    try {
      await api(`${tabla}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      limpiarBorrados([{ tabla, id }]);
    } catch (e) {
      // Sin conexión: queda apuntado para el próximo intento
    }
  }

  // ---------------- Conversión local <-> nube ----------------
  const aNubeCliente = (c, uid) => ({
    id: c.id, user_id: uid,
    nombre: c.nombre, empresa: c.empresa || '',
    actualizado_en: c.actualizadoEn || new Date().toISOString(),
  });
  const aLocalCliente = (r) => ({
    id: r.id, nombre: r.nombre, empresa: r.empresa || '',
    actualizadoEn: r.actualizado_en,
  });

  const aNubeVisita = (v, uid) => ({
    id: v.id, user_id: uid,
    cliente_id: v.clientId,
    fecha: v.fecha,
    duracion: Math.round(v.duracion || 0),
    estado: v.estado || 'listo',
    transcripcion: v.transcripcion || '',
    resumen: v.resumen || '',
    puntos_clave: v.puntosClave || [],
    proximos_pasos: v.proximosPasos || [],
    fecha_seguimiento: v.fechaSeguimiento || null,
    seguimiento_hecho: !!v.seguimientoHecho,
    actualizado_en: v.actualizadoEn || new Date().toISOString(),
  });
  const aLocalVisita = (r) => ({
    id: r.id, clientId: r.cliente_id,
    fecha: r.fecha,
    duracion: r.duracion || 0,
    estado: r.estado || 'listo',
    transcripcion: r.transcripcion || '',
    resumen: r.resumen || '',
    puntosClave: r.puntos_clave || [],
    proximosPasos: r.proximos_pasos || [],
    fechaSeguimiento: r.fecha_seguimiento || null,
    seguimientoHecho: !!r.seguimiento_hecho,
    errorMsg: '',
    actualizadoEn: r.actualizado_en,
    // El audio no viaja a la nube: si esta visita viene de otro móvil, no habrá
    uri: null,
  });

  // Gana la versión modificada más recientemente
  function fusionar(locales, remotos, claveFecha = 'actualizadoEn') {
    const mapa = new Map();
    for (const r of remotos) mapa.set(r.id, r);
    for (const l of locales) {
      const r = mapa.get(l.id);
      if (!r) { mapa.set(l.id, l); continue; }
      const tl = new Date(l[claveFecha] || 0).getTime();
      const tr = new Date(r[claveFecha] || 0).getTime();
      // En empate mandamos la local, que puede tener el audio asociado
      mapa.set(l.id, tl >= tr ? { ...r, ...l } : { ...l, ...r, uri: l.uri || r.uri });
    }
    return [...mapa.values()];
  }

  // ---------------- Sincronización ----------------
  // Devuelve el estado ya fusionado. Si no hay conexión, devuelve el local tal cual.
  async function sincronizar(clientesLocales, visitasLocales) {
    if (!configurada() || !sesion()) {
      return { ok: false, motivo: 'sin-cuenta', clientes: clientesLocales, visitas: visitasLocales };
    }
    try {
      const uid = usuario().id;

      // 1) Ejecutar los borrados que quedaron pendientes
      const pendientes = borrados();
      const hechos = [];
      for (const b of pendientes) {
        try {
          await api(`${b.tabla}?id=eq.${encodeURIComponent(b.id)}`, { method: 'DELETE' });
          hechos.push(b);
        } catch (e) { /* seguirá pendiente */ }
      }
      if (hechos.length) limpiarBorrados(hechos);
      const borradosIds = new Set(borrados().map((b) => b.id));

      // 2) Traer lo que hay en la nube
      const [remClientes, remVisitas] = await Promise.all([
        api('clientes?select=*'),
        api('visitas?select=*'),
      ]);

      // 3) Fusionar (gana lo modificado más tarde) descartando lo borrado
      const clientes = fusionar(
        clientesLocales,
        (remClientes || []).map(aLocalCliente)
      ).filter((c) => !borradosIds.has(c.id));

      const visitas = fusionar(
        visitasLocales,
        (remVisitas || []).map(aLocalVisita)
      ).filter((v) => !borradosIds.has(v.id));

      // 4) Devolver a la nube el resultado
      if (clientes.length) {
        await api('clientes', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(clientes.map((c) => aNubeCliente(c, uid))),
        });
      }
      if (visitas.length) {
        await api('visitas', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(visitas.map((v) => aNubeVisita(v, uid))),
        });
      }

      visitas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      return { ok: true, clientes, visitas };
    } catch (e) {
      return {
        ok: false, motivo: 'error', error: String(e.message || e),
        clientes: clientesLocales, visitas: visitasLocales,
      };
    }
  }

  return {
    configurada, sesion, usuario,
    registrarse, entrar, salir,
    sincronizar, borrar, funcionIA,
  };
})();
