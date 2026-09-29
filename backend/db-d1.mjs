/* Driver Cloudflare — D1 (SQLite) para usuarios e índice de documentos,
   R2 para el contenido completo de cada documento (con fotos pesa 1–5 MB y D1
   limita cada fila a 2 MB).
   Bindings (wrangler.jsonc):  DB = base D1  ·  DOCS = bucket R2
   Tablas: ver sql/esquema-d1.sql.

   Cada versión se escribe en R2 con llave propia (docs/<id>/v<N>-<azar>.json) y D1 apunta
   a la vigente. Las versiones anteriores se conservan 30 días (la ventana de D1 Time
   Travel), así un índice restaurado siempre encuentra su contenido. La actualización en D1 es condicional a la versión esperada: si dos
   personas guardan a la vez, solo una gana y la otra recibe el aviso de conflicto
   sin que su intento haya pisado nada. */

export function crearDriver(env) {
  const DB = env.DB, R2 = env.DOCS;
  if (!DB || !R2) throw new Error("Faltan los bindings DB (D1) y/o DOCS (R2) en wrangler.jsonc.");
  const ahora = () => new Date().toISOString();
  /* llave única por intento: dos guardados simultáneos nunca comparten objeto */
  const llave = (id, v) => `docs/${id}/v${v}-${crypto.randomUUID().slice(0, 8)}.json`;
  const COLS = "id, nombre, autor, version, bytes, creado, actualizado";

  const RETENCION_MS = 30 * 24 * 60 * 60 * 1000;
  async function leerEstado(fila) {
    const obj = await R2.get(fila.objeto);
    if (!obj) throw new Error("El contenido de este documento no está en R2 (" + fila.objeto + ").");
    return JSON.parse(await obj.text());
  }
  async function listarVersiones(id) {
    const todos = []; let cursor;
    do {
      const r = await R2.list({ prefix: `docs/${id}/`, cursor });
      todos.push(...r.objects); cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return todos;
  }
  /* borra versiones anteriores con más de 30 días; nunca la vigente */
  async function purgar(id, vigente) {
    const limite = Date.now() - RETENCION_MS;
    const viejas = (await listarVersiones(id))
      .filter((o) => o.key !== vigente && new Date(o.uploaded).getTime() < limite).map((o) => o.key);
    if (viejas.length) await R2.delete(viejas);
  }
  async function escribirEstado(id, v, estado) {
    const texto = JSON.stringify(estado || {});
    const k = llave(id, v);
    await R2.put(k, texto, { httpMetadata: { contentType: "application/json" } });
    return { objeto: k, bytes: texto.length };
  }

  return {
    /* ---------- usuarios ---------- */
    async contarUsuarios() {
      return (await DB.prepare("SELECT COUNT(*) AS n FROM usuarios").first("n")) || 0;
    },
    async usuarioPorCorreo(correo) {
      const u = await DB.prepare("SELECT * FROM usuarios WHERE correo = ?").bind(correo).first();
      return u ? { ...u, activo: !!u.activo } : null;
    },
    async crearUsuario(u) {
      await DB.prepare("INSERT INTO usuarios (correo, nombre, sal, hash, rol, activo, creado) VALUES (?, ?, ?, ?, ?, 1, ?)")
        .bind(u.correo, u.nombre, u.sal, u.hash, u.rol, ahora()).run();
    },
    async listarUsuarios() {
      const { results } = await DB.prepare("SELECT correo, nombre, rol, activo FROM usuarios ORDER BY correo").all();
      return results.map((u) => ({ ...u, activo: !!u.activo }));
    },
    async desactivarUsuario(correo) {
      await DB.prepare("UPDATE usuarios SET activo = 0 WHERE correo = ?").bind(correo).run();
    },

    /* ---------- documentos ---------- */
    async listarDocumentos() {
      const { results } = await DB.prepare(`SELECT ${COLS} FROM documentos ORDER BY actualizado DESC`).all();
      return results;
    },
    async documentoPorId(id) {
      const f = await DB.prepare("SELECT * FROM documentos WHERE id = ?").bind(id).first();
      if (!f) return null;
      const { objeto, ...resto } = f;
      return { ...resto, estado: await leerEstado(f) };
    },
    async documentoPorNombre(nombre) {
      return await DB.prepare("SELECT id, nombre FROM documentos WHERE nombre = ?").bind(nombre).first();
    },
    async crearDocumento({ nombre, estado, autor }) {
      const id = crypto.randomUUID(), t = ahora();
      const { objeto, bytes } = await escribirEstado(id, 1, estado);
      try {
        await DB.prepare("INSERT INTO documentos (id, nombre, autor, version, objeto, bytes, creado, actualizado) VALUES (?, ?, ?, 1, ?, ?, ?, ?)")
          .bind(id, nombre, autor, objeto, bytes, t, t).run();
      } catch (e) {
        await R2.delete(objeto);          /* sin huérfanos si el nombre ya existía */
        throw e;
      }
      return { id, nombre, autor, version: 1, actualizado: t };
    },
    /* versionEsperada: si viene, la actualización solo procede si D1 sigue en esa
       versión; devuelve null cuando alguien más guardó antes (conflicto). */
    async actualizarDocumento(id, cambios, versionEsperada) {
      const actual = await DB.prepare("SELECT version, objeto FROM documentos WHERE id = ?").bind(id).first();
      if (!actual) return null;
      if (versionEsperada !== undefined && actual.version !== versionEsperada) return null;
      const nueva = actual.version + 1, t = ahora();
      let objeto = actual.objeto, bytes = null;
      if (cambios.estado !== undefined) ({ objeto, bytes } = await escribirEstado(id, nueva, cambios.estado));

      const sets = ["version = version + 1", "actualizado = ?", "autor = ?", "objeto = ?"];
      const args = [t, cambios.autor, objeto];
      if (bytes !== null) { sets.push("bytes = ?"); args.push(bytes); }
      if (cambios.nombre !== undefined) { sets.push("nombre = ?"); args.push(cambios.nombre); }
      const r = await DB.prepare(`UPDATE documentos SET ${sets.join(", ")} WHERE id = ? AND version = ?`)
        .bind(...args, id, actual.version).run();

      if (!r.meta || r.meta.changes !== 1) {         /* otro guardado ganó la carrera */
        if (objeto !== actual.objeto) await R2.delete(objeto);
        return null;
      }
      await purgar(id, objeto);
      return { id, version: nueva, actualizado: t };
    },
    async eliminarDocumento(id) {
      await DB.prepare("DELETE FROM documentos WHERE id = ?").bind(id).run();
      const keys = (await listarVersiones(id)).map((o) => o.key);
      if (keys.length) await R2.delete(keys);
    },
  };
}
