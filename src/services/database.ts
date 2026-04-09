import { DatabaseSync, StatementSync } from "node:sqlite";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH ?? "./data/sales.db";

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    const dir = path.dirname(path.resolve(DB_PATH));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _db = new DatabaseSync(path.resolve(DB_PATH));
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
  }
  return _db;
}

// Helper: prepared statement type with .all() support
export type Stmt = StatementSync;

export function initSchema(): void {
  const db = getDb();
  db.exec(`
    -- ================ USERS ================
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name     TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'sales',
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- ================ QUOTATIONS ================
    CREATE TABLE IF NOT EXISTS quotations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      fa_document_id  TEXT UNIQUE,
      document_number TEXT NOT NULL,
      contact_name    TEXT NOT NULL,
      contact_tax_id  TEXT,
      product_codes   TEXT,
      total_amount    REAL DEFAULT 0,
      issue_date      TEXT NOT NULL,
      expiry_date     TEXT,
      fa_status       TEXT DEFAULT 'draft',
      sales_user_id   INTEGER REFERENCES users(id),
      pipeline_stage  TEXT NOT NULL DEFAULT 'new',
      pipeline_updated_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- ================ FOLLOW-UPS ================
    CREATE TABLE IF NOT EXISTS follow_ups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id INTEGER NOT NULL REFERENCES quotations(id),
      user_id      INTEGER NOT NULL REFERENCES users(id),
      note         TEXT,
      followed_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- ================ CONFLICT RESOLUTION ================
    CREATE TABLE IF NOT EXISTS conflict_resolutions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      winner_quot_id INTEGER NOT NULL REFERENCES quotations(id),
      loser_quot_id  INTEGER NOT NULL REFERENCES quotations(id),
      resolved_by    INTEGER NOT NULL REFERENCES users(id),
      reason         TEXT,
      resolved_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- ================ SALES LINE IDS ================
    CREATE TABLE IF NOT EXISTS sales_line_ids (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sales_name      TEXT NOT NULL UNIQUE,
      line_user_id    TEXT NOT NULL,
      display_name    TEXT,
      registered_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- ================ EXPIRY NOTIFICATIONS SENT ================
    CREATE TABLE IF NOT EXISTS expiry_notifications_sent (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id    INTEGER NOT NULL REFERENCES quotations(id),
      notification_type TEXT NOT NULL,  -- '7day' or '1day'
      sent_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(quotation_id, notification_type)
    );

    -- ================ SYNC LOG ================
    CREATE TABLE IF NOT EXISTS sync_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      status    TEXT NOT NULL,
      records   INTEGER DEFAULT 0,
      message   TEXT
    );
  `);

  // ── Migrate: add pipeline columns if missing ──
  const cols = db.prepare("PRAGMA table_info(quotations)").all() as { name: string }[];
  const colNames = cols.map(c => c.name);
  if (!colNames.includes("pipeline_stage")) {
    db.exec("ALTER TABLE quotations ADD COLUMN pipeline_stage TEXT NOT NULL DEFAULT 'new'");
  }
  if (!colNames.includes("pipeline_updated_at")) {
    db.exec("ALTER TABLE quotations ADD COLUMN pipeline_updated_at TEXT");
  }

  // Views must be recreated (DROP + CREATE)
  db.exec(`DROP VIEW IF EXISTS v_quotation_status`);
  db.exec(`
    CREATE VIEW v_quotation_status AS
    SELECT
      q.id,
      q.fa_document_id,
      q.document_number,
      q.contact_name,
      q.contact_tax_id,
      q.product_codes,
      q.total_amount,
      q.issue_date,
      -- ถ้า expiry_date = issue_date (FlowAccount ไม่ได้ตั้ง) → ใช้ issue_date + 90 วัน
      CASE
        WHEN q.expiry_date IS NULL OR q.expiry_date <= q.issue_date
          THEN date(q.issue_date, '+90 days')
        ELSE q.expiry_date
      END AS expiry_date,
      q.fa_status,
      q.sales_user_id,
      q.pipeline_stage,
      q.pipeline_updated_at,
      u.full_name   AS sales_name,
      fu.followed_at AS last_follow_up,
      fu.note        AS last_follow_note,
      CASE
        WHEN (CASE WHEN q.expiry_date IS NULL OR q.expiry_date <= q.issue_date
                THEN date(q.issue_date, '+90 days') ELSE q.expiry_date END) < date('now','localtime')
          THEN 'expired'
        WHEN (CASE WHEN q.expiry_date IS NULL OR q.expiry_date <= q.issue_date
                THEN date(q.issue_date, '+90 days') ELSE q.expiry_date END) <= date('now','localtime','+7 days')
          THEN 'warning'
        WHEN fu.followed_at IS NULL OR fu.followed_at < datetime('now','localtime','-90 days')
          THEN 'warning'
        ELSE 'safe'
      END AS health
    FROM quotations q
    LEFT JOIN users u ON u.id = q.sales_user_id
    LEFT JOIN (
      SELECT quotation_id, MAX(followed_at) AS followed_at, note
      FROM follow_ups
      GROUP BY quotation_id
    ) fu ON fu.quotation_id = q.id
  `);

  db.exec(`DROP VIEW IF EXISTS v_conflicts`);
  db.exec(`
    CREATE VIEW v_conflicts AS
    SELECT
      a.id              AS quot_a_id,
      a.document_number AS quot_a_number,
      a.sales_user_id   AS sales_a_id,
      ua.full_name      AS sales_a_name,
      a.issue_date      AS quot_a_date,
      b.id              AS quot_b_id,
      b.document_number AS quot_b_number,
      b.sales_user_id   AS sales_b_id,
      ub.full_name      AS sales_b_name,
      b.issue_date      AS quot_b_date,
      a.contact_name,
      a.contact_tax_id,
      a.product_codes
    FROM quotations a
    JOIN quotations b
      ON  a.contact_tax_id IS NOT NULL
      AND a.contact_tax_id = b.contact_tax_id
      AND a.product_codes  = b.product_codes
      AND a.sales_user_id != b.sales_user_id
      AND a.id < b.id
    LEFT JOIN users ua ON ua.id = a.sales_user_id
    LEFT JOIN users ub ON ub.id = b.sales_user_id
  `);
}
