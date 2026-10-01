'use strict';

/**
 * Обработчики ошибок и «не найдено».
 *
 * Задача — привести все ошибки к единому формату JSON, чтобы клиентская
 * часть (11–22-й дни) могла показать пользователю понятное уведомление:
 *
 *   {
 *     "success": false,
 *     "error": { "code": "BAD_REQUEST", "message": "…", "details": … }
 *   }
 */

const config = require('../config');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

/** Middleware для несуществующих маршрутов — 404. */
function notFoundHandler(req, res, next) {
  next(AppError.notFound(`Маршрут ${req.method} ${req.originalUrl} не существует`));
}

/**
 * Централизованный обработчик ошибок Express.
 * Обязательно должен объявляться последним и иметь четыре аргумента.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isOperational = err instanceof AppError || err.isOperational === true;
  const status = isOperational ? err.status : 500;
  const code = isOperational ? err.code : 'INTERNAL_ERROR';

  if (status >= 500) {
    logger.error(`[${req.method} ${req.originalUrl}]`, err);
  } else {
    logger.warn(`[${req.method} ${req.originalUrl}] ${code}: ${err.message}`);
  }

  const body = {
    success: false,
    error: {
      code,
      message: isOperational ? err.message : 'Внутренняя ошибка сервера',
    },
  };

  // Дополнительные сведения (ошибки валидации полей и т. п.)
  if (err.details !== undefined) body.error.details = err.details;

  // Трассировка стека отдаётся только в режиме разработки
  if (!config.isProduction && !isOperational) body.error.stack = err.stack;

  // Ошибка «страница не найдена» отдаётся браузеру оформленной страницей,
  // а программам (и всем обращениям к API) — в формате JSON.
  // Формат определяется заголовком Accept: браузер запрашивает text/html.
  const wantsHtml = status === 404
    && !req.originalUrl.startsWith('/api')
    && req.accepts(['html', 'json']) === 'html';

  if (wantsHtml) {
    // Модуль разметки подключается здесь, а не в начале файла: он, в свою
    // очередь, обращается к настройкам приложения, и порядок загрузки
    // модулей должен оставаться предсказуемым
    const { renderPage } = require('../views/layout');
    const { renderNotFoundContent } = require('../views/authPages');

    const html = renderPage({
      title: 'Страница не найдена',
      path: req.path,
      content: renderNotFoundContent({ path: req.path }),
    });

    res.status(status).type('html').send(html);
    return;
  }

  res.status(status).json(body);
}

module.exports = { notFoundHandler, errorHandler };
