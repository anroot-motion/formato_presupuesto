/* =============================================================================
   Generador de Propuestas — backend de referencia (portable)
   -----------------------------------------------------------------------------
   Un solo manejador fetch() sin dependencias externas. Corre igual como:
     - Cloudflare Worker (export default) con D1 + R2 — todo Cloudflare
     - Servidor Node ≥ 18 (ver server-node.mjs) — para infraestructura propia
   El acceso a datos está aislado en un "driver" (ver db-archivo.mjs y
   db-postgrest.mjs): para portarlo a otro motor solo se reimplementa el driver.

   Variables de entorno (ver .env.ejemplo):
     SECRETO_SESION   cadena larga aleatoria para firmar los tokens
     DB_DRIVER        "d1" (Cloudflare D1+R2) | "postgrest" (Supabase/PostgREST) | "archivo" (demo)
     SUPABASE_URL     solo driver postgrest
     SUPABASE_SERVICE_KEY  solo driver postgrest (llave service_role; NUNCA al navegador)
   ========================================================================== */

const JSONH = { "content-type": "application/json; charset=utf-8" };
const enc = new TextEncoder();

/* ---------- utilidades ---------- */
const j = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...JSONH, ...extra } });
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uTexto = (s) => b64u(enc.encode(s));
const deB64u = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
};
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secreto, texto) {
  const llave = await crypto.subtle.importKey("raw", enc.encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", llave, enc.encode(texto)));
}
async function pbkdf2(contrasena, salHex, iteraciones) {
  const sal = new Uint8Array(salHex.match(/.{2}/g).map((x) => parseInt(x, 16)));
  const llave = await crypto.subtle.importKey("raw", enc.encode(contrasena), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteraciones }, llave, 256);
  return hex(bits);
}
/* formato guardado: "pbkdf2$<iteraciones>$<hex>" — cada usuario conserva las suyas,
   así PBKDF2_ITER puede cambiarse sin invalidar contraseñas existentes */
const iterDe = (env) => Math.max(10000, parseInt(env.PBKDF2_ITER || "100000", 10) || 100000);
async function hashNuevo(env, contrasena, sal) {
  const it = iterDe(env);
  return "pbkdf2$" + it + "$" + (await pbkdf2(contrasena, sal, it));
}
async function verificar(contrasena, sal, guardado) {
  const m = /^pbkdf2\$(\d+)\$([0-9a-f]+)$/.exec(guardado || "");
  if (!m) return false;
  return igualesSeguro(await pbkdf2(contrasena, sal, parseInt(m[1], 10)), m[2]);
}
const salNueva = () => hex(crypto.getRandomValues(new Uint8Array(16)).buffer);

