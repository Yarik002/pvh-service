'use strict';

/**
 * Правила проверки (валидации) значений, вводимых пользователем.
 *
 * Каждое правило — функция вида (value, allValues) => результат, где результат:
 *   { ok: true, value }                  — значение корректно (value — приведённое значение);
 *   { ok: false, message, code }         — описание ошибки на русском языке.
 *
 * Второй аргумент allValues позволяет правилу обращаться к другим полям формы
 * (например, для проверки совпадения пароля и его повтора).
 *
 * Правила объединяются в схемы (src/validators/schemas.js) и применяются единой
 * функцией validate(). Сторонние библиотеки не используются: код полностью
 * прозрачен, а сообщения об ошибках формируются на русском языке и выводятся
 * рядом с соответствующим полем ввода (требование ТЗ, п. 3.5).
 */

const AppError = require('../utils/AppError');

/** Успешный результат проверки. */
const ok = (value) => ({ ok: true, value });

/** Неуспешный результат проверки. */
const fail = (message, code = 'INVALID') => ({ ok: false, message, code });

/**
 * Проверка обязательности заполнения и удаление крайних пробелов.
 * @param {string} [label] название поля для сообщения об ошибке
 */
function required(label = 'Поле') {
  return (value) => {
    if (value === undefined || value === null || String(value).trim() === '') {
      return fail(`${label} обязательно для заполнения`, 'REQUIRED');
    }
    return ok(String(value).trim());
  };
}

/**
 * Проверка длины строки в символах.
 * @param {{min?: number, max?: number, label?: string}} options
 */
function length({ min, max, label = 'Значение' } = {}) {
  return (value) => {
    const text = String(value);
    const count = [...text].length; // учитываются составные символы
    if (min !== undefined && count < min) {
      return fail(`${label} должно содержать не менее ${min} символов`, 'TOO_SHORT');
    }
    if (max !== undefined && count > max) {
      return fail(`${label} должно содержать не более ${max} символов`, 'TOO_LONG');
    }
    return ok(text);
  };
}

/**
 * Проверка формата адреса электронной почты регулярным выражением
 * (требование ТЗ, п. 3.6) с приведением к нижнему регистру.
 */
function emailPattern() {
  // Локальная часть: буквы, цифры и знаки ! # $ % & ' * + / = ? ^ _ ` { | } ~ - .
  // Точка не может быть первой, последней и не может удваиваться.
  const LOCAL = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
  // Домен: метки, разделённые точками; зона — только буквы (не менее двух)
  const DOMAIN = '(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}';
  const pattern = new RegExp(`^${LOCAL}@${DOMAIN}$`);

  return (value) => {
    const text = String(value).trim();
    if (text.length > 254) {
      return fail('Адрес электронной почты слишком длинный (не более 254 символов)', 'TOO_LONG');
    }
    if (!pattern.test(text)) {
      return fail('Укажите корректный адрес электронной почты, например ivanov@mail.ru', 'BAD_FORMAT');
    }
    // Адреса электронной почты нечувствительны к регистру
    return ok(text.toLowerCase());
  };
}

/**
 * Проверка сложности пароля: не менее 8 символов, хотя бы одна буква и одна цифра.
 */
function passwordStrength() {
  return (value) => {
    const text = String(value);
    if (text.length < 8) {
      return fail('Пароль должен содержать не менее 8 символов', 'TOO_SHORT');
    }
    if (text.length > 128) {
      return fail('Пароль слишком длинный (не более 128 символов)', 'TOO_LONG');
    }
    if (!/[A-Za-zА-Яа-яЁё]/.test(text)) {
      return fail('Пароль должен содержать хотя бы одну букву', 'NO_LETTER');
    }
    if (!/\d/.test(text)) {
      return fail('Пароль должен содержать хотя бы одну цифру', 'NO_DIGIT');
    }
    return ok(text);
  };
}

/**
 * Проверка совпадения значения с другим полем формы.
 * @param {string} otherField имя поля, с которым сравнивается значение
 * @param {{label?: string, otherLabel?: string}} [options]
 */
function matches(otherField, { label = 'Значение', otherLabel = 'указанное значение' } = {}) {
  return (value, allValues = {}) => {
    if (String(value) !== String(allValues[otherField])) {
      return fail(`${label} и ${otherLabel} не совпадают`, 'MISMATCH');
    }
    return ok(value);
  };
}

/** Проверка, что значение входит в список допустимых. */
function oneOf(allowed, { label = 'Значение' } = {}) {
  return (value) => {
    if (!allowed.includes(value)) {
      return fail(`${label}: допустимые значения — ${allowed.join(', ')}`, 'NOT_ALLOWED');
    }
    return ok(value);
  };
}

/**
 * Применяет схему проверки к объекту с данными.
 *
 * Схема — объект вида:
 *   {
 *     email: {
 *       label: 'Адрес электронной почты',
 *       rules: [required('Адрес'), emailPattern()],
 *     },
 *   }
 *
 * @param {object} data   проверяемые данные (обычно req.body)
 * @param {object} schema схема проверки
 * @returns {object} объект, содержащий только проверенные и приведённые значения
 * @throws {AppError} 400, если хотя бы одно поле заполнено неверно;
 *                    в details перечислены ошибки по каждому полю
 */
function validate(data, schema) {
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const values = {};
  const errors = {};

  for (const [field, definition] of Object.entries(schema)) {
    const label = definition.label || field;
    const rules = definition.rules || [];

    let result = ok(source[field]);

    for (const rule of rules) {
      result = rule(result.value, source);
      if (!result.ok) break;
    }

    if (result.ok) {
      values[field] = result.value;
    } else {
      errors[field] = { code: result.code, message: result.message };
    }
  }

  if (Object.keys(errors).length > 0) {
    const firstMessage = Object.values(errors)[0].message;
    throw AppError.badRequest(firstMessage, errors);
  }

  return values;
}

module.exports = {
  required,
  length,
  emailPattern,
  passwordStrength,
  matches,
  oneOf,
  validate,
  ok,
  fail,
};
