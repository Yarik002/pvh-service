'use strict';

/**
 * Простейший механизм миграций.
 *
 * Миграции — это пронумерованные SQL-файлы в каталоге src/db/migrations
 * (например 001_initial_schema.sql). Применённые миграции фиксируются
 * в служебной таблице schema_migrations, поэтому повторный запуск
 * не выполняет один и тот же скрипт дважды.
 *
 * Такое решение не требует сторонних библиотек и полностью прозрачно:
 * весь SQL виден в файлах и может быть проверен преподавателем.
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
const { getDb } = require('./connection');

const MIGRATIONS_TABLE = 'schema_migrations';

/** Создаёт служебную таблицу учёта применённых миграций. */
function ensureMigrationsTable() {
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         name       TEXT    NOT NULL UNIQUE,
         applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
       )`,
    )
    .run();
}

/**
 * Возвращает список файлов миграций, отсортированный по имени (номеру).
 * @returns {string[]} имена файлов, например ['001_initial_schema.sql']
 */
function listMigrationFiles() {
  const dir = require('../config').database.migrationsDir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Применяет все ещё не выполненные миграции.
 *
 * @returns {{ applied: string[], skipped: string[] }}
 */
function runMigrations() {
  const db = getDb();
  ensureMigrationsTable();

  const alreadyApplied = new Set(
    db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all().map((row) => row.name),
  );

  const applied = [];
  const skipped = [];

  for (const name of listMigrationFiles()) {
    if (alreadyApplied.has(name)) {
      skipped.push(name);
      continue;
    }

    const sql = fs.readFileSync(path.join(require('../config').database.migrationsDir, name), 'utf8');

    // Каждая миграция выполняется в транзакции: либо применяется целиком, либо не применяется вовсе
    const applyOne = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`).run(name);
    });

    try {
      applyOne();
      applied.push(name);
      logger.info(`Миграция применена: ${name}`);
    } catch (error) {
      logger.error(`Ошибка применения миграции ${name}:`, error);
      throw error;
    }
  }

  if (applied.length === 0) {
    logger.info(`Схема базы данных актуальна (проверено миграций: ${skipped.length})`);
  }

  return { applied, skipped };
}

/** Возвращает список уже применённых миграций. */
function getAppliedMigrations() {
  ensureMigrationsTable();
  return getDb()
    .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id`)
    .all();
}

module.exports = { runMigrations, getAppliedMigrations, listMigrationFiles, MIGRATIONS_TABLE };
