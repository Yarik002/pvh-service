'use strict';

/**
 * Скрипт применения миграций из командной строки.
 *
 * Использование:
 *   node scripts/migrate.js        — применить все новые миграции;
 *   node scripts/migrate.js status — показать список миграций и их состояние.
 */

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { getDb, closeDb, getInfo } = require('../src/db/connection');
const { runMigrations, getAppliedMigrations, listMigrationFiles } = require('../src/db/migrate');

function showStatus() {
  getDb();
  const files = listMigrationFiles();
  const applied = new Set(getAppliedMigrations().map((row) => row.name));

  console.log(`\nБаза данных: ${config.database.file}\n`);
  console.log('№  Миграция                              Состояние');
  console.log('-'.repeat(70));
  files.forEach((name, index) => {
    const state = applied.has(name) ? 'применена' : 'ожидает применения';
    console.log(`${String(index + 1).padEnd(3)}${name.padEnd(38)}${state}`);
  });

  const info = getInfo();
  console.log(`\nТаблицы (${info.tables.length}): ${info.tables.join(', ') || '(нет)'}`);
  console.log(`Версия SQLite: ${info.sqliteVersion}, журнал: ${info.journalMode}\n`);
}

function main() {
  const command = (process.argv[2] || 'up').toLowerCase();

  if (command === 'status') {
    showStatus();
    closeDb();
    return;
  }

  const { applied, skipped } = runMigrations();
  logger.info(`Применено миграций: ${applied.length}, уже было применено: ${skipped.length}`);

  const info = getInfo();
  logger.info(`Таблицы: ${info.tables.join(', ') || '(нет)'}`);
  closeDb();
}

try {
  main();
} catch (error) {
  logger.error('Не удалось выполнить миграции:', error);
  closeDb();
  process.exit(1);
}
