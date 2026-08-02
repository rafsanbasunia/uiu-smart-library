-- UIU Smart Library Platform — schema
-- Applied by: npm run db:push

create schema if not exists public;

-- ---------------------------------------------------------------- enums
do $$ begin
  create type user_role        as enum ('student','faculty','staff');
  create type title_type       as enum ('print','ebook','journal','thesis');
  create type copy_type        as enum ('circulating','reference','reserve');
  create type copy_status      as enum ('available','on_loan','held','lost','repair');
  create type hold_status      as enum ('queued','ready','collected','expired','cancelled');
  create type fine_status      as enum ('unpaid','paid','waived');
  create type ledger_type      as enum ('charge','payment','waiver');
  create type pay_method       as enum ('bkash','nagad','card');
  create type list_visibility  as enum ('private','link','course');
  create type booking_status   as enum ('booked','checked_in','released','cancelled','completed');
  create type reco_mode        as enum ('balanced','close','surprise');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- identity
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  uiu_id        text unique not null,
  name          text not null,
  email         text unique not null,
  role          user_role not null default 'student',
  department    text,
  avatar_hue    int not null default 210,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists courses (
  id        uuid primary key default gen_random_uuid(),
  code      text unique not null,
  title     text not null,
  semester  text not null,
  dept      text
);

create table if not exists enrollments (
  user_id    uuid references users(id) on delete cascade,
  course_id  uuid references courses(id) on delete cascade,
  primary key (user_id, course_id)
);

-- ---------------------------------------------------------------- catalogue
create table if not exists titles (
  id           uuid primary key default gen_random_uuid(),
  type         title_type not null default 'print',
  title        text not null,
  subtitle     text,
  isbn         text,
  issn         text,
  publisher    text,
  year         int,
  language     text not null default 'English',
  edition      text,
  pages        int,
  summary      text,
  cover_hue    int not null default 210,
  added_at     timestamptz not null default now(),
  rating_avg   numeric(3,2) not null default 0,
  rating_count int not null default 0,
  borrow_count int not null default 0
);

create table if not exists authors (
  id    uuid primary key default gen_random_uuid(),
  name  text unique not null
);

create table if not exists title_authors (
  title_id  uuid references titles(id) on delete cascade,
  author_id uuid references authors(id) on delete cascade,
  ord       int not null default 0,
  primary key (title_id, author_id)
);

create table if not exists subjects (
  id    uuid primary key default gen_random_uuid(),
  name  text unique not null
);

create table if not exists title_subjects (
  title_id   uuid references titles(id) on delete cascade,
  subject_id uuid references subjects(id) on delete cascade,
  primary key (title_id, subject_id)
);

create table if not exists copies (
  id                uuid primary key default gen_random_uuid(),
  title_id          uuid not null references titles(id) on delete cascade,
  accession_number  text unique not null,
  location_zone     text not null,
  shelf_bay         text not null,
  copy_type         copy_type not null default 'circulating',
  status            copy_status not null default 'available',
  due_back          date
);

create table if not exists digital_assets (
  id          uuid primary key default gen_random_uuid(),
  title_id    uuid not null references titles(id) on delete cascade,
  format      text not null default 'pdf',
  url         text,
  access_rule text not null default 'campus'
);
