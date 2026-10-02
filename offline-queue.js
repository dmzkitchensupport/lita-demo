/* LiTa Support — Cola de validación de PIN offline (offline-queue.js)
 *
 * Decisión explícita de Mario, 14 sep 2026, tras un incidente real con un cliente: las
 * acciones que dependen de validar un PIN de supervisor contra el servidor (apertura de
 * turno, cierre de turno, certificación de capacitación de 15 días) NUNCA deben aplicarse
 * sin haber validado el PIN de verdad contra rpc_validar_pin. Si no hay conexión real en
 * el momento del intento, la acción se guarda en esta cola local y se aplica -- con el
 * timestamp ORIGINAL del intento, no el de la sincronización -- solo cuando el servidor
 * confirma que el PIN es válido. Si el servidor confirma que el PIN es INválido, la acción
 * nunca se aplica, sin importar cuánto tiempo haya esperado en la cola.
 *
 * Mismo patrón de script suelto sin build step que vk-sb-init.js. Se carga en portal.html
 * justo después de vk-sb-init.js (necesita `vkSB` global) y antes del <script> principal.
 *
 * Contrato con portal.html (bajo acoplamiento a propósito -- este archivo no conoce turnos
 * ni capacitación, cada call site registra cómo aplicar SU acción):
 *   - encolarValidacionPin({tipo, pin, contexto, metodo, colaboradorId}) -- llamar cuando
 *     la validación del PIN no se pudo confirmar por falta de conexión. Devuelve el id de
 *     la entrada encolada. `metodo` es opcional: 'turno' (default, valida contra
 *     validarPinServidor -- PIN de supervisor, autorización) o 'actor' (valida contra
 *     rpc_validar_pin_actor con `colaboradorId` -- identidad de una persona específica ya
 *     elegida en el selector "¿Quién eres?", sin exigir puede_autorizar). Mismo mecanismo
 *     de cola para ambos, solo cambia el adaptador de validación que se usa al reintentar.
 *   - oqRegistrarAplicador(tipo, fn) -- fn(contexto, datosServidor, tsOriginal) debe aplicar
 *     la acción real y devolver true/false (o una promesa que resuelva a eso).
 *
 * (18 sep 2026, Fase 3 Grupo 2 del Bloqueador #10): generalizado para soportar además la
 * validación de identidad NO bloqueante de merma/cocina-temperatura -- a diferencia del
 * PIN de turno (que sí bloquea el cierre/apertura hasta confirmarse), aquí el registro
 * real ya se guardó antes de encolar; el aplicador solo adjunta actor_colaborador_id con
 * un UPDATE dirigido cuando el PIN se confirma. Ver portal.html:
 * requerirActorNoBloqueante()/_validarPinActorNoBloqueante().
 *
 * IMPORTANTE (14 sep 2026): validarPinServidor(pin) YA distingue 'sin_conexion' de
 * 'credencial' desde el commit 16de981 (fix de seguridad hecho en paralelo el mismo día,
 * cerró el bypass real donde un .catch() aplicaba la acción sin validar el PIN si la
 * promesa fallaba). Esta cola NO reimplementa esa validación -- llama a validarPinServidor()
 * tal cual vía el adaptador _oqValidarPin() de abajo, para no mantener dos copias del mismo
 * timeout/parsing. Cualquier respuesta que no sea reconocible como 'ok' o 'credencial' se
 * trata como 'sin_conexion' (fail-safe: reintentar después, nunca aplicar ni rechazar a
 * ciegas).
 *
 * Decisión de diseño pendiente de confirmar con Mario (ver ESTADO.md): esta cola descarta
 * (estado 'expirado', con alerta real) cualquier entrada que lleve más de OQ_TTL_MS sin
 * poder confirmarse -- default 24h, elegido porque estas acciones son de un mismo turno/día
 * operativo, no un registro que tenga sentido aplicar días después. Un solo número a
 * cambiar si Mario prefiere otro plazo.
 */

var OQ_KEY = 'vk_pin_queue_v1';
var OQ_PING_TIMEOUT_MS = 6000;
var OQ_TTL_MS = 12 * 60 * 60 * 1000; // 12h -- decisión explícita de Mario 14 sep 2026 (antes 24h)
var OQ_POLL_MS = 30000;

var OQ_ETIQUETAS = {
  'turno-apertura': 'Apertura de turno',
  'turno-cierre': 'Cierre de turno',
  'capacitacion-dia': 'Validación de día de capacitación',
  'merma-actor': 'Identidad de registro de merma',
  'temperatura-actor': 'Identidad de bitácora de temperaturas'
};

var OQ_APLICADORES = {};
var _oqSincronizando = false;

