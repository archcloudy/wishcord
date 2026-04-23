const db = require('../db');

class User {
  static async create(userData) {
    const { username, email, password } = userData;
    const query = `
      INSERT INTO users (username, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, username, email, created_at
    `;
    const values = [username, email, password];
    return db.one(query, values);
  }

  static async findById(id) {
    const query = `
      SELECT id, username, discriminator, global_name, avatar, bio, email, verified, created_at
      FROM users
      WHERE id = $1
    `;
    return db.oneOrNone(query, [id]);
  }

  static async findByUsername(username) {
    const query = `
      SELECT id, username, discriminator, global_name, avatar, bio, email, verified, created_at
      FROM users
      WHERE username = $1
    `;
    return db.oneOrNone(query, [username]);
  }

  static async findByEmail(email) {
    const query = `
      SELECT id, username, discriminator, global_name, avatar, bio, email, verified, created_at, password_hash
      FROM users
      WHERE email = $1
    `;
    return db.oneOrNone(query, [email]);
  }

  static async update(id, updates) {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');
    const query = `
      UPDATE users
      SET ${setClause}
      WHERE id = $1
      RETURNING id, username, discriminator, global_name, avatar, bio, email, verified, created_at
    `;
    return db.one(query, [id, ...values]);
  }
}

module.exports = User;