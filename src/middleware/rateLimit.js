'use strict';

/**
 * Ограничение частоты запросов (защита от перебора).
 *
 * Простейший счётчик в памяти процесса: для каждого IP-адреса хранится список
 * отметок времени обращений. Если число обращений за указанный интервал
 * превышает предел, возвращается ошибка 429.
 *
 * Для учебного проекта этого достаточно: решение не требует сторонних библиотек
 * и внешнего хранилища. При развёртывании на нескольких серверах потребовалось бы
 * общее хранилище (например, Redis) — это отмечено в документации.
 */

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

/**
 * Создаёт middleware ограничения частоты запросов.
 *
 * @param {{windowMs?: number, max?: number, message?: string}} [options]
 *   windowMs — длительность окна в миллисекундах (по умолчанию 15 минут);
 *   max      — предельное число запросов за окно (по умолчанию 10).
 * @returns {import('express').RequestHandler}
 */
function rateLimit({ windowMs = 15 * 60 * 1000, max = 10, message } = {}) {
  /** @type {Map<string, number[]>} отметки времени обращений по IP-адресам */
  const hits = new Map();

  // Периодическая очистка устаревших записей, чтобы память не росла
  const cleanup = setInterval(() => {
    const threshold = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const fresh = times.filter((t) => t > threshold);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }, windowMs);
  cleanup.unref();

  return function rateLimiter(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const threshold = now - windowMs;
    const times = (hits.get(key) || []).filter((t) => t > threshold);

    if (times.length >= max) {
      const retryAfterSec = Math.ceil((times[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      logger.warn(`Превышен предел запросов с адреса ${key}: ${times.length} за ${windowMs / 1000} с`);
      return next(AppError.tooManyRequests(
        message || 'Слишком много запросов. Повторите попытку через некоторое время.',
      ));
    }

    times.push(now);
    hits.set(key, times);

    // Информационные заголовки о состоянии предела
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - times.length)));

    return next();
  };
}

module.exports = rateLimit;
