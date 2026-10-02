# ESTADO — LiTa Support · Demo de Ventas (lita-demo)

> Fuente única de verdad de este repo.
> Se actualiza en el mismo commit que el cambio, nunca aparte.
> Regla: si no se puede verificar, se escribe "SIN VERIFICAR", no se inventa.

**Última actualización:** 2026-10-02 (rotación de credenciales por exposición en texto plano).
**Actualizado por:** Claude Code (agente de infraestructura).

---

## 1. Qué es esto

Tercer tenant de LiTa Support, 100% real (no mockup estático), para que Mario haga demos
en vivo a prospectos de venta sin tocar datos de clientes reales (Vitality Kitchen /
Corazón de Jaguar). Cliente ficticio: **"Fonda Raíz"** — nombre inventado, no corresponde
a ningún restaurante real. `portal.html` es una copia de `vitality-control/portal.html`
(el más reciente con el rediseño "D homologada" en producción) con el branding
reemplazado y apuntando a su propio proyecto Supabase, aislado.

## 2. Dónde vive

| Recurso | Valor | Verificado |
|---|---|---|
| Repo | `dmzkitchensupport/lita-demo` (público) | ✅ |
| Producción | https://dmzkitchensupport.github.io/lita-demo/portal.html | ✅ ver verificación abajo |
| Supabase project | `lita-demo`, ref `vyrbajxcvqhvageyxblg`, región `us-east-1`, org `osoiyzwcumyucmvjbkmi` | ✅ `supabase projects list` |
| Selector de login único | `dmzkitchensupport/lita-support-app` → `index.html` → `CLIENTES`, entrada `lita-demo` | ✅ ver commit de ese repo |

## 3. Credenciales

**Nunca en texto plano en este repo.** Entregadas directo a Mario en el reporte de la
sesión que creó este tenant (2026-10-02): email/contraseña del colaborador demo
(`rol:'admin'`, acceso completo), admin key de `rpc_upsert_colaborador`, anon key,
db password del proyecto Supabase. Si se pierden, regenerar con
`rpc_upsert_colaborador` (requiere la admin key, también entregada por el mismo canal) o
rotar con `scripts/onboarding/repair.js` del repo `lita-onboarding-template`.

### 3.1 Rotación de credenciales — 2026-10-02

La db password y la admin key de `rpc_upsert_colaborador` del proyecto Supabase
`vyrbajxcvqhvageyxblg` quedaron expuestas en texto plano en el reporte final (chat) de la
sesión que dio de alta este tenant. Ambas se rotaron el mismo día como higiene de
seguridad (proyecto demo, sin dato de cliente real, pero mala práctica dejarlas vivas
tras una exposición conocida):

- **DB password** — rotada vía Management API (`PATCH /v1/projects/{ref}/database/password`).
  Verificada con una conexión real (pooler `aws-0-us-east-1.pooler.supabase.com:6543`)
  usando el valor nuevo.
- **Admin key de `rpc_upsert_colaborador`** — rotada con `CREATE OR REPLACE FUNCTION`
  sobre esa única función (mismo cuerpo del template, solo cambia el literal comparado
  contra `p_admin_key`), vía `database/query` de la Management API. Verificado con una
  llamada REST real: la key vieja (`LT-ADMIN-jma4ctKFVaEg`) devuelve
  `{"ok":false,"err":"unauthorized"}`; la key nueva devuelve `{"ok":true}`.

Valores nuevos entregados directo a Mario en el reporte de esta sesión (mismo canal que
el alta original) — no se repiten aquí ni en ningún otro archivo de este repo.

## 4. Qué SÍ tiene

- Esquema completo reconciliado de VK/CJ (`colaboradores`, `turnos`, `turno_estado`,
  `progreso_modulos`, `scores_diarios`, `alertas`, etc. — ver
  `lita-onboarding-template/template/schema.sql`), RLS `anon_all` en las tablas
  operativas, RPCs `rpc_login`/`rpc_validar_pin`/`rpc_upsert_colaborador`.
- Datos de muestra sintéticos (7 días, `turno_estado`/`turnos`/`scores_diarios`
  variados de A+ a C/`progreso_modulos` por área, 8 `alertas` mezcla resueltas/
  pendientes) — ver query real de conteo en el reporte de la sesión.
- Un colaborador real (`demo@litasupport.com`, rol admin) para que un prospecto vea el
  producto completo.
