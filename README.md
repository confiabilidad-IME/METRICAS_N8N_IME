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
