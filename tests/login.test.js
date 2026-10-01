'use strict';

/**
 * Модульные тесты авторизации и сессий (7-й день практики).
 *
 * Запуск:  node tests/login.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';
process.env.SESSION_TTL_HOURS = '168';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const authService = require('../src/services/authService');
const sessionService = require('../src/services/sessionService');
const confirmationService = require('../src/services/confirmationService');
const userRepository = require('../src/repositories/userRepository');
const sessionRepository = require('../src/repositories/sessionRepository');
const AppError = require('../src/utils/AppError');
const { loginSchema } = require('../src/validators/schemas');

const PASSWORD = 'Xk9#mQ2$vL7p';

/** Готовит чистую схему базы данных. */
function prepareDatabase() {
  runMigrations();
  getDb().exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users;');
}

/**
 * Создаёт подтверждённого пользователя.
 * @param {{email?: string, confirmed?: boolean, role?: string}} [options]
 */
async function createUser({ email = 'ivanov@mail.ru', confirmed = true, role = 'client' } = {}) {
  const { user } = await authService.register({
    name: 'Иванов Иван',
    email,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  });

  if (confirmed) {
    confirmationService.confirmEmail(userRepository.findById(user.id).confirmToken);
  }
  if (role !== 'client') {
    getDb().prepare('UPDATE Users SET role = ? WHERE id = ?').run(role, user.id);
  }

  return userRepository.findById(user.id);
}

// ---------------------------------------------------------------------------
//  Успешный вход
// ---------------------------------------------------------------------------

test('вход по верным данным выдаёт токен сессии', async () => {
  prepareDatabase();
  await createUser();

  const result = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });

  assert.ok(result.token, 'токен должен быть выдан');
  assert.ok(result.token.length >= 32, `длина токена: ${result.token.length}`);
  assert.equal(result.user.email, 'ivanov@mail.ru');
  assert.equal(result.user.role, 'client');
  assert.ok(result.expiresAt instanceof Date);
  assert.ok(result.expiresAt.getTime() > Date.now(), 'срок действия в будущем');
});

test('вход не чувствителен к регистру адреса электронной почты', async () => {
  prepareDatabase();
  await createUser();

  const result = await authService.login({ email: 'IVANOV@MAIL.RU', password: PASSWORD });
  assert.equal(result.user.email, 'ivanov@mail.ru');
});

test('ответ входа не содержит хеш пароля', async () => {
  prepareDatabase();
  await createUser();

  const result = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });

  assert.equal(result.user.passwordHash, undefined);
  assert.equal(result.user.confirmToken, undefined);
});

test('после входа создаётся запись сессии', async () => {
  prepareDatabase();
  const user = await createUser();

  const result = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });

  assert.equal(sessionRepository.count(), 1);
  assert.equal(sessionRepository.countByUserId(user.id), 1);
  assert.equal(result.session.userId, user.id);
});

test('несколько входов создают несколько сессий', async () => {
  prepareDatabase();
  const user = await createUser();

  const first = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });
  const second = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });

  assert.notEqual(first.token, second.token, 'токены должны различаться');
  assert.equal(sessionRepository.countByUserId(user.id), 2);

  // Обе сессии действуют
  assert.equal(sessionService.validateSession(first.token).valid, true);
  assert.equal(sessionService.validateSession(second.token).valid, true);
});

test('в базе данных хранится хеш токена, а не сам токен', async () => {
  prepareDatabase();
  await createUser();

  const { token } = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });

  const row = getDb().prepare('SELECT token_hash FROM Sessions').get();
  assert.notEqual(row.token_hash, token, 'токен не должен храниться в открытом виде');
  assert.equal(row.token_hash.length, 64, 'SHA-256 в шестнадцатеричном виде');
  assert.equal(row.token_hash, sessionRepository.hashToken(token));
});

