'use strict';

/**
 * Модульные тесты правил валидации (3-й день практики).
 *
 * Запуск:  npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  required,
  length,
  emailPattern,
  passwordStrength,
  matches,
  validate,
} = require('../src/validators/rules');
const AppError = require('../src/utils/AppError');

test('правило required отклоняет пустые значения', () => {
  const rule = required('Имя');
  assert.equal(rule('').ok, false);
  assert.equal(rule('   ').ok, false);
  assert.equal(rule(undefined).ok, false);
  assert.equal(rule(null).ok, false);
  assert.equal(rule('Иван').ok, true);
  assert.equal(rule('  Иван  ').value, 'Иван', 'крайние пробелы удаляются');
});

test('правило required формирует понятное сообщение об ошибке', () => {
  const result = required('Адрес электронной почты')('');
  assert.equal(result.code, 'REQUIRED');
  assert.match(result.message, /Адрес электронной почты обязательно/);
});

test('правило length проверяет границы длины', () => {
  const rule = length({ min: 2, max: 5, label: 'Имя' });
  assert.equal(rule('И').ok, false);
  assert.equal(rule('И').code, 'TOO_SHORT');
  assert.equal(rule('Иван').ok, true);
  assert.equal(rule('ИванИван').ok, false);
  assert.equal(rule('ИванИван').code, 'TOO_LONG');
});

test('правило emailPattern принимает корректные адреса', () => {
  const rule = emailPattern();
  const valid = [
    'ivanov@mail.ru',
    'i.ivanov@mail.ru',
    'ivanov+tag@mail.ru',
    'ivanov_2026@mail.ru',
    'student@bsuir.by',
    'a@b.co',
  ];
  for (const address of valid) {
    assert.equal(rule(address).ok, true, `адрес ${address} должен приниматься`);
  }
});

test('правило emailPattern отклоняет некорректные адреса', () => {
  const rule = emailPattern();
  const invalid = [
    'ivanov',              // нет символа @
    'ivanov@',             // нет домена
    '@mail.ru',            // нет локальной части
    'ivanov@mail',         // нет зоны
    'ivanov@mail.r',       // слишком короткая зона
    'ivanov @mail.ru',     // пробел внутри
    'ivanov@@mail.ru',     // двойной @
    '.ivanov@mail.ru',     // локальная часть начинается с точки
    'ivanov.@mail.ru',     // локальная часть заканчивается точкой
    'iv..anov@mail.ru',    // две точки подряд
  ];
  for (const address of invalid) {
    assert.equal(rule(address).ok, false, `адрес ${address} должен отклоняться`);
  }
});

test('правило emailPattern приводит адрес к нижнему регистру', () => {
  const result = emailPattern()('Ivanov@Mail.RU');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'ivanov@mail.ru');
});

test('правило passwordStrength требует буквы и цифры', () => {
  const rule = passwordStrength();
  assert.equal(rule('parol12345').ok, true);
  assert.equal(rule('Parol12345').ok, true);
  assert.equal(rule('пароль12345').ok, true, 'кириллица допускается');

  assert.equal(rule('parol1').code, 'TOO_SHORT', 'короче 8 символов');
  assert.equal(rule('12345678').code, 'NO_LETTER', 'только цифры');
  assert.equal(rule('parolparol').code, 'NO_DIGIT', 'только буквы');
});

test('правило matches сравнивает значение с другим полем', () => {
  const rule = matches('password', { label: 'Пароль', otherLabel: 'подтверждение пароля' });
  const allValues = { password: 'parol12345' };

  assert.equal(rule('parol12345', allValues).ok, true);
  assert.equal(rule('parol54321', allValues).ok, false);
  assert.equal(rule('parol54321', allValues).code, 'MISMATCH');
  assert.match(rule('parol54321', allValues).message, /не совпадают/);
});

test('функция validate возвращает только проверенные значения', () => {
  const schema = {
    name: { label: 'Имя', rules: [required('Имя'), length({ min: 2, label: 'Имя' })] },
    email: { label: 'Email', rules: [required('Email'), emailPattern()] },
    role: { label: 'Роль', rules: [required('Роль')] },
  };

  const values = validate(
    { name: '  Иван  ', email: 'IVANOV@MAIL.RU', role: 'client', лишнее: 'игнорируется' },
    schema,
  );

  assert.equal(values.name, 'Иван', 'пробелы удалены');
  assert.equal(values.email, 'ivanov@mail.ru', 'регистр приведён');
  assert.equal(values.role, 'client');
  assert.equal(values.лишнее, undefined, 'необъявленные поля не попадают в результат');
});

test('функция validate собирает ошибки по всем полям сразу', () => {
  const schema = {
    name: { label: 'Имя', rules: [required('Имя')] },
    email: { label: 'Email', rules: [required('Email'), emailPattern()] },
  };

  let error;
  try {
    validate({ name: '', email: 'неверный' }, schema);
  } catch (thrown) {
    error = thrown;
  }

  assert.ok(error instanceof AppError, 'выбрасывается прикладная ошибка');
  assert.equal(error.status, 400);
  assert.equal(error.code, 'BAD_REQUEST');
  assert.equal(error.details.name.code, 'REQUIRED');
  assert.equal(error.details.email.code, 'BAD_FORMAT');
});

test('функция validate устойчива к некорректному входу', () => {
  const schema = { name: { label: 'Имя', rules: [required('Имя')] } };
  assert.throws(() => validate(null, schema), AppError);
  assert.throws(() => validate('строка', schema), AppError);
  assert.throws(() => validate(undefined, schema), AppError);
});
