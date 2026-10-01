'use strict';

/**
 * Модульные тесты подтверждения адреса электронной почты (6-й день практики).
 *
 * Запуск:  node tests/confirmation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';
process.env.MAIL_CONFIRM_TTL_HOURS = '24';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const authService = require('../src/services/authService');
const confirmationService = require('../src/services/confirmationService');
const userRepository = require('../src/repositories/userRepository');
const AppError = require('../src/utils/AppError');
const { confirmationPage } = require('../src/views/confirmationPage');

const { CONFIRM_STATUS } = confirmationService;

/** Готовит чистую схему базы данных. */
function prepareDatabase() {
  runMigrations();
  getDb().exec('DELETE FROM Orders; DELETE FROM Users;');
}

/** Регистрирует пользователя и возвращает его запись с токеном. */
async function registerUser(email = 'ivanov@mail.ru') {
  const { user } = await authService.register({
    name: 'Иванов Иван',
    email,
    password: 'Xk9#mQ2$vL7p',
    passwordConfirm: 'Xk9#mQ2$vL7p',
  });
  return userRepository.findById(user.id);
}

/** Сдвигает дату формирования токена в прошлое (имитация истечения срока). */
function ageToken(userId, hours) {
  getDb()
    .prepare("UPDATE Users SET confirm_token_created_at = datetime('now', ?) WHERE id = ?")
    .run(`-${hours} hours`, userId);
}

// ---------------------------------------------------------------------------
//  Успешное подтверждение
// ---------------------------------------------------------------------------

test('переход по ссылке подтверждает адрес электронной почты', async () => {
  prepareDatabase();
  const user = await registerUser();

  assert.equal(user.isConfirmed, false, 'сразу после регистрации адрес не подтверждён');

  const result = confirmationService.confirmEmail(user.confirmToken);

  assert.equal(result.status, CONFIRM_STATUS.CONFIRMED);
  assert.equal(result.user.isConfirmed, true);
  assert.match(result.message, /подтверждён/);
});

test('признак подтверждения сохраняется в базе данных', async () => {
  prepareDatabase();
  const user = await registerUser();

  confirmationService.confirmEmail(user.confirmToken);

  const row = getDb().prepare('SELECT is_confirmed FROM Users WHERE id = ?').get(user.id);
  assert.equal(row.is_confirmed, 1);
});

test('использованный токен удаляется из базы данных', async () => {
  prepareDatabase();
  const user = await registerUser();

  confirmationService.confirmEmail(user.confirmToken);

  const row = getDb()
    .prepare('SELECT confirm_token, confirm_token_created_at FROM Users WHERE id = ?')
    .get(user.id);
  assert.equal(row.confirm_token, null, 'токен должен быть очищен');
  assert.equal(row.confirm_token_created_at, null, 'дата формирования токена очищена');
});

test('повторное использование той же ссылки не подтверждает дважды', async () => {
  prepareDatabase();
  const user = await registerUser();

  const first = confirmationService.confirmEmail(user.confirmToken);
  const second = confirmationService.confirmEmail(user.confirmToken);

  assert.equal(first.status, CONFIRM_STATUS.CONFIRMED);
  assert.equal(second.status, CONFIRM_STATUS.INVALID_TOKEN,
    'повторный переход по использованной ссылке не должен подтверждать учётную запись');
});

test('повторный вызов для уже подтверждённой учётной записи сообщает об этом', async () => {
  prepareDatabase();
  const user = await registerUser();

  // Имитируем ситуацию: адрес подтверждён, но ссылка ещё не использована
  getDb().prepare('UPDATE Users SET is_confirmed = 1 WHERE id = ?').run(user.id);
  const token = userRepository.findById(user.id).confirmToken;

  const result = confirmationService.confirmEmail(token);

  assert.equal(result.status, CONFIRM_STATUS.ALREADY_CONFIRMED);
  assert.equal(result.user.isConfirmed, true);
  assert.match(result.message, /уже был подтверждён/);
});