/* ── Persistencia (localStorage -- volumen esperado: unas pocas entradas por turno,
 *    nunca cientos; si algún día esto crece mucho, IndexedDB sería la vía, pero no se
 *    justifica hoy) ─────────────────────────────────────────────────────────────── */
function oqLeerCola() {
  try { return JSON.parse(localStorage.getItem(OQ_KEY) || '[]'); } catch (e) { return []; }
}
function oqGuardarCola(arr) {
  try { localStorage.setItem(OQ_KEY, JSON.stringify(arr)); } catch (e) {}
}
function oqPendientes() {
  return oqLeerCola().filter(function (e) { return e.estado === 'pendiente'; });
}

function oqRegistrarAplicador(tipo, fn) { OQ_APLICADORES[tipo] = fn; }

/* ── Encolar un intento de PIN que no se pudo validar por falta de conexión ────── */
function encolarValidacionPin(entrada) {
  var cola = oqLeerCola();
  var item = {
    id: 'oq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    tipo: entrada.tipo,
    metodo: entrada.metodo || 'turno',
    pin: entrada.pin,
    colaboradorId: entrada.colaboradorId || null,
    contexto: entrada.contexto || {},
    ts_original: Date.now(),
    estado: 'pendiente',
    intentos: 0,
    creado_en: new Date().toISOString()
  };
  cola.push(item);
  oqGuardarCola(cola);
  oqActualizarBanner();
  return item.id;
}

/* ── Adaptador sobre validarPinServidor() (portal.html) ─────────────────────────
 * validarPinServidor() ya devuelve {ok:true,...datos} | {ok:false,motivo:'credencial'} |
 * {ok:false,motivo:'sin_conexion'} (fix de seguridad del 14 sep 2026, commit 16de981) y ya
 * incluye su propio timeout real de 10s contra conexiones "colgadas". Este adaptador solo
 * traduce esa forma a lo que la cola necesita, sin duplicar esa lógica. Fail-safe: si
 * validarPinServidor no existe todavía (script principal no cargado) o devuelve algo que
 * no reconoce, trata el caso como 'sin_conexion' -- nunca aplica ni rechaza a ciegas. */
async function _oqValidarPin(pin) {
  if (typeof validarPinServidor !== 'function') return { estado: 'sin_conexion' };
  try {
    var srv = await validarPinServidor(pin);
    if (srv && srv.ok) return { estado: 'ok', datos: srv };
    if (srv && srv.motivo === 'credencial') return { estado: 'invalido' };
    return { estado: 'sin_conexion' };
  } catch (e) { return { estado: 'sin_conexion' }; }
}

/* ── Adaptador sobre rpc_validar_pin_actor (Fase 2/3 -- identidad de UNA persona ya
 * elegida en el selector "¿Quién eres?", sin exigir puede_autorizar=true). A diferencia
 * de rpc_validar_pin, esta RPC no distingue "credencial inválida" de "sin conexión" en su
 * propia forma de respuesta -- solo {ok:true,...} o {ok:false} -- así que el adaptador
 * trata cualquier error de PostgREST o excepción como sin_conexion (fail-safe, igual
 * criterio que _oqValidarPin: nunca aplicar ni rechazar a ciegas). */
async function _oqValidarPinActor(colaboradorId, pin) {
  if (typeof vkSB === 'undefined' || !vkSB) return { estado: 'sin_conexion' };
  try {
    var r = await vkSB.rpc('rpc_validar_pin_actor', { p_colaborador_id: colaboradorId, p_pin: pin });
    if (r && r.error) return { estado: 'sin_conexion' };
    if (r && r.data && r.data.ok) return { estado: 'ok', datos: r.data };
    return { estado: 'invalido' };
  } catch (e) { return { estado: 'sin_conexion' }; }
}

/* ── Ping real y barato a Supabase -- navigator.onLine NO es confiable (wifi con portal
 * cautivo, DNS que resuelve pero no responde, etc. lo reportan como "online" igual). Usa
 * la misma tabla/forma de select que ya se consulta en portal.html (vk_config), así que
 * no depende de RLS/policies nuevas. Timeout corto -- esto solo pregunta "¿hay servidor
 * de verdad ahí?", no necesita esperar tanto como validarPinServidor(). */
function oqPingServidorReal() {
  return new Promise(function (resolve) {
    if (typeof vkSB === 'undefined' || !vkSB) { resolve(false); return; }
    var resuelto = false;
    var t = setTimeout(function () { if (!resuelto) { resuelto = true; resolve(false); } }, OQ_PING_TIMEOUT_MS);
    vkSB.from('vk_config').select('key').limit(1).then(function (r) {
      if (resuelto) return;
      resuelto = true; clearTimeout(t);
      resolve(!r.error);
    }).catch(function () {
      if (resuelto) return;
      resuelto = true; clearTimeout(t);
      resolve(false);
    });
  });
}

