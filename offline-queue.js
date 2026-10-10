var OQ_KEY = "vk_pin_queue_v1";

var OQ_PING_TIMEOUT_MS = 6e3;

var OQ_TTL_MS = 12 * 60 * 60 * 1e3;

var OQ_POLL_MS = 3e4;

var OQ_ETIQUETAS = {
 "turno-apertura": "Apertura de turno",
 "turno-cierre": "Cierre de turno",
 "capacitacion-dia": "Validación de día de capacitación",
 "merma-actor": "Identidad de registro de merma",
 "temperatura-actor": "Identidad de bitácora de temperaturas",
 "registro-actor": "Identidad de registro (vitrinas/inventario/baños/entradas)"
};

var OQ_APLICADORES = {};

var _oqSincronizando = false;

function oqLeerCola() {
 try {
  return JSON.parse(localStorage.getItem(OQ_KEY) || "[]");
 } catch (e) {
  return [];
 }
}

function oqGuardarCola(arr) {
 try {
  localStorage.setItem(OQ_KEY, JSON.stringify(arr));
 } catch (e) {}
}

function oqPendientes() {
 return oqLeerCola().filter(function(e) {
  return e.estado === "pendiente";
 });
}

function oqRegistrarAplicador(tipo, fn) {
 OQ_APLICADORES[tipo] = fn;
}

function encolarValidacionPin(entrada) {
 var cola = oqLeerCola();
 var item = {
  id: "oq_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
  tipo: entrada.tipo,
  metodo: entrada.metodo || "turno",
  pin: entrada.pin,
  colaboradorId: entrada.colaboradorId || null,
  contexto: entrada.contexto || {},
  ts_original: Date.now(),
  estado: "pendiente",
  intentos: 0,
  creado_en: (new Date).toISOString()
 };
 cola.push(item);
 oqGuardarCola(cola);
 oqActualizarBanner();
 return item.id;
}

async function _oqValidarPin(pin) {
 if (typeof validarPinServidor !== "function") return {
  estado: "sin_conexion"
 };
 try {
  var srv = await validarPinServidor(pin);
  if (srv && srv.ok) return {
   estado: "ok",
   datos: srv
  };
  if (srv && srv.motivo === "credencial") return {
   estado: "invalido"
  };
  return {
   estado: "sin_conexion"
  };
 } catch (e) {
  return {
   estado: "sin_conexion"
  };
 }
}

async function _oqValidarPinActor(colaboradorId, pin) {
 if (typeof vkSB === "undefined" || !vkSB) return {
  estado: "sin_conexion"
 };
 try {
  var r = await vkSB.rpc("rpc_validar_pin_actor", {
   p_colaborador_id: colaboradorId,
   p_pin: pin
  });
  if (r && r.error) return {
   estado: "sin_conexion"
  };
  if (r && r.data && r.data.motivo === "sin_sesion") return {
   estado: "sin_conexion"
  };
  if (r && r.data && r.data.ok) return {
   estado: "ok",
   datos: r.data
  };
  return {
   estado: "invalido"
  };
 } catch (e) {
  return {
   estado: "sin_conexion"
  };
 }
}

function oqPingServidorReal() {
 return new Promise(function(resolve) {
  if (typeof vkSB === "undefined" || !vkSB) {
   resolve(false);
   return;
  }
  var resuelto = false;
  var t = setTimeout(function() {
   if (!resuelto) {
    resuelto = true;
    resolve(false);
   }
  }, OQ_PING_TIMEOUT_MS);
  vkSB.from("vk_config").select("key").limit(1).then(function(r) {
   if (resuelto) return;
   resuelto = true;
   clearTimeout(t);
   resolve(!r.error);
  }).catch(function() {
   if (resuelto) return;
   resuelto = true;
   clearTimeout(t);
   resolve(false);
  });
 });
}

