# Sid

Local-first UI for searching your iMessage history. Sits on top of the macOS
Messages database (`~/Library/Messages/chat.db`), caches messages into a local
SQLite db, and exposes a fast search UI over them.

Nothing leaves your machine. There is no authentication, cloud service,
telemetry, or runtime network traffic outside `localhost`. The server binds to
`127.0.0.1`, so it is not exposed to other devices on your network.

## Install

```bash
git clone <repository-url> sid
cd sid
npm install
```

If `better-sqlite3` fails to build (Xcode CLT / python issues), try:

```bash
xcode-select --install
npm install --build-from-source better-sqlite3
```

## First run

```bash
npm start
```

Open http://localhost:3847.

The first time you open the app, the local cache is empty. Click **Pull latest**
to do the initial sync. Depending on how much history you have this can take
30-60 seconds (the UI warns you). Subsequent syncs only pull messages newer
than the last synced timestamp, so they are near-instant.

If you see permission errors opening `chat.db`, grant **Full Disk Access** to
your terminal app in **System Settings > Privacy & Security > Full Disk Access**.

## How incremental sync works

- `cache.db` has a `sync_meta` table with `last_synced_date_ns`, the maximum
  Apple-epoch timestamp from the last sync batch.
- On sync, the server queries `chat.db` with
  `WHERE m.date > last_synced_date_ns` (strict greater-than) and inserts new
  rows into `cache.db` in batches of 1000 inside a single transaction.
- `INSERT OR IGNORE` on `rowid` prevents duplicates if the same message is seen
  twice.
- After sync, `last_synced_date_ns` is updated to the new max.

Only messages with `item_type = 0` and visible text are synced. Sid reads both
the legacy `text` field and the serialized `attributedBody` field used by newer
macOS versions. It skips group-event rows and attachments without text.

## Cache location

```
./cache.db         (messages + FTS5 index + sync_meta)
./cache.db-wal     (WAL file, created automatically)
./cache.db-shm     (shared-memory file, created automatically)
```

## Wipe and resync

```bash
rm cache.db cache.db-wal cache.db-shm 2>/dev/null
npm start
```

Then click **Pull latest**.

## Schema upgrades

Each result's timestamp is a clickable link that opens a side-pane showing the
surrounding conversation. This requires a `chat_guid` column on cached
messages. If you have an older cache from before this feature landed, on
startup the server will log:

```
Resetting cache for schema upgrade (chat_guid added)...
```

and rebuild the `messages` + FTS tables and reset the sync cursor. Click
**Pull latest** once and the cache will be rebuilt from `chat.db`. This is a
one-time cost on first start after upgrading; no data is lost from `chat.db`.

## Port

Default port is `3847`. Override with `SID_PORT=9000 npm start`.

## Keyboard shortcuts

- `/`     focus the search box
- `Esc`   clear all filters
- `Enter` re-run search immediately (bypasses 300ms debounce)

## Privacy and release safety

- `cache.db*` contains private message content and is excluded by `.gitignore`.
- Run `npm run privacy-check` before every public release.
- Never weaken the `127.0.0.1` server binding without adding authentication.
- Sid opens the source Messages database read-only and never modifies it.

## Notes

- Times use the Mac's current timezone. Set `TZ` to override it.
- Search uses FTS5 for text queries with fallback to `LIKE` for non-word
  patterns.
- The server opens `chat.db` in read-only mode. It does not modify your
  Messages database in any way.
- If Messages.app is open while you sync, it should still work (chat.db uses
  WAL), but if you see `database is locked`, quit Messages and try again.

## License

MIT
