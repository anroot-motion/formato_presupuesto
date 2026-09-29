# Generador de Propuestas — guía de despliegue en línea

Adrián, equipo de Desarrollo:

Les comparto el paquete para conectar a internet el generador de propuestas que usa
Nuevos Negocios, ya adaptado a lo que acordamos: **todo sobre Cloudflare** — Worker, base
de datos D1 y almacenamiento R2. Dejo también la alternativa de infraestructura propia
por si la llegaran a necesitar. Cualquier duda la vemos juntos.

— Ayrton

---

## 1. Qué es y qué cambia al ponerla en línea

La herramienta es una sola página web (`app/index.html`, autocontenida: tipografías,
logos y fotos van embebidos) que arma el Formato Presupuesto V2 y lo exporta a PDF,
Word y PowerPoint. Hoy corre local en cada equipo y los borradores viajan como archivos.

Servida por este Worker, la misma página detecta la API y activa sola el **modo en
línea**:

- **Acceso con usuario y contraseña** (cuentas administradas desde la propia app).
- **Biblioteca compartida**: documentos con nombre que todo el equipo ve, abre,
  duplica, renombra y elimina.
- **Protección contra pisarse**: si dos personas guardan el mismo documento, la segunda
  recibe el aviso de quién guardó antes y decide. La actualización es condicional en la
  base, así que ni dos guardados en el mismo instante pueden mezclarse.

Abierta como archivo local, la página sigue funcionando 100% local como hasta hoy.

## 2. Arquitectura en Cloudflare

| Pieza | Servicio | Qué hace |
|---|---|---|
| App + API | **Workers** (con Static Assets) | Sirve la página, valida sesiones y aplica permisos |
| Base de datos | **D1** | Usuarios, índice de documentos, versiones y autor |
| Documentos | **R2** | El JSON completo de cada propuesta (con fotos: 1–5 MB) |

Por qué D1 **y** R2: D1 limita cada fila a 2 MB y las propuestas con fotos pesan más.
D1 guarda el índice y R2 el contenido; cada guardado escribe un objeto con llave única y
D1 apunta al vigente. Las versiones anteriores se conservan 30 días (la misma ventana
que D1 Time Travel) y los intentos que pierden un conflicto se eliminan al momento. D1 y R2 se conectan por *bindings*: **no
existe ninguna llave de base de datos** que resguardar.

## 3. Contenido del paquete

```
app/index.html                   la herramienta (Static Assets del Worker)
backend/worker.mjs               API: acceso, usuarios y documentos (sin dependencias)
backend/db-d1.mjs                acceso a datos Cloudflare: D1 + R2
backend/wrangler.jsonc           configuración del Worker, D1 y R2
backend/sql/esquema-d1.sql       tablas e índice para D1
backend/pruebas/prueba-api.mjs   batería de 28 pruebas de la API
backend/pruebas/emulador-cloudflare.mjs  corre el Worker local con D1/R2 emulados
INICIAR-DEMO.bat                 demo local (usa el emulador)
— alternativa de infraestructura propia —
backend/server-node.mjs          servidor Node ≥ 18
backend/db-postgrest.mjs         acceso a datos para PostgreSQL + PostgREST / Supabase
backend/sql/esquema.sql          esquema para PostgreSQL
backend/db-archivo.mjs           acceso a datos en archivo JSON (solo pruebas)
backend/.env.ejemplo             variables documentadas
```

## 4. Despliegue en Cloudflare

Requisitos: cuenta de Cloudflare, Node LTS y `wrangler` reciente (se usa con `npx`).
Todo desde la carpeta `backend/`:

1. **Crear la base D1** y copiar el `database_id` que devuelve al campo
   `database_id` de `wrangler.jsonc`:
   ```
   npx wrangler d1 create propuesta-motion
   ```
2. **Crear el bucket R2:**
   ```
   npx wrangler r2 bucket create propuesta-motion-docs
   ```
3. **Crear las tablas:**
   ```
   npx wrangler d1 execute propuesta-motion --remote --file=sql/esquema-d1.sql
   ```
4. **Registrar el secreto de sesiones** (cadena aleatoria de 32+ caracteres):
   ```
   npx wrangler secret put SECRETO_SESION
   ```
5. **Probar local antes de publicar** (D1/R2 locales de wrangler, no toca producción):
   ```
   npx wrangler d1 execute propuesta-motion --local --file=sql/esquema-d1.sql
   npx wrangler dev
   node pruebas/prueba-api.mjs http://localhost:8787
   ```
   Deben pasar las 28 pruebas. La batería crea un administrador de prueba: **nunca**
   correrla contra producción.
