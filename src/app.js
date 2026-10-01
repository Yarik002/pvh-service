'use strict';

/**
 * Сборка приложения Express.
 *
 * Файл экспортирует функцию createApp(), а не готовый сервер. Это позволяет:
 *   • запускать сервер из src/server.js (обычный режим);
 *   • поднимать приложение на случайном порту в тестах (23-й день);
 *   • переиспользовать приложение при развёртывании на стенде.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

const config = require('./config');
const logger = require('./utils/logger');
const AppError = require('./utils/AppError');
const requestLogger = require('./middleware/requestLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRouter = require('./routes/health');

/**
 * Создаёт и настраивает экземпляр приложения.
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  // Доверяем заголовкам прокси (X-Forwarded-For) при развёртывании за nginx
  app.set('trust proxy', true);
  // Скрываем техническую информацию о сервере из заголовка X-Powered-By
  app.disable('x-powered-by');

  // --- Разбор тела запроса -------------------------------------------
  // Ограничение 1 МБ защищает от переполнения памяти большим запросом
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // --- Логирование запросов -------------------------------------------
  app.use(requestLogger({ logLevel: 'info', ignore: ['/favicon.ico'] }));

  // --- Базовые заголовки безопасности ---------------------------------
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // --- Статические файлы клиентской части ------------------------------
  // Каталог public/ наполняется на 9-м дне (вёрстка шаблона приложения).
  if (fs.existsSync(config.publicDir)) {
    app.use(express.static(config.publicDir, { index: false, maxAge: '1h' }));
  }

  // --- Служебные маршруты ---------------------------------------------
  // Основной эндпоинт приёмки сборки v0.1: GET /health
  app.use('/health', healthRouter);

  // Корневой маршрут: краткая справка о сервисе
  app.get('/', (req, res) => {
    res.status(200).json({
      success: true,
      application: config.appName,
      version: config.version,
      environment: config.env,
      message: 'Сервер учебного проекта ПВЗ запущен.',
      endpoints: {
        health: 'GET /health — состояние сервера и базы данных',
        healthLive: 'GET /health/live — проверка живости процесса',
        healthReady: 'GET /health/ready — проверка готовности сервиса',
        api: 'REST API приложения — разделы появятся с 3-го дня разработки (префикс /api)',
      },
      timestamp: new Date().toISOString(),
    });
  });

  // --- Заглушка будущего REST API --------------------------------------
  // Начиная с 3-го дня здесь будут подключаться маршруты /api/auth, /api/orders,
  // /api/cells и другие. Сейчас префикс объявлен, но не содержит обработчиков.
  app.use('/api', (req, res, next) => {
    next(AppError.notFound(`Раздел API ${req.originalUrl} ещё не реализован (сборка v0.1)`));
  });

  // --- Обработка ошибок (всегда последними) ----------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.debug('Приложение Express сконфигурировано');
  return app;
}

module.exports = { createApp };
