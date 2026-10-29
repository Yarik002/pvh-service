'use strict';

/**
 * Тесты API управления ячейками и страницы «Ячейки хранения»
 * (12-й день практики).
 *
 * Проверяется:
 *   • GET /api/cells — список всех 20 ячеек со сводкой;
 *   • GET /api/cells/free — только свободные ячейки и первая свободная;
 *   • GET /api/cells/summary — согласованная сводка по складу;
 *   • проверка идентификатора ячейки и ответы 400/404;
 *   • клиент не видит трек-номера чужих заказов, администратор видит;
 *   • ответы не кешируются браузером;
 *   • страница /cells вместо заглушки «в разработке».
 *
 * Запуск:  node tests/cellsApi.test.js
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
const cellService = require('../src/services/cellService');
const userRepository = require('../src/repositories/userRepository');
const AppError = require('../src/utils/AppError');

const PASSWORD = 'Xk9#mQ2$vL7p';
let server;
let baseUrl;

/** Готовит базу данных с 20 свободными ячейками и поднимает сервер. */
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

/** Создаёт подтверждённого пользователя и возвращает его токен и запись. */
async function loginAs(email, role = 'client') {
  const { user } = await authService.register({
    name: 'Тестовый Пользователь', email, password: PASSWORD, passwordConfirm: PASSWORD,
  });
  confirmationService.confirmEmail(userRepository.findById(user.id).confirmToken);
  if (role !== 'client') getDb().prepare('UPDATE Users SET role = ? WHERE id = ?').run(role, user.id);

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return { token: (await response.json()).token, user: userRepository.findById(user.id) };
}

/** Кладёт заказ в ячейку с указанным номером (как это сделает приёмка). */
function putOrder(cellNumber, userId, trackNumber) {
  const cell = getDb().prepare('SELECT id FROM Storage_Cells WHERE cell_number = ?').get(cellNumber);
  getDb().prepare(
    `INSERT INTO Orders (track_number, description, user_id, cell_id, status, received_at)
     VALUES (?, 'Посылка', ?, ?, 'Готов к выдаче', datetime('now'))`,
  ).run(trackNumber, userId, cell.id);
  getDb().prepare("UPDATE Storage_Cells SET status = 'Занята' WHERE id = ?").run(cell.id);
  return cell.id;
}

