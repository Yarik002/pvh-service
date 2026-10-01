'use strict';

/**
 * Сессии пользователей.
 *
 * После успешного входа клиент получает токен сессии. Токен — случайная строка
 * (32 случайных байта, кодировка base64url); в базе данных хранится только его
 * хеш SHA-256.
 *
 * Сессия выдаётся двумя способами одновременно:
 *   • в теле ответа (поле token) — для программных клиентов и проверок;
 *   • в cookie HttpOnly — для браузера, чтобы клиентский сценарий не имел
 *     доступа к токену (защита от кражи через внедрённый сценарий).
 *
 * Срок действия сессии ограничен (по умолчанию 7 суток) и настраивается
 * параметром SESSION_TTL_HOURS.
 */

const config = require('../config');
const logger = require('../utils/logger');
const { generateUrlSafeToken, tokensEqual } = require('../utils/token');
const { sqliteAfterHours } = require('../utils/datetime');
const sessionRepository = require('../repositories/sessionRepository');

/** Имя cookie, в которой хранится токен сессии. */
const COOKIE_NAME = 'pvh_session';

/** Сколько часов действует сессия. */
function getSessionTtlHours() {
  return config.session.ttlHours;
}

/**
 * Формирует дату окончания сессии в формате, принятом в базе данных
 * («YYYY-MM-DD HH:MM:SS» в UTC).
 */
function buildExpiresAt(hours = getSessionTtlHours()) {
  return sqliteAfterHours(hours);
}

/**
 * Создаёт сессию для пользователя.
 *
 * @param {number} userId идентификатор пользователя
 * @param {{userAgent?: string, ipAddress?: string}} [context] сведения о клиенте
 * @returns {{token: string, session: object, expiresAt: Date}}
 */
function createSession(userId, context = {}) {
  const token = generateUrlSafeToken(32);
  const expiresAtRaw = buildExpiresAt();

  const session = sessionRepository.create({
    userId,
    token,
    expiresAt: expiresAtRaw,
    userAgent: context.userAgent,
    ipAddress: context.ipAddress,
  });

  logger.debug(`Создана сессия id=${session.id} для пользователя id=${userId}`);

  return {
    token,
    session,
    expiresAt: new Date(session.expiresAt),
  };
}

/**
 * Проверяет токен сессии и возвращает связанную запись.
 *
 * @param {string} token
 * @returns {{valid: boolean, session: object|null, reason: string|null}}
 */
function validateSession(token) {
  if (typeof token !== 'string' || token.trim() === '') {
    return { valid: false, session: null, reason: 'MISSING_TOKEN' };
  }

  const session = sessionRepository.findValidByToken(token.trim());
  if (session) {
    sessionRepository.touch(session.id);
    return { valid: true, session, reason: null };
  }

  // Различаем «сессия истекла» и «сессия не существует»
  const expired = sessionRepository.findByToken(token.trim());
  return {
    valid: false,
    session: null,
    reason: expired ? 'SESSION_EXPIRED' : 'SESSION_NOT_FOUND',
  };
}

/**
 * Завершает сессию (выход из системы).
 * @param {string} token
 * @returns {boolean} true, если сессия была найдена и удалена
 */
function destroySession(token) {
  const removed = sessionRepository.removeByToken(token) > 0;
  if (removed) logger.debug('Сессия завершена (выход из системы)');
  return removed;
}

/**
 * Завершает все сессии пользователя (выход на всех устройствах).
 * @param {number} userId
 * @returns {number} число завершённых сессий
 */
function destroyAllSessions(userId) {
  const removed = sessionRepository.removeByUserId(userId);
  logger.info(`Завершены все сессии пользователя id=${userId}: ${removed}`);
  return removed;
}

/** Удаляет истёкшие сессии. */
function cleanupExpired() {
  const removed = sessionRepository.removeExpired();
  if (removed > 0) logger.debug(`Удалено истёкших сессий: ${removed}`);
  return removed;
}

/**
 * Извлекает токен сессии из запроса.
 *
 * Поддерживаются два источника:
 *   1) заголовок Authorization: Bearer <токен> — для программных клиентов;
 *   2) cookie pvh_session — для браузера.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.trim() !== '') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }

  const cookies = req.headers?.cookie;
  if (typeof cookies === 'string' && cookies !== '') {
    for (const part of cookies.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE_NAME) {
        return decodeURIComponent(rest.join('='));
      }
    }
  }

  return null;
}

/**
 * Устанавливает cookie с токеном сессии.
 * @param {import('express').Response} res
 * @param {string} token
 * @param {Date} expiresAt
 */
function setSessionCookie(res, token, expiresAt) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,                                   // недоступна из JavaScript
    sameSite: 'lax',                                  // защита от подделки межсайтовых запросов
    secure: config.isProduction,                      // только по HTTPS в рабочем режиме
    expires: expiresAt,
    path: '/',
  });
}

/** Удаляет cookie с токеном сессии. */
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

module.exports = {
  COOKIE_NAME,
  createSession,
  validateSession,
  destroySession,
  destroyAllSessions,
  cleanupExpired,
  extractToken,
  setSessionCookie,
  clearSessionCookie,
  buildExpiresAt,
  getSessionTtlHours,
  tokensEqual,
};
