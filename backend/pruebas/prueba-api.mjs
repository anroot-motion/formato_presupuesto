/* Batería de pruebas de la API — correr contra un ambiente RECIÉN INICIALIZADO
   (tabla de usuarios vacía), p. ej. el de pruebas o staging. NO correr en producción:
   crea el administrador inicial y datos de prueba.
     node pruebas/prueba-api.mjs http://localhost:8080
*/
const B = (process.argv[2] || "http://localhost:8080").replace(/\/+$/, "");
let fallas = 0;
const call = async (r, o = {}, tk) => {
  const h = { "content-type": "application/json" }; if (tk) h.authorization = "Bearer " + tk;
  const res = await fetch(B + r, { ...o, headers: h }); let d = {}; try { d = await res.json(); } catch {}
  return { s: res.status, d };
};
const ok = (c, m) => { if (!c) fallas++; console.log((c ? "OK    " : "FALLA ") + m); };

let r = await call("/api/salud");
ok(r.s === 200 && r.d.servicio === "propuesta", "00 salud");
r = await call("/api/estado");
if (r.d.inicializado) { console.log("El ambiente ya tiene usuarios. Corre la batería en uno recién inicializado."); process.exit(2); }

r = await call("/api/registrar-inicial", { method: "POST", body: JSON.stringify({ correo: "Admin.Prueba@motioncorp.com.mx", nombre: "Admin", contrasena: "clave-segura-1" }) });
ok(r.s === 200, "01 crear admin inicial");
r = await call("/api/registrar-inicial", { method: "POST", body: JSON.stringify({ correo: "x@x.com", contrasena: "12345678" }) });
ok(r.s === 409, "02 segundo registro-inicial bloqueado");
r = await call("/api/login", { method: "POST", body: JSON.stringify({ correo: "admin.prueba@motioncorp.com.mx", contrasena: "mala" }) });
ok(r.s === 401, "03 contraseña incorrecta rechazada");
r = await call("/api/login", { method: "POST", body: JSON.stringify({ correo: "ADMIN.prueba@motioncorp.com.mx", contrasena: "clave-segura-1" }) });
ok(r.s === 200 && r.d.rol === "admin", "04 login admin (correo sin distinguir mayúsculas)"); const adm = r.d.token;
r = await call("/api/documentos"); ok(r.s === 401, "05 sin token = 401");
r = await call("/api/documentos", {}, adm + "x"); ok(r.s === 401, "06 token alterado = 401");
r = await call("/api/usuarios", { method: "POST", body: JSON.stringify({ correo: "editor.prueba@motioncorp.com.mx", nombre: "Editor", contrasena: "editor-123", rol: "editor" }) }, adm);
ok(r.s === 200, "07 admin agrega editor");
r = await call("/api/login", { method: "POST", body: JSON.stringify({ correo: "editor.prueba@motioncorp.com.mx", contrasena: "editor-123" }) }); const ed = r.d.token;
ok(r.s === 200 && r.d.rol === "editor", "08 login editor");
r = await call("/api/usuarios", {}, ed); ok(r.s === 403, "09 editor NO administra usuarios");
r = await call("/api/documentos", { method: "POST", body: JSON.stringify({ nombre: "Machote prueba", estado: { cliente: "Hospital A", inv: [{ precio: "5671520.89" }] } }) }, ed);
ok(r.s === 200 && r.d.version === 1, "10 editor crea documento"); const id = r.d.id;
r = await call("/api/documentos", { method: "POST", body: JSON.stringify({ nombre: "Machote prueba", estado: {} }) }, adm);
ok(r.s === 409, "11 nombre duplicado bloqueado");
r = await call("/api/documentos", {}, adm);
ok(r.s === 200 && r.d.documentos.length === 1 && !("estado" in r.d.documentos[0]), "12 lista sin el estado pesado");
r = await call("/api/documentos/" + id, {}, adm); ok(r.d.documento && r.d.documento.estado.cliente === "Hospital A", "13 abrir trae el estado completo");
r = await call("/api/documentos/" + id, { method: "PUT", body: JSON.stringify({ estado: { cliente: "v2" }, version: 1 }) }, ed);
ok(r.s === 200 && r.d.version === 2, "14 guardar con versión correcta -> v2");
r = await call("/api/documentos/" + id, { method: "PUT", body: JSON.stringify({ estado: { cliente: "pisada" }, version: 1 }) }, adm);
ok(r.s === 409 && r.d.error === "conflicto" && r.d.autor === "editor.prueba@motioncorp.com.mx", "15 conflicto detectado e informa quién guardó");
r = await call("/api/documentos/" + id, { method: "PUT", body: JSON.stringify({ estado: { cliente: "forzada" }, forzar: true }) }, adm);
ok(r.s === 200 && r.d.version === 3, "16 sobrescritura explícita -> v3");
r = await call("/api/documentos/" + id + "/duplicar", { method: "POST", body: "{}" }, ed);
ok(r.s === 200 && r.d.nombre === "Machote prueba (copia)", "17 duplicar"); const id2 = r.d.id;
r = await call("/api/documentos/" + id2, { method: "PUT", body: JSON.stringify({ nombre: "Variante B" }) }, ed); ok(r.s === 200, "18 renombrar");
r = await call("/api/documentos/" + id, { method: "PUT", body: JSON.stringify({ nombre: "Variante B" }) }, ed); ok(r.s === 409, "19 renombrar a nombre existente bloqueado");
r = await call("/api/usuarios/" + encodeURIComponent("editor.prueba@motioncorp.com.mx"), { method: "DELETE" }, adm); ok(r.s === 200, "20 admin desactiva al editor");
r = await call("/api/login", { method: "POST", body: JSON.stringify({ correo: "editor.prueba@motioncorp.com.mx", contrasena: "editor-123" }) }); ok(r.s === 401, "21 usuario desactivado ya no entra");
r = await call("/api/usuarios/" + encodeURIComponent("admin.prueba@motioncorp.com.mx"), { method: "DELETE" }, adm); ok(r.s === 400, "22 admin no se desactiva a sí mismo");
r = await call("/api/documentos/" + id, { method: "DELETE" }, adm); ok(r.s === 200, "23 eliminar");
r = await call("/api/documentos", {}, adm); ok(r.d.documentos.length === 1, "24 queda un documento");
r = await call("/api/documentos", { method: "POST", body: JSON.stringify({ nombre: "Pesado", estado: { foto: "x".repeat(4_000_000) } }) }, adm);
ok(r.s === 200, "25 documento de ~4 MB (fotos embebidas) se guarda");
const idPesado = r.d.id;
r = await call("/api/documentos/" + idPesado, {}, adm);
ok(r.d.documento && r.d.documento.estado.foto.length === 4_000_000, "26 el documento pesado se recupera íntegro");