/** Обращается к API. */
async function call(path, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** Загружает страницу. */
async function getPage(path, token) {
  const headers = { Accept: 'text/html' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { headers, redirect: 'manual' });
  return { status: response.status, text: await response.text() };
}

// ---------------------------------------------------------------------------
//  Список всех ячеек
// ---------------------------------------------------------------------------

test('API отдаёт состояние всех 20 ячеек в формате JSON', async () => {
  await startServer();
  try {
    const { token } = await loginAs('client@mail.ru');
    const { status, headers, body } = await call('/api/cells', token);

    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /application\/json/);
    assert.equal(body.cells.length, 20);
    assert.deepEqual(body.cells.map((cell) => cell.cellNumber), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.ok(body.cells.every((cell) => ['Свободна', 'Занята'].includes(cell.status)));
  } finally {
    await stopServer();
  }
});

test('сводка согласована с состоянием ячеек', async () => {
  await startServer();
  try {
    const { token, user } = await loginAs('client@mail.ru');
    putOrder(1, user.id, 'PVZ000000001');
    putOrder(2, user.id, 'PVZ000000002');

    const { body } = await call('/api/cells', token);

    assert.equal(body.summary.total, 20);
    assert.equal(body.summary.busy, 2);
    assert.equal(body.summary.free, 18);
    assert.equal(body.summary.free + body.summary.busy, body.summary.total);
    assert.equal(body.summary.occupancyPercent, 10);
    assert.equal(body.summary.firstFreeNumber, 3, 'первая свободная — № 3');
    assert.ok(!Number.isNaN(Date.parse(body.summary.generatedAt)), 'время формирования сводки');
  } finally {
    await stopServer();
  }
});

test('ответы раздела ячеек не кешируются браузером', async () => {
  await startServer();
  try {
    const { token } = await loginAs('client@mail.ru');
    for (const path of ['/api/cells', '/api/cells/free', '/api/cells/summary', '/api/cells/1']) {
      const { headers } = await call(path, token);
      assert.equal(headers.get('cache-control'), 'no-store', path);
    }
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Свободные ячейки и сводка
// ---------------------------------------------------------------------------

test('GET /api/cells/free возвращает только свободные ячейки по порядку', async () => {
  await startServer();
  try {
    const { token, user } = await loginAs('client@mail.ru');
    putOrder(1, user.id, 'PVZ000000001');
    putOrder(5, user.id, 'PVZ000000005');

    const { status, body } = await call('/api/cells/free', token);

    assert.equal(status, 200);
    assert.equal(body.count, 18);
    assert.equal(body.cells.length, 18);
    assert.ok(body.cells.every((cell) => cell.status === 'Свободна'));
    assert.ok(!body.cells.some((cell) => [1, 5].includes(cell.cellNumber)), 'занятые исключены');
    assert.equal(body.firstFreeNumber, 2);
    assert.match(body.message, /Первая свободная — № 2/);
  } finally {
    await stopServer();
  }
});

test('если свободных ячеек нет, возвращается пустой список, а не ошибка', async () => {
  await startServer();
  try {
    const { token } = await loginAs('client@mail.ru');
    getDb().exec("UPDATE Storage_Cells SET status = 'Занята'");

    const { status, body } = await call('/api/cells/free', token);

    assert.equal(status, 200);
    assert.deepEqual(body.cells, []);
    assert.equal(body.count, 0);
    assert.equal(body.firstFreeNumber, null);
    assert.equal(body.message, 'Свободных ячеек нет.');
  } finally {
    await stopServer();
  }
});

test('GET /api/cells/summary возвращает сводку без списка ячеек', async () => {
  await startServer();
  try {
    const { token } = await loginAs('client@mail.ru');
    const { status, body } = await call('/api/cells/summary', token);

    assert.equal(status, 200);
    assert.equal(body.cells, undefined);
    assert.deepEqual(
      Object.keys(body.summary).sort(),
      ['busy', 'firstFreeNumber', 'free', 'generatedAt', 'occupancyPercent', 'total'],
    );
    assert.equal(body.summary.total, 20);
  } finally {
    await stopServer();
  }
});

test('новые адреса раздела требуют авторизацию', async () => {
  await startServer();
  try {
    for (const path of ['/api/cells/free', '/api/cells/summary', '/api/cells/1']) {
      const { status } = await call(path);
      assert.equal(status, 401, path);
    }
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Одна ячейка и проверка идентификатора
// ---------------------------------------------------------------------------

test('неверный идентификатор ячейки отклоняется с понятным сообщением', async () => {
  await startServer();
  try {
    const { token } = await loginAs('client@mail.ru');

    for (const id of ['abc', '0', '-3', '1.5']) {
      const { status, body } = await call(`/api/cells/${id}`, token);
      assert.equal(status, 400, `идентификатор ${id}`);
      assert.match(body.error.message, /целым положительным числом/);
    }

    const missing = await call('/api/cells/99999', token);
    assert.equal(missing.status, 404);
  } finally {
    await stopServer();
  }
});

test('клиент не видит трек-номера чужих заказов', async () => {
  await startServer();
  try {
    const other = await loginAs('other@mail.ru');
    const cellId = putOrder(3, other.user.id, 'PVZ333333333');

    const { token } = await loginAs('client@mail.ru');
    const list = await call('/api/cells?withOrders=true', token);
    const single = await call(`/api/cells/${cellId}`, token);

    assert.ok(!JSON.stringify(list.body).includes('PVZ333333333'), 'в списке нет трек-номера');
    assert.equal(list.body.filter.withOrders, false);
    assert.equal(single.body.cell.status, 'Занята', 'состояние ячейки клиенту видно');
    assert.equal(single.body.cell.order, undefined, 'сведений о заказе нет');
  } finally {
    await stopServer();
  }
});

test('администратор видит заказ в ячейке и его получателя', async () => {
  await startServer();
  try {
    const client = await loginAs('client@mail.ru');
    const cellId = putOrder(4, client.user.id, 'PVZ444444444');

    const { token } = await loginAs('admin@mail.ru', 'admin');
    const list = await call('/api/cells?withOrders=true', token);
    const single = await call(`/api/cells/${cellId}`, token);

    assert.equal(list.body.cells.find((cell) => cell.cellNumber === 4).trackNumber, 'PVZ444444444');
    assert.equal(single.body.cell.order.trackNumber, 'PVZ444444444');
    assert.equal(single.body.cell.order.client.email, 'client@mail.ru');
    assert.ok(single.body.cell.order.receivedAt.endsWith('Z'), 'дата в формате ISO 8601');

    const freeCellId = getDb().prepare('SELECT id FROM Storage_Cells WHERE cell_number = 1').get().id;
    const empty = await call(`/api/cells/${freeCellId}`, token);
    assert.equal(empty.body.cell.order, null, 'у свободной ячейки заказа нет');
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Сервис (без HTTP)
// ---------------------------------------------------------------------------

test('проверка идентификатора ячейки в сервисе', () => {
  assert.equal(cellService.parseCellId('7'), 7);
  assert.equal(cellService.parseCellId(12), 12);
  for (const value of ['', 'abc', '0', '-1', '2.5', '1e3', null, undefined]) {
    assert.throws(() => cellService.parseCellId(value), (error) => error instanceof AppError && error.status === 400,
      `значение ${value}`);
  }
});

test('сводка и список свободных ячеек совпадают', async () => {
  await startServer();
  try {
    const { user } = await loginAs('client@mail.ru');
    putOrder(1, user.id, 'PVZ100000001');

    const summary = cellService.getSummary();
    const free = cellService.listFreeCells();

    assert.equal(summary.free, free.count);
    assert.equal(summary.firstFreeNumber, free.firstFreeNumber);
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Страница «Ячейки хранения»
// ---------------------------------------------------------------------------

test('страница ячеек открывается вместо заглушки «в разработке»', async () => {
  await startServer();
  try {
    const { token } = await loginAs('client@mail.ru');
    const page = await getPage('/cells', token);

    assert.equal(page.status, 200);
    assert.ok(page.text.includes('id="cells-grid"'), 'сетка ячеек');
    assert.ok(page.text.includes('data-cells-filter="free"'), 'фильтр свободных');
    assert.ok(page.text.includes('/js/cells.js'), 'подключён сценарий страницы');
    assert.ok(!page.text.includes('Раздел находится в разработке'));
    assert.ok(page.text.includes('данные других клиентов не раскрываются'));
  } finally {
    await stopServer();
  }
});

test('администратору страница сообщает о трек-номерах в ячейках', async () => {
  await startServer();
  try {
    const { token } = await loginAs('admin@mail.ru', 'admin');
    const page = await getPage('/cells', token);

    assert.equal(page.status, 200);
    assert.ok(page.text.includes('показан трек-номер заказа'));
  } finally {
    await stopServer();
  }
});

test('сценарий страницы строит разметку без innerHTML', async () => {
  await startServer();
  try {
    const response = await fetch(`${baseUrl}/js/cells.js`);
    const source = await response.text();

    assert.equal(response.status, 200);
    assert.ok(source.includes('createElement') && source.includes('textContent'));
    assert.ok(!/\.innerHTML\s*=/.test(source), 'данные из базы не попадают в innerHTML');
  } finally {
    await stopServer();
  }
});

test.after(() => closeDb());
