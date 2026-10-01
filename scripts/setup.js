'use strict';

/**
 * Скрипт первоначальной настройки проекта («развернуть и запустить»).
 *
 * Выполняет всё, что нужно для запуска проекта на чистом компьютере:
 *   1) проверяет версию Node.js;
 *   2) создаёт файл настроек .env из образца .env.example, если его ещё нет;
 *   3) проверяет наличие установленных зависимостей;
 *   4) создаёт базу данных и применяет миграции;
 *   5) выполняет контрольную проверку сборки.
 *
 * Запуск:  node scripts/setup.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const config = require('../src/config');
const logger = require('../src/utils/logger');

const MIN_NODE_MAJOR = 20;

/** Шаг 1. Проверка версии Node.js. */
function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(
      `Требуется Node.js версии ${MIN_NODE_MAJOR} или выше, установлена версия ${process.version}. ` +
      'Скачать актуальную версию: https://nodejs.org/',
    );
  }
  logger.info(`Node.js ${process.version} — версия подходит`);
}

/** Шаг 2. Создание файла .env из образца. */
function ensureEnvFile() {
  const envPath = path.join(config.rootDir, '.env');
  const examplePath = path.join(config.rootDir, '.env.example');

  if (fs.existsSync(envPath)) {
    logger.info('Файл настроек .env уже существует — оставлен без изменений');
    return;
  }
  if (!fs.existsSync(examplePath)) {
    logger.warn('Файл .env.example не найден — пропускаю создание .env');
    return;
  }

  fs.copyFileSync(examplePath, envPath);
  logger.info('Создан файл настроек .env (скопирован из .env.example)');
}

/** Шаг 3. Проверка установленных зависимостей. */
function checkDependencies() {
  const required = ['express', 'better-sqlite3', 'dotenv'];
  const missing = required.filter((name) => {
    try {
      require.resolve(name, { paths: [config.rootDir] });
      return false;
    } catch {
      return true;
    }
  });

  if (missing.length > 0) {
    throw new Error(
      `Не установлены зависимости: ${missing.join(', ')}.\n` +
      '  Выполните команду установки в каталоге проекта:\n' +
      '      npm install        (или pnpm install)',
    );
  }
  logger.info(`Зависимости установлены: ${required.join(', ')}`);
}

/** Шаг 4. Создание базы данных и применение миграций. */
function prepareDatabase() {
  const { getDb, getInfo, closeDb } = require('../src/db/connection');
  const { runMigrations } = require('../src/db/migrate');

  getDb();
  const { applied, skipped } = runMigrations();
  logger.info(`Миграции: применено ${applied.length}, уже было применено ${skipped.length}`);

  const info = getInfo();
  logger.info(`База данных готова. Таблицы: ${info.tables.join(', ')}`);
  closeDb();
}

/** Шаг 5. Контрольная проверка сборки. */
function runAcceptanceCheck() {
  logger.info('Выполняется контрольная проверка сборки…\n');
  // Для текущей версии сборки выбирается соответствующий сценарий проверки
  const major = config.version.split('.')[0];
  const minor = config.version.split('.')[1];
  const script = path.join(config.rootDir, 'scripts', `check-v${major}.${minor}.js`);
  // stdio: 'inherit' — вывод проверки направляется прямо в консоль
  execFileSync(process.execPath, [script], { stdio: 'inherit' });
}

function main() {
  logger.info('='.repeat(70));
  logger.info('НАСТРОЙКА ПРОЕКТА «Сервис трекинга заказов и инвентаря для ПВЗ»');
  logger.info('='.repeat(70));

  checkNodeVersion();
  ensureEnvFile();
  checkDependencies();
  prepareDatabase();
  runAcceptanceCheck();

  logger.info('\nПроект готов к работе. Запуск сервера:  npm start');
  logger.info('Адрес проверки:  http://127.0.0.1:3000/health');
}

try {
  main();
} catch (error) {
  logger.error('\nНастройка не завершена:');
  logger.error(error.message);
  process.exit(1);
}
