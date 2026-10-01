'use strict';

/**
 * Схемы проверки данных для запросов API.
 *
 * Схемы вынесены отдельно от правил, чтобы их можно было переиспользовать
 * (например, схема регистрации понадобится и на 4-м дне при сохранении
 * пользователя в базу данных) и чтобы требования к полям были собраны
 * в одном месте.
 */

const {
  required,
  length,
  emailPattern,
  passwordStrength,
  matches,
} = require('./rules');

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
    rules: [
      required('Пароль'),
      passwordStrength(),
    ],
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

module.exports = { registerSchema };
