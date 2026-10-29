'use strict';

/**
 * Тесты страницы администратора и заглушек разделов в разработке.
 *
 * Проверяется:
 *   • страница админки открывается только администратором;
 *   • клиент получает отказ 403, гость — 401;
 *   • страница содержит разделы сводки, таблиц и подключает сценарий;
 *   • разделы «в разработке» отдают понятную страницу вместо ошибки 404.
 *
 * Запуск:  node tests/adminPage.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';
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

/** Готовит базу данных и поднимает сервер. */
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

/** Создаёт подтверждённого пользователя с ролью и возвращает токен. */
async function loginAs(email, role = 'client') {
  const { user } = await authService.register({
    name: 'Тестовый Пользователь', email, password: PASSWORD, passwordConfirm: PASSWORD,
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

  return (await response.json()).token;
}

/** Загружает страницу. */
async function getPage(path, token) {
  const headers = { Accept: 'text/html' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, { headers, redirect: 'manual' });
  return { status: response.status, text: await response.text() };
}

// ---------------------------------------------------------------------------
//  Доступ к странице администратора
// ---------------------------------------------------------------------------

test('гость не может открыть страницу администратора (401)', async () => {
  await startServer();
  try {
    const page = await getPage('/admin');

    assert.equal(page.status, 401, 'без сессии страница недоступна');
  } finally {
    await stopServer();
  }
});

test('клиент получает отказ 403 на странице администратора', async () => {
  await startServer();
  try {
    const token = await loginAs('client@mail.ru', 'client');
    const page = await getPage('/admin', token);

    assert.equal(page.status, 403, 'клиенту страница недоступна');
    assert.ok(!page.text.includes('Пользователи системы'),
      'данные админки не должны попадать в ответ');
  } finally {
    await stopServer();
  }
});

test('администратор открывает страницу администратора (200)', async () => {
  await startServer();
  try {
    const token = await loginAs('admin@mail.ru', 'admin');
    const page = await getPage('/admin', token);

    assert.equal(page.status, 200);
    assert.match(page.text, /Администрирование/);
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Состав страницы администратора
// ---------------------------------------------------------------------------

test('страница администратора содержит разделы сводки', async () => {
  await startServer();
  try {
    const token = await loginAs('admin@mail.ru', 'admin');
    const page = await getPage('/admin', token);

    for (const marker of ['stat-users', 'stat-cells', 'stat-free', 'stat-orders',
      'users-confirmed', 'orders-transit', 'sessions-active']) {
      assert.ok(page.text.includes(marker), `отсутствует показатель: ${marker}`);
    }
  } finally {
    await stopServer();
  }
});

test('страница администратора содержит таблицы пользователей и ячеек', async () => {
  await startServer();
  try {
    const token = await loginAs('admin@mail.ru', 'admin');
    const page = await getPage('/admin', token);

    assert.ok(page.text.includes('id="users-table"'), 'таблица пользователей');
    assert.ok(page.text.includes('id="cells-table"'), 'таблица ячеек');

    for (const header of ['Имя', 'Адрес электронной почты', 'Роль', 'Номер ячейки']) {
      assert.ok(page.text.includes(header), `отсутствует столбец: ${header}`);
    }
  } finally {
    await stopServer();
  }
});

test('страница администратора подключает сценарий загрузки данных', async () => {
  await startServer();
  try {
    const token = await loginAs('admin@mail.ru', 'admin');
    const page = await getPage('/admin', token);

    assert.ok(page.text.includes('/js/admin.js'), 'сценарий страницы');
    assert.ok(page.text.includes('/js/api.js'), 'модуль обращения к API');
  } finally {
    await stopServer();
  }
});

test('страница администратора оформлена в общем шаблоне', async () => {
  await startServer();
  try {
    const token = await loginAs('admin@mail.ru', 'admin');
    const page = await getPage('/admin', token);

    assert.ok(page.text.includes('header__inner'), 'шапка');
    assert.ok(page.text.includes('footer__grid'), 'подвал');
    assert.ok(page.text.includes('data-role="admin"'), 'роль в разметке');
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Разделы в разработке
// ---------------------------------------------------------------------------

test('разделы в разработке отдают страницу вместо ошибки 404', async () => {
  await startServer();
  try {
    const token = await loginAs('admin@mail.ru', 'admin');

    // Раздел «Ячейки» реализован на 12-м дне и проверяется в tests/cellsApi.test.js
    for (const path of ['/orders', '/receive']) {
      const page = await getPage(path, token);

      assert.equal(page.status, 200, `${path} должен открываться`);
      assert.match(page.text, /в разработке/i, `${path} сообщает о разработке`);
      assert.ok(!page.text.includes('Страница не найдена'),
        `${path} не должен считаться отсутствующим`);
    }
  } finally {
    await stopServer();
  }
});

test('раздел «Приёмка товара» доступен только администратору', async () => {
  await startServer();
  try {
    const clientToken = await loginAs('client@mail.ru', 'client');
    const page = await getPage('/receive', clientToken);

    assert.equal(page.status, 403);
  } finally {
    await stopServer();
  }
});

test('старый адрес /admin.html перенаправляет на /admin', async () => {
  await startServer();
  try {
    const response = await fetch(`${baseUrl}/admin.html`, { redirect: 'manual' });

    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), '/admin');
  } finally {
    await stopServer();
  }
});

test('завершение работы: сервер остановлен, соединение закрыто', async () => {
  await stopServer();
  closeDb();
});
