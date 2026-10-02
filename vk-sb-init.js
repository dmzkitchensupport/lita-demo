/* LiTa Support — Supabase init + sync multi-dispositivo */
var VK_SB_URL='https://vyrbajxcvqhvageyxblg.supabase.co';
var VK_SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5cmJhanhjdnFodmFnZXl4YmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5MjE1ODUsImV4cCI6MjEwNjQ5NzU4NX0.rKr44_UaIi6-hf9fUlXOLJxwaDh4q2dPpHIlnMLNxKA';
var vkSB=null;
function initSB(){
  if(vkSB)return;
  try{ if(window.supabase&&window.supabase.createClient){ vkSB=window.supabase.createClient(VK_SB_URL,VK_SB_KEY); } }catch(e){}
}
function _fMX(){ return new Date().toLocaleDateString('en-CA',{timeZone:'America/Mexico_City'}); }

/* Identidad individual (Fase 3 Grupo 3, Bloqueador #10, 18 sep 2026): resuelve
 * actor_colaborador_id desde CU.email contra colaboradores. Tablas de este grupo ya
 * derivan de la sesión logueada (CU.email/CU.nombre), no de un <input> de texto libre --
 * a diferencia del Grupo 2 (merma/cocina-temperatura/etc.), aquí no hace falta ningún
 * selector "¿Quién eres?" ni PIN adicional: la sesión YA fue autenticada al hacer login.
 * HALLAZGO REAL (verificado contra el schema, no asumido): `colaboradores` no es legible
 * directo por anon (sin política RLS de SELECT) -- la resolución pasa por
 * rpc_resolver_actor_por_email (SECURITY DEFINER, ver vk-actor-fase3-grupo3-sesion.sql),
 * no por un .from('colaboradores').select() directo.
 * Cachea en window._actorPorSesionCache para no consultar en cada write -- se invalida
 * sola si CU.email cambia (otro login en el mismo dispositivo). En la práctica ya queda
 * resuelto desde el login (sbInsertActividad('login',...) la llama primero), así que la
 * mayoría de los callers la reciben de caché, sin round-trip.
 * Nunca bloquea al caller: ante cualquier falla (sin conexión, colaborador no encontrado)
 * resuelve null y quien llama simplemente no manda actor_colaborador_id, igual que antes
 * de este cambio. Timeout real de 5s (mismo criterio que loginServidor/validarPinServidor
 * en portal.html) -- esta resolución es best-effort de atribución, no un gate de
 * seguridad, así que no debe colgar un guardado (crítico para `encuestas`, que hace
 * respaldo local ANTES de cualquier llamada de red). */
async function _resolverActorPorSesion(){
  try{
    var email = typeof CU!=='undefined'&&CU&&CU.email ? CU.email : '';
    if(!email) return null;
    if(window._actorPorSesionCache && window._actorPorSesionCache.email===email){
      return window._actorPorSesionCache.id;
    }
    initSB(); if(!vkSB) return null;
    var timeoutMarker={_timeout:true};
    var timeoutP=new Promise(function(res){ setTimeout(function(){ res(timeoutMarker); },5000); });
    var r = await Promise.race([vkSB.rpc('rpc_resolver_actor_por_email', {p_email: email}), timeoutP]);
    if(r===timeoutMarker) return null;
    var id = (r && !r.error && r.data && r.data.ok) ? r.data.id : null;
    window._actorPorSesionCache = {email: email, id: id};
    return id;
  }catch(e){ return null; }
}

/* Detecta celular vs computadora por user-agent — para poder distinguir
 * en la bitácora desde qué tipo de dispositivo se hizo cada acción. */
function _detectarDispositivo(){
  try{
    var ua=(typeof navigator!=='undefined'&&navigator.userAgent)||'';
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua)?'celular':'computadora';
  }catch(e){ return 'desconocido'; }
}

/* Bitácora de actividad: login y movimientos de cada usuario (tabla registro_actividad).
 * Best-effort, nunca bloquea la acción real que la dispara. */
