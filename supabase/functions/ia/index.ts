// ============================================================
// Función "ia" — hace de intermediaria con Groq.
//
// Existe para que la clave de Groq viva AQUÍ y no en cada móvil: así
// cualquiera que entre con su cuenta tiene la IA lista sin configurar nada.
//
// Supabase exige un usuario con sesión para llamarla (verify_jwt), de modo
// que la clave no queda expuesta a cualquiera que encuentre la dirección.
// ============================================================

const GROQ = 'https://api.groq.com/openai/v1';

// Groq retiró los modelos Llama en 2026. Si algún día falla con
// "model_not_found", consultar /v1/models y poner aquí uno vigente.
const MODELO_TEXTO = 'openai/gpt-oss-120b';
const MODELO_AUDIO = 'whisper-large-v3-turbo';

// La app vive en otro dominio (github.io), así que hay que permitirlo
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (cuerpo: unknown, estado = 200) =>
  new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const clave = Deno.env.get('GROQ_API_KEY');
  if (!clave) {
    return json({ error: 'El servidor no tiene configurada la clave de Groq.' }, 500);
  }

  // Solo usuarios con sesión: la clave publicable viaja dentro de la app y es
  // pública, así que por sí sola no puede dar derecho a gastar la cuota.
  const autorizacion = req.headers.get('Authorization') || '';
  const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  const quien = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: autorizacion, apikey },
  });
  if (!quien.ok) {
    return json({ error: 'Necesitas iniciar sesión para usar la IA.' }, 401);
  }

  const accion = new URL(req.url).searchParams.get('accion');

  try {
    // ---------- Transcribir audio ----------
    if (accion === 'transcribir') {
      const entrada = await req.formData();
      const audio = entrada.get('file');
      if (!(audio instanceof File)) {
        return json({ error: 'No llegó ningún audio.' }, 400);
      }

      const salida = new FormData();
      salida.append('file', audio, audio.name || 'audio.m4a');
      salida.append('model', MODELO_AUDIO);
      salida.append('language', 'es');
      salida.append('response_format', 'json');

      const r = await fetch(`${GROQ}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${clave}` },
        body: salida,
      });
      const texto = await r.text();
      if (!r.ok) return json({ error: `Groq respondió ${r.status}: ${texto.slice(0, 300)}` }, 502);
      return json(JSON.parse(texto));
    }

    // ---------- Resumir / estructurar ----------
    if (accion === 'resumir') {
      const { transcripcion, hoy } = await req.json();

      const system =
        'Eres un asistente que organiza notas de visitas comerciales. A partir de la ' +
        'transcripción de una nota de voz que un comercial graba tras una reunión, ' +
        'extraes la información clave. Respondes SOLO con JSON válido.';

      const user =
        `Fecha de hoy: ${hoy}.\n` +
        `Transcripción de la nota de voz del comercial:\n"""${transcripcion}"""\n\n` +
        `Devuelve un objeto JSON con EXACTAMENTE estos campos:\n` +
        `{\n` +
        `  "resumen": "2-3 frases con lo esencial de la visita",\n` +
        `  "puntosClave": ["punto relevante 1", "punto 2"],\n` +
        `  "proximosPasos": ["acción pendiente 1", "acción 2"],\n` +
        `  "fechaSeguimiento": "fecha YYYY-MM-DD si se menciona o deduce un seguimiento ` +
        `(calcula fechas relativas tipo 'en dos semanas' a partir de hoy), o null"\n` +
        `}\n` +
        `Si un campo no tiene información usa [] o null. Todo en español.`;

      const r = await fetch(`${GROQ}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODELO_TEXTO,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      const texto = await r.text();
      if (!r.ok) return json({ error: `Groq respondió ${r.status}: ${texto.slice(0, 300)}` }, 502);
      return json(JSON.parse(texto));
    }

    // ---------- Preguntar sobre los datos ----------
    if (accion === 'preguntar') {
      const { contexto, historial, hoy } = await req.json();

      const system =
        'Eres el asistente personal de una comercial. Respondes preguntas sobre sus ' +
        'visitas y clientes usando EXCLUSIVAMENTE los datos proporcionados abajo. ' +
        'Si un dato no aparece, dilo con claridad en vez de inventarlo. Cuenta y ' +
        'filtra por fechas cuando te lo pidan (formato YYYY-MM-DD). Responde en ' +
        `español, breve y directo. Hoy es ${hoy}.\n\n===== DATOS =====\n${contexto}`;

      const r = await fetch(`${GROQ}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODELO_TEXTO,
          temperature: 0.2,
          messages: [{ role: 'system', content: system }, ...(historial || [])],
        }),
      });
      const texto = await r.text();
      if (!r.ok) return json({ error: `Groq respondió ${r.status}: ${texto.slice(0, 300)}` }, 502);
      return json(JSON.parse(texto));
    }

    return json({ error: `Acción no reconocida: ${accion}` }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