- Branding "D homologada" (tokens `--lita-*`, bottom nav de 5 posiciones) — mismo código
  que corre hoy en producción en Vitality Kitchen.

## 5. Qué NO tiene (a propósito)

- **Sin email de alertas real.** No se desplegó la Edge Function de alertas
  (`functions_alert.sql`/`send-alert`) — bloqueador real: no había `RESEND_API_KEY`
  disponible en esta sesión para generar el secret. La tabla `alertas` tiene filas de
  muestra (se ven en el panel), pero ningún insert nuevo dispara un correo real. Pendiente
  si Mario quiere activarlo: correr la parte de Edge Function de `onboard.js` a mano con
  `RESEND_API_KEY` real.
- **Sin Stripe ni WhatsApp real.** No se configuró ningún secret de pago ni de
  mensajería en este proyecto Supabase — los paneles que referencian `vk_pagos`/
  `vk_config` (Control Absoluto) y el campo de teléfono de WhatsApp quedan inertes
  (tablas no existen en este schema, sin backend que envíe nada). El demo no puede
  cobrar ni mandar WhatsApp real a nadie.
- **Sin cuenta `qa-bot` dedicada ni CI de QA/seguridad** — este repo es un demo de venta
  desechable, no un cliente operando de verdad; se omitió a propósito el aparato de
  monitoreo 24/7 que sí llevan VK/CJ.
- **Sin dominio propio** — usa el link `*.github.io` normal, suficiente para una demo.

## 6. Bloqueadores abiertos

1. **Email de alertas sin activar** (ver sección 5) — requiere `RESEND_API_KEY` real.
2. **Logo real de "Fonda Raíz"** — se usa el ícono genérico de marca LiTa (tinta/ocre),
   no hay logo de cliente porque el cliente es ficticio. No aplica preparar uno.

## 6.1 🔴 Hallazgo real — bug heredado de Vitality Kitchen / Corazón de Jaguar (NO corregido ahí)

Verificando por qué el dashboard de este demo mostraba "1% del turno completado" pese a
tener datos de muestra reales con 72% de avance promedio, se encontró la causa exacta en
`calcScoreArea()`/`calcScoreGlobal()` (línea ~8247 de `portal.html`): ambas hacen
`Math.round(sc/mx)` / `Math.round(t/m)` — `sc/mx` y `t/m` ya son una fracción 0–1 (el
numerador y denominador están multiplicados por `pct` 0–100 y por `100` respectivamente),
así que el resultado real **solo puede ser 0 o 1, nunca un porcentaje útil**. Esto afecta
"% del turno completado", las "botellas" de progreso por área, y las letras A+/A/B/C/D
(`letraCalif()` nunca puede pasar de 'D' si `gl` solo vale 0 o 1).

**Confirmado con `grep` que el mismo código, byte por byte, vive hoy en
`~/dev/vitality-control/portal.html` y `~/dev/cdj-support/portal.html`** — es decir, muy
probablemente el dashboard de los dos clientes reales (Vitality Kitchen, Corazón de
Jaguar) tiene el mismo problema en producción ahora mismo. **No se tocó ninguno de esos
dos repos** (fuera de alcance de esta sesión, instrucción explícita del brief). Se
corrigió **solo en este repo** (`lita-demo`, agregando `*100` a ambas funciones) porque
sin eso el demo de ventas no puede cumplir su propósito (mostrar progreso real). Ver
comentario en el propio `portal.html` justo arriba de `calcScoreArea`.

**Pendiente de decisión de Mario**: si esto se confirma también roto en VK/CDJ, decidir
si se corrige ahí (afecta directamente lo que ve el cliente pagador) — no se hizo aquí
porque está fuera del alcance de este encargo y porque tocar producción de un cliente
real requiere su confirmación explícita.

## 7. Qué sigue

- Los datos de muestra quedaron sembrados con fechas fijas (2026-09-26 a 2026-10-02,
  calculadas con `CURRENT_DATE - n` **en el momento del seed**, no son dinámicas). Si el
  demo se usa varias semanas después, las fechas se van a ver viejas — re-correr
  `gen-seed.js`/`seed.sql` (ver sesión que creó este tenant) para refrescarlas antes de
  una demo importante.
- Si se activa el envío de alertas reales, re-verificar que `resendDestinatarios` siga
  siendo únicamente `mario@delamorazumaran.com` (nunca un correo de prospecto real).
