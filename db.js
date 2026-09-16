'use strict';

/**
 * SQLite database layer.
 *
 * The app talks to a real relational database: tables, foreign keys, CHECK
 * constraints, indexes and transactions. Two drivers are supported and picked
 * automatically at startup:
 *
 *   1. better-sqlite3  — installed by `npm install` (ships prebuilt binaries)
 *   2. node:sqlite     — Node's own built-in SQLite, used as a fallback if the
 *                        native module could not be built on this machine
 *
 * Both expose the same prepare()/run()/get()/all() shape, so the rest of the
 * app never needs to know which one is in use. Only positional `?` parameters
 * are used, because that is the syntax both drivers agree on.
 */

const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'data', 'avroom.db');

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const Database = require('better-sqlite3');
    return { driver: 'better-sqlite3', handle: new Database(file) };
  } catch (nativeErr) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      return { driver: 'node:sqlite', handle: new DatabaseSync(file) };
    } catch (builtinErr) {
      throw new Error(
        'No SQLite driver available.\n' +
        '  better-sqlite3 failed: ' + nativeErr.message + '\n' +
        '  node:sqlite failed:    ' + builtinErr.message + '\n' +
        'Run `npm install`, or use Node 22.13+ / 24+.'
      );
    }
  }
}

const opened = openDatabase(DB_FILE);
const handle = opened.handle;

handle.exec('PRAGMA journal_mode = WAL');
handle.exec('PRAGMA foreign_keys = ON');

// ---------------------------------------------------------------
// Schema
// ---------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('student', 'staff')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'General',
  description      TEXT NOT NULL DEFAULT '',
  deposit_amount   REAL NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  late_fee_per_day REAL NOT NULL DEFAULT 0 CHECK (late_fee_per_day >= 0),
  max_loan_days    INTEGER NOT NULL DEFAULT 7 CHECK (max_loan_days >= 1),
  retired          INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id           TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'available'
               CHECK (status IN ('available', 'borrowed', 'maintenance')),
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id                   TEXT PRIMARY KEY,
  equipment_id         TEXT NOT NULL REFERENCES equipment(id),
  unit_id              TEXT REFERENCES units(id),
  borrower_id          TEXT NOT NULL REFERENCES users(id),
  original_borrower_id TEXT NOT NULL REFERENCES users(id),
  note                 TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL
                       CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
  requested_at         TEXT NOT NULL,
  due_date             TEXT NOT NULL,
  approved_at          TEXT,
  approved_by          TEXT REFERENCES users(id),
  returned_at          TEXT,
  returned_by          TEXT REFERENCES users(id),
  deposit_amount       REAL NOT NULL DEFAULT 0,
  late_fee_per_day     REAL NOT NULL DEFAULT 0,
  late_fee_charged     REAL NOT NULL DEFAULT 0,
  deposit_refunded     REAL,
  transfer_count       INTEGER NOT NULL DEFAULT 0,
  last_nudged_at       TEXT
);

CREATE TABLE IF NOT EXISTS loan_transfers (
  id                   TEXT PRIMARY KEY,
  loan_id              TEXT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  from_user_id         TEXT NOT NULL REFERENCES users(id),
  to_user_id           TEXT NOT NULL REFERENCES users(id),
  due_date_at_transfer TEXT NOT NULL,
  status               TEXT NOT NULL
                       CHECK (status IN ('pending', 'completed', 'rejected', 'cancelled')),
  initiated_by         TEXT NOT NULL REFERENCES users(id),
  initiated_role       TEXT NOT NULL CHECK (initiated_role IN ('student', 'staff')),
  note                 TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  decided_at           TEXT,
  decided_by           TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_units_equipment ON units(equipment_id, status);
CREATE INDEX IF NOT EXISTS idx_loans_borrower  ON loans(borrower_id, status);
CREATE INDEX IF NOT EXISTS idx_loans_status    ON loans(status, due_date);
CREATE INDEX IF NOT EXISTS idx_loans_equipment ON loans(equipment_id, status);
CREATE INDEX IF NOT EXISTS idx_transfers_loan  ON loan_transfers(loan_id, status);
CREATE INDEX IF NOT EXISTS idx_transfers_to    ON loan_transfers(to_user_id, status);
`;

handle.exec(SCHEMA);

// A borrowed unit can only be on one live loan at a time — enforced by the
// database itself rather than by hopeful application code.
handle.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_one_live_loan_per_unit " +
  "ON loans(unit_id) WHERE status = 'approved' AND unit_id IS NOT NULL"
);

// ---------------------------------------------------------------
// Thin query helpers
// ---------------------------------------------------------------
const stmtCache = new Map();
function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = handle.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// Neither driver accepts `undefined` as a bound value, so it becomes NULL.
function clean(params) {
  return (params || []).map(function (p) { return p === undefined ? null : p; });
}

function run(sql, params) {
  return prepare(sql).run.apply(prepare(sql), clean(params));
}
function get(sql, params) {
  const row = prepare(sql).get.apply(prepare(sql), clean(params));
  return row === undefined ? null : row;
}
function all(sql, params) {
  return prepare(sql).all.apply(prepare(sql), clean(params));
}
function exec(sql) {
  return handle.exec(sql);
}

/**
 * Runs `fn` inside a real SQL transaction: every write in an approval, a
 * return or a transfer either all lands or none of it does.
 */
function transaction(fn) {
  handle.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

// ---------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------
function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function nowISO() {
  return new Date().toISOString();
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
function daysBetween(aISO, bISO) {
  const a = new Date(aISO + 'T00:00:00Z');
  const b = new Date(bISO + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

module.exports = {
  driver: opened.driver,
  file: DB_FILE,
  run, get, all, exec, transaction,
  uid, nowISO, todayISO, addDaysISO, daysBetween
};
