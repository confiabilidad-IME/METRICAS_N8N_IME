# metrics_n8n_flows

Tablero de **auditoría** de los flujos n8n de IME (proyecto "Confiabilidad IME"): estado de servicios, ejecuciones y el
efecto en el negocio (cotizaciones definidas, pipeline, correos, seguimientos).

Está construido sobre [Habblaud](https://github.com/marmottajr/habblaud) (MIT, ver `LICENSE`): cada flujo n8n **activo** es un
personaje en una sala "n8n" de la oficina pixel-art, y un flujo con la última ejecución fallida levanta la mano y enciende la
alarma de la sala. El botón **Auditoría** (o la tecla `M`) abre el panel con las métricas.

## Cómo funciona

```
n8n (AUD01-03 escriben data tables)  ->  AUD04 (webhook GET)  ->  servidor (sondeo cada POLL_INTERVAL_SECONDS)
                                                               ->  SSE /api/stream  ->  oficina + panel
```

| Flujo | Qué hace | Tabla |
|---|---|---|
| AUD01 | Métricas del día de cotizaciones y automatización (upsert por fecha) | `Audit_Metricas_Diarias` |
| AUD02 | Correos enviados/recibidos de los buzones comerciales | `Audit_Correos` |
| AUD03 | Ejecuciones por flujo/día y estado de cada servicio | `Audit_Ejecuciones_Diario`, `Audit_Servicios` |
| AUD04 | `GET /webhook/audit/metricas?desde=&hasta=` (header `x-audit-token`) | lee todas las anteriores + `Cotizaciones` |

**De dónde sale cada dato.** Las métricas de negocio vienen de AUD04. El estado de **servicios** y las **ejecuciones de hoy**
vienen en vivo de la API pública de n8n (`N8N_API_KEY`, y `N8N_PROJECT_ID` para limitar al proyecto), así que no dependen de
que AUD03 haya corrido. Los días anteriores de ejecuciones sí los consolida AUD03. Si la API falla, el tablero usa lo que dejó
AUD03 y lo indica en el panel. Los flujos AUD01–04 ya existían en n8n: esta app solo los lee, no crea ni modifica flujos.

### Ojo con las métricas

En `Audit_Metricas_Diarias`, `cotizaciones_*`, `definidas_total`, `ganadas`, `perdidas`, `valor_*`, `en_revision_manual` y
`tasa_cierre` son una **foto acumulada** de todas las cotizaciones a esa fecha: **no se suman entre días**. Solo son cifras del
día `enviadas_cliente_dia`, `seguimientos_enviados`, `correos_*` y `ejecuciones_*`. Por eso el panel separa:

- **Del rango**: cotizaciones definidas dentro del rango (sale de `cotizaciones_definidas`).
- **Acumulado**: la última foto disponible.
- **Actividad**: suma de las cifras diarias.

## Puesta en marcha

```
cp env.example .env     # completar N8N_BASE_URL, N8N_AUDIT_TOKEN, ...
npm install
npm run dev             # http://127.0.0.1:3000 (Vite + HMR)
npm run build && npm start
AUDIT_DEMO=1 npm run dev   # datos ficticios, sin n8n
```

Sin `N8N_BASE_URL` o `N8N_AUDIT_TOKEN` la app abre igual, con el estado "Sin configurar". Si n8n falla, el tablero conserva el
último dato bueno y lo marca como desactualizado.

Variables: ver `env.example`. Extra: `AUDIT_RANGE_DAYS` (30), `AUDIT_HOST` (127.0.0.1), `AUDIT_ALLOWED_HOSTS`,
`AUDIT_ENV_FILE`, `AUDIT_DEMO`.

## Seguridad

- El token de AUD04 va por header y **nunca** sale del servidor (ni en snapshots, ni en logs, ni en errores).
- Escucha solo en loopback por defecto; no hay login. No exponerlo a la red sin un proxy con autenticación.
- Solo lectura: toda ruta no-GET responde 405; las funciones heredadas de Habblaud (terminal, mensajes, permisos, spawn,
  Habblaud World) no existen en el servidor (404). `server/world/` no se incluyó: ningún dato sale hacia servicios de terceros.
- `.env` está en `.gitignore`.

## Desarrollo

`npm run typecheck`, `npm test`, `npm run build`. El código nuevo está en `server/audit/`, `server/model/n8n-office.ts`,
`shared/audit.ts` y `client/src/ui/audit*.ts`; el resto es Habblaud adaptado.

## Inicio de sesión

El tablero **siempre** pide usuario y contraseña (nada se sirve sin sesión, ni la página ni la API; solo `/login` y
`/api/health`). Las contraseñas se guardan cifradas con **scrypt** (hash con sal propia; la contraseña nunca se almacena) y
la sesión es una cookie `HttpOnly` firmada con HMAC. Tras 5 intentos fallidos el usuario se bloquea unos minutos.

- **Usuarios por defecto:** `admin` y `gerencia`, en `users.default.json` (solo hashes, se versiona). Sus contraseñas iniciales
  están en `credenciales-iniciales.txt` (ignorado por git): léelas, cámbialas y borra el archivo.
- **Roles:** `admin` ve todas las pestañas del panel de Auditoría. `gerencia` no ve la pestaña **Técnico** (flujos, ejecuciones,
  errores y estado de servicios); sí ve **Cotizaciones** y **Facturación**. Es un cambio de la interfaz, no un control de
  acceso a los datos. El usuario llamado `gerencia` es `gerencia` por defecto (también tras cambiarle la contraseña); para otro
  usuario añade `"rol": "gerencia"` en `users.json` o `AUDIT_USERS`.
- **Cambiar una contraseña / agregar usuarios:** `npm run user:add -- <usuario>` (guarda en `users.json`, ignorado por git).
  `npm run user:remove -- <usuario>` desactiva uno; `npm run user:list` los lista.
- **Hostings sin disco persistente:** genera el hash con `npm run user:hash` y pásalo en `AUDIT_USERS` (JSON).
- **Variables:** `AUDIT_SESSION_SECRET` (≥ 32 caracteres; sin él las sesiones se cierran al reiniciar), `AUDIT_SESSION_HOURS`,
  `AUDIT_TRUST_PROXY=1` y `AUDIT_COOKIE_SECURE=1` detrás de un proxy HTTPS. Ver `env.example`.
- Si no hay ningún usuario activo, el servidor **se niega a arrancar** (nunca queda abierto por error).

### Publicarlo en Vercel

El repo incluye `vercel.json` y la función `api/index.js`: la página sale como archivos estáticos (`dist/client`) y toda la
API (`/api/*`) y `/login` pasan por esa función, con el mismo login. Diferencias con el servidor Node: **no hay tiempo real**; la
página consulta `/api/snapshot` cada 30 s y el servidor refresca n8n si su dato tiene más de 20 s.

1. En Vercel: importa el repositorio. `vercel.json` ya fija build (`npm run build:vercel`) y carpeta de salida (`dist/client`);
   deja el *Framework Preset* en "Other".
2. En **Settings → Environment Variables** define: `N8N_BASE_URL`, `N8N_API_KEY`, `N8N_PROJECT_ID`, `N8N_AUDIT_WEBHOOK_PATH`,
   `N8N_AUDIT_TOKEN`, `APP_TIMEZONE` y **`AUDIT_SESSION_SECRET`** (obligatorio, ≥ 32 caracteres aleatorios; sin él la función
   responde 500 diciéndolo). Para otros usuarios además de los de `users.default.json`: `AUDIT_USERS` (ver `npm run user:hash`).
3. Despliega. Nunca subas el `.env`.

`api/index.js` es un archivo **generado y versionado** (Vercel detecta las funciones al clonar, antes del build). Si cambias
código del servidor, ejecuta `npm run build:api` y sube también `api/index.js`; una prueba (`npm test`) falla si quedó desactualizado.
Limitaciones: el límite de intentos de login vive en la memoria de cada instancia (más laxo que en un servidor único: usa
contraseñas largas) y el plan gratuito limita la duración de las funciones.

### Publicarlo en un servidor que corre siempre (Render, Railway, VPS, Docker)

Con `npm run build && npm start`, `AUDIT_HOST=0.0.0.0` y las variables de `env.example`. Aquí sí hay tiempo real (SSE). Pon
siempre HTTPS delante: sin él, las contraseñas viajan en claro.
