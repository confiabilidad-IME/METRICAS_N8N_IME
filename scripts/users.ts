// Gestión de usuarios del tablero (solo guarda hashes scrypt; la contraseña nunca queda en disco salvo en `init`).
//
//   npm run user:init              crea users.default.json (admin y gerencia) con contraseñas aleatorias, guardadas en
//                                  credenciales-iniciales.txt (ignorado por git; léelas, cámbialas y borra el archivo)
//   npm run user:add -- <usuario>  agrega un usuario o cambia su contraseña (en users.json, ignorado por git)
//   npm run user:remove -- <usuario>  desactiva un usuario (también uno por defecto)
//   npm run user:hash              imprime solo el hash de una contraseña (para la variable AUDIT_USERS del hosting)
//   npm run user:list              lista los usuarios activos
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { hashPassword } from '../server/auth/passwords';
import { loadUsers, normalizeUsername, parseUsers, USERNAME_RE } from '../server/auth/users';

const root = resolve(import.meta.dirname, '..');
const usersFile = process.env.AUDIT_USERS_FILE?.trim() || join(root, 'users.json');
const MIN_LEN = 10;

/** Lee una línea sin mostrarla (contraseña). Sin terminal interactiva (stdin redirigido) lee la primera línea. */
async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    return new Promise((res) => rl.once('line', (l) => (rl.close(), res(l))));
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((res) => {
    let buf = '';
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return res(buf);
        }
        if (c === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function askNewPassword(): Promise<string> {
  const a = await readHidden('Contraseña: ');
  if (a.length < MIN_LEN) throw new Error(`La contraseña debe tener al menos ${MIN_LEN} caracteres.`);
  const b = await readHidden('Repite la contraseña: ');
  if (a !== b) throw new Error('Las contraseñas no coinciden.');
  return a;
}

function readLocal(): Array<Record<string, unknown>> {
  if (!existsSync(usersFile)) return [];
  const raw = JSON.parse(readFileSync(usersFile, 'utf8')) as unknown;
  parseUsers(raw, usersFile); // valida antes de tocar nada
  return raw as Array<Record<string, unknown>>;
}

function upsert(list: Array<Record<string, unknown>>, entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return [...list.filter((u) => normalizeUsername(String(u.usuario)) !== entry.usuario), entry];
}

function needUser(arg: string | undefined): string {
  const name = normalizeUsername(arg ?? '');
  if (!USERNAME_RE.test(name)) throw new Error('Indica un usuario válido (2-32 caracteres: letras, números, . _ -). Ej.: npm run user:add -- maria');
  return name;
}

/** Contraseña aleatoria legible: 20 caracteres sin los que se confunden (0/O, 1/l/I). */
function randomPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'init': {
      const defaults = join(root, 'users.default.json');
      if (existsSync(defaults)) throw new Error('users.default.json ya existe; no se sobrescribe. Usa user:add para cambiar una contraseña.');
      const names = ['admin', 'gerencia'];
      const entries: Array<{ usuario: string; hash: string }> = [];
      const lines: string[] = ['Credenciales iniciales del tablero de auditoría n8n', 'Cámbialas con: npm run user:add -- <usuario>   y borra este archivo.', ''];
      for (const usuario of names) {
        const password = randomPassword();
        entries.push({ usuario, hash: await hashPassword(password) });
        lines.push(`usuario: ${usuario}`, `contraseña: ${password}`, '');
      }
      writeFileSync(defaults, JSON.stringify(entries, null, 2) + '\n');
      writeFileSync(join(root, 'credenciales-iniciales.txt'), lines.join('\n'), { mode: 0o600 });
      console.log(`Creado users.default.json (solo hashes) con ${names.join(' y ')}.`);
      console.log('Las contraseñas iniciales están en credenciales-iniciales.txt (ignorado por git). Cámbialas y bórralo.');
      return;
    }
    case 'add': {
      const name = needUser(arg);
      const hash = await hashPassword(await askNewPassword());
      writeFileSync(usersFile, JSON.stringify(upsert(readLocal(), { usuario: name, hash }), null, 2) + '\n', { mode: 0o600 });
      console.log(`Usuario "${name}" guardado en ${usersFile}.`);
      return;
    }
    case 'remove': {
      const name = needUser(arg);
      writeFileSync(usersFile, JSON.stringify(upsert(readLocal(), { usuario: name, disabled: true }), null, 2) + '\n', { mode: 0o600 });
      console.log(`Usuario "${name}" desactivado.`);
      return;
    }
    case 'hash': {
      console.log(await hashPassword(await askNewPassword()));
      return;
    }
    case 'list': {
      const users = loadUsers(process.env, root);
      console.log(users.length ? users.map((u) => `- ${u.name}`).join('\n') : '(sin usuarios activos)');
      return;
    }
    default:
      console.log('Uso: npm run user:init | user:add -- <usuario> | user:remove -- <usuario> | user:hash | user:list');
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
