'use strict';

/**
 * Маршруты аутентификации: /api/auth
 *
 * Реализовано на текущий момент:
 *   POST /api/auth/register — регистрация нового пользователя.
 *
 * Будет добавлено на следующих днях:
 *   GET  /api/auth/confirm  — подтверждение адреса электронной почты по токену (6-й день);
 *   POST /api/auth/login    — вход в систему (7-й день);
 *   POST /api/auth/logout   — выход из системы (7-й день);
 *   GET  /api/auth/me       — данные текущего пользователя (7-й день).
 */

const express = require('express');

const logger = require('../utils/logger');
const rateLimit = require('../middleware/rateLimit');
const authService = require('../services/authService');

const router = express.Router();

/**
 * Пределы частоты запросов для маршрутов аутентификации.
 *
 * Значения можно изменить через переменные окружения, что используется
 * сценарием автоматической проверки: ему требуется выполнить больше запросов,
 * чем разрешено обычному пользователю.
 */
const REGISTER_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10); // 15 мин
const REGISTER_MAX = Number.parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const RESEND_MAX = Number.parseInt(process.env.RESEND_LIMIT_MAX || '5', 10);

/** Ограничитель частоты запросов регистрации (общий для всех обращений). */
const registerLimiter = rateLimit({
  windowMs: REGISTER_WINDOW_MS,
  max: REGISTER_MAX,
  message: 'Слишком много попыток регистрации. Повторите попытку позже.',
});

/** Ограничитель частоты повторных отправок письма. */
const resendLimiter = rateLimit({
  windowMs: REGISTER_WINDOW_MS,
  max: RESEND_MAX,
  message: 'Слишком много запросов повторной отправки письма. Повторите попытку позже.',
});

/**
 * POST /api/auth/register
 * Регистрация нового пользователя (роль client, статус «не подтверждён»).
 *
 * Тело запроса (JSON):
 *   {
 *     "name": "Иванов Иван",
 *     "email": "ivanov@mail.ru",
 *     "password": "parol123",
 *     "passwordConfirm": "parol123"
 *   }
 *
 * Ответы:
 *   201 — пользователь создан;
 *   400 — поля заполнены неверно (details содержит ошибки по каждому полю);
 *   409 — адрес электронной почты уже зарегистрирован;
 *   429 — превышена частота запросов.
 */
router.post(
  '/register',
  registerLimiter,
  async (req, res, next) => {
    try {
      const { user, confirmToken, strength, delivery } = await authService.register(req.body);

      logger.debug(`Токен подтверждения для ${user.email}: ${confirmToken}`);

      // Сообщение зависит от результата отправки письма
      const emailSent = delivery.status === 'sent' || delivery.status === 'logged';
      const message = emailSent
        ? 'Регистрация выполнена успешно. Проверьте почту и подтвердите адрес электронной почты.'
        : 'Регистрация выполнена, но письмо с подтверждением отправить не удалось. '
          + 'Запросите письмо повторно.';

      res.status(201).json({
        success: true,
        message,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          isConfirmed: user.isConfirmed,
        },
        // Оценка надёжности принятого пароля — рекомендация пользователю
        passwordStrength: {
          score: strength.score,
          level: strength.level,
          label: strength.label,
        },
        // Результат отправки письма с ссылкой подтверждения
        confirmationEmail: {
          sent: emailSent,
          status: delivery.status,
          error: delivery.error,
        },
        nextStep: emailSent
          ? 'Перейдите по ссылке из письма, чтобы активировать учётную запись.'
          : 'Используйте повторную отправку письма: POST /api/auth/resend-confirmation.',
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/auth/resend-confirmation
 * Повторная отправка письма со ссылкой подтверждения.
 *
 * Тело запроса: { "email": "ivanov@mail.ru" }
 *
 * Ответы:
 *   200 — письмо отправлено повторно;
 *   400 — адрес не указан;
 *   404 — пользователь не найден;
 *   409 — учётная запись уже подтверждена;
 *   429 — превышена частота запросов.
 */
router.post(
  '/resend-confirmation',
  resendLimiter,
  async (req, res, next) => {
    try {
      const { user, delivery } = await authService.resendConfirmation(req.body?.email);

      const emailSent = delivery.status === 'sent' || delivery.status === 'logged';

      res.status(200).json({
        success: true,
        message: emailSent
          ? 'Письмо со ссылкой подтверждения отправлено повторно.'
          : 'Отправить письмо повторно не удалось. Попробуйте позже.',
        user: { id: user.id, email: user.email, isConfirmed: user.isConfirmed },
        confirmationEmail: { sent: emailSent, status: delivery.status, error: delivery.error },
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
