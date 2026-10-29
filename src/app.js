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
const cellsRouter = require('./routes/cells');
const adminRouter = require('./routes/admin');
const ordersRouter = require('./routes/orders');
const pagesRouter = require('./routes/pages');

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
  // Таблица стилей, сценарии, изображения из каталога public
  if (fs.existsSync(config.publicDir)) {
    app.use(express.static(config.publicDir, {
      index: false,
      maxAge: config.isProduction ? '1h' : 0,
      // Файлы, начинающиеся с точки, не отдаются
      dotfiles: 'ignore',
    }));
  }

  // --- Служебные маршруты ---------------------------------------------
  // Основной эндпоинт приёмки сборки v0.1: GET /health
  app.use('/health', healthRouter);

  // --- REST API --------------------------------------------------------
  // Маршруты аутентификации: регистрация, подтверждение Email, вход
  app.use('/api/auth', authRouter);
  // Маршруты работы с паролями: оценка надёжности, смена пароля
  app.use('/api/password', passwordRouter);
  // Ячейки хранения: просмотр — всем авторизованным, изменение — администратору
  app.use('/api/cells', cellsRouter);
  // Административный раздел: доступен только пользователям с ролью admin
  app.use('/api/admin', adminRouter);
  // Заказы: приёмка (администратор) и просмотр заказа
  app.use('/api/orders', ordersRouter);

  // Корневой маршрут: краткая справка о сервисе и перечень разделов API.
  // Отдаётся в формате JSON по адресу /api; главная страница приложения —
  // HTML-страница (см. маршруты страниц ниже)
  app.get('/api', (req, res) => {
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
        cells: 'GET /api/cells — список ячеек хранения (для авторизованных)',
        cellsFree: 'GET /api/cells/free — только свободные ячейки',
        cellsSummary: 'GET /api/cells/summary — сводка по складу',
        cell: 'GET /api/cells/:id — сведения об одной ячейке',
        cellSuggest: 'GET /api/cells/suggest?mode=auto|manual — выбор ячейки для заказа (администратор)',
        adminOverview: 'GET /api/admin/overview — сводка по ПВЗ (только администратор)',
        adminUsers: 'GET /api/admin/users — список пользователей (только администратор)',
        receiveOrder: 'POST /api/orders — приёмка заказа в пункт выдачи (только администратор)',
        order: 'GET /api/orders/:id — сведения о заказе',
      },
      pages: {
        home: 'GET / — главная страница приложения',
        templateDemo: 'GET /template-demo — страница проверки шаблона',
      },
      planned: [
        'GET /api/orders/my — список заказов клиента (16-й день)',
        'POST /api/orders/:id/issue — выдача заказа (18-й день)',
      ],
      timestamp: new Date().toISOString(),
    });
  });

  // --- Страницы приложения ---------------------------------------------
  // Разметка формируется на сервере на основе общего шаблона,
  // поэтому сведения о пользователе и его роли подставляются сразу
  app.use('/', pagesRouter);

  // --- Несуществующие разделы API --------------------------------------
  // Обработчик срабатывает для путей /api/*, не перехваченных выше
  app.use('/api', (req, res, next) => {
    next(AppError.notFound(`Раздел API ${req.method} ${req.originalUrl} не существует`));
  });

  // --- Обработка ошибок (всегда последними) ----------------------------
  // Формат ответа для ненайденного адреса зависит от того, кто обратился:
  // браузер получает оформленную страницу (см. routes/pages.js),
  // программа — ответ в формате JSON. Обработчик notFoundHandler
  // отдаёт JSON только клиентам, запросившим его в заголовке Accept.
  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.debug('Приложение Express сконфигурировано');
  return app;
}

module.exports = { createApp };
