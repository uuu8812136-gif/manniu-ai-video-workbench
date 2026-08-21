const path = require("node:path");

const [action, databasePath, betterSqlitePath] = process.argv.slice(2);
if (!action || !databasePath || !betterSqlitePath) {
  throw new Error("Usage: smoke-installed-state.cjs <seed|read> <database> <better-sqlite3>");
}

const Database = require(path.resolve(betterSqlitePath));

if (action === "seed") {
  const db = new Database(databasePath);
  try {
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO vidu_accounts (
        id, name, session_key, enabled, created_at, updated_at,
        disabled_reason, disabled_message, disabled_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "00000000-0000-4000-8000-000000000021",
      "legacy-credits",
      "smoke-legacy-credits",
      now,
      now,
      "credits_exhausted",
      "legacy credits",
      now,
    );
    insert.run(
      "00000000-0000-4000-8000-000000000022",
      "expired-login",
      "smoke-expired-login",
      now,
      now,
      "login_expired",
      "expired login",
      now,
    );
  } finally {
    db.close();
  }
  process.exit(0);
}

if (action === "read") {
  const db = new Database(databasePath, { readonly: true });
  try {
    const rows = db.prepare("SELECT id, enabled, disabled_reason FROM vidu_accounts ORDER BY id").all();
    process.stdout.write(JSON.stringify(rows));
  } finally {
    db.close();
  }
  process.exit(0);
}

throw new Error(`Unknown action: ${action}`);
