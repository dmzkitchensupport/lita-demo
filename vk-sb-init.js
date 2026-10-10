var VK_SB_URL = "https://vyrbajxcvqhvageyxblg.supabase.co";

var VK_SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5cmJhanhjdnFodmFnZXl4YmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5MjE1ODUsImV4cCI6MjEwNjQ5NzU4NX0.rKr44_UaIi6-hf9fUlXOLJxwaDh4q2dPpHIlnMLNxKA";

var vkSB = null;

var LITA_SESION_TOKEN_KEY = "vk_sesion_token";

function litaToken() {
 try {
  return localStorage.getItem(LITA_SESION_TOKEN_KEY) || "";
 } catch (e) {
  return "";
 }
}

function litaGuardarToken(t) {
 try {
  if (t) localStorage.setItem(LITA_SESION_TOKEN_KEY, t); else localStorage.removeItem(LITA_SESION_TOKEN_KEY);
 } catch (e) {}
}

function _litaFetch(input, init) {
 init = init || {};
 var t = litaToken();
 var u = typeof input === "string" ? input : input && input.url || "";
 if (t && u.indexOf("/functions/v1/") < 0) {
  var h = new Headers(init.headers || input && input.headers || {});
  h.set("x-lita-session", t);
  init = Object.assign({}, init, {
   headers: h
  });
 }
 return fetch(input, init);
}

function initSB() {
 if (vkSB) return;
 try {
  if (window.supabase && window.supabase.createClient) {
   vkSB = window.supabase.createClient(VK_SB_URL, VK_SB_KEY, {
    global: {
     fetch: _litaFetch
    }
   });
  }
 } catch (e) {}
}

function _fMX() {
 return (new Date).toLocaleDateString("en-CA", {
  timeZone: "America/Mexico_City"
 });
}

async function _resolverActorPorSesion() {
 try {
  var email = typeof CU !== "undefined" && CU && CU.email ? CU.email : "";
  if (!email) return null;
  if (window._actorPorSesionCache && window._actorPorSesionCache.email === email) {
   return window._actorPorSesionCache.id;
  }
  initSB();
  if (!vkSB) return null;
  var timeoutMarker = {
   _timeout: true
  };
  var timeoutP = new Promise(function(res) {
   setTimeout(function() {
    res(timeoutMarker);
   }, 5e3);
  });
  var r = await Promise.race([ vkSB.rpc("rpc_resolver_actor_por_email", {
   p_email: email
  }), timeoutP ]);
  if (r === timeoutMarker) return null;
  var id = r && !r.error && r.data && r.data.ok ? r.data.id : null;
  window._actorPorSesionCache = {
   email: email,
   id: id
  };
  return id;
 } catch (e) {
  return null;
 }
}

function _detectarDispositivo() {
 try {
  var ua = typeof navigator !== "undefined" && navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ? "celular" : "computadora";
 } catch (e) {
  return "desconocido";
 }
}

async function sbInsertActividad(accion, detalle) {
 try {
  initSB();
  if (!vkSB) return;
  var usr = typeof CU !== "undefined" && CU ? CU : null;
  var detalleFinal = Object.assign({
   dispositivo: _detectarDispositivo()
  }, detalle || {});
  var actorId = await _resolverActorPorSesion();
  vkSB.from("registro_actividad").insert({
   colaborador_email: usr ? usr.email : "",
   colaborador_nombre: usr ? ((usr.nombre || usr.name || "") + " " + (usr.apellido || "")).trim() : "",
   accion: accion,
   detalle: detalleFinal,
   fecha: _fMX(),
   actor_colaborador_id: actorId
  }).then(function(r) {
   if (r && r.error && typeof sbInsertAlerta === "function") {
    sbInsertAlerta("bitacora-actividad", "importante", "⚠ Falla al registrar actividad en servidor", 'No se guardo en registro_actividad: accion="' + accion + '", usuario=' + (usr ? usr.email : "") + ". Error: " + r.error.message, "bitacora-fallo-" + _fMX(), {
     accion: accion
    });
   }
  }).catch(function() {});
 } catch (e) {}
}