6. **Publicar:**
   ```
   npx wrangler deploy
   ```
   Queda en `https://propuesta-motion.<subdominio>.workers.dev`; si prefieren dominio
   propio, se agrega como *Custom Domain* del Worker.

### Costos

Para el volumen del equipo (5–10 personas) todo cabe en los planes gratuitos: D1 hasta
5 GB, R2 hasta 10 GB y 100,000 peticiones diarias en Workers. **Recomiendo Workers Paid
(USD $5/mes):** el plan gratuito limita cada petición a 10 ms de CPU y el inicio de
sesión con 100,000 iteraciones PBKDF2 puede excederlo. Si se quedan en el gratuito,
bajar `PBKDF2_ITER` en `wrangler.jsonc`; las cuentas existentes no se afectan.

## 5. Primer arranque

1. Abrir la URL publicada: sin usuarios, la app pide **crear el administrador**.
2. El administrador da de alta al equipo desde el botón **Usuarios** (barra "En línea"):
   nombre, correo, contraseña temporal y rol (editor o administrador).
3. Usuarios iniciales sugeridos: Víctor Molina, María Trinidad Vergara, Karina Irais
   Castro, y quien ustedes designen para administración.

## 6. Seguridad

- D1 y R2 solo son accesibles desde el Worker (bindings); no hay llaves expuestas ni
  endpoints de datos públicos.
- Contraseñas con PBKDF2-SHA256 y sal por usuario; cada hash guarda sus iteraciones
  (`pbkdf2$<iteraciones>$<hex>`).
- Sesiones firmadas con HMAC-SHA256 (`SECRETO_SESION`), vigencia 12 horas. Rotar el
  secreto cierra todas las sesiones.
- Roles: **editor** trabaja documentos; **administrador** además gestiona accesos. Un
  administrador no puede desactivarse a sí mismo; los usuarios desactivados dejan de
  entrar de inmediato.

## 7. Verificación que hice de mi lado

- Las **28 pruebas** pasan contra el Worker corriendo con D1 emulado sobre SQLite real y
  R2 emulado (el emulador incluido corre `worker.mjs` sin modificarlo), y también
  contra el servidor Node. Incluyen **10 rondas de dos guardados simultáneos** con
  latencia de red simulada: siempre gana exactamente uno, el otro recibe el aviso de
  conflicto y el contenido vigente es íntegro. (La misma prueba contra una versión con
  llave de objeto fija falla 10 de 10: así se detectó y corrigió ese riesgo.)
- En navegador: acceso, guardar, conflicto entre dos usuarios, abrir la versión del
  otro, recargar con sesión activa, salir, y una propuesta real con foto (≈600 KB)
  guardada en R2 y recuperada íntegra.
- Revisé el almacenamiento tras las pruebas: solo las versiones vigentes e históricas
  de cada documento; ningún objeto de intentos perdidos.

Lo que no pude correr es `wrangler` contra Cloudflare real (no tengo acceso a la
cuenta); el paso 5 de la sección 4 es esa validación y es lo primero que conviene hacer.

## 8. Operación

- **Actualizar la herramienta**: reemplazar `app/index.html` por la versión que les
  envíe y `npx wrangler deploy`. Los documentos no se tocan.
- **Respaldos**: D1 tiene *Time Travel* — restaurar a cualquier minuto de los últimos
  30 días en Workers Paid (7 en el gratuito) con
  `npx wrangler d1 time-travel restore propuesta-motion --timestamp=<unix>`. Como R2
  conserva 30 días las versiones anteriores, el índice restaurado encuentra su
  contenido. Para retención más larga, un respaldo programado del bucket. Cada
  usuario puede además exportar cualquier documento a JSON desde la app.
- **Siguiente versión**: edición simultánea en vivo con **Durable Objects** (mismo
  proyecto de Cloudflare, sin cambiar tablas) y repositorio de firmas compartido.

## 9. Alternativa: infraestructura propia

Si en algún momento prefieren montarlo fuera de Cloudflare (VM, IONOS, contenedor):
PostgreSQL con `sql/esquema.sql` y PostgREST (o Supabase), `backend/.env` a partir de
`.env.ejemplo` con `DB_DRIVER=postgrest`, y `node backend/server-node.mjs` como servicio
detrás de HTTPS (sirve app y API en el mismo puerto; admitir cuerpos de 20 MB). La app,
la API y la batería de pruebas son las mismas.
