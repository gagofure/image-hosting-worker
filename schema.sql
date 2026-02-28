-- ImageWorker D1 Schema
-- Run with: wrangler d1 execute image-hosting-db --file=schema.sql

CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    source_url TEXT UNIQUE,
    alt_text TEXT,
    created_at TEXT DEFAULT(datetime('now')),
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_images_created_at ON images (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_images_source_url ON images (source_url);