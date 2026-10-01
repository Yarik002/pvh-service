'use strict';

/**
 * Подтверждение адреса электронной почты.
 *
 * Пользователь получает письмо со ссылкой вида
 *   {APP_BASE_URL}/api/auth/confirm?token=<токен>
 * Переход по ссылке подтверждает учётную запись.
 *
 * Алгоритм подтверждения:
 *   1) проверить, что токен передан;
 *   2) найти пользователя по токену;
 *   3) если учётная запись уже подтверждена — сообщить об этом;
 *   4) проверить срок действия токена (по умолчанию 24 ч);
 *   5) установить признак подтверждения и удалить использованный токен.
 *
 * Токен одноразовый: после успешного подтверждения он очищается, поэтому
 * повторное использование ссылки невозможно.
 */

const config = require('../config');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const userRepository = require('../repositories/userRepository');

/** Возможные результаты подтверждения (используются интерфейсом и проверками). */
const CONFIRM_STATUS = {
  CONFIRMED: 'confirmed',           // учётная запись подтверждена
  ALREADY_CONFIRMED: 'already',     // адрес уже был подтверждён ранее
  INVALID_TOKEN: 'invalid',         // токен не найден
  EXPIRED: 'expired',               // срок действия токена истёк
  MISSING_TOKEN: 'missing',         // токен не передан
};

/** Понятные сообщения для каждой ситуации. */
const MESSAGES = {
  [CONFIRM_STATUS.CONFIRMED]: 'Адрес электронной почты подтверждён. Учётная запись активирована.',
  [CONFIRM_STATUS.ALREADY_CONFIRMED]: 'Адрес электронной почты уже был подтверждён ранее.',
  [CONFIRM_STATUS.INVALID_TOKEN]: 'Ссылка недействительна. Возможно, она была использована ранее '
    + 'или скопирована не полностью.',
  [CONFIRM_STATUS.EXPIRED]: `Срок действия ссылки истёк (${config.mail.confirmTokenTtlHours} ч). `
    + 'Запросите новое письмо с подтверждением.',
  [CONFIRM_STATUS.MISSING_TOKEN]: 'В ссылке отсутствует токен подтверждения.',
};

/** Коды ошибок для ответов API. */
const ERROR_CODES = {
  [CONFIRM_STATUS.INVALID_TOKEN]: 'INVALID_CONFIRM_TOKEN',
  [CONFIRM_STATUS.EXPIRED]: 'CONFIRM_TOKEN_EXPIRED',
  [CONFIRM_STATUS.MISSING_TOKEN]: 'MISSING_CONFIRM_TOKEN',
};

/** Сколько часов действует ссылка подтверждения. */
function getTokenTtlHours() {
  return config.mail.confirmTokenTtlHours;
}

/**
 * Проверяет, истёк ли срок действия токена.
 *
 * Токен, у которого не заполнена дата формирования (записи, созданные
 * до появления поля), считается действующим: иначе пользователи, зарегистрированные
 * ранее, не смогли бы подтвердить адрес.
 *
 * @param {Date|null} createdAt дата формирования токена
 * @returns {boolean}
 */
function isTokenExpired(createdAt) {
  if (!createdAt) return false;
  if (Number.isNaN(createdAt.getTime())) return false;

  const ttlMs = getTokenTtlHours() * 60 * 60 * 1000;
  return Date.now() - createdAt.getTime() > ttlMs;
}

/** Сколько времени осталось до истечения ссылки (в часах). */
function getTokenTimeLeftHours(createdAt) {
  if (!createdAt) return null;
  const ttlMs = getTokenTtlHours() * 60 * 60 * 1000;
  const leftMs = ttlMs - (Date.now() - createdAt.getTime());
  return leftMs > 0 ? Math.round((leftMs / (60 * 60 * 1000)) * 10) / 10 : 0;
}

/**
 * Выполняет подтверждение адреса электронной почты по токену.
 *
 * Функция не выбрасывает исключений для ожидаемых ситуаций (неверный токен,
 * истёкший срок): она возвращает результат с описанием. Это позволяет
 * показать пользователю понятную страницу вместо технической ошибки.
 *
 * @param {string} token токен из ссылки в письме
 * @returns {{status: string, message: string, user: object|null}}
 */
