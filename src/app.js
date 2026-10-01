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
const { cookieParser } = require('./middleware/cookies');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const passwordRouter = require('./routes/password');

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

  // --- Разбор cookie ---------------------------------------------------
  // Нужен для хранения токена сессии в браузере
  app.use(cookieParser());

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

  // --- REST API --------------------------------------------------------
  // Маршруты аутентификации: регистрация, подтверждение Email, вход
  app.use('/api/auth', authRouter);
  // Маршруты работы с паролями: оценка надёжности, смена пароля
  app.use('/api/password', passwordRouter);

  // Корневой маршрут: краткая справка о сервисе и перечень разделов API
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
        register: 'POST /api/auth/register — регистрация нового пользователя',
        login: 'POST /api/auth/login — вход в систему, выдача токена сессии',
        logout: 'POST /api/auth/logout — выход из системы',
        me: 'GET /api/auth/me — данные текущего пользователя',
        confirm: 'GET /api/auth/confirm?token=… — подтверждение адреса электронной почты',
        confirmCheck: 'GET /api/auth/confirm/check?token=… — проверка ссылки подтверждения',
        resend: 'POST /api/auth/resend-confirmation — повторная отправка письма',
        passwordStrength: 'POST /api/password/strength — оценка надёжности пароля',
      },
      planned: [
        'GET /api/cells — управление ячейками хранения (12-й день)',
        'POST /api/orders — приёмка заказа (14-й день)',
      ],
      timestamp: new Date().toISOString(),
    });
  });

  // --- Несуществующие разделы API --------------------------------------
  // Обработчик срабатывает для путей /api/*, не перехваченных выше
  app.use('/api', (req, res, next) => {
    next(AppError.notFound(`Раздел API ${req.method} ${req.originalUrl} не существует`));
  });

  // --- Обработка ошибок (всегда последними) ----------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.debug('Приложение Express сконфигурировано');
  return app;
}

module.exports = { createApp };
