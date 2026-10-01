'use strict';

/**
 * Работа с паролями пользователей.
 *
 * Для хеширования используется функция scrypt из встроенного модуля node:crypto:
 *   • scrypt — криптографически стойкая функция формирования ключа,
 *     устойчивая к подбору на графических процессорах (в отличие от MD5/SHA);
 *   • соль генерируется случайно для каждого пароля, поэтому одинаковые пароли
 *     дают разные хеши (защита от радужных таблиц);
 *   • параметры N, r, p подобраны так, чтобы вычисление занимало заметное время
 *     (затрудняет перебор), но не замедляло работу сервера.
 *
 * Формат сохранённого значения (одна строка в поле Users.password_hash):
 *     scrypt$N$r$p$<соль в hex>$<хеш в hex>
 * Параметры хранятся вместе с хешем, что позволяет в дальнейшем их изменить,
 * не теряя способность проверять старые пароли.
 *
 * Сторонние библиотеки (bcrypt, argon2) не используются: они требуют компиляции
 * нативных модулей, что усложнило бы развёртывание проекта.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

/** Параметры функции формирования ключа. */
const PARAMS = {
  N: 16384,      // стоимость вычисления (2^14)
  r: 8,          // размер блока
  p: 1,          // коэффициент параллелизма
  keyLength: 64, // длина производного ключа в байтах
  saltLength: 16,
};

/** Префикс формата — позволяет отличать алгоритм и проверять корректность записи. */
const ALGORITHM = 'scrypt';

/**
 * Формирует хеш пароля.
 * @param {string} password пароль в открытом виде
 * @returns {Promise<string>} строка вида scrypt$N$r$p$соль$хеш
 */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Пароль должен быть непустой строкой');
  }

  const salt = crypto.randomBytes(PARAMS.saltLength);
  const derived = await scrypt(password, salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    // Ограничение памяти: 128 * N * r байт с небольшим запасом
    maxmem: 256 * PARAMS.N * PARAMS.r,
  });

  return [
    ALGORITHM,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/**
 * Проверяет пароль по сохранённому хешу.
 *
 * Сравнение выполняется функцией timingSafeEqual, чтобы время сравнения
 * не зависело от количества совпавших байт (защита от атак по времени).
 *
 * @param {string} password пароль в открытом виде
 * @param {string} stored   значение из поля Users.password_hash
 * @returns {Promise<boolean>} true, если пароль верен
 */
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;

  const [, n, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');

  try {
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * Number(n) * Number(r),
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    // Повреждённая или несовместимая запись хеша — пароль считать неверным
    return false;
  }
}

/** Проверяет, что строка является корректной записью хеша пароля. */
function isPasswordHash(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('$');
  return parts.length === 6 && parts[0] === ALGORITHM;
}

module.exports = { hashPassword, verifyPassword, isPasswordHash, PARAMS };
