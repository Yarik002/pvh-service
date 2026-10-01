'use strict';

/**
 * Доступ к данным пользователей (таблица Users).
 *
 * Весь SQL, относящийся к пользователям, собран в этом модуле: сервисы
 * (src/services) работают с методами репозитория и не составляют запросы
 * самостоятельно. Такой подход упрощает сопровождение — при изменении схемы
 * базы данных правки требуются только здесь.
 */

const { getDb } = require('../db/connection');

/** Поля, которые можно безопасно возвращать клиенту (без хеша пароля). */
const PUBLIC_FIELDS = 'id, name, email, role, is_confirmed, confirm_token';
const SAFE_FIELDS = 'id, name, email, role, is_confirmed';

/** Приводит строку базы данных к удобному для клиента виду. */
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isConfirmed: row.is_confirmed === 1,
    confirmToken: row.confirm_token,
  };
}

/** Убирает из записи служебные поля (хеш пароля, токен подтверждения). */
function toPublic(user) {
  if (!user) return null;
  const { confirmToken, ...rest } = user;
  return rest;
}

/**
 * Находит пользователя по адресу электронной почты.
 * Поиск нечувствителен к регистру: в схеме поле объявлено с COLLATE NOCASE,
 * дополнительно значение приводится к нижнему регистру.
 *
 * @param {string} email
 * @returns {object|null}
 */
function findByEmail(email) {
  const row = getDb()
    .prepare(`SELECT ${PUBLIC_FIELDS}, password_hash FROM Users WHERE email = ? COLLATE NOCASE`)
    .get(String(email).trim().toLowerCase());
  if (!row) return null;
  return { ...mapRow(row), passwordHash: row.password_hash };
}

/**
 * Находит пользователя по идентификатору.
 * @param {number} id
 * @returns {object|null}
 */
function findById(id) {
  const row = getDb()
    .prepare(`SELECT ${PUBLIC_FIELDS}, password_hash FROM Users WHERE id = ?`)
    .get(id);
  if (!row) return null;
  return { ...mapRow(row), passwordHash: row.password_hash };
}

/**
 * Находит пользователя по токену подтверждения (понадобится на 6-м дне).
 * @param {string} token
 * @returns {object|null}
 */
function findByConfirmToken(token) {
  const row = getDb()
    .prepare(`SELECT ${PUBLIC_FIELDS} FROM Users WHERE confirm_token = ?`)
    .get(token);
  return mapRow(row);
}

/**
 * Создаёт нового пользователя.
 *
 * @param {{name: string, email: string, passwordHash: string,
 *          role?: string, isConfirmed?: boolean, confirmToken?: string|null}} data
 * @returns {object} созданная запись
 */
function create({ name, email, passwordHash, role = 'client', isConfirmed = false, confirmToken = null }) {
  const info = getDb()
    .prepare(
      `INSERT INTO Users (name, email, password_hash, role, is_confirmed, confirm_token)
       VALUES (@name, @email, @passwordHash, @role, @isConfirmed, @confirmToken)`,
    )
    .run({
      name,
      email: String(email).trim().toLowerCase(),
      passwordHash,
      role,
      isConfirmed: isConfirmed ? 1 : 0,
      confirmToken,
    });

  return findById(info.lastInsertRowid);
}

/**
 * Отмечает учётную запись как подтверждённую и удаляет токен (6-й день).
 * @param {number} id
 * @returns {object|null} обновлённая запись
 */
function confirm(id) {
  getDb()
    .prepare('UPDATE Users SET is_confirmed = 1, confirm_token = NULL WHERE id = ?')
    .run(id);
  return findById(id);
}

/** Возвращает общее количество пользователей (используется в проверках). */
function count() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM Users').get().n;
}

module.exports = {
  findByEmail,
  findById,
  findByConfirmToken,
  create,
  confirm,
  count,
  toPublic,
  SAFE_FIELDS,
};
