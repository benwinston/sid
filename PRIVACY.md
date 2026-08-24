# Privacy

Sid runs entirely on the user's Mac. It reads the local Messages database in
read-only mode, builds a local search cache, and serves its interface only on
`127.0.0.1`.

Sid does not include telemetry, analytics, advertising, remote APIs, user
accounts, or cloud storage. Message content, contact identifiers, chat names,
and search queries are not intentionally transmitted off-device.

The generated `cache.db`, `cache.db-wal`, and `cache.db-shm` files contain
private message data. They must never be attached to bug reports or included
in releases. They are excluded by the repository's `.gitignore`.

Dependency installation contacts the npm registry. That happens during
installation, not while Sid is running.