async function sbInsertActividad(accion,detalle){
  try{
    initSB(); if(!vkSB)return;
    var usr=typeof CU!=='undefined'&&CU?CU:null;
    var detalleFinal=Object.assign({dispositivo:_detectarDispositivo()},detalle||{});
    /* Identidad individual (Fase 3 Grupo 3, Bloqueador #10, 18 sep 2026): este campo ya
     * derivaba de la sesión (colaborador_email/colaborador_nombre = CU), no de texto libre
     * -- solo faltaba resolver el id real contra colaboradores. Ver
     * _resolverActorPorSesion() arriba. Nunca bloquea: si falla, actor queda null. */
    var actorId = await _resolverActorPorSesion();
    vkSB.from('registro_actividad').insert({
      colaborador_email: usr?usr.email:'',
      colaborador_nombre: usr?((usr.nombre||usr.name||'')+' '+(usr.apellido||'')).trim():'',
      accion: accion, detalle: detalleFinal, fecha:_fMX(), actor_colaborador_id: actorId
    }).then(function(r){
      /* Vigilancia best-effort: mismo criterio que el resto de la app (ver CLAUDE.md,
       * bugs de turno/venta ya corregidos por catch vacio). No cambia el flujo visible. */
      if(r&&r.error&&typeof sbInsertAlerta==='function'){
        sbInsertAlerta('bitacora-actividad','importante',
          '⚠ Falla al registrar actividad en servidor',
          'No se guardo en registro_actividad: accion="'+accion+'", usuario='+(usr?usr.email:'')+'. Error: '+r.error.message,
          'bitacora-fallo-'+_fMX(),{accion:accion});
      }
    }).catch(function(){});
  }catch(e){}
}

/* UP: progreso local → servidor (PK fecha+modulo_id, last-write-wins con mayor pct) */
function sbUpsertProgreso(subId,pct,total,ok,datos){
  try{
    initSB(); if(!vkSB)return;
    var usr=typeof CU!=='undefined'&&CU?CU.email:'';
    var payloadProgreso={
      fecha:_fMX(), modulo_id:subId, pct:pct,
      items:{total:total,hechos:ok,extra:datos||{}},
      updated_by:usr, updated_at:new Date().toISOString()
    };
    /* Identidad individual (Fase 3 Grupo 2, Bloqueador #10, 18 sep 2026): si el caller ya
     * trae actor_colaborador_id confirmado por PIN dentro de `datos` (ver
     * requerirActorNoBloqueante/guardarTemperatura en portal.html), se escribe también en
     * la columna dedicada de progreso_modulos (agregada en la Fase 1, aditiva desde
     * entonces) -- no solo dentro del JSON de `items`. Si esta llamada no trae identidad,
     * la columna simplemente no se incluye en el upsert y PostgREST no la toca (el valor
     * previo, si lo hay, se conserva -- no se pisa con NULL). */
    if(datos && datos.actor_colaborador_id) payloadProgreso.actor_colaborador_id = datos.actor_colaborador_id;
    vkSB.from('progreso_modulos').upsert(payloadProgreso,{onConflict:'fecha,modulo_id'}).then(function(r){
      if(r&&r.error&&typeof sbInsertAlerta==='function'){
        sbInsertAlerta('progreso-modulo','importante',
          '⚠ Falla al sincronizar progreso de modulo',
          'No se guardo en progreso_modulos: modulo_id="'+subId+'", pct='+pct+', usuario='+usr+'. Error: '+r.error.message,
          'progreso-fallo-'+_fMX()+'-'+subId,{modulo_id:subId,pct:pct});
      }
    }).catch(function(){});
    sbInsertActividad('modulo_guardado',{modulo_id:subId,pct:pct});
  }catch(e){}
}

/* DOWN: servidor → localStorage (server gana si pct mayor). Devuelve true si cambió algo */
function sbDownProgreso(){
  return new Promise(function(resolve){
    try{
      initSB(); if(!vkSB){resolve(false);return;}
      vkSB.from('progreso_modulos').select('modulo_id,pct,items').eq('fecha',_fMX()).then(function(r){
        if(r.error||!r.data||!r.data.length){resolve(false);return;}
        var changed=false;
        var hk=typeof hoyKey==='function'?hoyKey():_fMX();
        r.data.forEach(function(row){
          var key='vk_prog_'+row.modulo_id+'_'+hk;
          var localPct=0;
          try{var v=JSON.parse(localStorage.getItem(key)||'null');localPct=v&&v.pct?v.pct:0;}catch(e){}
          if((row.pct||0)>localPct){
            var it=row.items||{};
            localStorage.setItem(key,JSON.stringify({total:it.total||0,hechos:it.hechos||0,pct:row.pct,ts:Date.now(),srv:true}));
            changed=true;
          }
        });
        resolve(changed);
      }).catch(function(){resolve(false);});
    }catch(e){resolve(false);}
  });
}

