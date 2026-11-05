// Página de inicio de sesión: HTML autocontenido (sin recursos externos). El CSP solo permite el script y el estilo
// inline por su hash SHA-256, así que cualquier otro script inyectado no se ejecuta.
import { createHash } from 'node:crypto';

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12151d;color:#e8ecf5;font:15px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
main{width:min(380px,calc(100vw - 32px));padding:28px;border:1px solid rgba(160,176,210,.24);border-radius:12px;background:#141821}
h1{margin:0 0 4px;font-size:20px}
p.sub{margin:0 0 20px;color:#9aa4b8;font-size:13px}
label{display:block;margin:14px 0 6px;font-size:13px;color:#9aa4b8}
input{width:100%;padding:10px 12px;border:1px solid rgba(160,176,210,.3);border-radius:8px;background:#0e1117;color:inherit;font:inherit}
input:focus{outline:2px solid #7cc8ff;outline-offset:1px}
button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;background:#7cc8ff;color:#08131d;font:inherit;font-weight:600;cursor:pointer}
button[disabled]{opacity:.6;cursor:wait}
#msg{min-height:20px;margin:14px 0 0;color:#e5484d;font-size:13px}
`;

const SCRIPT = `
const f=document.getElementById('f'),m=document.getElementById('msg'),b=document.getElementById('b');
f.addEventListener('submit',async(e)=>{
  e.preventDefault();
  m.textContent='';
  b.disabled=true;
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({usuario:f.usuario.value,password:f.password.value})});
    if(r.ok){location.replace('/');return;}
    const j=await r.json().catch(()=>({}));
    m.textContent=j.error||'No se pudo iniciar sesión.';
  }catch{m.textContent='No se pudo conectar con el servidor.';}
  b.disabled=false;
  f.password.value='';
  f.password.focus();
});
`;

const sha = (s: string): string => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

/** Cabecera Content-Security-Policy de la página de login. */
export const LOGIN_CSP = `default-src 'none'; style-src ${sha(STYLE)}; script-src ${sha(SCRIPT)}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;

export const LOGIN_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Iniciar sesión · Auditoría n8n</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Auditoría n8n</h1>
<p class="sub">Ingresa con tu usuario y contraseña.</p>
<form id="f" autocomplete="on">
<label for="usuario">Usuario</label>
<input id="usuario" name="usuario" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus>
<label for="password">Contraseña</label>
<input id="password" name="password" type="password" autocomplete="current-password" maxlength="200" required>
<button id="b" type="submit">Entrar</button>
<p id="msg" role="alert" aria-live="assertive"></p>
</form>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
