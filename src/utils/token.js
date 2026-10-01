'use strict';

/**
 * Формирование случайных токенов.
 *
 * Токены используются для подтверждения адреса электронной почты (5–6-й дни)
 * и для сессий авторизации (7-й день).
 *
 * Источник случайности — crypto.randomBytes, то есть криптографически стойкий
 * генератор псевдослучайных чисел. Применять Math.random для токенов нельзя:
 * его последовательность предсказуема.
 */

const crypto = require('crypto');

/**
 * Формирует токен в виде шестнадцатеричной строки.
 * @param {number} [bytes] количество случайных байт (по умолчанию 32)
 * @returns {string} строка длиной bytes * 2 символов
 */
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Формирует токен в безопасном для адресной строки виде (base64url).
 * Применяется для ссылок в письмах: /api/auth/confirm?token=...
 * @param {number} [bytes] количество случайных байт (по умолчанию 32)
 */
function generateUrlSafeToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Сравнивает два токена за постоянное время.
 * @returns {boolean}
 */
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

module.exports = { generateToken, generateUrlSafeToken, tokensEqual };
