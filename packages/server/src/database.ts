import {Pool} from 'pg';

export const database = process.env.DATABASE_URL ? new Pool({connectionString: process.env.DATABASE_URL, max: 10}) : null;

export async function initializeDatabase(): Promise<void> {
  if (!database) return;
  await database.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username VARCHAR(39) NOT NULL UNIQUE,
      email VARCHAR(254) NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name VARCHAR(80) NOT NULL,
      bio VARCHAR(280) NOT NULL DEFAULT '', language VARCHAR(8) NOT NULL DEFAULT 'es',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS repositories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL, description VARCHAR(350) NOT NULL DEFAULT '', is_public BOOLEAN NOT NULL DEFAULT true,
      disk_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(), stars_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(owner_id, name)
    );
    CREATE TABLE IF NOT EXISTS repository_stars (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id, repository_id)
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, title VARCHAR(180) NOT NULL,
      body TEXT NOT NULL DEFAULT '', source_branch VARCHAR(150) NOT NULL, target_branch VARCHAR(150) NOT NULL DEFAULT 'main',
      status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK(status IN ('open','merged','closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pull_request_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), pull_request_id UUID NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
      reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL,
      state VARCHAR(16) NOT NULL CHECK(state IN ('commented','approved','changes_requested')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS activity_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repository_id UUID REFERENCES repositories(id) ON DELETE CASCADE, kind VARCHAR(32) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS activity_feed_idx ON activity_events(created_at DESC);
  `);
}

