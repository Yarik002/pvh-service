'use strict';

/**
 * Преобразование даты и времени.
 *
 * SQLite хранит дату и время строкой вида «YYYY-MM-DD HH:MM:SS» в формате UTC.
 * Для передачи клиенту такие значения приводятся к стандарту ISO 8601
 * («YYYY-MM-DDTHH:MM:SSZ»), а для записи в базу данных — к формату SQLite.
 */

/**
 * Преобразует значение из базы данных в объект Date (UTC).
 * @param {string|Date|null} value
 * @returns {Date|null}
 */
function fromSqlite(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const text = String(value).trim();
  if (text === '') return null;

  const normalized = text.replace(' ', 'T');
  const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const date = new Date(hasZone ? normalized : `${normalized}Z`);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Преобразует значение из базы данных в строку ISO 8601.
 * @param {string|Date|null} value
 * @returns {string|null}
 */
function toIso(value) {
  const date = fromSqlite(value);
  return date ? date.toISOString() : null;
}

/**
 * Приводит дату к формату, принятому в базе данных
 * («YYYY-MM-DD HH:MM:SS», формат UTC).
 * @param {Date} [date]
 * @returns {string}
 */
function toSqlite(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Возвращает дату, отстоящую от текущей на указанное число часов.
 * @param {number} hours
 * @returns {string} значение в формате базы данных
 */
function sqliteAfterHours(hours) {
  return toSqlite(new Date(Date.now() + hours * 60 * 60 * 1000));
}

module.exports = { fromSqlite, toIso, toSqlite, sqliteAfterHours };
