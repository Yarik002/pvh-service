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

/** Ограничитель частоты запросов регистрации (общий для всех обращений). */
const registerLimiter = rateLimit({
  windowMs: REGISTER_WINDOW_MS,
  max: REGISTER_MAX,
  message: 'Слишком много попыток регистрации. Повторите попытку позже.',
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
      const { user, confirmToken, strength } = await authService.register(req.body);

      logger.debug(`Токен подтверждения для ${user.email}: ${confirmToken}`);

      res.status(201).json({
        success: true,
        message: 'Регистрация выполнена успешно. Подтвердите адрес электронной почты.',
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
        nextStep: 'На адрес электронной почты будет отправлена ссылка для подтверждения аккаунта.',
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
