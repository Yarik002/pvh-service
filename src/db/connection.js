'use strict';

/**
 * Подключение к базе данных SQLite.
 *
 * Модуль отдаёт единственный экземпляр соединения (паттерн Singleton):
 * библиотека better-sqlite3 работает синхронно, поэтому повторное открытие
 * файла базы данных не требуется и нежелательно.
 *
 * Используются следующие PRAGMA:
 *   foreign_keys = ON  — включение контроля внешних ключей (в SQLite по умолчанию выключен!);
 *   journal_mode = WAL — журнал упреждающей записи: быстрее и устойчивее к сбоям;
 *   busy_timeout       — ожидание снятия блокировки вместо мгновенной ошибки SQLITE_BUSY.
 */

const fs = require('fs');
const Database = require('better-sqlite3');

const config = require('../config');
const logger = require('../utils/logger');

/** @type {import('better-sqlite3').Database | null} */
let db = null;

/**
 * Открывает (при первом вызове) и возвращает соединение с базой данных.
 * При повторном вызове возвращает уже открытое соединение.
 *
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  if (db) return db;

  const { file, verbose } = config.database;
  logger.info(`Подключение к базе данных SQLite: ${file}`);
  logger.debug(`Версия библиотеки better-sqlite3: ${require('better-sqlite3/package.json').version}`);

  db = new Database(file, {
    // Подробный вывод SQL-запросов в консоль (удобно при отладке)
    verbose: verbose ? (sql) => logger.debug('SQL:', sql) : undefined,
  });

  // In-memory база создаётся пустой, для файловой включаем журнал WAL
  if (file === ':memory:') {
    db.pragma('foreign_keys = ON');
  } else {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  return db;
}

/**
 * Проверяет, что соединение с базой данных действительно работоспособно.
 * Используется эндпоинтом /health.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
function ping() {
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get();
    return { ok: row?.ok === 1 };
  } catch (error) {
    logger.error('Проверка соединения с БД не пройдена:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Корректно закрывает соединение с базой данных.
 * Вызывается при остановке сервера, чтобы не осталось незавершённых транзакций.
 */
function closeDb() {
  if (!db) return;
  try {
    // Перед закрытием переносим данные из WAL в основной файл
    if (config.database.file !== ':memory:') db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    logger.info('Соединение с базой данных закрыто');
  } catch (error) {
    logger.error('Ошибка при закрытии соединения с БД:', error);
  } finally {
    db = null;
  }
}

/**
 * Выполняет функцию внутри транзакции. При исключении изменения откатываются.
 * Пригодится на 14-м и 18-м днях (приёмка и выдача заказа).
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function transaction(fn) {
  return getDb().transaction(fn)();
}

/** Сведения о базе данных для эндпоинта /health. */
function getInfo() {
  const database = getDb();
  return {
    file: config.database.file,
    sqliteVersion: database.prepare('SELECT sqlite_version() AS v').get().v,
    journalMode: database.pragma('journal_mode', { simple: true }),
    foreignKeys: database.pragma('foreign_keys', { simple: true }) === 1,
    tables: database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name),
  };
}

/** Существует ли файл базы данных (для диагностики). */
function fileExists() {
  return config.database.file === ':memory:' || fs.existsSync(config.database.file);
}

module.exports = { getDb, ping, closeDb, transaction, getInfo, fileExists };
