const db = require('../db');

const USER_NOTES_SCHEMA_UPDATES = [
  `CREATE TABLE IF NOT EXISTS user_notes (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note VARCHAR(256),
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, note_user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_user_notes_user_id ON user_notes(user_id)',
];

let schemaReadyPromise;

const toNote = (row) => ({
  note: row.note || '',
  note_user_id: String(row.note_user_id),
  user_id: String(row.user_id),
});

class UserNote {
  static async ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        for (const statement of USER_NOTES_SCHEMA_UPDATES) {
          await db.none(statement);
        }
      })().catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
    }

    return schemaReadyPromise;
  }

  static async listForUser(userId) {
    await this.ensureSchema();
    const rows = await db.manyOrNone(
      `
        SELECT user_id, note_user_id, note
        FROM user_notes
        WHERE user_id::text = $1
        ORDER BY updated_at DESC, note_user_id DESC
      `,
      [String(userId)],
    );

    return Object.fromEntries(rows.map((row) => [String(row.note_user_id), row.note || '']));
  }

  static async get(userId, noteUserId) {
    await this.ensureSchema();
    const row = await db.oneOrNone(
      `
        SELECT user_id, note_user_id, note
        FROM user_notes
        WHERE user_id::text = $1 AND note_user_id::text = $2
      `,
      [String(userId), String(noteUserId)],
    );

    return row ? toNote(row) : { note: '', note_user_id: String(noteUserId), user_id: String(userId) };
  }

  static async put(userId, noteUserId, note) {
    await this.ensureSchema();
    if (note == null || note === '') {
      await db.none(
        'DELETE FROM user_notes WHERE user_id::text = $1 AND note_user_id::text = $2',
        [String(userId), String(noteUserId)],
      );
      return this.get(userId, noteUserId);
    }

    const row = await db.one(
      `
        INSERT INTO user_notes (user_id, note_user_id, note, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, note_user_id)
        DO UPDATE SET note = EXCLUDED.note, updated_at = CURRENT_TIMESTAMP
        RETURNING user_id, note_user_id, note
      `,
      [String(userId), String(noteUserId), note],
    );

    return toNote(row);
  }
}

module.exports = UserNote;