/* carrera: dos guardados simultáneos sobre la MISMA versión — gana exactamente uno.
   Se repite 10 rondas para que el entrelazado ocurra de verdad. */
let rondasOk = 0, contenidoOk = 0;
for (let ronda = 0; ronda < 10; ronda++) {
  const previo = (await call("/api/documentos/" + idPesado, {}, adm)).d.documento;
  if (!previo) { console.log("       ronda " + ronda + ": el documento quedó ilegible"); break; }
  const vAct = previo.version;
  const [a, b] = await Promise.all([
    call("/api/documentos/" + idPesado, { method: "PUT", body: JSON.stringify({ estado: { quien: "A" + ronda, relleno: "a".repeat(200000) }, version: vAct }) }, adm),
    call("/api/documentos/" + idPesado, { method: "PUT", body: JSON.stringify({ estado: { quien: "B" + ronda, relleno: "b".repeat(200000) }, version: vAct }) }, adm),
  ]);
  const st = [a.s, b.s].sort();
  if (st[0] === 200 && st[1] === 409) rondasOk++;
  const vig = (await call("/api/documentos/" + idPesado, {}, adm)).d.documento;
  const gano = a.s === 200 ? "A" : "B";
  if (vig && vig.version === vAct + 1 && vig.estado.quien === gano + ronda &&
      vig.estado.relleno === (gano === "A" ? "a" : "b").repeat(200000)) contenidoOk++;
}
ok(rondasOk === 10, `27 carrera de dos guardados (10 rondas): siempre gana exactamente uno (${rondasOk}/10)`);
ok(contenidoOk === 10, `28 el contenido vigente es íntegramente del ganador, sin mezcla ni pérdida (${contenidoOk}/10)`);

console.log(fallas ? `\n${fallas} FALLA(S)` : "\nTODAS LAS PRUEBAS PASARON");
process.exit(fallas ? 1 : 0);