/* Alertas → Supabase (dispara email via trigger + Edge Function) */
/* datos (opcional): {area, foto_url, tipo_evidencia, usuario, turno, ...} — se manda tal cual al correo para enriquecerlo */
function sbInsertAlerta(area,severidad,titulo,mensaje,moduloId,datos){
  try{
    initSB(); if(!vkSB)return;
    var hoy=_fMX();
    var k='vk_alert_sent_'+hoy+'_'+(moduloId||titulo).replace(/\W/g,'').slice(0,40);
    if(localStorage.getItem(k))return; /* atajo local: evita ida y vuelta si ESTE dispositivo ya la mando hoy */
    localStorage.setItem(k,'1');
    var payload={
      tipo:area,severidad:severidad,titulo:titulo,mensaje:mensaje,
      modulo_id:moduloId||'',fecha:hoy,leida:false,
      datos:datos||null
    };
    function insertar(){
      vkSB.from('alertas').insert(payload).then(function(r){
        /* Esta ES la tabla que dispara el correo de alertas -- si falla justo esta escritura no
         * podemos avisar via sbInsertAlerta (circular). Dejar rastro en consola para diagnostico
         * futuro (ver DevTools/logs), sin bloquear ni re-lanzar. */
        if(r&&r.error){ try{console.error('sbInsertAlerta: fallo insert en alertas',area,titulo,r.error);}catch(e){} }
      }).catch(function(){});
    }
    if(!moduloId){ insertar(); return; }
    /* Dedup real cross-device: localStorage solo evita repetir en ESTE dispositivo -- con
     * varios dispositivos abiertos (o localStorage limpiado), cada uno mandaba su propia
     * copia del mismo aviso el mismo dia (bug real detectado 2 ago 2026, flood de correos
     * que agoto la cuota diaria de Resend). Confirmar en el servidor antes de insertar. */
    vkSB.from('alertas').select('id').eq('modulo_id',moduloId).eq('fecha',hoy).limit(1).then(function(chk){
      if(chk && chk.data && chk.data.length) return; /* ya existe una alerta de este contexto hoy */
      insertar();
    }).catch(function(){ insertar(); }); /* si falla la verificacion, mandar igual -- mejor un duplicado ocasional que perder una alerta critica */
  }catch(e){}
}

/* Registro genérico (temperaturas/merma usan sus propias tablas via portal) */
function sbInsertRegistro(tabla,payload){
  try{
    initSB(); if(!vkSB)return;
    vkSB.from(tabla).insert(payload).then(function(r){
      if(r&&r.error&&typeof sbInsertAlerta==='function'){
        sbInsertAlerta('registro-generico','importante',
          '⚠ Falla al guardar registro en servidor',
          'No se guardo en '+tabla+'. Error: '+r.error.message,
          'registro-fallo-'+_fMX()+'-'+tabla,{tabla:tabla});
      }
    }).catch(function(){});
  }catch(e){}
}

/* Display de Sabores → servidor (PK area+semana_key). Se llamaba desde portal.html sin que
 * esta función existiera nunca — cada guardado tiraba ReferenceError antes de llegar siquiera
 * al fallback de localStorage, así que Display de Sabores nunca había guardado nada, ni local
 * ni en servidor. Confirmado con 0 filas en la tabla real. */
async function sbUpsertDisplay(area,semanaKey,datos){
  try{
    initSB(); if(!vkSB)return;
    var usr=typeof CU!=='undefined'&&CU?CU.email:'';
    /* Identidad individual (Fase 3 Grupo 3, Bloqueador #10, 18 sep 2026): actualizado_por
     * ya derivaba de la sesión (CU.email), no de texto libre -- solo faltaba el id real. */
    var actorId = await _resolverActorPorSesion();
    vkSB.from('display_sabores').upsert({
      area:area, semana_key:semanaKey,
      proyecto:(datos&&datos.proyecto)||'', elaboro:(datos&&datos.elaboro)||'',
      reviso:(datos&&datos.reviso)||'', obs:(datos&&datos.obs)||'',
      filas:(datos&&datos.rows)||[],
      actualizado_por:usr, actor_colaborador_id:actorId, updated_at:new Date().toISOString()
    },{onConflict:'area,semana_key'}).then(function(r){
      if(r&&r.error&&typeof sbInsertAlerta==='function'){
        sbInsertAlerta('display-sabores','importante',
          '⚠ Falla al guardar Display de Sabores',
          'No se guardo en display_sabores: area="'+area+'", semana="'+semanaKey+'". Error: '+r.error.message,
          'display-sabores-fallo-'+_fMX()+'-'+area+'-'+semanaKey,{area:area,semana_key:semanaKey});
      }
    }).catch(function(){});
  }catch(e){}
}

/* Lee Display de Sabores del SERVIDOR -- antes solo se leía de localStorage (dsLoad),
 * así que el checklist semanal aparecía en blanco si se abría desde un dispositivo
 * distinto al que lo llenó esa semana, aunque sbUpsertDisplay() ya lo hubiera guardado
 * bien en el servidor. Diagnóstico 5 ago 2026. */
async function sbDownDisplay(area,semanaKey){
  try{
    initSB(); if(!vkSB)return null;
    var r=await vkSB.from('display_sabores').select('proyecto,elaboro,reviso,obs,filas').eq('area',area).eq('semana_key',semanaKey).maybeSingle();
    if(r.error||!r.data)return null;
    return {proyecto:r.data.proyecto||'',elaboro:r.data.elaboro||'',reviso:r.data.reviso||'',obs:r.data.obs||'',rows:r.data.filas||[]};
  }catch(e){return null;}
}
