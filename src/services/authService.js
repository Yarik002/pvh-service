'use strict';

/**
 * Регистрация пользователей.
 *
 * Порядок работы (требование ТЗ, п. 3.6 — алгоритм валидации формы регистрации):
 *   1) проверить обязательные поля, формат Email и совпадение пароля с повтором
 *      (схема registerSchema);
 *   2) проверить, что адрес электронной почты ещё не зарегистрирован;
 *   3) сформировать хеш пароля (пароль в открытом виде не сохраняется);
 *   4) сохранить пользователя со статусом «не подтверждён» и токеном
 *      для письма-подтверждения;
 *   5) вернуть данные созданной записи без служебных полей.
 *
 * Отправка письма с токеном будет добавлена на 5-м дне: сейчас токен только
 * формируется и сохраняется в базе данных.
 */

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { hashPassword } = require('../utils/password');
const { analyzePassword, findWeaknessReason } = require('../utils/passwordStrength');
const { generateUrlSafeToken } = require('../utils/token');
const { validate } = require('../validators/rules');
const { registerSchema } = require('../validators/schemas');
const userRepository = require('../repositories/userRepository');
const mailer = require('../mail/mailer');

/**
 * Проверяет, что пароль не содержит личных данных пользователя.
 *
 * Выполняется после проверки полей формы, так как требует одновременно
 * готовых значений имени и адреса электронной почты.
 *
 * @param {string} password проверяемый пароль
 * @param {{name: string, email: string}} user данные пользователя
 * @throws {AppError} 400, если пароль содержит имя, фамилию или адрес почты
 */
function assertNoPersonalData(password, user) {
  const reason = findWeaknessReason(password, user);
  if (reason) {
    throw AppError.badRequest(reason.message, {
      password: { code: reason.code, message: reason.message },
    });
  }
}

/**
 * Регистрирует нового пользователя.
 *
 * @param {object} payload данные формы регистрации
 * @param {string} payload.name            имя пользователя
 * @param {string} payload.email           адрес электронной почты
 * @param {string} payload.password        пароль
 * @param {string} payload.passwordConfirm повтор пароля
 * @returns {Promise<{user: object, confirmToken: string, strength: object}>}
 * @throws {AppError} 400 — данные не прошли проверку; 409 — Email уже занят
 */
async function register(payload) {
  // Шаг 1. Проверка полей формы
  const data = validate(payload, registerSchema);

  // Шаг 1.1. Проверка, что пароль не содержит личных данных пользователя
  assertNoPersonalData(data.password, { name: data.name, email: data.email });

  // Шаг 2. Проверка уникальности адреса электронной почты
  if (userRepository.findByEmail(data.email)) {
    throw AppError.conflict(
      'Пользователь с таким адресом электронной почты уже зарегистрирован',
      { email: { code: 'ALREADY_EXISTS', message: 'Этот адрес электронной почты уже используется' } },
    );
  }

  // Шаг 3. Формирование хеша пароля
  const passwordHash = await hashPassword(data.password);

  // Шаг 4. Сохранение пользователя
  const confirmToken = generateUrlSafeToken(32);
  const user = userRepository.create({
    name: data.name,
    email: data.email,
    passwordHash,
    role: 'client',
    isConfirmed: false,
    confirmToken,
  });

  // Оценка надёжности принятого пароля — возвращается клиенту как рекомендация
  const strength = analyzePassword(data.password, { name: data.name, email: data.email });

  logger.info(
    `Зарегистрирован пользователь id=${user.id} (${user.email}), `
    + `ожидает подтверждения Email; надёжность пароля: ${strength.label} (${strength.score}/100)`,
  );

  // Шаг 5. Отправка письма со ссылкой подтверждения.
  // Ошибка отправки не отменяет регистрацию: учётная запись уже создана,
  // а повторная регистрация на тот же адрес запрещена. Пользователь получит
  // уведомление о неудаче и сможет запросить письмо повторно.
  const delivery = await mailer.sendConfirmationEmail({
    name: user.name,
    email: user.email,
    token: confirmToken,
  });

  // Шаг 6. Хеш пароля и токен не покидают сервер
  return {
    user: userRepository.toPublic(user),
    confirmToken,
    strength,
    delivery: {
      status: delivery.status,
      error: delivery.error,
    },
  };
}

/**
 * Повторно отправляет письмо с ссылкой подтверждения адреса электронной почты.
 *
 * Используется, когда первое письмо не дошло: регистрация уже выполнена,
 * повторно зарегистрироваться на тот же адрес нельзя, поэтому письмо
 * необходимо отправить ещё раз.
 *
 * @param {string} email адрес электронной почты
 * @returns {Promise<{user: object, delivery: object}>}
 * @throws {AppError} 400 — адрес не указан; 404 — пользователь не найден;
 *                    409 — учётная запись уже подтверждена
 */
async function resendConfirmation(email) {
  if (typeof email !== 'string' || email.trim() === '') {
    throw AppError.badRequest('Укажите адрес электронной почты', {
      email: { code: 'REQUIRED', message: 'Адрес электронной почты обязателен для заполнения' },
    });
  }

  const user = userRepository.findByEmail(email);
  if (!user) {
    throw AppError.notFound('Пользователь с таким адресом электронной почты не найден');
  }
  if (user.isConfirmed) {
    throw AppError.conflict('Учётная запись уже подтверждена', {
      email: { code: 'ALREADY_CONFIRMED', message: 'Адрес электронной почты уже подтверждён' },
    });
  }

  // Формируем новый токен: срок действия предыдущего мог истечь
  const confirmToken = generateUrlSafeToken(32);
  userRepository.updateConfirmToken(user.id, confirmToken);

  logger.info(`Повторная отправка письма подтверждения для ${user.email}`);

  const delivery = await mailer.sendConfirmationEmail({
    name: user.name,
    email: user.email,
    token: confirmToken,
  });

  return {
    user: userRepository.toPublic({ ...user, confirmToken }),
    delivery: { status: delivery.status, error: delivery.error },
  };
}

module.exports = { register, resendConfirmation };
