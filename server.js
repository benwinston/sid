#!/usr/bin/env node
/**
 * Sid - local-first iMessage search UI
 *
 * Usage:
 *   npm install
 *   npm start
 *   open http://localhost:3847
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 unavailable:', e.message);
  console.error('Run `npm install better-sqlite3`. If the native build fails, install Xcode CLT: `xcode-select --install`.');
  process.exit(1);
}

// --- Apple epoch helpers (mirroring ../search.js) ---
const APPLE_EPOCH = 978307200; // unix timestamp of 2001-01-01
const APPLE_EPOCH_NS = BigInt(APPLE_EPOCH) * 1_000_000_000n;
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Returns BigInt Apple-epoch nanoseconds for boundary comparisons.
function toAppleNsBig(dateStr, endOfDay = false) {
  const suffix = endOfDay ? 'T23:59:59-07:00' : 'T00:00:00-07:00';
  const unixMs = new Date(dateStr + suffix).getTime();
  // unixMs fits in Number; convert to BigInt ns.
  return BigInt(unixMs) * 1_000_000n - APPLE_EPOCH_NS;
}

function fromAppleNs(ts) {
  // ts may be BigInt or string. ms-precision is fine for display.
  const nsBig = typeof ts === 'bigint' ? ts : BigInt(ts);
  const unixMs = Number((nsBig + APPLE_EPOCH_NS) / 1_000_000n);
  return new Date(unixMs).toISOString();
}

function fromAppleNsLocal(ts) {
  const nsBig = typeof ts === 'bigint' ? ts : BigInt(ts);
  const unixMs = Number((nsBig + APPLE_EPOCH_NS) / 1_000_000n);
  return new Date(unixMs).toLocaleString('en-US', { timeZone: TZ, hour12: false }).replace(',', '');
}

// --- Paths ---
const CHAT_DB = `${process.env.HOME}/Library/Messages/chat.db`;
// The packaged app stores its writable cache in Application Support.
const CACHE_DIR = process.env.SID_DATA_DIR
  ? path.resolve(process.env.SID_DATA_DIR)
  : path.resolve(__dirname);
fs.mkdirSync(CACHE_DIR, { recursive: true });
const CACHE_DB = path.join(CACHE_DIR, 'cache.db');

// --- Cache db setup ---
function openCacheDb() {
  const db = new Database(CACHE_DB);
  // better-sqlite3 returns BigInt for integer columns when safeIntegers is on.
  // Apple-epoch ns (~7.7e17 for 2025) exceeds Number.MAX_SAFE_INTEGER (~9e15),
  // so we must use BigInt for date_ns to avoid precision loss.
  db.defaultSafeIntegers(true);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Phase 1: sync_meta always exists. Create messages table if absent with
  // the latest schema (including chat_guid). We create indexes + FTS + triggers
  // only AFTER the schema-migration check, because an older cache.db may have
  // a `messages` table without `chat_guid`, which would make
  // `CREATE INDEX ... ON messages(chat_guid, ...)` fail before we get a chance
  // to migrate.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      rowid INTEGER PRIMARY KEY,
      text TEXT,
      date_ns INTEGER NOT NULL,
      is_from_me INTEGER NOT NULL,
      sender_handle TEXT,
      chat_name TEXT,
      chat_guid TEXT
    );
  `);

  // Phase 2: migrate older caches that predate `chat_guid`. CREATE TABLE IF
  // NOT EXISTS above is a no-op on pre-existing tables, so we still have to
  // probe and rebuild.
  const cols = db.prepare(`PRAGMA table_info(messages)`).all();
  const hasChatGuid = cols.some(c => c.name === 'chat_guid');
  if (!hasChatGuid) {
    console.log('Resetting cache for schema upgrade (chat_guid added)...');
    db.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS messages;

      CREATE TABLE messages (
        rowid INTEGER PRIMARY KEY,
        text TEXT,
        date_ns INTEGER NOT NULL,
        is_from_me INTEGER NOT NULL,
        sender_handle TEXT,
        chat_name TEXT,
        chat_guid TEXT
      );
    `);
    db.prepare(`DELETE FROM sync_meta WHERE key = 'last_synced_date_ns'`).run();
    db.prepare(`DELETE FROM sync_meta WHERE key = 'last_synced_at'`).run();
    console.log('Cache reset complete. Click "Pull latest" to rebuild.');
  }

  // Phase 3: now that the `messages` table definitely has `chat_guid`,
  // create/ensure all indexes, FTS virtual table, and triggers.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_date_ns ON messages(date_ns);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_handle);
    CREATE INDEX IF NOT EXISTS idx_messages_from_me ON messages(is_from_me);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_guid_date ON messages(chat_guid, date_ns DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);

  return db;
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// --- chat.db reader (read-only, immutable) ---
function openChatDb() {
  if (!fs.existsSync(CHAT_DB)) {
    throw new Error(`chat.db not found at ${CHAT_DB}. Grant Full Disk Access to Sid in System Settings.`);
  }
  try {
    const db = new Database(CHAT_DB, { readonly: true, fileMustExist: true });
    db.defaultSafeIntegers(true); // message.date values exceed JS safe-int range
    return db;
  } catch (err) {
    throw new Error(`Could not open chat.db: ${err.message}. If Messages is open, this usually still works (WAL mode). If you see a permission error, grant Full Disk Access to your terminal in System Settings > Privacy & Security.`);
  }
}

// Newer Messages versions frequently leave message.text NULL and serialize
// the visible text inside an NSAttributedString typedstream instead.
function decodeAttributedBody(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const marker = Buffer.from('NSString');
  const markerAt = buf.indexOf(marker);
  if (markerAt < 0) return null;

  // In Apple's typedstream, the first NSString payload follows this fixed
  // object header. Its byte length is either one byte, or 0x81/0x82 followed
  // by a little-endian 16/32-bit length.
  let p = markerAt + marker.length;
  const header = Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]);
  if (!buf.subarray(p, p + header.length).equals(header)) return null;
  p += header.length;

  let length;
  const sizeTag = buf[p++];
  if (sizeTag < 0x80) {
    length = sizeTag;
  } else if (sizeTag === 0x81 && p + 2 <= buf.length) {
    length = buf.readUInt16LE(p);
    p += 2;
  } else if (sizeTag === 0x82 && p + 4 <= buf.length) {
    length = buf.readUInt32LE(p);
    p += 4;
  } else {
    return null;
  }

  if (!length || p + length > buf.length) return null;
  const text = buf.subarray(p, p + length).toString('utf8').replace(/\uFFFC/g, '').trim();
  return text || null;
}

function fetchChatIdentity(chatGuid) {
  const fallbackIdentifier = String(chatGuid || '').split(';').pop() || '';
  let chat;
  try {
    chat = openChatDb();
    const row = chat.prepare(`
      SELECT
        c.chat_identifier,
        COALESCE(c.display_name, '') AS chat_name,
        GROUP_CONCAT(DISTINCT h.id) AS participant_handles
      FROM chat c
      LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      LEFT JOIN handle h ON h.ROWID = chj.handle_id
      WHERE c.guid = ?
      GROUP BY c.ROWID
    `).get(chatGuid);

    const participants = row && row.participant_handles
      ? row.participant_handles.split(',').filter(Boolean)
      : [];
    if (row && row.chat_identifier && !participants.includes(row.chat_identifier)) {
      participants.unshift(row.chat_identifier);
    }

    return {
      chat_name: row ? row.chat_name : '',
      chat_identifier: row && row.chat_identifier ? row.chat_identifier : fallbackIdentifier,
      participants,
    };
  } catch (err) {
    return {
      chat_name: '',
      chat_identifier: fallbackIdentifier,
      participants: fallbackIdentifier ? [fallbackIdentifier] : [],
    };
  } finally {
    if (chat) chat.close();
  }
}

// --- Sync ---
function syncFromChatDb(cache, { batchSize = 1000 } = {}) {
  const lastSyncedRaw = getMeta(cache, 'last_synced_date_ns');
  // Store Apple ns as BigInt to avoid precision loss.
  let lastSyncedNs;
  try {
    lastSyncedNs = lastSyncedRaw ? BigInt(lastSyncedRaw) : 0n;
  } catch (e) {
    lastSyncedNs = 0n;
  }
  const chat = openChatDb();

  const stmt = chat.prepare(`
    SELECT
      m.ROWID AS rowid,
      m.text AS text,
      m.attributedBody AS attributed_body,
      m.date AS date_ns,
      m.is_from_me AS is_from_me,
      h.id AS sender_handle,
      COALESCE(c.display_name, '') AS chat_name,
      c.guid AS chat_guid
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE (length(trim(m.text)) > 0 OR m.attributedBody IS NOT NULL)
      AND m.item_type = 0
      AND m.date > ?
    ORDER BY m.date ASC
  `);

  const insert = cache.prepare(`
    INSERT OR IGNORE INTO messages (rowid, text, date_ns, is_from_me, sender_handle, chat_name, chat_guid)
    VALUES (@rowid, @text, @date_ns, @is_from_me, @sender_handle, @chat_name, @chat_guid)
  `);

  const insertMany = cache.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });

  let newCount = 0;
  let maxDateNs = lastSyncedNs;
  let batch = [];

  // stmt.iterate accepts BigInt; bound to a SQLite INTEGER column this keeps full precision.
  const iter = stmt.iterate(lastSyncedNs);
  for (const row of iter) {
    const visibleText = row.text || decodeAttributedBody(row.attributed_body);
    if (!visibleText) continue;
    // With defaultSafeIntegers(true), row.rowid, row.date_ns, row.is_from_me are BigInt.
    const dateNs = row.date_ns; // BigInt
    const r = {
      rowid: row.rowid, // BigInt is OK for INTEGER PK binding
      text: visibleText,
      date_ns: dateNs,  // BigInt stored into INTEGER column
      is_from_me: row.is_from_me ? 1 : 0,
      sender_handle: row.sender_handle || null,
      chat_name: row.chat_name || '',
      chat_guid: row.chat_guid || null,
    };
    batch.push(r);
    if (dateNs > maxDateNs) maxDateNs = dateNs;
    if (batch.length >= batchSize) {
      insertMany(batch);
      newCount += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    insertMany(batch);
    newCount += batch.length;
  }

  chat.close();

  if (maxDateNs > lastSyncedNs) {
    setMeta(cache, 'last_synced_date_ns', maxDateNs.toString());
  }
  setMeta(cache, 'last_synced_at', new Date().toISOString());

  return {
    newCount,
    lastSynced: getMeta(cache, 'last_synced_at'),
    lastSyncedDateNs: getMeta(cache, 'last_synced_date_ns'),
  };
}

// --- Search ---
function searchCache(cache, opts) {
  const conds = [];
  const params = {};
  let usedFts = false;

  // Use FTS for text search if available and query looks safe
  if (opts.text && opts.text.trim()) {
    // Escape double quotes for FTS phrase queries. Using phrase query for substring-ish behavior.
    // FTS5 doesn't do true substring, so we tokenize and look for a phrase match.
    const cleaned = opts.text.trim().replace(/"/g, '""');
    // Fall back to LIKE if text contains only non-word chars (FTS would choke)
    if (/\w/.test(cleaned)) {
      conds.push(`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH @ftsq)`);
      params.ftsq = `"${cleaned}"`;
      usedFts = true;
    } else {
      conds.push(`m.text LIKE @textLike`);
      params.textLike = `%${opts.text}%`;
    }
  }
  if (opts.from && opts.from.trim()) {
    conds.push(`m.sender_handle LIKE @fromLike`);
    params.fromLike = `%${opts.from.trim()}%`;
    conds.push(`m.is_from_me = 0`);
  }
  if (opts.sent && !opts.received) conds.push(`m.is_from_me = 1`);
  if (opts.received && !opts.sent) conds.push(`m.is_from_me = 0`);
  if (opts.after) {
    conds.push(`m.date_ns >= @afterNs`);
    params.afterNs = toAppleNsBig(opts.after);
  }
  if (opts.before) {
    conds.push(`m.date_ns <= @beforeNs`);
    params.beforeNs = toAppleNsBig(opts.before, true);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(1000, parseInt(opts.limit, 10) || 100));

  const sql = `
    SELECT rowid, text, date_ns, is_from_me, sender_handle, chat_name, chat_guid
    FROM messages m
    ${where}
    ORDER BY date_ns DESC
    LIMIT ${limit}
  `;

  let rows;
  try {
    rows = cache.prepare(sql).all(params);
  } catch (err) {
    // If FTS failed (e.g. bad query), retry with LIKE
    if (usedFts) {
      const fallbackConds = conds.map(c =>
        c.startsWith('m.rowid IN (SELECT rowid FROM messages_fts')
          ? `m.text LIKE @textLike`
          : c
      );
      delete params.ftsq;
      params.textLike = `%${opts.text}%`;
      const fallbackSql = `
        SELECT rowid, text, date_ns, is_from_me, sender_handle, chat_name, chat_guid
        FROM messages m
        WHERE ${fallbackConds.join(' AND ')}
        ORDER BY date_ns DESC
        LIMIT ${limit}
      `;
      rows = cache.prepare(fallbackSql).all(params);
    } else {
      throw err;
    }
  }

  return rows.map(r => ({
    rowid: typeof r.rowid === 'bigint' ? Number(r.rowid) : r.rowid,
    text: r.text,
    // date_ns as string to preserve BigInt precision across JSON boundary.
    date_ns: typeof r.date_ns === 'bigint' ? r.date_ns.toString() : String(r.date_ns),
    is_from_me: typeof r.is_from_me === 'bigint' ? Number(r.is_from_me) : r.is_from_me,
    sender_handle: r.sender_handle,
    chat_name: r.chat_name,
    chat_guid: r.chat_guid,
    date_iso: fromAppleNs(r.date_ns),
    date_local: fromAppleNsLocal(r.date_ns),
  }));
}

// --- Thread (surrounding conversation) ---
function fetchThread(cache, { chatGuid, anchorRowid, anchorDateNs, before, after }) {
  if (!chatGuid) throw new Error('chat_guid is required');
  const beforeN = Math.max(0, Math.min(500, parseInt(before, 10) || 40));
  const afterN = Math.max(0, Math.min(500, parseInt(after, 10) || 40));

  // Resolve the anchor's date_ns. anchor_rowid is preferred.
  let anchorNs = null;
  let anchorRowidResolved = null;
  if (anchorRowid != null && anchorRowid !== '') {
    const row = cache
      .prepare(`SELECT rowid, date_ns FROM messages WHERE rowid = ? AND chat_guid = ?`)
      .get(BigInt(anchorRowid), chatGuid);
    if (row) {
      anchorNs = row.date_ns; // BigInt
      anchorRowidResolved = typeof row.rowid === 'bigint' ? Number(row.rowid) : row.rowid;
    }
  }
  if (anchorNs == null && anchorDateNs != null && anchorDateNs !== '') {
    try {
      anchorNs = BigInt(anchorDateNs);
    } catch (e) {
      throw new Error('Invalid anchor_date_ns');
    }
  }
  if (anchorNs == null) {
    throw new Error('anchor_rowid or anchor_date_ns is required');
  }

  const chatIdentity = fetchChatIdentity(chatGuid);

  // Pull the chat_name from cached messages if Messages has no display name.
  const chatNameRow = cache
    .prepare(`SELECT chat_name FROM messages WHERE chat_guid = ? AND chat_name <> '' LIMIT 1`)
    .get(chatGuid);
  const chatName = chatIdentity.chat_name || (chatNameRow ? chatNameRow.chat_name : '');

  // Before anchor (strictly earlier), newest first so we LIMIT properly.
  const beforeRows = cache
    .prepare(`
      SELECT rowid, text, date_ns, is_from_me, sender_handle, chat_name, chat_guid
      FROM messages
      WHERE chat_guid = ? AND date_ns < ?
      ORDER BY date_ns DESC, rowid DESC
      LIMIT ?
    `)
    .all(chatGuid, anchorNs, beforeN);

  // From anchor (inclusive) forward.
  const afterRows = cache
    .prepare(`
      SELECT rowid, text, date_ns, is_from_me, sender_handle, chat_name, chat_guid
      FROM messages
      WHERE chat_guid = ? AND date_ns >= ?
      ORDER BY date_ns ASC, rowid ASC
      LIMIT ?
    `)
    .all(chatGuid, anchorNs, afterN + 1); // +1 so we can always include the anchor itself

  // Merge chronological (oldest -> newest).
  const merged = [...beforeRows.slice().reverse(), ...afterRows];

  // has_more_before: any row earlier than the earliest returned
  let hasMoreBefore = false;
  if (merged.length) {
    const earliest = merged[0].date_ns;
    const row = cache
      .prepare(`SELECT 1 AS x FROM messages WHERE chat_guid = ? AND date_ns < ? LIMIT 1`)
      .get(chatGuid, earliest);
    hasMoreBefore = !!row;
  }
  // has_more_after: any row later than the latest returned
  let hasMoreAfter = false;
  if (merged.length) {
    const latest = merged[merged.length - 1].date_ns;
    const row = cache
      .prepare(`SELECT 1 AS x FROM messages WHERE chat_guid = ? AND date_ns > ? LIMIT 1`)
      .get(chatGuid, latest);
    hasMoreAfter = !!row;
  }

  const mapped = merged.map(r => ({
    rowid: typeof r.rowid === 'bigint' ? Number(r.rowid) : r.rowid,
    text: r.text,
    date_ns: typeof r.date_ns === 'bigint' ? r.date_ns.toString() : String(r.date_ns),
    is_from_me: typeof r.is_from_me === 'bigint' ? Number(r.is_from_me) : r.is_from_me,
    sender_handle: r.sender_handle,
    chat_name: r.chat_name,
    chat_guid: r.chat_guid,
    date_iso: fromAppleNs(r.date_ns),
    date_local: fromAppleNsLocal(r.date_ns),
  }));

  return {
    chat_guid: chatGuid,
    chat_name: chatName,
    chat_identifier: chatIdentity.chat_identifier,
    participants: chatIdentity.participants,
    anchor_rowid: anchorRowidResolved,
    anchor_date_ns: anchorNs.toString(),
    messages: mapped,
    has_more_before: hasMoreBefore,
    has_more_after: hasMoreAfter,
  };
}

// Paginate earlier or later than a given cursor (exclusive), returning
// chronological (oldest -> newest) within the returned slice.
function fetchThreadPage(cache, { chatGuid, direction, cursorDateNs, cursorRowid, limit }) {
  if (!chatGuid) throw new Error('chat_guid is required');
  const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 40));
  let cursor;
  try {
    cursor = BigInt(cursorDateNs);
  } catch (e) {
    throw new Error('Invalid cursor_date_ns');
  }
  const cursorR = cursorRowid != null && cursorRowid !== '' ? BigInt(cursorRowid) : null;

  let rows;
  if (direction === 'before') {
    // strictly earlier; tiebreak by rowid so we don't skip or duplicate when
    // two messages share a timestamp.
    rows = cache
      .prepare(`
        SELECT rowid, text, date_ns, is_from_me, sender_handle, chat_name, chat_guid
        FROM messages
        WHERE chat_guid = ?
          AND (date_ns < ? OR (date_ns = ? AND rowid < ?))
        ORDER BY date_ns DESC, rowid DESC
        LIMIT ?
      `)
      .all(chatGuid, cursor, cursor, cursorR != null ? cursorR : 0n, n);
    rows = rows.slice().reverse();
  } else {
    rows = cache
      .prepare(`
        SELECT rowid, text, date_ns, is_from_me, sender_handle, chat_name, chat_guid
        FROM messages
        WHERE chat_guid = ?
          AND (date_ns > ? OR (date_ns = ? AND rowid > ?))
        ORDER BY date_ns ASC, rowid ASC
        LIMIT ?
      `)
      .all(chatGuid, cursor, cursor, cursorR != null ? cursorR : 0n, n);
  }

  let hasMore = false;
  if (rows.length) {
    const edge = direction === 'before' ? rows[0] : rows[rows.length - 1];
    const op = direction === 'before' ? '<' : '>';
    const r = cache
      .prepare(`SELECT 1 AS x FROM messages WHERE chat_guid = ? AND date_ns ${op} ? LIMIT 1`)
      .get(chatGuid, edge.date_ns);
    hasMore = !!r;
  }

  const mapped = rows.map(r => ({
    rowid: typeof r.rowid === 'bigint' ? Number(r.rowid) : r.rowid,
    text: r.text,
    date_ns: typeof r.date_ns === 'bigint' ? r.date_ns.toString() : String(r.date_ns),
    is_from_me: typeof r.is_from_me === 'bigint' ? Number(r.is_from_me) : r.is_from_me,
    sender_handle: r.sender_handle,
    chat_name: r.chat_name,
    chat_guid: r.chat_guid,
    date_iso: fromAppleNs(r.date_ns),
    date_local: fromAppleNsLocal(r.date_ns),
  }));

  return {
    chat_guid: chatGuid,
    messages: mapped,
    has_more: hasMore,
  };
}

// --- HTTP server ---
const app = express();
app.use(express.json());

const cache = openCacheDb();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function getMessageCount() {
  const c = cache.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  return typeof c === 'bigint' ? Number(c) : c;
}

app.get('/api/status', (req, res) => {
  try {
    res.json({
      messageCount: getMessageCount(),
      lastSynced: getMeta(cache, 'last_synced_at'),
      lastSyncedDateNs: getMeta(cache, 'last_synced_date_ns'),
      firstSync: !getMeta(cache, 'last_synced_date_ns'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync', (req, res) => {
  try {
    const result = syncFromChatDb(cache);
    res.json({ ...result, messageCount: getMessageCount() });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', (req, res) => {
  try {
    const opts = {
      text: req.query.text || '',
      from: req.query.from || '',
      sent: req.query.sent === '1' || req.query.sent === 'true',
      received: req.query.received === '1' || req.query.received === 'true',
      after: req.query.after || '',
      before: req.query.before || '',
      limit: req.query.limit || '100',
    };
    const rows = searchCache(cache, opts);
    res.json({ results: rows, count: rows.length });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/thread', (req, res) => {
  try {
    const chatGuid = req.query.chat_guid || '';
    const anchorRowid = req.query.anchor_rowid || '';
    const anchorDateNs = req.query.anchor_date_ns || '';
    const before = req.query.before || '40';
    const after = req.query.after || '40';
    if (!chatGuid) {
      return res.status(400).json({ error: 'chat_guid is required' });
    }
    if (!anchorRowid && !anchorDateNs) {
      return res.status(400).json({ error: 'anchor_rowid or anchor_date_ns is required' });
    }
    const data = fetchThread(cache, {
      chatGuid,
      anchorRowid,
      anchorDateNs,
      before,
      after,
    });
    res.json(data);
  } catch (err) {
    console.error('Thread error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/thread/page', (req, res) => {
  try {
    const chatGuid = req.query.chat_guid || '';
    const direction = req.query.direction === 'after' ? 'after' : 'before';
    const cursorDateNs = req.query.cursor_date_ns || '';
    const cursorRowid = req.query.cursor_rowid || '';
    const limit = req.query.limit || '40';
    if (!chatGuid) return res.status(400).json({ error: 'chat_guid is required' });
    if (!cursorDateNs) return res.status(400).json({ error: 'cursor_date_ns is required' });
    const data = fetchThreadPage(cache, {
      chatGuid,
      direction,
      cursorDateNs,
      cursorRowid,
      limit,
    });
    res.json(data);
  } catch (err) {
    console.error('Thread page error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.SID_PORT ? parseInt(process.env.SID_PORT, 10) : 3847;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nSid is running at http://localhost:${PORT}`);
  console.log(`Cache db: ${CACHE_DB}`);
  const count = getMessageCount();
  const lastSynced = getMeta(cache, 'last_synced_at');
  if (count === 0) {
    console.log('No messages cached yet. Click "Pull latest" in the UI to do the first sync.');
  } else {
    console.log(`${count} messages cached. Last synced: ${lastSynced || 'never'}`);
  }
});