/* ── Limpieza de entradas vencidas ──────────────────────────────────────────────── */
function oqLimpiarExpirados() {
  var cola = oqLeerCola();
  var ahora = Date.now();
  var huboExpirados = false;
  cola.forEach(function (item) {
    if (item.estado === 'pendiente' && (ahora - item.ts_original) > OQ_TTL_MS) {
      item.estado = 'expirado';
      item.resuelto_en = new Date().toISOString();
      huboExpirados = true;
      try {
        if (typeof sbInsertAlerta === 'function') {
          sbInsertAlerta('pin-offline-expirado', 'importante',
            '⚠ PIN pendiente expiró sin poder validarse (' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + ')',
            'Un intento de "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" del ' +
              new Date(item.ts_original).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) +
              ' llevaba más de 24h sin poder validarse contra el servidor -- se descartó SIN aplicar. Revisar manualmente si la acción sigue siendo necesaria.',
            'pin-offline-expirado-' + item.id,
            { tipo: item.tipo, ts_original: item.ts_original });
        }
      } catch (e) {}
    }
  });
  if (huboExpirados) oqGuardarCola(cola);
}

/* ── Sincronización real: recorre la cola y reintenta validar cada pendiente ───── */
async function oqIntentarSincronizar() {
  if (_oqSincronizando) return;
  oqLimpiarExpirados();
  var pendientes = oqPendientes();
  if (!pendientes.length) { oqActualizarBanner(); return; }
  _oqSincronizando = true;
  try {
    var vivo = await oqPingServidorReal();
    if (!vivo) return; // sigue sin conexión real -- se queda todo pendiente, se reintenta después
    for (var i = 0; i < pendientes.length; i++) {
      await oqProcesarUno(pendientes[i].id);
    }
  } finally {
    _oqSincronizando = false;
    oqActualizarBanner();
  }
}

async function oqProcesarUno(id) {
  var cola = oqLeerCola();
  var idx = cola.findIndex(function (e) { return e.id === id; });
  if (idx === -1) return;
  if (cola[idx].estado !== 'pendiente') return;
  cola[idx].intentos = (cola[idx].intentos || 0) + 1;
  oqGuardarCola(cola);

  var item = cola[idx];
  var detalle = item.metodo === 'actor'
    ? await _oqValidarPinActor(item.colaboradorId, item.pin)
    : await _oqValidarPin(item.pin);

  // Releer la cola -- puede haber cambiado mientras la validación estaba en vuelo.
  cola = oqLeerCola();
  idx = cola.findIndex(function (e) { return e.id === id; });
  if (idx === -1 || cola[idx].estado !== 'pendiente') return;
  item = cola[idx];

  if (detalle.estado === 'sin_conexion') {
    // Sigue sin poder confirmarse -- se queda pendiente, se reintenta en el siguiente ciclo.
    return;
  }

  if (detalle.estado === 'invalido') {
    cola[idx].estado = 'rechazado';
    cola[idx].resuelto_en = new Date().toISOString();
    oqGuardarCola(cola);
    oqNotificarRechazo(item);
    return;
  }

  // detalle.estado === 'ok' -- el PIN SÍ es válido. Si era una validación de actor
  // (identidad, no autorización de supervisor) y la persona sigue en la misma sesión,
  // refresca window._actorConfirmado -- así cualquier guardado siguiente ya no vuelve a
  // pedir el PIN dentro de la misma ventana de 15 min, igual que si se hubiera validado
  // en línea desde el primer intento.
  if (item.metodo === 'actor' && detalle.datos && detalle.datos.id && typeof window !== 'undefined') {
    window._actorConfirmado = { id: detalle.datos.id, expira: Date.now() + (typeof ACTOR_FOTO_VIGENCIA_MS !== 'undefined' ? ACTOR_FOTO_VIGENCIA_MS : 15 * 60 * 1000) };
  }

  // Aplicar la acción real ahora, con el timestamp original del intento (la acción
  // ocurrió cuando el usuario la hizo, no ahora).
  var aplicador = OQ_APLICADORES[item.tipo];
  var aplicadoOk = false;
  if (typeof aplicador === 'function') {
    try { aplicadoOk = !!(await aplicador(item.contexto, detalle.datos, item.ts_original)); }
    catch (e) { aplicadoOk = false; }
  }

  cola = oqLeerCola();
  idx = cola.findIndex(function (e) { return e.id === id; });
  if (idx === -1) return;
  cola[idx].estado = aplicadoOk ? 'aplicado' : 'error_aplicar';
  cola[idx].resuelto_en = new Date().toISOString();
  oqGuardarCola(cola);

  if (aplicadoOk) {
    oqMostrarAvisoVisible('✓ "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" (guardado sin conexión) se validó y se aplicó correctamente.', 'ok');
  } else {
    oqNotificarFalloAplicar(item);
  }
}

