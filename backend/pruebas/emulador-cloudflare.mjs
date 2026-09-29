/* Emulador local de la variante "todo Cloudflare" — corre worker.mjs SIN cambios
   con bindings equivalentes:
     DB     → D1 emulado sobre SQLite real (node:sqlite, Node ≥ 22.13)
     DOCS   → R2 emulado sobre una carpeta
     ASSETS → la carpeta ../app
   Sirve para la demo y las pruebas locales. La validación definitiva es
   `npx wrangler dev` / el despliegue real con la batería de pruebas.
     node pruebas/emulador-cloudflare.mjs [puerto] [carpeta-de-datos]
*/
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import worker from "../worker.mjs";

const aqui = dirname(fileURLToPath(import.meta.url));
const PUERTO = parseInt(process.argv[2] || process.env.PUERTO || "8787", 10);
const DATOS = process.argv[3] || join(aqui, "..", ".datos-locales");
mkdirSync(join(DATOS, "r2"), { recursive: true });

/* ---------- D1 ---------- */
const sql = new DatabaseSync(join(DATOS, "d1.sqlite"));
sql.exec(readFileSync(join(aqui, "..", "sql", "esquema-d1.sql"), "utf8"));
const plano = (r) => (r ? { ...r } : r);
class Sentencia {
  constructor(texto, args = []) { this.texto = texto; this.args = args; }
  bind(...args) { return new Sentencia(this.texto, args); }
  async first(col) { const r = plano(sql.prepare(this.texto).get(...this.args)); if (!r) return null; return col ? r[col] : r; }
  async all() { return { results: sql.prepare(this.texto).all(...this.args).map(plano), success: true, meta: {} }; }
  async run() { const r = sql.prepare(this.texto).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
}
const DB = { prepare: (texto) => new Sentencia(texto) };

/* ---------- R2 ---------- */
const ruta = (k) => join(DATOS, "r2", encodeURIComponent(k));
const DOCS = {
  /* latencia simulada de red: fuerza que los guardados concurrentes se entrelacen */
  async put(k, valor) { await new Promise((ok) => setTimeout(ok, 5 + Math.random() * 40)); writeFileSync(ruta(k), typeof valor === "string" ? valor : Buffer.from(await new Response(valor).arrayBuffer())); return { key: k }; },
  async get(k) { await new Promise((ok) => setTimeout(ok, 2 + Math.random() * 10)); if (!existsSync(ruta(k))) return null; const b = readFileSync(ruta(k)); return { key: k, text: async () => b.toString("utf8"), json: async () => JSON.parse(b) }; },
  async delete(k) { for (const x of [].concat(k)) if (existsSync(ruta(x))) rmSync(ruta(x)); },
  async list({ prefix = "" } = {}) {
    const objects = readdirSync(join(DATOS, "r2")).map(decodeURIComponent).filter((k) => k.startsWith(prefix))
      .map((k) => ({ key: k, uploaded: statSync(ruta(k)).mtime }));
    return { objects, truncated: false };
  },
};

/* ---------- ASSETS ---------- */
const dirApp = join(aqui, "..", "..", "app");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const ASSETS = {
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname); if (p === "/") p = "/index.html";
    const f = join(dirApp, p);
    if (p.includes("..") || !existsSync(f)) return new Response("No encontrado", { status: 404 });
    return new Response(readFileSync(f), { headers: { "content-type": TIPOS[extname(f)] || "application/octet-stream" } });
  },
};

const env = {
  DB, DOCS, ASSETS, DB_DRIVER: "d1",
  SECRETO_SESION: process.env.SECRETO_SESION || randomBytes(32).toString("hex"),
  PBKDF2_ITER: process.env.PBKDF2_ITER || "100000",
};

createServer(async (req, res) => {
  try {
    const cuerpo = await new Promise((ok) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => ok(Buffer.concat(c))); });
    const r = await worker.fetch(new Request(new URL(req.url, "http://localhost:" + PUERTO), {
      method: req.method, headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : cuerpo,
    }), env, {});
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("Error: " + e.message);
  }
}).listen(PUERTO, () => console.log(`Emulador Cloudflare (D1+R2) en http://localhost:${PUERTO}  · datos: ${DATOS}`));
