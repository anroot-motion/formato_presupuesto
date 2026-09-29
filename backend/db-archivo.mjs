/* Driver de datos en archivo JSON — para la demo local y las pruebas.
   NO usar en producción: un solo proceso, sin concurrencia real ni respaldos. */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

export function crearDriver(ruta) {
  let d = { usuarios: [], documentos: [] };
  if (existsSync(ruta)) d = JSON.parse(readFileSync(ruta, "utf8"));
  const guardar = () => {
    const tmp = ruta + ".tmp";
    writeFileSync(tmp, JSON.stringify(d));
    renameSync(tmp, ruta); /* escritura atómica */
  };
  const ahora = () => new Date().toISOString();
  const sinEstado = (x) => ({ id: x.id, nombre: x.nombre, version: x.version, autor: x.autor, actualizado: x.actualizado });

  return {
    async contarUsuarios() { return d.usuarios.length; },
    async usuarioPorCorreo(correo) { return d.usuarios.find((u) => u.correo === correo) || null; },
    async crearUsuario(u) { d.usuarios.push({ ...u, activo: true, creado: ahora() }); guardar(); },
    async listarUsuarios() {
      return d.usuarios.map((u) => ({ correo: u.correo, nombre: u.nombre, rol: u.rol, activo: u.activo }));
    },
    async desactivarUsuario(correo) {
      const u = d.usuarios.find((x) => x.correo === correo); if (u) { u.activo = false; guardar(); }
    },
    async listarDocumentos() {
      return d.documentos.map(sinEstado).sort((a, b) => (b.actualizado > a.actualizado ? 1 : -1));
    },
    async documentoPorId(id) { return d.documentos.find((x) => x.id === id) || null; },
    async documentoPorNombre(nombre) { return d.documentos.find((x) => x.nombre === nombre) || null; },
    async crearDocumento({ nombre, estado, autor }) {
      const doc = { id: crypto.randomUUID(), nombre, estado, autor, version: 1, actualizado: ahora() };
      d.documentos.push(doc); guardar(); return doc;
    },
    async actualizarDocumento(id, cambios, versionEsperada) {
      const doc = d.documentos.find((x) => x.id === id);
      if (!doc || (versionEsperada !== undefined && doc.version !== versionEsperada)) return null;
      Object.assign(doc, cambios, { version: doc.version + 1, actualizado: ahora() });
      guardar(); return doc;
    },
    async eliminarDocumento(id) { d.documentos = d.documentos.filter((x) => x.id !== id); guardar(); },
  };
}