/* comparación en tiempo constante para hashes/firmas en hex */
function igualesSeguro(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------- sesiones (token firmado, sin estado en servidor) ---------- */
async function emitirToken(env, usuario) {
  const cuerpo = b64uTexto(JSON.stringify({
    correo: usuario.correo, nombre: usuario.nombre, rol: usuario.rol,
    exp: Date.now() + 12 * 60 * 60 * 1000,
  }));
  return cuerpo + "." + (await hmac(env.SECRETO_SESION, cuerpo));
}
async function validarToken(env, req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const punto = token.lastIndexOf(".");
  if (punto < 0) return null;
  const cuerpo = token.slice(0, punto), firma = token.slice(punto + 1);
  if (!igualesSeguro(await hmac(env.SECRETO_SESION, cuerpo), firma)) return null;
  try {
    const datos = JSON.parse(deB64u(cuerpo));
    if (!datos.exp || datos.exp < Date.now()) return null;
    return datos;
  } catch { return null; }
}

/* ---------- manejador principal ---------- */
export async function manejar(req, env, db) {
  const url = new URL(req.url);
  const ruta = url.pathname.replace(/\/+$/, "");
  const metodo = req.method.toUpperCase();

  try {
    /* --- salud y estado (sin sesión) --- */
    if (ruta === "/api/salud") return j({ ok: true, servicio: "propuesta", version: 1 });
    if (ruta === "/api/estado" && metodo === "GET") {
      const n = await db.contarUsuarios();
      return j({ usuarios: n, inicializado: n > 0 });
    }

    /* --- arranque: crear el primer administrador (solo con la tabla vacía) --- */
    if (ruta === "/api/registrar-inicial" && metodo === "POST") {
      if ((await db.contarUsuarios()) > 0) return j({ error: "El sistema ya está inicializado." }, 409);
      const { correo, nombre, contrasena } = await req.json();
      if (!correo || !contrasena || contrasena.length < 8)
        return j({ error: "Correo y contraseña (mínimo 8 caracteres) son obligatorios." }, 400);
      const sal = salNueva();
      await db.crearUsuario({
        correo: correo.trim().toLowerCase(), nombre: (nombre || "").trim() || correo,
        sal, hash: await hashNuevo(env, contrasena, sal), rol: "admin",
      });
      return j({ ok: true });
    }

    /* --- login --- */
    if (ruta === "/api/login" && metodo === "POST") {
      const { correo, contrasena } = await req.json();
      const u = await db.usuarioPorCorreo((correo || "").trim().toLowerCase());
      if (!u || !u.activo) return j({ error: "Correo o contraseña incorrectos." }, 401);
      if (!(await verificar(contrasena || "", u.sal, u.hash)))
        return j({ error: "Correo o contraseña incorrectos." }, 401);
      return j({ token: await emitirToken(env, u), correo: u.correo, nombre: u.nombre, rol: u.rol });
    }

    /* --- todo lo demás exige sesión --- */
    const sesion = await validarToken(env, req);
    if (!sesion) return j({ error: "Sesión inválida o vencida." }, 401);

    /* --- gestión de usuarios (solo admin) --- */
    if (ruta === "/api/usuarios" && metodo === "GET") {
      if (sesion.rol !== "admin") return j({ error: "Solo el administrador." }, 403);
      return j({ usuarios: await db.listarUsuarios() });
    }
    if (ruta === "/api/usuarios" && metodo === "POST") {
      if (sesion.rol !== "admin") return j({ error: "Solo el administrador." }, 403);
      const { correo, nombre, contrasena, rol } = await req.json();
      if (!correo || !contrasena || contrasena.length < 8)
        return j({ error: "Correo y contraseña (mínimo 8 caracteres) son obligatorios." }, 400);
      if (await db.usuarioPorCorreo(correo.trim().toLowerCase()))
        return j({ error: "Ese correo ya existe." }, 409);
      const sal = salNueva();
      await db.crearUsuario({
        correo: correo.trim().toLowerCase(), nombre: (nombre || "").trim() || correo,
        sal, hash: await hashNuevo(env, contrasena, sal), rol: rol === "admin" ? "admin" : "editor",
      });
      return j({ ok: true });
    }
    const mUsuario = ruta.match(/^\/api\/usuarios\/([^/]+)$/);
    if (mUsuario && metodo === "DELETE") {
      if (sesion.rol !== "admin") return j({ error: "Solo el administrador." }, 403);
      const correo = decodeURIComponent(mUsuario[1]).toLowerCase();
      if (correo === sesion.correo) return j({ error: "No puedes desactivar tu propia cuenta." }, 400);
      await db.desactivarUsuario(correo);
      return j({ ok: true });
    }

    /* --- documentos compartidos --- */
    if (ruta === "/api/documentos" && metodo === "GET")
      return j({ documentos: await db.listarDocumentos() });

    if (ruta === "/api/documentos" && metodo === "POST") {
      const { nombre, estado } = await req.json();
      const limpio = (nombre || "").trim();
      if (!limpio) return j({ error: "El documento necesita nombre." }, 400);
      if (await db.documentoPorNombre(limpio)) return j({ error: "Ya existe un documento con ese nombre." }, 409);
      const doc = await db.crearDocumento({ nombre: limpio, estado: estado || {}, autor: sesion.correo });
      return j({ ok: true, id: doc.id, version: doc.version });
    }

    const mDoc = ruta.match(/^\/api\/documentos\/([^/]+)(\/duplicar)?$/);
    if (mDoc) {
      const id = decodeURIComponent(mDoc[1]);
      const doc = await db.documentoPorId(id);
      if (!doc) return j({ error: "Documento no encontrado." }, 404);

      if (mDoc[2] && metodo === "POST") { /* duplicar */
        const { nombre } = await req.json().catch(() => ({}));
        let nuevo = (nombre || "").trim() || doc.nombre + " (copia)";
        let i = 2;
        while (await db.documentoPorNombre(nuevo)) nuevo = doc.nombre + " (copia " + i++ + ")";
        const copia = await db.crearDocumento({ nombre: nuevo, estado: doc.estado, autor: sesion.correo });
        return j({ ok: true, id: copia.id, nombre: nuevo });
      }
      if (metodo === "GET") return j({ documento: doc });
      if (metodo === "PUT") {
        const { nombre, estado, version, forzar } = await req.json();
        if (!forzar && version !== undefined && version !== doc.version)
          return j({ error: "conflicto", version: doc.version, actualizado: doc.actualizado, autor: doc.autor }, 409);
        if (nombre !== undefined) {
          const limpio = (nombre || "").trim();
          if (!limpio) return j({ error: "El documento necesita nombre." }, 400);
          const otro = await db.documentoPorNombre(limpio);
          if (otro && otro.id !== doc.id) return j({ error: "Ya existe un documento con ese nombre." }, 409);
        }
        const cambios = {
          ...(nombre !== undefined ? { nombre: nombre.trim() } : {}),
          ...(estado !== undefined ? { estado } : {}),
          autor: sesion.correo,
        };
        /* actualización condicional: cierra la carrera entre dos guardados simultáneos */
        const esperada = (!forzar && version !== undefined) ? version : undefined;
        let act = await db.actualizarDocumento(id, cambios, esperada);
        for (let intento = 0; !act && forzar && intento < 3; intento++)
          act = await db.actualizarDocumento(id, cambios, undefined);
        if (!act) {
          const vig = await db.documentoPorId(id);
          if (!vig) return j({ error: "Documento no encontrado." }, 404);
          return j({ error: "conflicto", version: vig.version, actualizado: vig.actualizado, autor: vig.autor }, 409);
        }
        return j({ ok: true, version: act.version });
      }
      if (metodo === "DELETE") { await db.eliminarDocumento(id); return j({ ok: true }); }
    }

    return j({ error: "Ruta no encontrada." }, 404);
  } catch (e) {
    return j({ error: "Error interno: " + (e && e.message || e) }, 500);
  }
}

/* ---------- entrada Cloudflare Worker ---------- */
export default {
  async fetch(req, env, ctx) {
    if (new URL(req.url).pathname.startsWith("/api/")) {
      /* "d1" (default si existe el binding DB) = todo Cloudflare: D1 + R2
         "postgrest" = Supabase o PostgreSQL + PostgREST */
      const driver = env.DB_DRIVER || (env.DB ? "d1" : "postgrest");
      const { crearDriver } = driver === "d1" ? await import("./db-d1.mjs") : await import("./db-postgrest.mjs");
      return manejar(req, env, crearDriver(env));
    }
    /* estáticos: con Workers Assets (wrangler.jsonc) env.ASSETS sirve la app */
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("Generador de Propuestas — API activa. La app se sirve como asset estático.", { status: 200 });
  },
};