function oqLimpiarExpirados() {
 var cola = oqLeerCola();
 var ahora = Date.now();
 var huboExpirados = false;
 cola.forEach(function(item) {
  if (item.estado === "pendiente" && ahora - item.ts_original > OQ_TTL_MS) {
   item.estado = "expirado";
   item.resuelto_en = (new Date).toISOString();
   huboExpirados = true;
   try {
    if (typeof sbInsertAlerta === "function") {
     sbInsertAlerta("pin-offline-expirado", "importante", "⚠ PIN pendiente expiró sin poder validarse (" + (OQ_ETIQUETAS[item.tipo] || item.tipo) + ")", 'Un intento de "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" del ' + new Date(item.ts_original).toLocaleString("es-MX", {
      timeZone: "America/Mexico_City"
     }) + " llevaba más de 24h sin poder validarse contra el servidor -- se descartó SIN aplicar. Revisar manualmente si la acción sigue siendo necesaria.", "pin-offline-expirado-" + item.id, {
      tipo: item.tipo,
      ts_original: item.ts_original
     });
    }
   } catch (e) {}
  }
 });
 if (huboExpirados) oqGuardarCola(cola);
}

async function oqIntentarSincronizar() {
 if (_oqSincronizando) return;
 oqLimpiarExpirados();
 var pendientes = oqPendientes();
 if (!pendientes.length) {
  oqActualizarBanner();
  return;
 }
 _oqSincronizando = true;
 try {
  var vivo = await oqPingServidorReal();
  if (!vivo) return;
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
 var idx = cola.findIndex(function(e) {
  return e.id === id;
 });
 if (idx === -1) return;
 if (cola[idx].estado !== "pendiente") return;
 cola[idx].intentos = (cola[idx].intentos || 0) + 1;
 oqGuardarCola(cola);
 var item = cola[idx];
 var detalle = item.metodo === "actor" ? await _oqValidarPinActor(item.colaboradorId, item.pin) : await _oqValidarPin(item.pin);
 cola = oqLeerCola();
 idx = cola.findIndex(function(e) {
  return e.id === id;
 });
 if (idx === -1 || cola[idx].estado !== "pendiente") return;
 item = cola[idx];
 if (detalle.estado === "sin_conexion") {
  return;
 }
 if (detalle.estado === "invalido") {
  cola[idx].estado = "rechazado";
  cola[idx].resuelto_en = (new Date).toISOString();
  oqGuardarCola(cola);
  oqNotificarRechazo(item);
  return;
 }
 if (item.metodo === "actor" && detalle.datos && detalle.datos.id && typeof window !== "undefined") {
  window._actorConfirmado = {
   id: detalle.datos.id,
   expira: Date.now() + (typeof ACTOR_FOTO_VIGENCIA_MS !== "undefined" ? ACTOR_FOTO_VIGENCIA_MS : 15 * 60 * 1e3)
  };
 }
 var aplicador = OQ_APLICADORES[item.tipo];
 var aplicadoOk = false;
 if (typeof aplicador === "function") {
  try {
   aplicadoOk = !!await aplicador(item.contexto, detalle.datos, item.ts_original);
  } catch (e) {
   aplicadoOk = false;
  }
 }
 cola = oqLeerCola();
 idx = cola.findIndex(function(e) {
  return e.id === id;
 });
 if (idx === -1) return;
 cola[idx].estado = aplicadoOk ? "aplicado" : "error_aplicar";
 cola[idx].resuelto_en = (new Date).toISOString();
 oqGuardarCola(cola);
 if (aplicadoOk) {
  oqMostrarAvisoVisible('✓ "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" (guardado sin conexión) se validó y se aplicó correctamente.', "ok");
 } else {
  oqNotificarFalloAplicar(item);
 }
}

function oqNotificarRechazo(item) {
 try {
  if (typeof sbInsertAlerta === "function") {
   sbInsertAlerta("pin-offline-rechazado", "importante", "⚠ PIN rechazado tras validar en línea (" + (OQ_ETIQUETAS[item.tipo] || item.tipo) + ")", 'Se intentó "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" sin conexión el ' + new Date(item.ts_original).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City"
   }) + ". Al recuperar la conexión, el servidor confirmó que el PIN NO es válido -- la acción NO se aplicó.", "pin-offline-rechazado-" + item.id, {
    tipo: item.tipo,
    ts_original: item.ts_original
   });
  }
 } catch (e) {}
 oqMostrarAvisoVisible('El PIN de "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" quedó pendiente, se validó al reconectar y resultó INVÁLIDO. La acción NO se aplicó.', "err");
}

