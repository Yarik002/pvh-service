'use strict';

/**
 * Модульные тесты сервиса регистрации (3-й день практики).
 *
 * Сервис проверяется напрямую (без HTTP), на отдельной базе данных в памяти.
 *
 * Запуск:  npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const authService = require('../src/services/authService');
const userRepository = require('../src/repositories/userRepository');
const AppError = require('../src/utils/AppError');
const { verifyPassword, isPasswordHash } = require('../src/utils/password');

/** Готовит чистую схему базы данных перед каждым тестом. */
function prepareDatabase() {
  // Сначала применяем миграции (создают таблицы), затем очищаем данные
  runMigrations();
  getDb().exec('DELETE FROM Orders; DELETE FROM Users;');
}

/** Формирует корректный набор данных для регистрации. */
function validPayload(overrides = {}) {
  return {
    name: 'Иванов Иван',
    email: 'ivanov@mail.ru',
    password: 'parol12345',
    passwordConfirm: 'parol12345',
    ...overrides,
  };
}

test('регистрация создаёт пользователя с ролью client и статусом «не подтверждён»', async () => {
  prepareDatabase();

  const { user } = await authService.register(validPayload());

  assert.equal(user.name, 'Иванов Иван');
  assert.equal(user.email, 'ivanov@mail.ru');
  assert.equal(user.role, 'client');
  assert.equal(user.isConfirmed, false);
  assert.ok(user.id > 0);
  assert.equal(user.confirmToken, undefined, 'токен не должен покидать сервер');
});

test('пароль сохраняется в виде хеша и может быть проверен', async () => {
  prepareDatabase();
  await authService.register(validPayload());

  const row = getDb().prepare('SELECT password_hash FROM Users WHERE email = ?').get('ivanov@mail.ru');

  assert.equal(isPasswordHash(row.password_hash), true);
  assert.equal(row.password_hash.includes('parol12345'), false);
  assert.equal(await verifyPassword('parol12345', row.password_hash), true);
  assert.equal(await verifyPassword('drugoyparol1', row.password_hash), false);
});

test('для подтверждения Email формируется уникальный токен', async () => {
  prepareDatabase();

  const first = await authService.register(validPayload({ email: 'one@mail.ru' }));
  const second = await authService.register(validPayload({ email: 'two@mail.ru' }));

  assert.ok(first.confirmToken.length >= 32);
  assert.notEqual(first.confirmToken, second.confirmToken, 'токены должны различаться');

  const stored = getDb().prepare('SELECT confirm_token FROM Users WHERE email = ?').get('one@mail.ru');
  assert.equal(stored.confirm_token, first.confirmToken);
});

test('повторная регистрация на тот же Email отклоняется с кодом 409', async () => {
  prepareDatabase();
  await authService.register(validPayload());

  await assert.rejects(
    () => authService.register(validPayload({ name: 'Петров Пётр' })),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'CONFLICT');
      assert.equal(error.details.email.code, 'ALREADY_EXISTS');
      return true;
    },
  );

  assert.equal(userRepository.count(), 1, 'второй пользователь не должен создаваться');
});

test('регистр адреса электронной почты не влияет на проверку дубликата', async () => {
  prepareDatabase();
  await authService.register(validPayload({ email: 'ivanov@mail.ru' }));

  await assert.rejects(
    () => authService.register(validPayload({ email: 'IVANOV@MAIL.RU' })),
    (error) => error.status === 409,
  );
});

test('адрес электронной почты сохраняется в нижнем регистре', async () => {
  prepareDatabase();
  const { user } = await authService.register(validPayload({ email: 'Ivanov@Mail.RU' }));
  assert.equal(user.email, 'ivanov@mail.ru');
});

test('некорректные данные отклоняются с кодом 400 и перечнем ошибок', async () => {
  prepareDatabase();

  await assert.rejects(
    () => authService.register({ name: '', email: 'неверный', password: '123', passwordConfirm: '456' }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'BAD_REQUEST');
      assert.ok(error.details.name, 'ошибка по полю name');
      assert.ok(error.details.email, 'ошибка по полю email');
      assert.ok(error.details.password, 'ошибка по полю password');
      assert.ok(error.details.passwordConfirm, 'ошибка по полю passwordConfirm');
      return true;
    },
  );

  assert.equal(userRepository.count(), 0, 'пользователь не должен создаваться');
});

test('имя пользователя сохраняется без крайних пробелов', async () => {
  prepareDatabase();
  const { user } = await authService.register(validPayload({ name: '  Иванов Иван  ' }));
  assert.equal(user.name, 'Иванов Иван');
});

test('двумя параллельными запросами нельзя создать двух пользователей с одним Email', async () => {
  prepareDatabase();

  const attempts = await Promise.allSettled([
    authService.register(validPayload({ email: 'race@mail.ru' })),
    authService.register(validPayload({ email: 'race@mail.ru' })),
  ]);

  const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
  const rejected = attempts.filter((a) => a.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'успешной должна быть ровно одна попытка');
  assert.equal(rejected.length, 1, 'вторая попытка должна быть отклонена');
  assert.equal(userRepository.count(), 1);
});

test('завершение работы: соединение с базой данных закрывается', () => {
  closeDb();
});