test('результат подтверждения не раскрывает хеш пароля и токен', async () => {
  prepareDatabase();
  const user = await registerUser();

  const result = confirmationService.confirmEmail(user.confirmToken);

  assert.equal(result.user.passwordHash, undefined);
  assert.equal(result.user.confirmToken, undefined);
  assert.equal(result.user.confirmTokenCreatedAt, undefined);
});

// ---------------------------------------------------------------------------
//  Ошибки подтверждения
// ---------------------------------------------------------------------------

test('недействительный токен отклоняется', () => {
  prepareDatabase();

  const result = confirmationService.confirmEmail('nesushchestvuyushchij-token');

  assert.equal(result.status, CONFIRM_STATUS.INVALID_TOKEN);
  assert.match(result.message, /недействительна/);
  assert.equal(result.user, null);
});

test('отсутствующий токен отклоняется', () => {
  prepareDatabase();

  for (const token of [undefined, null, '', '   ']) {
    const result = confirmationService.confirmEmail(token);
    assert.equal(result.status, CONFIRM_STATUS.MISSING_TOKEN, `токен ${JSON.stringify(token)}`);
  }
});

test('истёкший токен отклоняется', async () => {
  prepareDatabase();
  const user = await registerUser();

  // Сдвигаем дату формирования токена на 25 часов назад при сроке действия 24 часа
  ageToken(user.id, 25);

  const result = confirmationService.confirmEmail(user.confirmToken);

  assert.equal(result.status, CONFIRM_STATUS.EXPIRED);
  assert.match(result.message, /Срок действия ссылки истёк/);

  const row = getDb().prepare('SELECT is_confirmed FROM Users WHERE id = ?').get(user.id);
  assert.equal(row.is_confirmed, 0, 'учётная запись не должна подтверждаться');
});

test('токен в пределах срока действия принимается', async () => {
  prepareDatabase();
  const user = await registerUser();

  // 23 часа при сроке действия 24 часа
  ageToken(user.id, 23);

  const result = confirmationService.confirmEmail(user.confirmToken);
  assert.equal(result.status, CONFIRM_STATUS.CONFIRMED);
});

test('функция проверки срока действия работает корректно', () => {
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

  assert.equal(confirmationService.isTokenExpired(hoursAgo(1)), false);
  assert.equal(confirmationService.isTokenExpired(hoursAgo(23)), false);
  assert.equal(confirmationService.isTokenExpired(hoursAgo(25)), true);
  assert.equal(confirmationService.isTokenExpired(hoursAgo(100)), true);

  // Записи без даты формирования считаются действующими
  assert.equal(confirmationService.isTokenExpired(null), false);
  assert.equal(confirmationService.isTokenExpired(new Date('неверная дата')), false);
});

test('функция расчёта оставшегося времени работает корректно', () => {
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

  assert.ok(confirmationService.getTokenTimeLeftHours(hoursAgo(0)) > 23);
  assert.ok(confirmationService.getTokenTimeLeftHours(hoursAgo(20)) < 5);
  assert.equal(confirmationService.getTokenTimeLeftHours(hoursAgo(30)), 0);
  assert.equal(confirmationService.getTokenTimeLeftHours(null), null);
});

test('функция confirmEmailOrFail выбрасывает прикладные ошибки', () => {
  prepareDatabase();

  assert.throws(
    () => confirmationService.confirmEmailOrFail(''),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'MISSING_CONFIRM_TOKEN');
      return true;
    },
  );

  assert.throws(
    () => confirmationService.confirmEmailOrFail('nesushchestvuyushchij'),
    (error) => error.code === 'INVALID_CONFIRM_TOKEN',
  );
});

