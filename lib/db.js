import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { bardDirs } from './store.js'

let db = null
let dbPath = ''
let exitHookInstalled = false

export function getDb() {
  const dirs = bardDirs()
  const file = path.join(dirs.root, 'memory.sqlite')
  if (db && dbPath !== file) {
    try { db.close() } catch (e) { /* 已关或未开 */ }
    db = null
  }
  if (db) return db
  if (!fs.existsSync(dirs.root)) fs.mkdirSync(dirs.root, { recursive: true })
  db = new DatabaseSync(file)
  dbPath = file
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', () => { try { if (db) db.close() } catch (e) { /* exit 时忽略 */ } })
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `)
  initSchema(db)
  runInitialMigrationIfNeeded(db)
  // 先清孤儿边，再启用外键约束：旧库可能已有脏数据，先删再开更稳。
  db.exec(`DELETE FROM edges WHERE source_id NOT IN (SELECT id FROM nodes) OR target_id NOT IN (SELECT id FROM nodes)`)
  db.exec(`PRAGMA foreign_keys = ON;`)
  return db
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      importance REAL DEFAULT 5.0,
      emotion REAL DEFAULT 0.0,
      base_strength REAL DEFAULT 1.0,
      last_restated_at INTEGER,
      restate_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      state TEXT DEFAULT 'active',
      meta TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(source_id) REFERENCES nodes(id),
      FOREIGN KEY(target_id) REFERENCES nodes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      text,
      content='nodes',
      content_rowid='rowid',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO nodes_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `)
  // 旧库迁移：以下列是后加的（CREATE TABLE IF NOT EXISTS 不会给已存在的表补列）
  const cols = db.prepare('PRAGMA table_info(nodes)').all()
  const has = (name) => cols.some((c) => c.name === name)
  if (!has('state')) db.exec("ALTER TABLE nodes ADD COLUMN state TEXT DEFAULT 'active'")
  if (!has('archived_at')) db.exec('ALTER TABLE nodes ADD COLUMN archived_at INTEGER DEFAULT NULL')
  if (!has('archived_reason')) db.exec('ALTER TABLE nodes ADD COLUMN archived_reason TEXT DEFAULT NULL')
  if (!has('last_accessed_at')) db.exec('ALTER TABLE nodes ADD COLUMN last_accessed_at INTEGER DEFAULT NULL')
  if (!has('corrupted_at')) db.exec('ALTER TABLE nodes ADD COLUMN corrupted_at INTEGER DEFAULT NULL')

  // 旧库可能已有重复边，先去重，否则下面的 CREATE UNIQUE INDEX 会失败。
  db.exec(`DELETE FROM edges WHERE id NOT IN (SELECT MIN(id) FROM edges GROUP BY source_id, target_id, relation_type)`)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nodes_persona ON nodes(persona_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_nodes_accessed ON nodes(persona_id, last_accessed_at);
    CREATE INDEX IF NOT EXISTS idx_edges_persona_source ON edges(persona_id, source_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique ON edges(source_id, target_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_edges_persona_target ON edges(persona_id, target_id);
    CREATE TABLE IF NOT EXISTS maintenance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL,
      action TEXT NOT NULL,
      node_id TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_maint_persona ON maintenance_log(persona_id, created_at);
    CREATE TABLE IF NOT EXISTS session_activity (
      session_id TEXT PRIMARY KEY,
      last_assemble_at INTEGER NOT NULL,
      wake_streak INTEGER NOT NULL DEFAULT 0
    );
  `)
}

/**
 * 首次启动时把旧 personas/*.json 里的 memories 迁进 SQLite。
 *
 * 幂等条件：nodes 表为空、personas/ 下存在非快照 .json。跑完写
 * maintenance_log(action='initial_migration')；之后 nodes 非空即跳过。
 */
function runInitialMigrationIfNeeded(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c
  if (count > 0) return

  const personasDir = path.join(bardDirs().root, 'personas')
  if (!fs.existsSync(personasDir)) return

  const files = fs.readdirSync(personasDir).filter(
    (f) => f.endsWith('.json') && !f.includes('.pre-migration')
  )
  if (files.length === 0) return

  let imported = 0
  const insertNode = db.prepare(`
    INSERT OR IGNORE INTO nodes
    (id, persona_id, type, text, importance, emotion, base_strength,
     last_restated_at, restate_count, created_at)
    VALUES (?, ?, 'episodic', ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(personasDir, file), 'utf8'))
      if (!raw || !raw.id || !Array.isArray(raw.memories)) continue
      for (const m of raw.memories) {
        if (!m || typeof m.id !== 'string' || typeof m.text !== 'string') continue
        insertNode.run(
          m.id, raw.id, m.text,
          Number.isFinite(m.importance) ? m.importance : 5,
          Number.isFinite(m.emotion) ? m.emotion : 0,
          Number.isFinite(m.clarity) ? m.clarity : 1.0,
          Date.parse(m.lastRestatedAt || m.createdAt) || Date.now(),
          Number.isFinite(m.restateCount) ? m.restateCount : 0,
          Date.parse(m.createdAt) || Date.now(),
        )
        imported += 1
      }
    } catch (e) { /* 单个文件坏了不阻断 */ }
  }

  db.prepare(`INSERT INTO maintenance_log (persona_id, action, payload, created_at)
    VALUES ('__system__', 'initial_migration', ?, ?)`)
    .run(JSON.stringify({ files: files.length, imported }), Date.now())
}

export function getLastAssembleAt(sessionId) {
  const db = getDb()
  const row = db.prepare('SELECT last_assemble_at FROM session_activity WHERE session_id = ?').get(sessionId)
  return row ? row.last_assemble_at : null
}

export function setLastAssembleAt(sessionId, ts) {
  const db = getDb()
  db.prepare(`
    INSERT INTO session_activity (session_id, last_assemble_at) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET last_assemble_at = excluded.last_assemble_at
  `).run(sessionId, ts)
}

export function getWakeStreak(sessionId) {
  const db = getDb()
  const row = db.prepare('SELECT wake_streak FROM session_activity WHERE session_id = ?').get(sessionId)
  return row ? row.wake_streak : 0
}

export function setWakeStreak(sessionId, n) {
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO session_activity (session_id, last_assemble_at) VALUES (?, 0)').run(sessionId)
  db.prepare('UPDATE session_activity SET wake_streak = ? WHERE session_id = ?').run(n, sessionId)
}

export function closeDb() {
  if (!db) return
  try { db.close() } catch (e) { /* 已关 */ }
  db = null
  dbPath = ''
}