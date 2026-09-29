-- =============================================================================
-- Generador de Propuestas — esquema de base de datos (PostgreSQL ≥ 13)
-- Funciona en Supabase o en cualquier PostgreSQL. Todo vive en el esquema
-- "propuesta" para convivir con otras herramientas en el mismo proyecto.
-- =============================================================================

create schema if not exists propuesta;

-- Usuarios de la herramienta (login propio: correo + contraseña con PBKDF2)
create table if not exists propuesta.usuarios (
  correo     text primary key,
  nombre     text not null,
  sal        text not null,          -- sal hex de 16 bytes
  hash       text not null,          -- "pbkdf2$<iteraciones>$<hex>" (PBKDF2-SHA256)
  rol        text not null default 'editor' check (rol in ('admin','editor')),
  activo     boolean not null default true,
  creado     timestamptz not null default now()
);

-- Documentos (propuestas). "estado" es el JSON completo que produce la app
-- (el mismo objeto que hoy se exporta como .json), incluidas imágenes en base64.
create table if not exists propuesta.documentos (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null unique,
  estado      jsonb not null default '{}'::jsonb,
  autor       text not null,         -- correo de quien guardó por última vez
  version     integer not null default 1,
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now()
);

create index if not exists documentos_actualizado_idx on propuesta.documentos (actualizado desc);

-- La versión sube sola en cada actualización (control de conflictos optimista)
create or replace function propuesta.tocar_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  new.actualizado := now();
  return new;
end $$;

drop trigger if exists documentos_version on propuesta.documentos;
create trigger documentos_version before update on propuesta.documentos
  for each row execute function propuesta.tocar_version();

-- Seguridad: nadie entra directo desde el navegador. RLS activo SIN políticas
-- públicas = las llaves anónimas no leen nada; solo el backend con la llave de
-- servicio (que se salta RLS) opera las tablas.
alter table propuesta.usuarios   enable row level security;
alter table propuesta.documentos enable row level security;
revoke all on schema propuesta from anon, authenticated;
revoke all on all tables in schema propuesta from anon, authenticated;
grant usage on schema propuesta to service_role;
grant all on all tables in schema propuesta to service_role;

-- Supabase: exponer el esquema a la API (Project Settings → API → Exposed schemas:
-- agregar "propuesta"). En PostgREST propio: db-schemas = "public, propuesta".
