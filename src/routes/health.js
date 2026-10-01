'use strict';

/**
 * Эндпоинты проверки работоспособности (health-check).
 *
 * GET /health  — основной эндпоинт приёмки сборки v0.1.
 *                Возвращает 200 OK и состояние базы данных.
 * GET /health/live  — «жив ли процесс» (liveness probe).
 * GET /health/ready — «готов ли сервис принимать запросы» (readiness probe):
 *                     проверяет соединение с БД и наличие применённых миграций.
 */

const express = require('express');

const config = require('../config');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const db = require('../db/connection');
const { getAppliedMigrations } = require('../db/migrate');

const router = express.Router();

/** Время старта процесса — для расчёта времени работы (uptime). */
const startedAt = Date.now();

/** Форматирует время работы в удобочитаемый вид: 1 ч 2 мин 3 с. */
function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours} ч` : null, minutes ? `${minutes} мин` : null, `${seconds} с`]
    .filter(Boolean)
    .join(' ');
}

/**
 * GET /health
 * Основная проверка сборки: сервер отвечает и соединение с SQLite работает.
 */
router.get('/', (req, res, next) => {
  try {
    const ping = db.ping();
    const uptimeMs = Date.now() - startedAt;

    if (!ping.ok) {
      // Сервер запущен, но база данных недоступна — это не «OK»
      logger.warn('Запрос /health: база данных недоступна');
      throw AppError.unavailable(
        `База данных недоступна${ping.error ? `: ${ping.error}` : ''}`,
      );
    }

    const database = db.getInfo();
    const migrations = getAppliedMigrations();

    res.status(200).json({
      success: true,
      status: 'OK',
      message: 'Сервер работает, база данных доступна',
      application: config.appName,
      version: config.version,
      environment: config.env,
      uptime: formatUptime(uptimeMs),
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      timestamp: new Date().toISOString(),
      database: {
        engine: 'SQLite',
        connected: true,
        version: database.sqliteVersion,
        file: database.file,
        journalMode: database.journalMode,
        foreignKeys: database.foreignKeys,
        tables: database.tables,
        migrations: migrations.map((m) => m.name),
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        pid: process.pid,
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    });
  } catch (error) {
    next(error);
  }
});

/** GET /health/live — процесс жив (база данных не проверяется). */
router.get('/live', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'OK',
    check: 'liveness',
    timestamp: new Date().toISOString(),
  });
});

/** GET /health/ready — сервис готов: БД доступна и схема создана. */
router.get('/ready', (req, res, next) => {
  try {
    const ping = db.ping();
    if (!ping.ok) throw AppError.unavailable('База данных недоступна');

    const tables = db.getInfo().tables;
    const required = ['Users', 'Orders', 'Storage_Cells'];
    const missing = required.filter((table) => !tables.includes(table));
    if (missing.length > 0) {
      throw AppError.unavailable(`Схема базы данных не создана, отсутствуют таблицы: ${missing.join(', ')}`);
    }

    res.status(200).json({
      success: true,
      status: 'READY',
      check: 'readiness',
      tables,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
