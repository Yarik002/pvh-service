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
const confirmationService = require('../services/confirmationService');
const sessionService = require('../services/sessionService');
const { confirmationPage } = require('../views/confirmationPage');
const { requireAuth, optionalAuth } = require('../middleware/authenticate');

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
const CONFIRM_MAX = Number.parseInt(process.env.CONFIRM_LIMIT_MAX || '20', 10);
const LOGIN_MAX = Number.parseInt(process.env.LOGIN_LIMIT_MAX || '10', 10);
const LOGIN_WINDOW_MS = Number.parseInt(process.env.LOGIN_LIMIT_WINDOW_MS || '900000', 10);

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

/** Ограничитель частоты попыток подтверждения (защита от подбора токена). */
const confirmLimiter = rateLimit({
  windowMs: REGISTER_WINDOW_MS,
  max: CONFIRM_MAX,
  message: 'Слишком много попыток подтверждения. Повторите попытку позже.',
});

/** Ограничитель частоты попыток входа (защита от подбора пароля). */
const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_MAX,
  message: 'Слишком много попыток входа. Повторите попытку позже.',
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

      // Сообщение зависит от результата отправки письма.
      // Режим log НЕ считается отправкой: письмо выводится в журнал сервера
      // и до адресата не доходит. Иначе пользователь ждал бы письмо, которого
      // нет, — именно так и выглядит «письмо отправлено», но пустой ящик.
      const reallySent = delivery.status === 'sent';
      const loggedOnly = delivery.status === 'logged';

      const message = reallySent
        ? 'Регистрация выполнена успешно. Проверьте почту и подтвердите адрес электронной почты.'
        : loggedOnly
          ? 'Регистрация выполнена. Отправка писем не настроена: ссылка для подтверждения '
            + 'выведена в журнал сервера.'
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
        // Результат отправки письма с ссылкой подтверждения.
        // Поле sent означает именно доставку на почтовый сервер
        confirmationEmail: {
          sent: reallySent,
          logged: loggedOnly,
          status: delivery.status,
          error: delivery.error,
        },
        nextStep: reallySent
          ? 'Перейдите по ссылке из письма, чтобы активировать учётную запись.'
          : loggedOnly
            ? 'Отправка писем не настроена. Ссылку для подтверждения следует взять '
              + 'из журнала сервера либо настроить параметры SMTP в файле .env.'
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

      // Режим log не считается отправкой: письмо остаётся в журнале сервера
      const reallySent = delivery.status === 'sent';
      const loggedOnly = delivery.status === 'logged';

      res.status(200).json({
        success: true,
        message: reallySent
          ? 'Письмо со ссылкой подтверждения отправлено повторно.'
          : loggedOnly
            ? 'Отправка писем не настроена: ссылка выведена в журнал сервера.'
            : 'Отправить письмо повторно не удалось. Попробуйте позже.',
        user: { id: user.id, email: user.email, isConfirmed: user.isConfirmed },
        confirmationEmail: {
          sent: reallySent,
          logged: loggedOnly,
          status: delivery.status,
          error: delivery.error,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/auth/confirm?token=…
 * Подтверждение адреса электронной почты по ссылке из письма.
 *
 * Пользователь открывает ссылку в браузере, поэтому:
 *   • по умолчанию возвращается HTML-страница с понятным результатом;
 *   • при запросе с заголовком Accept: application/json возвращается JSON —
 *     это удобно для проверок и для клиентской части приложения.
 *
 * Результаты:
 *   200 — адрес подтверждён (или уже был подтверждён ранее);
 *   400 — токен отсутствует или недействителен;
 *   410 — срок действия ссылки истёк.
 */
router.get('/confirm', (req, res, next) => {
  try {
    const result = confirmationService.confirmEmail(req.query.token);
    const wantsJson = req.accepts(['html', 'json']) === 'json';

    // Ошибки отдаются с соответствующим статусом, но всегда с понятным текстом
    const isSuccess = result.status === confirmationService.CONFIRM_STATUS.CONFIRMED
      || result.status === confirmationService.CONFIRM_STATUS.ALREADY_CONFIRMED;

    let statusCode = 200;
    if (!isSuccess) {
      statusCode = result.status === confirmationService.CONFIRM_STATUS.EXPIRED ? 410 : 400;
    }

    if (wantsJson) {
      return res.status(statusCode).json({
        success: isSuccess,
        status: result.status,
        message: result.message,
        user: result.user
          ? {
            id: result.user.id,
            name: result.user.name,
            email: result.user.email,
            isConfirmed: result.user.isConfirmed,
          }
          : null,
      });
    }

    return res.status(statusCode).type('html').send(confirmationPage(result));
  } catch (error) {
    return next(error);
  }
});

/**
 * Соответствие внутренних состояний подтверждения адреса значениям
 * параметра status страницы результата (/confirm).
 */
const CONFIRM_REDIRECT_STATUS = {
  [confirmationService.CONFIRM_STATUS.CONFIRMED]: 'success',
  [confirmationService.CONFIRM_STATUS.ALREADY_CONFIRMED]: 'success',
  [confirmationService.CONFIRM_STATUS.EXPIRED]: 'expired',
  [confirmationService.CONFIRM_STATUS.INVALID_TOKEN]: 'invalid',
  [confirmationService.CONFIRM_STATUS.MISSING_TOKEN]: 'invalid',
};

/**
 * GET /api/auth/confirm/page?token=…
 *
 * Альтернативный адрес подтверждения, который после проверки токена
 * перенаправляет пользователя на страницу результата (/confirm), оформленную
 * в общем шаблоне приложения — с шапкой, меню и подвалом. Применяется, когда
 * письмо содержит ссылку именно на эту страницу.
 */
router.get('/confirm/page', (req, res, next) => {
  try {
    const result = confirmationService.confirmEmail(req.query.token);
    const status = CONFIRM_REDIRECT_STATUS[result.status] || 'invalid';
    const email = result.user?.email || '';

    const query = new URLSearchParams({ status });
    if (email) query.set('email', email);

    return res.redirect(303, `/confirm?${query.toString()}`);
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/auth/confirm
 * Подтверждение адреса электронной почты с передачей токена в теле запроса.
 *
 * Тело: { "token": "…" } либо { "email": "…", "token": "…" }
 * Полезно, когда приложение отправляет подтверждение программно.
 *
 * Ответы: 200 — подтверждено; 400 — токен недействителен; 410 — срок истёк.
 */
router.post('/confirm', confirmLimiter, (req, res, next) => {
  try {
    const result = confirmationService.confirmEmailOrFail(req.body?.token);
    const alreadyConfirmed = result.status === confirmationService.CONFIRM_STATUS.ALREADY_CONFIRMED;

    res.status(200).json({
      success: true,
      status: result.status,
      message: result.message,
      alreadyConfirmed,
      user: result.user
        ? {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
          role: result.user.role,
          isConfirmed: result.user.isConfirmed,
        }
        : null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/confirm/check?token=…
 * Проверка ссылки без подтверждения учётной записи.
 *
 * Позволяет интерфейсу заранее показать пользователю, действительна ли ссылка,
 * и сколько времени осталось до истечения её срока.
 */
router.get('/confirm/check', (req, res, next) => {
  try {
    const result = confirmationService.checkToken(req.query.token);
    const isValid = result.status === 'valid';

    res.status(isValid ? 200 : 400).json({
      success: isValid,
      status: result.status,
      message: result.message,
      timeLeftHours: result.timeLeftHours,
      user: result.user ? { email: result.user.email } : null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/login
 * Вход в систему по адресу электронной почты и паролю.
 *
 * Тело запроса:
 *   { "email": "ivanov@mail.ru", "password": "parol12345" }
 *
 * Ответы:
 *   200 — вход выполнен, выдан токен сессии;
 *   400 — поля заполнены неверно;
 *   401 — неверный адрес электронной почты или пароль;
 *   403 — адрес электронной почты не подтверждён;
 *   429 — превышена частота попыток.
 *
 * Токен возвращается двумя способами: в теле ответа (для программных клиентов)
 * и в cookie HttpOnly (для браузера — недоступна из JavaScript).
 */
router.post(
  '/login',
  loginLimiter,
  async (req, res, next) => {
    try {
      const { user, token, expiresAt } = await authService.login(req.body, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });

      sessionService.setSessionCookie(res, token, expiresAt);

      res.status(200).json({
        success: true,
        message: 'Вход выполнен успешно.',
        token,
        tokenType: 'Bearer',
        expiresAt: expiresAt.toISOString(),
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          isConfirmed: user.isConfirmed,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/auth/logout
 * Выход из системы: текущая сессия завершается.
 *
 * Ответы: 200 — сессия завершена (или уже была завершена).
 */
router.post('/logout', optionalAuth(), (req, res, next) => {
  try {
    // Если сессия не определена, пробуем извлечь токен напрямую
    const token = req.sessionToken || sessionService.extractToken(req);
    const { closed } = authService.logout(token);

    sessionService.clearSessionCookie(res);

    res.status(200).json({
      success: true,
      message: closed ? 'Вы вышли из системы.' : 'Активная сессия не найдена.',
      closed,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/me
 * Данные текущего пользователя по действующей сессии.
 *
 * Ответы: 200 — данные пользователя; 401 — сессия отсутствует или истекла.
 */
router.get('/me', requireAuth(), (req, res, next) => {
  try {
    const user = req.user;

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isConfirmed: user.isConfirmed,
      },
      session: {
        createdAt: req.session.createdAt,
        expiresAt: req.session.expiresAt,
        lastUsedAt: req.session.lastUsedAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
