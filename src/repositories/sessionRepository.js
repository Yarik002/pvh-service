'use strict';

/**
 * Доступ к данным сессий (таблица Sessions).
 *
 * В базе данных хранится хеш токена, а не сам токен: по сохранённому значению
 * нельзя восстановить токен и воспользоваться чужой сессией.
 */

const crypto = require('crypto');
const { getDb } = require('../db/connection');
const { toIso } = require('../utils/datetime');

/** Вычисляет хеш токена (SHA-256, шестнадцатеричная строка). */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Приводит строку базы данных к удобному виду (даты — в формате ISO 8601). */
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    lastUsedAt: toIso(row.last_used_at),
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
  };
}

/**
 * Создаёт сессию.
 *
 * @param {{userId: number, token: string, expiresAt: string,
 *          userAgent?: string, ipAddress?: string}} data
 * @returns {object} созданная запись
 */
function create({ userId, token, expiresAt, userAgent = null, ipAddress = null }) {
  const info = getDb()
    .prepare(
      `INSERT INTO Sessions (token_hash, user_id, expires_at, user_agent, ip_address)
       VALUES (@tokenHash, @userId, @expiresAt, @userAgent, @ipAddress)`,
    )
    .run({
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: userAgent ? String(userAgent).slice(0, 255) : null,
      ipAddress: ipAddress ? String(ipAddress).slice(0, 45) : null,
    });

  return findById(info.lastInsertRowid);
}

/** Находит сессию по идентификатору. */
function findById(id) {
  const row = getDb().prepare('SELECT * FROM Sessions WHERE id = ?').get(id);
  return mapRow(row);
}

/**
 * Находит действующую сессию по токену.
 *
 * Истёкшие сессии не возвращаются: проверка срока выполняется в запросе,
 * чтобы не полагаться на своевременную очистку таблицы.
 *
 * @param {string} token
 * @returns {object|null}
 */
function findValidByToken(token) {
  if (typeof token !== 'string' || token === '') return null;

  const row = getDb()
    .prepare(
      `SELECT * FROM Sessions
        WHERE token_hash = ?
          AND expires_at > datetime('now')`,
    )
    .get(hashToken(token));

  return mapRow(row);
}

/**
 * Находит сессию по токену независимо от срока действия.
 * Используется, чтобы отличить «сессия истекла» от «сессия не существует».
 */
function findByToken(token) {
  if (typeof token !== 'string' || token === '') return null;
  const row = getDb().prepare('SELECT * FROM Sessions WHERE token_hash = ?').get(hashToken(token));
  return mapRow(row);
}

/** Отмечает время последнего обращения с токеном. */
function touch(id) {
  getDb().prepare("UPDATE Sessions SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

/** Удаляет одну сессию (выход из системы). */
function remove(id) {
  return getDb().prepare('DELETE FROM Sessions WHERE id = ?').run(id).changes;
}

/** Удаляет сессию по токену. */
function removeByToken(token) {
  if (typeof token !== 'string' || token === '') return 0;
  return getDb().prepare('DELETE FROM Sessions WHERE token_hash = ?').run(hashToken(token)).changes;
}

/** Удаляет все сессии пользователя (выход на всех устройствах). */
function removeByUserId(userId) {
  return getDb().prepare('DELETE FROM Sessions WHERE user_id = ?').run(userId).changes;
}

/** Удаляет истёкшие сессии. Возвращает число удалённых записей. */
function removeExpired() {
  return getDb().prepare("DELETE FROM Sessions WHERE expires_at <= datetime('now')").run().changes;
}

/** Возвращает число сессий пользователя. */
function countByUserId(userId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM Sessions WHERE user_id = ?').get(userId).n;
}

/** Возвращает общее число сессий. */
function count() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM Sessions').get().n;
}

module.exports = {
  create,
  findById,
  findByToken,
  findValidByToken,
  touch,
  remove,
  removeByToken,
  removeByUserId,
  removeExpired,
  countByUserId,
  count,
  hashToken,
};