function confirmEmail(token) {
  if (typeof token !== 'string' || token.trim() === '') {
    logger.warn('Попытка подтверждения без токена');
    return { status: CONFIRM_STATUS.MISSING_TOKEN, message: MESSAGES[CONFIRM_STATUS.MISSING_TOKEN], user: null };
  }

  const user = userRepository.findByConfirmToken(token.trim());

  if (!user) {
    logger.warn('Попытка подтверждения с недействительным токеном');
    return { status: CONFIRM_STATUS.INVALID_TOKEN, message: MESSAGES[CONFIRM_STATUS.INVALID_TOKEN], user: null };
  }

  // Адрес уже подтверждён (например, пользователь перешёл по старой ссылке)
  if (user.isConfirmed) {
    return {
      status: CONFIRM_STATUS.ALREADY_CONFIRMED,
      message: MESSAGES[CONFIRM_STATUS.ALREADY_CONFIRMED],
      user,
    };
  }

  // Проверка срока действия ссылки
  if (isTokenExpired(user.confirmTokenCreatedAt)) {
    logger.warn(`Ссылка подтверждения для ${user.email} просрочена`);
    return { status: CONFIRM_STATUS.EXPIRED, message: MESSAGES[CONFIRM_STATUS.EXPIRED], user };
  }

  const confirmed = userRepository.confirm(user.id);

  logger.info(`Адрес электронной почты подтверждён: id=${user.id} (${user.email})`);

  return {
    status: CONFIRM_STATUS.CONFIRMED,
    message: MESSAGES[CONFIRM_STATUS.CONFIRMED],
    user: userRepository.toPublic(confirmed),
  };
}

/**
 * Проверяет токен без подтверждения учётной записи.
 * Используется, чтобы показать пользователю причину отказа до нажатия кнопки.
 *
 * @param {string} token
 * @returns {{status: string, message: string, user: object|null, timeLeftHours: number|null}}
 */
function checkToken(token) {
  if (typeof token !== 'string' || token.trim() === '') {
    return {
      status: CONFIRM_STATUS.MISSING_TOKEN,
      message: MESSAGES[CONFIRM_STATUS.MISSING_TOKEN],
      user: null,
      timeLeftHours: null,
    };
  }

  const user = userRepository.findByConfirmToken(token.trim());

  if (!user) {
    return {
      status: CONFIRM_STATUS.INVALID_TOKEN,
      message: MESSAGES[CONFIRM_STATUS.INVALID_TOKEN],
      user: null,
      timeLeftHours: null,
    };
  }

  if (user.isConfirmed) {
    return {
      status: CONFIRM_STATUS.ALREADY_CONFIRMED,
      message: MESSAGES[CONFIRM_STATUS.ALREADY_CONFIRMED],
      user,
      timeLeftHours: null,
    };
  }

  if (isTokenExpired(user.confirmTokenCreatedAt)) {
    return {
      status: CONFIRM_STATUS.EXPIRED,
      message: MESSAGES[CONFIRM_STATUS.EXPIRED],
      user,
      timeLeftHours: 0,
    };
  }

  return {
    status: 'valid',
    message: `Ссылка действительна. Осталось времени: ${getTokenTimeLeftHours(user.confirmTokenCreatedAt)} ч.`,
    user,
    timeLeftHours: getTokenTimeLeftHours(user.confirmTokenCreatedAt),
  };
}

/**
 * Выполняет подтверждение и, если оно невозможно, формирует прикладную ошибку.
 * Используется в JSON-ответах API.
 *
 * @param {string} token
 * @returns {object} подтверждённая учётная запись
 * @throws {AppError} 400 — токен отсутствует или недействителен; 410 — срок истёк
 */
function confirmEmailOrFail(token) {
  const result = confirmEmail(token);

  if (result.status === CONFIRM_STATUS.CONFIRMED || result.status === CONFIRM_STATUS.ALREADY_CONFIRMED) {
    return result;
  }

  if (result.status === CONFIRM_STATUS.EXPIRED) {
    throw new AppError(result.message, 410, ERROR_CODES[result.status]);
  }

  throw new AppError(result.message, 400, ERROR_CODES[result.status] || 'CONFIRM_FAILED');
}

module.exports = {
  confirmEmail,
  confirmEmailOrFail,
  checkToken,
  isTokenExpired,
  getTokenTimeLeftHours,
  getTokenTtlHours,
  CONFIRM_STATUS,
  MESSAGES,
};