test('сведения о клиенте сохраняются в сессии', async () => {
  prepareDatabase();
  await createUser();

  const result = await authService.login(
    { email: 'ivanov@mail.ru', password: PASSWORD },
    { userAgent: 'Mozilla/5.0 Test Browser', ipAddress: '127.0.0.1' },
  );

  assert.equal(result.session.userAgent, 'Mozilla/5.0 Test Browser');
  assert.equal(result.session.ipAddress, '127.0.0.1');
});

// ---------------------------------------------------------------------------
//  Отказы при входе
// ---------------------------------------------------------------------------

test('вход в неподтверждённую учётную запись отклоняется (403)', async () => {
  prepareDatabase();
  await createUser({ confirmed: false });

  await assert.rejects(
    () => authService.login({ email: 'ivanov@mail.ru', password: PASSWORD }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'EMAIL_NOT_CONFIRMED');
      assert.match(error.message, /не подтверждён/);
      return true;
    },
  );

  assert.equal(sessionRepository.count(), 0, 'сессия не должна создаваться');
});

test('неверный пароль отклоняется (401)', async () => {
  prepareDatabase();
  await createUser();

  await assert.rejects(
    () => authService.login({ email: 'ivanov@mail.ru', password: 'NevernyjParol1' }),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, 'INVALID_CREDENTIALS');
      return true;
    },
  );
});

test('несуществующий адрес отклоняется с тем же сообщением, что и неверный пароль', async () => {
  prepareDatabase();
  await createUser();

  let wrongPasswordMessage = null;
  let unknownEmailMessage = null;

  try {
    await authService.login({ email: 'ivanov@mail.ru', password: 'NevernyjParol1' });
  } catch (error) {
    wrongPasswordMessage = error.message;
  }

  try {
    await authService.login({ email: 'nikogo@mail.ru', password: PASSWORD });
  } catch (error) {
    unknownEmailMessage = error.message;
  }

  assert.ok(wrongPasswordMessage);
  assert.equal(
    wrongPasswordMessage,
    unknownEmailMessage,
    'сообщения должны совпадать, иначе можно перебирать существующие адреса',
  );
});

test('пустые поля отклоняются (400)', async () => {
  prepareDatabase();

  await assert.rejects(
    () => authService.login({}),
    (error) => {
      assert.equal(error.status, 400);
      assert.ok(error.details.email);
      assert.ok(error.details.password);
      return true;
    },
  );

  await assert.rejects(() => authService.login({ email: 'неверный', password: PASSWORD }),
    (error) => error.status === 400);
});

test('схема входа требует только адрес и пароль', () => {
  assert.deepEqual(Object.keys(loginSchema).sort(), ['email', 'password']);
});

// ---------------------------------------------------------------------------
//  Сессии
// ---------------------------------------------------------------------------

test('проверка действующей сессии проходит', async () => {
  prepareDatabase();
  const user = await createUser();

  const { token } = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });
  const result = sessionService.validateSession(token);

  assert.equal(result.valid, true);
  assert.equal(result.session.userId, user.id);
});

test('проверка несуществующего токена отклоняется', () => {
  prepareDatabase();

  const result = sessionService.validateSession('nesushchestvuyushchij-token');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'SESSION_NOT_FOUND');
});

test('проверка пустого токена отклоняется', () => {
  prepareDatabase();

  for (const token of [undefined, null, '', '   ']) {
    const result = sessionService.validateSession(token);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'MISSING_TOKEN');
  }
});

test('истёкшая сессия не проходит проверку', async () => {
  prepareDatabase();
  await createUser();

  const { token, session } = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });

  // Сдвигаем срок окончания сессии в прошлое
  getDb()
    .prepare("UPDATE Sessions SET expires_at = datetime('now', '-1 hour') WHERE id = ?")
    .run(session.id);

  const result = sessionService.validateSession(token);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'SESSION_EXPIRED');
});

test('при проверке сессии обновляется время последнего обращения', async () => {
  prepareDatabase();
  await createUser();

  const { token, session } = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });
  assert.equal(session.lastUsedAt, null, 'сразу после создания обращения не было');

  sessionService.validateSession(token);

  const updated = sessionRepository.findById(session.id);
  assert.ok(updated.lastUsedAt, 'время последнего обращения должно быть заполнено');
});