var _actModPend = {};

function _logModuloAgrupado(subId, pct) {
 var p = _actModPend[subId];
 if (!p) {
  p = _actModPend[subId] = {
   pct_inicial: pct,
   cambios: 0
  };
 }
 p.pct = pct;
 p.cambios++;
 clearTimeout(p.t);
 p.t = setTimeout(function() {
  _flushActModulo(subId);
 }, 2e4);
}

function _flushActModulo(subId) {
 var p = _actModPend[subId];
 if (!p) return;
 delete _actModPend[subId];
 clearTimeout(p.t);
 sbInsertActividad("modulo_guardado", {
  modulo_id: subId,
  pct: p.pct,
  cambios: p.cambios,
  pct_inicial: p.pct_inicial
 });
}

function _flushActModulosTodos() {
 Object.keys(_actModPend).forEach(_flushActModulo);
}

if (typeof document !== "undefined") {
 document.addEventListener("visibilitychange", function() {
  if (document.visibilityState === "hidden") _flushActModulosTodos();
 });
 window.addEventListener("pagehide", _flushActModulosTodos);
}

function sbUpsertProgreso(subId, pct, total, ok, datos) {
 try {
  initSB();
  if (!vkSB) return;
  var usr = typeof CU !== "undefined" && CU ? CU.email : "";
  var payloadProgreso = {
   fecha: _fMX(),
   modulo_id: subId,
   pct: pct,
   items: {
    total: total,
    hechos: ok,
    extra: datos || {}
   },
   updated_by: usr,
   updated_at: (new Date).toISOString()
  };
  if (datos && datos.actor_colaborador_id) payloadProgreso.actor_colaborador_id = datos.actor_colaborador_id;
  vkSB.from("progreso_modulos").upsert(payloadProgreso, {
   onConflict: "fecha,modulo_id"
  }).then(function(r) {
   if (r && r.error && typeof sbInsertAlerta === "function") {
    sbInsertAlerta("progreso-modulo", "importante", "⚠ Falla al sincronizar progreso de modulo", 'No se guardo en progreso_modulos: modulo_id="' + subId + '", pct=' + pct + ", usuario=" + usr + ". Error: " + r.error.message, "progreso-fallo-" + _fMX() + "-" + subId, {
     modulo_id: subId,
     pct: pct
    });
   }
  }).catch(function() {});
  _logModuloAgrupado(subId, pct);
 } catch (e) {}
}

function sbDownProgreso() {
 return new Promise(function(resolve) {
  try {
   initSB();
   if (!vkSB) {
    resolve(false);
    return;
   }
   vkSB.from("progreso_modulos").select("modulo_id,pct,items").eq("fecha", _fMX()).then(function(r) {
    if (r.error || !r.data || !r.data.length) {
     resolve(false);
     return;
    }
    var changed = false;
    var hk = typeof hoyKey === "function" ? hoyKey() : _fMX();
    r.data.forEach(function(row) {
     var key = "vk_prog_" + row.modulo_id + "_" + hk;
     var localPct = 0;
     try {
      var v = JSON.parse(localStorage.getItem(key) || "null");
      localPct = v && v.pct ? v.pct : 0;
     } catch (e) {}
     if ((row.pct || 0) > localPct) {
      var it = row.items || {};
      localStorage.setItem(key, JSON.stringify({
       total: it.total || 0,
       hechos: it.hechos || 0,
       pct: row.pct,
       ts: Date.now(),
       srv: true
      }));
      changed = true;
     }
    });
    resolve(changed);
   }).catch(function() {
    resolve(false);
   });
  } catch (e) {
   resolve(false);
  }
 });
}