/* ── Notificaciones -- nunca silenciosas, siempre con constancia real vía sbInsertAlerta ── */
function oqNotificarRechazo(item) {
  try {
    if (typeof sbInsertAlerta === 'function') {
      sbInsertAlerta('pin-offline-rechazado', 'importante',
        '⚠ PIN rechazado tras validar en línea (' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + ')',
        'Se intentó "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" sin conexión el ' +
          new Date(item.ts_original).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) +
          '. Al recuperar la conexión, el servidor confirmó que el PIN NO es válido -- la acción NO se aplicó.',
        'pin-offline-rechazado-' + item.id,
        { tipo: item.tipo, ts_original: item.ts_original });
    }
  } catch (e) {}
  oqMostrarAvisoVisible('El PIN de "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" quedó pendiente, se validó al reconectar y resultó INVÁLIDO. La acción NO se aplicó.', 'err');
}

function oqNotificarFalloAplicar(item) {
  try {
    if (typeof sbInsertAlerta === 'function') {
      sbInsertAlerta('pin-offline-error-aplicar', 'importante',
        '⚠ PIN válido pero la acción ya no se pudo aplicar (' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + ')',
        'El PIN de "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" intentado sin conexión el ' +
          new Date(item.ts_original).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) +
          ' SÍ resultó válido al reconectar, pero la acción ya no se pudo aplicar (el contexto guardado ya no es válido). Revisar manualmente.',
        'pin-offline-error-aplicar-' + item.id,
        { tipo: item.tipo, ts_original: item.ts_original });
    }
  } catch (e) {}
  oqMostrarAvisoVisible('El PIN de "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" era válido, pero la acción ya no se pudo aplicar. Revisa manualmente.', 'err');
}

/* ── UI: mismo lenguaje visual que ya usa el portal para "guardado localmente, sin
 * conexión" (ver toast de encuestas pendientes, colores idénticos) -- no se inventa un
 * diseño nuevo. Toast puntual + badge fijo mientras haya algo pendiente. ──────────── */
function oqMostrarAvisoVisible(msg, tipo) {
  try {
    var colores = { info: ['#EFF6FF', '#1E40AF'], warn: ['#FFFBEB', '#92400E'], ok: ['#F0FDF4', '#15803D'], err: ['#FEF2F2', '#DC2626'] };
    var c = colores[tipo] || colores.warn;
    var old = document.getElementById('oqToast'); if (old) old.remove();
    var div = document.createElement('div');
    div.id = 'oqToast';
    div.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10001;'
      + 'background:' + c[0] + ';color:' + c[1] + ';border-radius:10px;padding:12px 18px;font-size:13px;font-weight:500;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.18);max-width:92vw;text-align:center';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(function () { var t = document.getElementById('oqToast'); if (t) t.remove(); }, 9000);
  } catch (e) {}
}

function oqActualizarBanner() {
  try {
    var n = oqPendientes().length;
    var el = document.getElementById('oqBanner');
    if (!n) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'oqBanner';
      el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:10001;background:#FFFBEB;color:#92400E;'
        + 'border:1px solid #FDE68A;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:600;'
        + 'display:flex;align-items:center;gap:6px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);max-width:70vw';
      el.title = 'Toca para reintentar sincronizar ahora';
      el.onclick = function () { oqIntentarSincronizar(); };
      document.body.appendChild(el);
    }
    el.innerHTML = '<i class="ti ti-cloud-off" style="font-size:13px"></i> ' + n + ' PIN' + (n > 1 ? 'es' : '') +
      ' guardado' + (n > 1 ? 's' : '') + ' localmente, pendiente' + (n > 1 ? 's' : '') + ' de validar';
  } catch (e) {}
}

/* ── Disparadores de sincronización: evento online, revisión al cargar la página, y un
 * sondeo periódico como respaldo (navigator.onLine/el evento 'online' no son confiables
 * en redes con portal cautivo o "colgadas" -- resuelven DNS pero no responden). ─────── */
(function () {
  function boot() {
    oqActualizarBanner();
    setTimeout(function () { oqIntentarSincronizar(); }, 1200);
  }
  if (typeof window === 'undefined') return;
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
  window.addEventListener('online', function () { oqIntentarSincronizar(); });
  setInterval(function () { oqIntentarSincronizar(); }, OQ_POLL_MS);
})();
