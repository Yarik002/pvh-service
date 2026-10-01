'use strict';

/**
 * Маршруты работы с паролями: /api/password
 *
 *   POST /api/password/strength — оценка надёжности пароля (доступна без авторизации);
 *   POST /api/password/change   — смена пароля (будет подключён на 7-м дне,
 *                                 после реализации авторизации и middleware
 *                                 проверки сессии).
 */

const express = require('express');

const { getDb } = require('../db/connection');
const rateLimit = require('../middleware/rateLimit');
const passwordService = require('../services/passwordService');
const { requireAuth } = require('../middleware/authenticate');

const router = express.Router();

/** Ограничение частоты: проверка надёжности не должна использоваться для перебора. */
const strengthLimiter = rateLimit({
  windowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: Number.parseInt(process.env.PASSWORD_CHECK_MAX || '200', 10),
  message: 'Слишком много запросов проверки пароля. Повторите попытку позже.',
});

/**
 * POST /api/password/strength
 * Оценивает надёжность пароля и объясняет, что следует улучшить.
 *
 * Тело запроса:
 *   { "password": "parol12345", "name": "Иванов Иван", "email": "ivanov@mail.ru" }
 * Поля name и email необязательны: они позволяют проверить, не содержит ли
 * пароль личных данных пользователя.
 *
 * Ответ 200:
 *   {
 *     "success": true,
 *     "strength": {
 *       "score": 84, "level": "strong", "label": "Высокая", "color": "#388e3c",
 *       "checks": [ { "id": "length", "title": "...", "passed": true, "advice": "" } ],
 *       "warnings": []
 *     }
 *   }
 *
 * Пароль не сохраняется и не журналируется.
 */
router.post('/strength', strengthLimiter, (req, res, next) => {
  try {
    const { password, name, email } = req.body || {};
    const strength = passwordService.checkStrength(password, { name, email });

    res.status(200).json({
      success: true,
      strength,
      message: `Надёжность пароля: ${strength.label.toLowerCase()} (${strength.score} из 100)`,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/password/change
 * Смена пароля текущим пользователем. Требует действующей сессии.
 *
 * Тело запроса:
 *   {
 *     "currentPassword": "Xk9#mQ2$vL7p",
 *     "newPassword": "Tr9$kLm2#nQ",
 *     "newPasswordConfirm": "Tr9$kLm2#nQ"
 *   }
 *
 * Ответы:
 *   200 — пароль изменён; остальные сессии пользователя завершены;
 *   400 — форма заполнена неверно или новый пароль ненадёжен;
 *   401 — сессия отсутствует/истекла либо неверный текущий пароль;
 *   404 — пользователь не найден.
 *
 * После смены пароля все прочие сессии завершаются: если пароль был изменён
 * из-за подозрения на компрометацию, доступ по старым токенам должен
 * прекратиться. Текущая сессия при этом сохраняется.
 */
router.post('/change', requireAuth(), async (req, res, next) => {
  try {
    const currentSessionId = req.session?.id;

    const { user } = await passwordService.changePassword(req.user.id, req.body || {});

    // Завершаем все сессии пользователя, кроме текущей
    const removed = getDb()
      .prepare('DELETE FROM Sessions WHERE user_id = ? AND id <> ?')
      .run(req.user.id, currentSessionId ?? 0).changes;

    res.status(200).json({
      success: true,
      message: removed > 0
        ? 'Пароль изменён. Остальные сессии завершены.'
        : 'Пароль изменён.',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      otherSessionsClosed: removed,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
