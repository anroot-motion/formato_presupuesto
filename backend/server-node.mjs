/* Servidor Node ≥ 18 — para montar en infraestructura propia (VM, IONOS, IIS con
   reverse proxy, contenedor…). Sirve la app (../app) y la API (/api/*).
   Uso:  node server-node.mjs            (lee .env si existe)
   Variables: PUERTO (8080), DB_DRIVER ("archivo"|"postgrest"), DATOS (ruta del JSON
   del driver archivo), SECRETO_SESION, SUPABASE_URL, SUPABASE_SERVICE_KEY. */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manejar } from "./worker.mjs";

const aqui = dirname(fileURLToPath(import.meta.url));

/* .env mínimo (clave=valor), sin dependencias */
const envArchivo = join(aqui, ".env");
if (existsSync(envArchivo)) {
  for (const linea of readFileSync(envArchivo, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = process.env;
if (!env.SECRETO_SESION || env.SECRETO_SESION.length < 32) {
  console.error("Falta SECRETO_SESION (mínimo 32 caracteres) en .env o variables de entorno.");
  process.exit(1);
}

const driverNombre = env.DB_DRIVER || "archivo";
const db = driverNombre === "postgrest"
  ? (await import("./db-postgrest.mjs")).crearDriver(env)
  : (await import("./db-archivo.mjs")).crearDriver(env.DATOS || join(aqui, "datos-demo.json"));

const dirApp = join(aqui, "..", "app");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const cuerpo = await new Promise((ok) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => ok(Buffer.concat(c))); });
      const r = await manejar(new Request(url, {
        method: req.method, headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : cuerpo,
      }), env, db);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let archivo = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    if (archivo.includes("..")) { res.writeHead(400); res.end(); return; }
    const ruta = join(dirApp, archivo);
    if (!existsSync(ruta)) { res.writeHead(404); res.end("No encontrado"); return; }
    res.writeHead(200, { "content-type": TIPOS[extname(ruta)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(readFileSync(ruta));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("Error: " + e.message);
  }
}).listen(parseInt(env.PUERTO || "8080", 10), () => {
  console.log(`Generador de Propuestas en http://localhost:${env.PUERTO || 8080}  (driver: ${driverNombre})`);
});
