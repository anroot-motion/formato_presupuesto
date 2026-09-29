-- =============================================================================
-- Generador de Propuestas — esquema para Cloudflare D1 (SQLite)
-- Aplicar:  npx wrangler d1 execute propuesta-motion --remote --file=sql/esquema-d1.sql
-- El contenido completo de cada documento vive en R2 (binding DOCS); aquí solo
-- el índice, las versiones y los usuarios.
-- =============================================================================

CREATE TABLE IF NOT EXISTS usuarios (
  correo  TEXT PRIMARY KEY,
  nombre  TEXT NOT NULL,
  sal     TEXT NOT NULL,                 -- sal hex de 16 bytes
  hash    TEXT NOT NULL,                 -- "pbkdf2$<iteraciones>$<hex>" (PBKDF2-SHA256)
  rol     TEXT NOT NULL DEFAULT 'editor' CHECK (rol IN ('admin','editor')),
  activo  INTEGER NOT NULL DEFAULT 1,
  creado  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documentos (
  id          TEXT PRIMARY KEY,          -- UUID
  nombre      TEXT NOT NULL UNIQUE,
  autor       TEXT NOT NULL,             -- correo de quien guardó por última vez
  version     INTEGER NOT NULL DEFAULT 1,
  objeto      TEXT NOT NULL,             -- llave en R2 de la versión vigente
  bytes       INTEGER,                   -- tamaño del JSON
  creado      TEXT NOT NULL,
  actualizado TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS documentos_actualizado_idx ON documentos (actualizado DESC);
