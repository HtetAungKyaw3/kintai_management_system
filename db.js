"use strict";
// SQLite（Node.js 標準の node:sqlite）。外部パッケージは不要。
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (cols.length && !cols.some((c) => c.name === "email")) {
    throw new Error("このデータベースは社員番号でログインする旧バージョンのものです。メールアドレスでのログインには対応していません。" +
      "テストデータなら " + file + " を削除して起動し直してください。");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- ログインID（小文字で保存）
      emp_no      TEXT    UNIQUE,                            -- 社員番号（任意）
      name        TEXT    NOT NULL,
      pw_hash     TEXT    NOT NULL,
      must_change_pw INTEGER NOT NULL DEFAULT 0,             -- 1 = 次回ログイン時にパスワード変更を必須にする
      role        TEXT    NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
      start_time  TEXT    NOT NULL DEFAULT '09:00',“
      end_time    TEXT    NOT NULL DEFAULT '18:00',
      std_min     INTEGER NOT NULL DEFAULT 480,
      break_min   INTEGER NOT NULL DEFAULT 60,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS days (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date        TEXT    NOT NULL,              -- YYYY-MM-DD（日本時間の日付）
      type        TEXT    NOT NULL DEFAULT 'work' CHECK (type IN ('work','paid','comp','absent')),
      time_in     TEXT,                          -- HH:MM
      time_out    TEXT,                          -- HH:MM
      break_min   INTEGER,                       -- NULL = 打刻または所定休憩から自動計算
      breaks      TEXT    NOT NULL DEFAULT '[]', -- [{"s":"12:00","e":"13:00"}]
      note        TEXT    NOT NULL DEFAULT '',
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_days_date ON days(date);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT    PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  INTEGER NOT NULL               -- epoch ミリ秒
    );

    -- 勤怠記録の変更履歴（誰が・いつ・何を変えたか）
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,              -- 記録の持ち主
      actor_id    INTEGER NOT NULL,              -- 操作した人
      date        TEXT    NOT NULL,
      action      TEXT    NOT NULL,              -- punch / edit / delete
      before_json TEXT,
      after_json  TEXT,
      at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// ---- パスワード（scrypt） ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}
function verifyPassword(password, stored) {
  const parts = String(stored).split(":");
  if (parts.length !== 2) return false;
  const salt = Buffer.from(parts[0], "hex");
  const expected = Buffer.from(parts[1], "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// メールアドレスの検査と正規化（前後の空白を除き、小文字にする）
function normalizeEmail(v) {
  const e = String(v == null ? "" : v).trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

module.exports = { openDb, hashPassword, verifyPassword, normalizeEmail };
