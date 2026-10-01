'use strict';

/**
 * Схемы проверки данных для запросов API.
 *
 * Схемы вынесены отдельно от правил, чтобы их можно было переиспользовать
 * (например, схема регистрации используется и сервисом регистрации,
 * и сценариями проверки) и чтобы требования к полям были собраны в одном месте.
 */

const {
  required,
  length,
  emailPattern,
  passwordStrength,
  matches,
  differsFrom,
} = require('./rules');
const { noCommonWord, noRepeatedPattern } = require('./passwordRules');

/**
 * Требования к паролю, проверяемые по данным самой формы
 * (общие для регистрации и смены пароля):
 *   1) обязательное поле;
 *   2) от 8 символов, хотя бы одна буква и одна цифра;
 *   3) отсутствие повторов символов и блоков;
 *   4) отсутствие распространённых словарных слов («password», «qwerty»).
 *
 * Проверки на использование личных данных и на вхождение пароля в словарь
 * часто используемых выполняются в сервисном слое функцией findWeaknessReason().
 * Причина: на этапе смены пароля имя и адрес берутся из записи пользователя,
 * а не из формы, поэтому в схеме они недоступны; порядок причин отказа
 * (сначала личные данные, затем словарь) задаётся именно там.
 *
 * Порядок проверок в схеме — от более конкретных причин к более общим.
 */
function passwordRules(label = 'Пароль') {
  return [
    required(label),
    passwordStrength(),
    noRepeatedPattern(label),
    noCommonWord(label),
  ];
}

/** Схема регистрации нового пользователя. */
const registerSchema = {
  name: {
    label: 'Имя',
    rules: [
      required('Имя'),
      length({ min: 2, max: 100, label: 'Имя' }),
    ],
  },
  email: {
    label: 'Адрес электронной почты',
    rules: [
      required('Адрес электронной почты'),
      emailPattern(),
    ],
  },
  password: {
    label: 'Пароль',
    rules: passwordRules('Пароль'),
  },
  passwordConfirm: {
    label: 'Подтверждение пароля',
    rules: [
      required('Подтверждение пароля'),
      matches('password', {
        label: 'Пароль',
        otherLabel: 'подтверждение пароля',
      }),
    ],
  },
};

/** Схема смены пароля авторизованным пользователем. */
const changePasswordSchema = {
  currentPassword: {
    label: 'Текущий пароль',
    rules: [required('Текущий пароль')],
  },
  newPassword: {
    label: 'Новый пароль',
    rules: [
      ...passwordRules('Новый пароль'),
      // Новый пароль не должен совпадать с текущим
      differsFrom('currentPassword', {
        label: 'Новый пароль',
        otherLabel: 'текущий пароль',
      }),
    ],
  },
  newPasswordConfirm: {
    label: 'Подтверждение нового пароля',
    rules: [
      required('Подтверждение нового пароля'),
      matches('newPassword', {
        label: 'Новый пароль',
        otherLabel: 'подтверждение нового пароля',
      }),
    ],
  },
};

module.exports = { registerSchema, changePasswordSchema, passwordRules };
