'use strict';

/**
 * Тесты разграничения прав доступа (8-й день практики).
 *
 * Проверяется главное требование дня: клиент получает отказ 403 Forbidden
 * при попытке доступа к административным маршрутам.
 *
 * Запуск:  node tests/access.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';

// Проверки выполняют больше попыток входа, чем разрешено обычному
// пользователю за окно ограничения, поэтому пределы на время тестов
// повышаются. Работа самой защиты проверяется отдельным тестом
// в файле login.test.js и сценарии check-v0.6.js.
process.env.LOGIN_LIMIT_MAX = '500';
process.env.RATE_LIMIT_MAX = '500';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const authService = require('../src/services/authService');
const confirmationService = require('../src/services/confirmationService');
const userRepository = require('../src/repositories/userRepository');

const PASSWORD = 'Xk9#mQ2$vL7p';
let server;
let baseUrl;

/** Готовит базу данных и поднимает сервер на свободном порту. */
async function startServer() {
  runMigrations();
  getDb().exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');

  const insert = getDb().prepare("INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')");
  getDb().transaction(() => {
    for (let number = 1; number <= 20; number += 1) insert.run(number);
  })();

  server = await new Promise((resolve, reject) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

/** Останавливает сервер. */
async function stopServer() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
}

/** Создаёт подтверждённого пользователя с ролью и возвращает токен сессии. */
async function loginAs(email, role = 'client') {
  const { user } = await authService.register({
    name: 'Тестовый Пользователь',
    email,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  });

  confirmationService.confirmEmail(userRepository.findById(user.id).confirmToken);

  if (role !== 'client') {
    getDb().prepare('UPDATE Users SET role = ? WHERE id = ?').run(role, user.id);
  }

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  const body = await response.json();
  assert.ok(body.token, `вход не удался: ${JSON.stringify(body)}`);
  return body.token;
}

/** Выполняет запрос с указанным токеном. */
async function call(method, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return { status: response.status, body: parsed };
}

// ---------------------------------------------------------------------------
//  Административные маршруты: отказ клиенту
// ---------------------------------------------------------------------------

test('клиент получает 403 на всех административных маршрутах', async () => {
  await startServer();
  try {
    const clientToken = await loginAs('client@mail.ru', 'client');

    const endpoints = [
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/sessions'],
      ['POST', '/api/cells'],
      ['PATCH', '/api/cells/1/status'],
      ['DELETE', '/api/cells/1'],
    ];

    for (const [method, path] of endpoints) {
      const response = await call(method, path, {
        token: clientToken,
        body: method === 'GET' || method === 'DELETE' ? undefined : { status: 'Занята', cellNumber: 99 },
      });

      assert.equal(response.status, 403, `${method} ${path}: ожидался отказ 403`);
      assert.equal(response.body?.error?.code, 'FORBIDDEN');
      assert.match(response.body?.error?.message || '', /Недостаточно прав/);
    }
  } finally {
    await stopServer();
  }
});

test('администратор получает доступ к административным маршрутам', async () => {
  await startServer();
  try {
    const adminToken = await loginAs('admin@mail.ru', 'admin');

    const overview = await call('GET', '/api/admin/overview', { token: adminToken });
    assert.equal(overview.status, 200);
    assert.ok(overview.body?.overview?.users);
    assert.ok(overview.body?.overview?.cells);

    const users = await call('GET', '/api/admin/users', { token: adminToken });
    assert.equal(users.status, 200);
    assert.ok(Array.isArray(users.body?.users));

    const sessions = await call('GET', '/api/admin/sessions', { token: adminToken });
    assert.equal(sessions.status, 200);
  } finally {
    await stopServer();
  }
});

test('администратор имеет доступ к маршрутам клиента', async () => {
  await startServer();
  try {
    const adminToken = await loginAs('admin@mail.ru', 'admin');

    const cells = await call('GET', '/api/cells', { token: adminToken });
    assert.equal(cells.status, 200, 'администратор должен видеть список ячеек');

    const me = await call('GET', '/api/auth/me', { token: adminToken });
    assert.equal(me.status, 200);
    assert.equal(me.body?.user?.role, 'admin');
  } finally {
    await stopServer();
  }
});

test('без авторизации административные маршруты возвращают 401, а не 403', async () => {
  await startServer();
  try {
    const response = await call('GET', '/api/admin/overview');

    assert.equal(response.status, 401, 'сначала проверяется наличие сессии');
    assert.equal(response.body?.error?.code, 'MISSING_TOKEN');
  } finally {
    await stopServer();
  }
});

test('просмотр списка ячеек доступен клиенту, изменение — нет', async () => {
  await startServer();
  try {
    const clientToken = await loginAs('client@mail.ru', 'client');

    const view = await call('GET', '/api/cells', { token: clientToken });
    assert.equal(view.status, 200, 'клиент видит список ячеек');
    assert.equal(view.body?.summary?.total, 20);

    const create = await call('POST', '/api/cells', {
      token: clientToken,
      body: { cellNumber: 50 },
    });
    assert.equal(create.status, 403, 'клиент не может добавлять ячейки');

    const adminToken = await loginAs('admin2@mail.ru', 'admin');
    const created = await call('POST', '/api/cells', { token: adminToken, body: { cellNumber: 50 } });
    assert.equal(created.status, 201, 'администратор добавляет ячейку');
  } finally {
    await stopServer();
  }
});

test('администратор может завершить сессию пользователя', async () => {
  await startServer();
  try {
    const clientToken = await loginAs('client@mail.ru', 'client');
    const adminToken = await loginAs('admin@mail.ru', 'admin');

    const before = await call('GET', '/api/auth/me', { token: clientToken });
    assert.equal(before.status, 200);

    const sessions = await call('GET', '/api/admin/sessions', { token: adminToken });
    const clientSession = sessions.body.sessions.find((item) => item.role === 'client');
    assert.ok(clientSession, 'сессия клиента должна быть в списке');

    const closed = await call('DELETE', `/api/admin/sessions/${clientSession.id}`, { token: adminToken });
    assert.equal(closed.status, 200);

    const after = await call('GET', '/api/auth/me', { token: clientToken });
    assert.equal(after.status, 401, 'сессия клиента должна быть завершена');
  } finally {
    await stopServer();
  }
});

test('в списке пользователей нет хеша пароля и токенов', async () => {
  await startServer();
  try {
    const adminToken = await loginAs('admin@mail.ru', 'admin');

    const response = await call('GET', '/api/admin/users', { token: adminToken });
    const serialized = JSON.stringify(response.body);

    assert.ok(!serialized.includes('passwordHash'));
    assert.ok(!serialized.includes('password_hash'));
    assert.ok(!serialized.includes('confirmToken'));
    assert.ok(!serialized.includes('token_hash'));
  } finally {
    await stopServer();
  }
});

test('фильтр пользователей по роли работает', async () => {
  await startServer();
  try {
    await loginAs('client@mail.ru', 'client');
    const adminToken = await loginAs('admin@mail.ru', 'admin');

    const admins = await call('GET', '/api/admin/users?role=admin', { token: adminToken });
    assert.equal(admins.body.total, 1);
    assert.equal(admins.body.users[0].role, 'admin');

    const clients = await call('GET', '/api/admin/users?role=client', { token: adminToken });
    assert.equal(clients.body.total, 1);
    assert.equal(clients.body.users[0].role, 'client');

    const invalid = await call('GET', '/api/admin/users?role=superuser', { token: adminToken });
    assert.equal(invalid.status, 400, 'недопустимая роль в фильтре отклоняется');
  } finally {
    await stopServer();
  }
});

test('фильтр пользователей по подтверждению адреса работает', async () => {
  await startServer();
  try {
    const adminToken = await loginAs('admin@mail.ru', 'admin');

    // Создаём неподтверждённого пользователя
    await authService.register({
      name: 'Неподтверждённый',
      email: 'unconfirmed@mail.ru',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });

    const unconfirmed = await call('GET', '/api/admin/users?confirmed=false', { token: adminToken });
    assert.equal(unconfirmed.body.total, 1, `ответ сервера: ${JSON.stringify(unconfirmed.body)}`);
    assert.equal(unconfirmed.body.users[0].isConfirmed, false);

    const confirmed = await call('GET', '/api/admin/users?confirmed=true', { token: adminToken });
    assert.equal(confirmed.body.total, 1);
    assert.equal(confirmed.body.users[0].isConfirmed, true);
  } finally {
    await stopServer();
  }
});

test('завершение работы: сервер остановлен, соединение закрыто', async () => {
  await stopServer();
  closeDb();
});
