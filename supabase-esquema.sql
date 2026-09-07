-- ============================================================
-- Visitas — esquema de base de datos para Supabase
-- Pegar entero en: Supabase → SQL Editor → New query → Run
-- ============================================================

-- ---------- Clientes ----------
create table if not exists public.clientes (
  id              text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  nombre          text not null,
  empresa         text not null default '',
  actualizado_en  timestamptz not null default now()
);

-- ---------- Visitas ----------
create table if not exists public.visitas (
  id                 text primary key,
  user_id            uuid not null references auth.users(id) on delete cascade,
  cliente_id         text not null,
  fecha              timestamptz not null,
  duracion           integer not null default 0,
  estado             text not null default 'listo',
  transcripcion      text not null default '',
  resumen            text not null default '',
  puntos_clave       jsonb not null default '[]'::jsonb,
  proximos_pasos     jsonb not null default '[]'::jsonb,
  fecha_seguimiento  date,
  actualizado_en     timestamptz not null default now()
);

-- Marca de que el seguimiento ya se atendió (pantalla Pendientes).
-- Se añade aparte para poder aplicarlo sobre una base de datos ya creada.
alter table public.visitas
  add column if not exists seguimiento_hecho boolean not null default false;

-- Índices para que las consultas por usuario y fecha vayan rápidas
create index if not exists idx_clientes_user on public.clientes (user_id);
create index if not exists idx_visitas_user_fecha on public.visitas (user_id, fecha desc);

-- ============================================================
-- Seguridad: cada usuario solo puede ver y tocar SUS datos.
-- Sin esto, cualquiera con la clave pública leería todo.
-- ============================================================
alter table public.clientes enable row level security;
alter table public.visitas  enable row level security;

drop policy if exists "clientes propios" on public.clientes;
create policy "clientes propios" on public.clientes
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "visitas propias" on public.visitas;
create policy "visitas propias" on public.visitas
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);