test('истёкший токен даёт ошибку 410', async () => {
  prepareDatabase();
  const user = await registerUser();
  ageToken(user.id, 25);

  assert.throws(
    () => confirmationService.confirmEmailOrFail(user.confirmToken),
    (error) => {
      assert.equal(error.status, 410);
      assert.equal(error.code, 'CONFIRM_TOKEN_EXPIRED');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
//  Проверка ссылки без подтверждения
// ---------------------------------------------------------------------------

test('проверка действующей ссылки сообщает оставшееся время', async () => {
  prepareDatabase();
  const user = await registerUser();

  const result = confirmationService.checkToken(user.confirmToken);

  assert.equal(result.status, 'valid');
  assert.ok(result.timeLeftHours > 23, `осталось ${result.timeLeftHours} ч`);
  assert.equal(result.user.email, 'ivanov@mail.ru');
});

test('проверка ссылки не подтверждает учётную запись', async () => {
  prepareDatabase();
  const user = await registerUser();

  confirmationService.checkToken(user.confirmToken);

  const row = getDb().prepare('SELECT is_confirmed FROM Users WHERE id = ?').get(user.id);
  assert.equal(row.is_confirmed, 0, 'проверка не должна подтверждать адрес');
});

test('проверка просроченной ссылки сообщает об истечении срока', async () => {
  prepareDatabase();
  const user = await registerUser();
  ageToken(user.id, 30);

  const result = confirmationService.checkToken(user.confirmToken);

  assert.equal(result.status, CONFIRM_STATUS.EXPIRED);
  assert.equal(result.timeLeftHours, 0);
});

// ---------------------------------------------------------------------------
//  Повторная отправка письма
// ---------------------------------------------------------------------------

test('повторная отправка обновляет дату формирования токена', async () => {
  prepareDatabase();
  const user = await registerUser();

  ageToken(user.id, 30);
  assert.equal(
    confirmationService.checkToken(userRepository.findById(user.id).confirmToken).status,
    CONFIRM_STATUS.EXPIRED,
    'перед повторной отправкой ссылка просрочена',
  );

  await authService.resendConfirmation('ivanov@mail.ru');

  const refreshed = userRepository.findById(user.id);
  assert.notEqual(refreshed.confirmToken, user.confirmToken, 'токен обновлён');
  assert.equal(
    confirmationService.checkToken(refreshed.confirmToken).status,
    'valid',
    'новая ссылка должна быть действующей',
  );
});

test('после повторной отправки новый токен подтверждает учётную запись', async () => {
  prepareDatabase();
  const user = await registerUser();
  ageToken(user.id, 30);

  await authService.resendConfirmation('ivanov@mail.ru');

  const token = userRepository.findById(user.id).confirmToken;
  const result = confirmationService.confirmEmail(token);

  assert.equal(result.status, CONFIRM_STATUS.CONFIRMED);
});

// ---------------------------------------------------------------------------
//  HTML-страница результата
// ---------------------------------------------------------------------------

test('страница подтверждения содержит результат и понятный текст', async () => {
  prepareDatabase();
  const user = await registerUser();
  const result = confirmationService.confirmEmail(user.confirmToken);

  const html = confirmationPage(result);

  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes('Адрес электронной почты подтверждён'), 'заголовок страницы');
  assert.ok(html.includes('ivanov@mail.ru'), 'адрес пользователя');
  assert.ok(html.includes('charset="UTF-8"'), 'кодировка указана');
  assert.ok(html.includes('name="viewport"'), 'страница адаптивна');
});

test('страница ошибки содержит ссылку на повторную отправку письма', () => {
  const html = confirmationPage({
    status: CONFIRM_STATUS.EXPIRED,
    message: 'Срок действия ссылки истёк',
    user: null,
  });

  assert.ok(html.includes('Срок действия ссылки истёк'));
  assert.ok(html.includes('resend-confirmation.html'), 'предложена повторная отправка');
});

test('значения на странице экранируются', () => {
  const html = confirmationPage({
    status: CONFIRM_STATUS.CONFIRMED,
    message: 'Подтверждено',
    user: { name: '<script>alert(1)</script>', email: 'test@mail.ru', isConfirmed: true },
  });

  assert.ok(!html.includes('<script>alert(1)</script>'), 'опасные символы экранированы');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('завершение работы: соединение с базой данных закрывается', () => {
  closeDb();
});
