'use strict';

/**
 * Middleware проверки сессии и прав доступа.
 *
 * requireAuth   — пропускает только запросы с действующей сессией;
 * requireRole   — пропускает только пользователей с указанными ролями;
 * optionalAuth  — заполняет req.user, если сессия есть, но не требует её.
 *
 * Токен сессии извлекается из заголовка Authorization (Bearer) либо из cookie
 * pvh_session — см. sessionService.extractToken().
 */

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const sessionService = require('../services/sessionService');
const userRepository = require('../repositories/userRepository');

/** Понятные сообщения для разных причин отказа. */
const FAILURE_MESSAGES = {
  MISSING_TOKEN: 'Требуется авторизация: укажите токен сессии',
  SESSION_NOT_FOUND: 'Сессия не найдена или завершена. Войдите в систему заново.',
  SESSION_EXPIRED: 'Срок действия сессии истёк. Войдите в систему заново.',
};

/**
 * Определяет пользователя по токену сессии.
 *
 * @param {import('express').Request} req
 * @returns {{user: object|null, session: object|null, reason: string|null, token: string|null}}
 */
function resolveUser(req) {
  const token = sessionService.extractToken(req);
  const { valid, session, reason } = sessionService.validateSession(token);

  if (!valid) return { user: null, session: null, reason, token };

  const user = userRepository.findById(session.userId);
  if (!user) {
    // Пользователь удалён, а сессия осталась — считаем сессию недействительной
    sessionService.destroySession(token);
    return { user: null, session: null, reason: 'SESSION_NOT_FOUND', token };
  }

  return { user, session, reason: null, token };
}

/**
 * Требует действующую сессию.
 *
 * При успехе в запрос добавляются:
 *   req.user        — запись пользователя;
 *   req.session     — запись сессии;
 *   req.sessionToken — токен сессии.
 *
 * @returns {import('express').RequestHandler}
 */
function requireAuth() {
  return function authenticate(req, res, next) {
    const { user, session, reason, token } = resolveUser(req);

    if (!user) {
      const message = FAILURE_MESSAGES[reason] || 'Требуется авторизация';
      logger.warn(`Отказ в доступе к ${req.method} ${req.originalUrl}: ${reason}`);
      return next(new AppError(message, 401, reason || 'UNAUTHORIZED'));
    }

    req.user = user;
    req.session = session;
    req.sessionToken = token;
    return next();
  };
}

/**
 * Заполняет req.user, если сессия действительна, но не требует её.
 * @returns {import('express').RequestHandler}
 */
function optionalAuth() {
  return function attachUser(req, res, next) {
    const { user, session, token } = resolveUser(req);
    if (user) {
      req.user = user;
      req.session = session;
      req.sessionToken = token;
    }
    return next();
  };
}

/**
 * Требует одну из указанных ролей. Применяется после requireAuth().
 *
 * @param {...string} roles допустимые роли (например, 'admin')
 * @returns {import('express').RequestHandler}
 */
function requireRole(...roles) {
  const allowed = roles.flat().map((role) => String(role).toLowerCase());

  return function authorize(req, res, next) {
    if (!req.user) {
      // middleware вызван без предварительной проверки сессии — это ошибка настройки
      logger.error(`requireRole вызван без requireAuth для ${req.method} ${req.originalUrl}`);
      return next(new AppError('Требуется авторизация', 401, 'UNAUTHORIZED'));
    }

    const userRole = String(req.user.role || '').toLowerCase();

    if (!allowed.includes(userRole)) {
      logger.warn(
        `Отказ в доступе: пользователь id=${req.user.id} (роль ${userRole}) `
        + `обратился к ${req.method} ${req.originalUrl} (требуется: ${allowed.join('/')})`,
      );
      return next(new AppError(
        'Недостаточно прав для выполнения операции',
        403,
        'FORBIDDEN',
      ));
    }

    return next();
  };
}

/**
 * Готовые сочетания middleware для типовых случаев.
 * Администратор имеет доступ и к маршрутам клиента.
 */
const admin = [requireAuth(), requireRole('admin')];
const client = [requireAuth(), requireRole('client', 'admin')];
const anyUser = [requireAuth()];

module.exports = { requireAuth, requireRole, optionalAuth, resolveUser, admin, client, anyUser };