function oqNotificarFalloAplicar(item) {
 try {
  if (typeof sbInsertAlerta === "function") {
   sbInsertAlerta("pin-offline-error-aplicar", "importante", "⚠ PIN válido pero la acción ya no se pudo aplicar (" + (OQ_ETIQUETAS[item.tipo] || item.tipo) + ")", 'El PIN de "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" intentado sin conexión el ' + new Date(item.ts_original).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City"
   }) + " SÍ resultó válido al reconectar, pero la acción ya no se pudo aplicar (el contexto guardado ya no es válido). Revisar manualmente.", "pin-offline-error-aplicar-" + item.id, {
    tipo: item.tipo,
    ts_original: item.ts_original
   });
  }
 } catch (e) {}
 oqMostrarAvisoVisible('El PIN de "' + (OQ_ETIQUETAS[item.tipo] || item.tipo) + '" era válido, pero la acción ya no se pudo aplicar. Revisa manualmente.', "err");
}

function oqMostrarAvisoVisible(msg, tipo) {
 try {
  var colores = {
   info: [ "#EFF6FF", "#1E40AF" ],
   warn: [ "#FFFBEB", "#92400E" ],
   ok: [ "#F0FDF4", "#15803D" ],
   err: [ "#FEF2F2", "#DC2626" ]
  };
  var c = colores[tipo] || colores.warn;
  var old = document.getElementById("oqToast");
  if (old) old.remove();
  var div = document.createElement("div");
  div.id = "oqToast";
  div.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10001;" + "background:" + c[0] + ";color:" + c[1] + ";border-radius:10px;padding:12px 18px;font-size:13px;font-weight:500;" + "box-shadow:0 4px 16px rgba(0,0,0,.18);max-width:92vw;text-align:center";
  div.textContent = msg;
  document.body.appendChild(div);
  setTimeout(function() {
   var t = document.getElementById("oqToast");
   if (t) t.remove();
  }, 9e3);
 } catch (e) {}
}

function oqActualizarBanner() {
 try {
  var n = oqPendientes().length;
  var el = document.getElementById("oqBanner");
  if (!n) {
   if (el) el.remove();
   return;
  }
  if (!el) {
   el = document.createElement("div");
   el.id = "oqBanner";
   el.style.cssText = "position:fixed;top:8px;right:8px;z-index:10001;background:#FFFBEB;color:#92400E;" + "border:1px solid #FDE68A;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:600;" + "display:flex;align-items:center;gap:6px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.12);max-width:70vw";
   el.title = "Toca para reintentar sincronizar ahora";
   el.onclick = function() {
    oqIntentarSincronizar();
   };
   document.body.appendChild(el);
  }
  el.innerHTML = '<i class="ti ti-cloud-off" style="font-size:13px"></i> ' + n + " PIN" + (n > 1 ? "es" : "") + " guardado" + (n > 1 ? "s" : "") + " localmente, pendiente" + (n > 1 ? "s" : "") + " de validar";
 } catch (e) {}
}

(function() {
 function boot() {
  oqActualizarBanner();
  setTimeout(function() {
   oqIntentarSincronizar();
  }, 1200);
 }
 if (typeof window === "undefined") return;
 if (document.readyState === "complete") boot(); else window.addEventListener("load", boot);
 window.addEventListener("online", function() {
  oqIntentarSincronizar();
 });
 setInterval(function() {
  oqIntentarSincronizar();
 }, OQ_POLL_MS);
})();