'use strict';

/**
 * Точка входа серверной части.
 *
 * Порядок работы:
 *   1) загрузить конфигурацию;
 *   2) открыть соединение с базой данных SQLite;
 *   3) применить неприменённые миграции (создание схемы);
 *   4) запустить HTTP-сервер и вывести в консоль адрес;
 *   5) корректно остановиться по Ctrl+C / SIGTERM.
 */

const http = require('http');

const config = require('./config');
const logger = require('./utils/logger');
const { createApp } = require('./app');
const { getDb, closeDb } = require('./db/connection');
const { runMigrations, getAppliedMigrations } = require('./db/migrate');

/**
 * Готовит базу данных: открывает соединение и применяет миграции.
 * @returns {{ tables: string[], migrations: string[] }}
 */
function prepareDatabase() {
  getDb();

  if (config.database.autoMigrate) {
    runMigrations();
  } else {
    logger.warn('Автоматическое применение миграций отключено (DB_AUTO_MIGRATE=false)');
  }

  const { tables } = require('./db/connection').getInfo();
  const migrations = getAppliedMigrations().map((row) => row.name);

  logger.info(`Таблицы в базе данных: ${tables.length ? tables.join(', ') : '(нет)'}`);
  logger.info(`Применённые миграции: ${migrations.length ? migrations.join(', ') : '(нет)'}`);

  return { tables, migrations };
}

/**
 * Запускает HTTP-сервер.
 * @returns {Promise<import('http').Server>}
 */
function startServer() {
  const app = createApp();
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/** Корректная остановка: закрываем сервер и соединение с БД. */
function setupGracefulShutdown(server) {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Получен сигнал ${signal}, остановка сервера…`);

    // Принудительное завершение, если соединения не закрылись за 10 секунд
    const forceExit = setTimeout(() => {
      logger.error('Сервер не остановился за 10 секунд, принудительное завершение');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(() => {
      logger.info('HTTP-сервер остановлен');
      closeDb();
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Необработанный отказ промиса:', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Необработанное исключение:', error);
    shutdown('uncaughtException');
  });
}

/** Основной сценарий запуска. */
async function main() {
  logger.info('='.repeat(78));
  logger.info(`${config.appName} — сборка v${config.version}`);
  logger.info(`Режим работы: ${config.env}`);
  logger.info('='.repeat(78));

  prepareDatabase();

  const server = await startServer();
  const { address, port } = server.address();
  const host = address === '::' || address === '0.0.0.0' ? 'localhost' : address;

  logger.info(`Сервер запущен: http://${host}:${port}`);
  logger.info(`Проверка работоспособности: http://${host}:${port}/health`);

  setupGracefulShutdown(server);
}

// Запускаем только при прямом вызове файла (при импорте в тестах — нет)
if (require.main === module) {
  main().catch((error) => {
    logger.error('Не удалось запустить сервер:', error);
    closeDb();
    process.exit(1);
  });
}

module.exports = { main, startServer, prepareDatabase };