test('выход из системы завершает сессию', async () => {
  prepareDatabase();
  await createUser();

  const { token } = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });

  const { closed } = authService.logout(token);
  assert.equal(closed, true);

  assert.equal(sessionService.validateSession(token).valid, false);
  assert.equal(sessionRepository.count(), 0);
});

test('выход по неизвестному токену не считается ошибкой', () => {
  prepareDatabase();

  const { closed } = authService.logout('nesushchestvuyushchij');
  assert.equal(closed, false);
});

test('выход завершает только текущую сессию', async () => {
  prepareDatabase();
  const user = await createUser();

  const first = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });
  const second = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });

  authService.logout(first.token);

  assert.equal(sessionService.validateSession(first.token).valid, false);
  assert.equal(sessionService.validateSession(second.token).valid, true);
  assert.equal(sessionRepository.countByUserId(user.id), 1);
});

test('завершение всех сессий пользователя', async () => {
  prepareDatabase();
  const user = await createUser();

  await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });
  await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });

  const removed = sessionService.destroyAllSessions(user.id);

  assert.equal(removed, 2);
  assert.equal(sessionRepository.countByUserId(user.id), 0);
});

test('удаление пользователя завершает его сессии (каскадное удаление)', async () => {
  prepareDatabase();
  const user = await createUser();

  await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });
  assert.equal(sessionRepository.count(), 1);

  getDb().prepare('DELETE FROM Users WHERE id = ?').run(user.id);
  assert.equal(sessionRepository.count(), 0, 'сессии должны удалиться вместе с пользователем');
});

test('очистка истёкших сессий удаляет только просроченные', async () => {
  prepareDatabase();
  const user = await createUser();

  const active = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });
  const expired = await sessionService.createSession(user.id);

  getDb()
    .prepare("UPDATE Sessions SET expires_at = datetime('now', '-1 hour') WHERE id = ?")
    .run(expired.session.id);

  const removed = sessionService.cleanupExpired();

  assert.equal(removed, 1);
  assert.equal(sessionRepository.count(), 1);
  assert.equal(sessionService.validateSession(active.token).valid, true);
});

// ---------------------------------------------------------------------------
//  Извлечение токена из запроса
// ---------------------------------------------------------------------------

test('токен извлекается из заголовка Authorization', () => {
  const request = { headers: { authorization: 'Bearer abc123token' } };
  assert.equal(sessionService.extractToken(request), 'abc123token');

  const lowerCase = { headers: { authorization: 'bearer xyz789' } };
  assert.equal(sessionService.extractToken(lowerCase), 'xyz789');
});

test('токен извлекается из cookie', () => {
  const request = { headers: { cookie: 'other=1; pvh_session=cookie-token; another=2' } };
  assert.equal(sessionService.extractToken(request), 'cookie-token');
});

test('заголовок Authorization имеет приоритет над cookie', () => {
  const request = {
    headers: {
      authorization: 'Bearer header-token',
      cookie: 'pvh_session=cookie-token',
    },
  };
  assert.equal(sessionService.extractToken(request), 'header-token');
});

test('отсутствие токена возвращает null', () => {
  assert.equal(sessionService.extractToken({ headers: {} }), null);
  assert.equal(sessionService.extractToken({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(sessionService.extractToken({ headers: { cookie: 'other=1' } }), null);
});

// ---------------------------------------------------------------------------
//  Получение текущего пользователя
// ---------------------------------------------------------------------------

test('данные текущего пользователя возвращаются по сессии', async () => {
  prepareDatabase();
  const user = await createUser();

  const { session } = await authService.login({ email: 'ivanov@mail.ru', password: PASSWORD });
  const current = authService.getCurrentUser(session);

  assert.equal(current.id, user.id);
  assert.equal(current.email, 'ivanov@mail.ru');
});

test('для отсутствующей сессии текущий пользователь не определяется', () => {
  assert.equal(authService.getCurrentUser(null), null);
});

test('завершение работы: соединение с базой данных закрывается', () => {
  closeDb();
});