function _uuidDeterministico(txt) {
 function fnv(seed) {
  var h = seed >>> 0;
  for (var i = 0; i < txt.length; i++) {
   h ^= txt.charCodeAt(i);
   h = Math.imul(h, 16777619) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
 }
 var hex = fnv(2166136261) + fnv(2654435769) + fnv(2246822507) + fnv(3266489909);
 return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-" + (parseInt(hex[16], 16) & 3 | 8).toString(16) + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}

function sbInsertAlerta(area, severidad, titulo, mensaje, moduloId, datos) {
 try {
  initSB();
  if (!vkSB) return;
  var hoy = _fMX();
  var k = "vk_alert_sent_" + hoy + "_" + (moduloId || titulo).replace(/\W/g, "").slice(0, 40);
  if (localStorage.getItem(k)) return;
  localStorage.setItem(k, "1");
  var payload = {
   tipo: area,
   severidad: severidad,
   titulo: titulo,
   mensaje: mensaje,
   modulo_id: moduloId || "",
   fecha: hoy,
   leida: false,
   datos: datos || null
  };
  if (moduloId) payload.id = _uuidDeterministico("alerta|" + hoy + "|" + moduloId);
  function insertar() {
   (moduloId ? vkSB.from("alertas").upsert(payload, {
    onConflict: "id",
    ignoreDuplicates: true
   }) : vkSB.from("alertas").insert(payload)).then(function(r) {
    if (r && r.error) {
     try {
      console.error("sbInsertAlerta: fallo insert en alertas", area, titulo, r.error);
     } catch (e) {}
    }
   }).catch(function() {});
  }
  if (!moduloId) {
   insertar();
   return;
  }
  vkSB.from("alertas").select("id").eq("modulo_id", moduloId).eq("fecha", hoy).limit(1).then(function(chk) {
   if (chk && chk.data && chk.data.length) return;
   insertar();
  }).catch(function() {
   insertar();
  });
 } catch (e) {}
}

function sbInsertRegistro(tabla, payload) {
 try {
  initSB();
  if (!vkSB) return;
  vkSB.from(tabla).insert(payload).then(function(r) {
   if (r && r.error && typeof sbInsertAlerta === "function") {
    sbInsertAlerta("registro-generico", "importante", "⚠ Falla al guardar registro en servidor", "No se guardo en " + tabla + ". Error: " + r.error.message, "registro-fallo-" + _fMX() + "-" + tabla, {
     tabla: tabla
    });
   }
  }).catch(function() {});
 } catch (e) {}
}

async function sbUpsertDisplay(area, semanaKey, datos) {
 try {
  initSB();
  if (!vkSB) return;
  var usr = typeof CU !== "undefined" && CU ? CU.email : "";
  var actorId = await _resolverActorPorSesion();
  vkSB.from("display_sabores").upsert({
   area: area,
   semana_key: semanaKey,
   proyecto: datos && datos.proyecto || "",
   elaboro: datos && datos.elaboro || "",
   reviso: datos && datos.reviso || "",
   obs: datos && datos.obs || "",
   filas: datos && datos.rows || [],
   actualizado_por: usr,
   actor_colaborador_id: actorId,
   updated_at: (new Date).toISOString()
  }, {
   onConflict: "area,semana_key"
  }).then(function(r) {
   if (r && r.error && typeof sbInsertAlerta === "function") {
    sbInsertAlerta("display-sabores", "importante", "⚠ Falla al guardar Display de Sabores", 'No se guardo en display_sabores: area="' + area + '", semana="' + semanaKey + '". Error: ' + r.error.message, "display-sabores-fallo-" + _fMX() + "-" + area + "-" + semanaKey, {
     area: area,
     semana_key: semanaKey
    });
   }
  }).catch(function() {});
 } catch (e) {}
}

async function sbDownDisplay(area, semanaKey) {
 try {
  initSB();
  if (!vkSB) return null;
  var r = await vkSB.from("display_sabores").select("proyecto,elaboro,reviso,obs,filas").eq("area", area).eq("semana_key", semanaKey).maybeSingle();
  if (r.error || !r.data) return null;
  return {
   proyecto: r.data.proyecto || "",
   elaboro: r.data.elaboro || "",
   reviso: r.data.reviso || "",
   obs: r.data.obs || "",
   rows: r.data.filas || []
  };
 } catch (e) {
  return null;
 }
}