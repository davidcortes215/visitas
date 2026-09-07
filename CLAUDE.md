# Visitas — CRM de voz para comerciales

App web instalable (PWA) para iPhone. La comercial graba una nota de voz al
salir de una reunión; se transcribe, la IA la resume en una ficha ordenada por
cliente, y los seguimientos que detecta aparecen en la pestaña Pendientes.

**En producción:** https://davidcortes215.github.io/visitas/

## Estructura

Los archivos de la app están en la **raíz del repo** (es lo que sirve GitHub
Pages). No hay compilación ni dependencias: HTML, CSS y JavaScript a pelo.

| Archivo | Qué hace |
|---|---|
| `index.html` | Todas las pantallas |
| `app.js` | Lógica: grabación, IA, pantallas, datos |
| `nube.js` | Cuenta y sincronización con Supabase |
| `supabase-config.js` | URL y clave pública (son públicas a propósito) |
| `styles.css` | Paleta "Ámbar cálido", fondo claro |
| `sw.js` | Service worker: permite abrirla sin conexión |
| `supabase/functions/ia/index.ts` | Función de servidor que habla con Groq |
| `supabase-esquema.sql` | Tablas y reglas de seguridad de la base de datos |

## Publicar un cambio

Basta con hacer commit y push a `main`: GitHub Pages reconstruye en ~1 minuto.

**AL PUBLICAR HAY QUE SUBIR LA VERSIÓN EN TRES SITIOS A LA VEZ.** Si no, los
móviles siguen sirviendo la copia antigua desde su caché y parece que el cambio
no ha llegado:

1. `APP_VERSION` en `app.js`
2. El `?v=N` de `styles.css` y `app.js` en `index.html`
3. `CACHE` y los `?v=N` de los ASSETS en `sw.js`

La versión se ve en Ajustes, y ahí hay un botón "Buscar actualización" que
fuerza la descarga.

## Supabase

Proyecto `ufhtcbfrjbjsbzzkbypb`. La clave publicable va dentro de la app y es
pública: lo que protege los datos son las reglas RLS, que solo dejan a cada
usuario ver sus propias filas.

- **La clave de Groq vive en el servidor**, en el secreto `GROQ_API_KEY`, no en
  los móviles. Así la comercial no tiene que configurar nada.
- **Los audios no suben a la nube**: se quedan en el móvil (IndexedDB). Arriba
  van clientes, fichas, transcripciones y seguimientos.
- **El plan gratuito pausa el proyecto** tras unos días sin actividad. Lo evita
  la tarea `.github/workflows/mantener-despierto.yml`, que consulta a diario.

## Cosas que ya han mordido

- **Groq retira modelos sin avisar.** Los Llama desaparecieron y los resúmenes
  estuvieron rotos un tiempo sin que nadie lo notara. Modelo actual:
  `openai/gpt-oss-120b` (constante `MODELO_TEXTO`, está en `app.js` y en la
  función). Si falla con `model_not_found`, consultar
  `https://api.groq.com/openai/v1/models` y poner uno vigente.
- **Una visita escrita a mano se reconoce por `duracion === 0`**: se salta la
  transcripción, no muestra botón de escuchar y cambia los textos.
- **iOS reserva una franja bajo la ventana que la app no puede pintar.** Por eso
  la barra de pestañas es del color del fondo: para fundirse con ella. No
  intentar bajarla más, ya se probó y la barra se sale de la pantalla.

## Estado y siguientes pasos

Funcionando y probado en producción: grabar, transcribir, resumir con IA,
clientes, pestaña Pendientes, preguntar en lenguaje natural, cuenta con
sincronización, modo literal (guardar solo la transcripción sin que la IA
reescriba), añadir clientes sin visita y escribir la nota en vez de dictarla.

Pendiente, por orden de lo que más urge:

1. **Poder corregir.** Hoy, si la IA se equivoca, lo único que se puede hacer es
   borrar la visita. No se puede editar el nombre de un cliente, cambiar una
   visita de cliente, ajustar una fecha de seguimiento, retocar un resumen ni
   borrar un cliente. Whisper falla con nombres propios a menudo, así que esto
   se nota desde la primera semana de uso. **Es lo siguiente acordado.**
2. **Notificaciones que lleguen sin abrir la app.** Era el encargo original.
   Pendientes ya reúne los seguimientos, pero exige acordarse de mirar. En iOS
   solo llegan con la app cerrada si las envía un servidor: haría falta claves
   VAPID, una función de Supabase y una tarea diaria que mire qué vence.
3. **Buscador global.** Con 10 clientes la lista va bien; con 80 no.
4. **Exportar los datos.** Hoy están atrapados en la app.
5. **Mensaje de bienvenida** la primera vez, que ahora se abre en vacío.
6. **Probar una nota larga.** Solo se han probado notas de 20-40 segundos; no
   se sabe si Groq acepta una de 10 minutos.

Aviso de negocio: todas las transcripciones salen de la cuota gratuita de Groq
de David. Sirve para una comercial; no aguanta venderlo a varios clientes.

## Cómo probar

No hay tests automáticos. Lo que funciona es publicar y verificar contra la URL
real con el navegador: inyectar datos en `localStorage`, recargar y comprobar lo
que pinta. El servidor de pruebas local cachea de forma muy agresiva y suele
servir versiones viejas.
