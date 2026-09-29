/* Driver PostgREST — Supabase o cualquier PostgreSQL con PostgREST delante.
   Usa la llave de servicio del lado del servidor: el navegador NUNCA la ve.
   Tablas: ver sql/esquema.sql (esquema "propuesta"). */

export function crearDriver(env) {
  const base = (env.SUPABASE_URL || "").replace(/\/+$/, "") + "/rest/v1";
  const H = {
    apikey: env.SUPABASE_SERVICE_KEY,
    authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
    "content-type": "application/json",
    "accept-profile": "propuesta",
    "content-profile": "propuesta",
  };
  async function q(ruta, opt = {}) {
    const r = await fetch(base + ruta, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
    if (!r.ok) throw new Error("PostgREST " + r.status + ": " + (await r.text()).slice(0, 300));
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  const uno = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
  const enc = encodeURIComponent;

  return {
    async contarUsuarios() {
      const r = await fetch(base + "/usuarios?select=correo", { headers: { ...H, prefer: "count=exact", range: "0-0" } });
      const cr = r.headers.get("content-range") || "*/0";
      return parseInt(cr.split("/")[1], 10) || 0;
    },
    async usuarioPorCorreo(correo) { return uno(await q("/usuarios?correo=eq." + enc(correo) + "&select=*")); },
    async crearUsuario(u) {
      await q("/usuarios", { method: "POST", body: JSON.stringify({ ...u, activo: true }), headers: { prefer: "return=minimal" } });
    },
    async listarUsuarios() { return q("/usuarios?select=correo,nombre,rol,activo&order=correo"); },
    async desactivarUsuario(correo) {
      await q("/usuarios?correo=eq." + enc(correo), { method: "PATCH", body: JSON.stringify({ activo: false }), headers: { prefer: "return=minimal" } });
    },
    async listarDocumentos() { return q("/documentos?select=id,nombre,version,autor,actualizado&order=actualizado.desc"); },
    async documentoPorId(id) { return uno(await q("/documentos?id=eq." + enc(id) + "&select=*")); },
    async documentoPorNombre(nombre) { return uno(await q("/documentos?nombre=eq." + enc(nombre) + "&select=id,nombre")); },
    async crearDocumento({ nombre, estado, autor }) {
      return uno(await q("/documentos", { method: "POST", body: JSON.stringify({ nombre, estado, autor }), headers: { prefer: "return=representation" } }));
    },
    async actualizarDocumento(id, cambios, versionEsperada) {
      /* la versión la incrementa el trigger de la tabla (sql/esquema.sql); el filtro
         por versión hace la actualización condicional (vacío = conflicto) */
      const filtro = "/documentos?id=eq." + enc(id) + (versionEsperada !== undefined ? "&version=eq." + versionEsperada : "");
      return uno(await q(filtro, { method: "PATCH", body: JSON.stringify(cambios), headers: { prefer: "return=representation" } }));
    },
    async eliminarDocumento(id) {
      await q("/documentos?id=eq." + enc(id), { method: "DELETE", headers: { prefer: "return=minimal" } });
    },
  };
}
