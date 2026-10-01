'use strict';

/**
 * Правила проверки надёжности пароля.
 *
 * Вынесены отдельно от общих правил (rules.js), так как используют словарь
 * часто используемых паролей и анализ состава пароля.
 *
 * Коды ошибок:
 *   WEAK_PASSWORD         — пароль входит в словарь часто используемых;
 *   CONTAINS_PERSONAL_DATA — пароль содержит имя, фамилию или адрес почты;
 *   REPEATED_PATTERN      — пароль состоит из повторяющихся символов или блоков.
 */

const { fail, ok } = require('./rules');
const {
  isCommonPassword,
  containsCommonWord,
  containsPersonalData,
  isRepeatedPattern,
} = require('../utils/passwordStrength');

/**
 * Проверяет, что пароль отсутствует в словаре часто используемых.
 * @param {string} [label] название поля для сообщения об ошибке
 */
function notCommonPassword(label = 'Пароль') {
  return (value) => {
    if (isCommonPassword(value)) {
      return fail(
        `${label} входит в список часто используемых и легко подбирается. Выберите другой пароль.`,
        'WEAK_PASSWORD',
      );
    }
    return ok(value);
  };
}

/**
 * Проверяет, что пароль не содержит распространённых словарных слов
 * («password», «qwerty»), в том числе с заменами символов.
 * @param {string} [label] название поля для сообщения об ошибке
 */
function noCommonWord(label = 'Пароль') {
  return (value) => {
    if (!isCommonPassword(value) && containsCommonWord(value)) {
      return fail(
        `${label} содержит распространённое слово, которое проверяется при подборе `
        + 'в первую очередь. Выберите другой пароль.',
        'CONTAINS_COMMON_WORD',
      );
    }
    return ok(value);
  };
}

/**
 * Проверяет, что пароль не состоит из повторяющихся символов или блоков.
 * @param {string} [label] название поля для сообщения об ошибке
 */
function noRepeatedPattern(label = 'Пароль') {
  return (value) => {
    if (isRepeatedPattern(value)) {
      return fail(
        `${label} не должен состоять из повторяющихся символов или блоков.`,
        'REPEATED_PATTERN',
      );
    }
    return ok(value);
  };
}

/**
 * Проверяет, что пароль не содержит личных данных пользователя.
 *
 * Значения имени и адреса берутся из того же объекта с данными формы,
 * поэтому правило применяется после проверки самих этих полей.
 *
 * @param {{nameField?: string, emailField?: string}} [options]
 */
function noPersonalData({ nameField = 'name', emailField = 'email' } = {}) {
  return (value, allValues = {}) => {
    const personal = containsPersonalData(value, {
      name: allValues[nameField] || '',
      email: allValues[emailField] || '',
    });

    if (personal) {
      return fail(
        'Пароль не должен содержать ваше имя, фамилию или адрес электронной почты.',
        'CONTAINS_PERSONAL_DATA',
      );
    }
    return ok(value);
  };
}

module.exports = { notCommonPassword, noCommonWord, noRepeatedPattern, noPersonalData };
