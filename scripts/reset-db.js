'use strict';

/**
 * Скрипт полного пересоздания базы данных.
 *
 * Удаляет файл базы данных (вместе с журналами WAL/SHM) и применяет
 * все миграции заново. Используется при отладке, когда нужно получить
 * «чистую» базу данных.
 *
 * ВНИМАНИЕ: все данные будут потеряны.
 */

const fs = require('fs');
const readline = require('readline');

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');

/** Спрашивает подтверждение в интерактивном режиме. */
function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  const file = config.database.file;

  if (file === ':memory:') {
    logger.info('База данных в памяти, удалять нечего. Применяю миграции.');
    runMigrations();
    closeDb();
    return;
  }

  const force = process.argv.includes('--force') || process.argv.includes('-f');
  if (!force) {
    const answer = await confirm(`Удалить файл базы данных ${file}? Все данные будут потеряны. [y/N] `);
    if (!['y', 'yes', 'д', 'да'].includes(answer)) {
      logger.info('Операция отменена пользователем');
      return;
    }
  }

  closeDb();

  // SQLite в режиме WAL создаёт дополнительные файлы — удаляем и их
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = `${file}${suffix}`;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      logger.info(`Удалён файл: ${target}`);
    }
  }

  runMigrations();
  logger.info('База данных пересоздана');
  closeDb();
}

main().catch((error) => {
  logger.error('Ошибка пересоздания базы данных:', error);
  process.exit(1);
});
