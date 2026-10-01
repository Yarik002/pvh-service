'use strict';

/**
 * Middleware логирования HTTP-запросов.
 *
 * Собственная реализация вместо библиотеки morgan: вывод согласован
 * с общим логгером приложения, зависимостей становится меньше.
 * Время обработки запроса выводится в миллисекундах.
 */

const logger = require('../utils/logger');

/**
 * @param {{ logLevel?: 'info'|'debug', ignore?: string[] }} [options]
 *   logLevel — уровень логирования для успешных запросов (ошибки 4xx/5xx всегда уровень warn);
 *   ignore   — список путей, которые не нужно логировать (например, /favicon.ico).
 */
function requestLogger(options = {}) {
  const { logLevel = 'info', ignore = [] } = options;

  return function logRequest(req, res, next) {
    if (ignore.some((prefix) => req.originalUrl.startsWith(prefix))) return next();

    const startedAt = process.hrtime.bigint();

    // Событие 'finish' наступает после отправки ответа клиенту
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const message = `${req.method} ${req.originalUrl} → ${res.statusCode} (${durationMs.toFixed(1)} мс)`;

      if (res.statusCode >= 400) {
        logger.warn(message);
      } else {
        logger[logLevel](message);
      }
    });

    next();
  };
}

module.exports = requestLogger;
