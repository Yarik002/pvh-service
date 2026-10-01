'use strict';

/**
 * Разбор и установка cookie.
 *
 * Собственная реализация вместо библиотеки cookie-parser: формат cookie прост,
 * а зависимостей в проекте становится меньше. Используется для хранения токена
 * сессии в браузере.
 */

/**
 * Разбирает заголовок Cookie в объект.
 * @param {string} header
 * @returns {Record<string, string>}
 */
function parseCookies(header) {
  const result = {};

  if (typeof header !== 'string' || header.trim() === '') return result;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    if (name === '') continue;

    const value = part.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      // Некорректная последовательность кодирования — используем значение как есть
      result[name] = value;
    }
  }

  return result;
}

/**
 * Формирует значение заголовка Set-Cookie.
 *
 * @param {string} name имя cookie
 * @param {string} value значение
 * @param {{maxAge?: number, expires?: Date, path?: string, httpOnly?: boolean,
 *          secure?: boolean, sameSite?: string}} [options]
 * @returns {string}
 */
function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  return parts.join('; ');
}

/**
 * Middleware: добавляет в запрос разобранные cookie и метод для их установки.
 *
 * req.cookies         — объект с полученными cookie;
 * res.setCookie(...)  — установка cookie;
 * res.removeCookie()  — удаление cookie.
 */
function cookieParser() {
  return function cookies(req, res, next) {
    req.cookies = parseCookies(req.headers.cookie);

    res.setCookie = (name, value, options = {}) => {
      const existing = res.getHeader('Set-Cookie');
      const header = serializeCookie(name, value, options);
      res.setHeader('Set-Cookie', existing ? [].concat(existing, header) : header);
      return res;
    };

    res.removeCookie = (name, options = {}) => res.setCookie(name, '', {
      ...options,
      expires: new Date(0),
      maxAge: 0,
    });

    next();
  };
}

module.exports = { cookieParser, parseCookies, serializeCookie };
