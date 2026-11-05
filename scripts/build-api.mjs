// Empaqueta la función de Vercel (server/vercel/handler.ts) en un solo archivo autocontenido: api/index.js.
// No depende de node_modules en producción (el proyecto no tiene dependencias de ejecución) y evita los problemas de
// importaciones sin extensión de TypeScript en Node ESM.
//
// El archivo generado SE VERSIONA (no está en .gitignore): Vercel detecta las funciones de api/ al clonar el repo, antes de
// ejecutar el build, así que tiene que existir en git. Tras cambiar código del servidor, vuelve a correr `npm run build:api`
// y sube también api/index.js (el build de Vercel lo regenera igualmente; el test de server/vercel lo comprueba al día).
import { build } from 'esbuild';

await build({
  entryPoints: ['server/vercel/handler.ts'],
  outfile: 'api/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Determinista: mismo código -> mismo archivo (sin rutas absolutas ni sourcemap), para poder comprobar que está al día.
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: '// GENERADO por scripts/build-api.mjs desde server/vercel/handler.ts. No editar a mano.' },
});
