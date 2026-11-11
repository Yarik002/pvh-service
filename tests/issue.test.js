'use strict';

/**
 * Тесты выдачи заказа (18-й день практики).
 *
 * Проверяется:
 *   • заказ получает статус «Выдан» и дату выдачи, ячейка — «Свободна»;
 *   • освобождённая ячейка снова назначается следующему заказу;
 *   • выданный заказ нельзя выдать повторно, заказ «В пути» — нельзя выдать;
 *   • транзакция: при сбое не меняется ни заказ, ни ячейка;
 *   • адрес POST /api/orders/:id/issue и права доступа к нему.
 *
 * Запуск:  node tests/issue.test.js
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
const { hashPassword } = require('../src/utils/password');
const userRepository = require('../src/repositories/userRepository');
const cellRepository = require('../src/repositories/cellRepository');
const orderService = require('../src/services/orderService');

const PASSWORD = 'Xk9#mQ2$vL7p';

async function prepare() {
  runMigrations();
  const db = getDb();
  db.exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');
  const insert = db.prepare("INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')");
  for (let number = 1; number <= 20; number += 1) insert.run(number);

  const passwordHash = await hashPassword(PASSWORD);
  const client = userRepository.create({ name: 'Иванов Иван', email: 'ivanov@mail.ru', passwordHash, role: 'client', isConfirmed: true });
  userRepository.create({ name: 'Администратор', email: 'admin@mail.ru', passwordHash, role: 'admin', isConfirmed: true });
  return { client };
}

/** Принимает заказ и возвращает его. */
async function receive(trackNumber) {
  return (await orderService.receiveOrder({ trackNumber, clientEmail: 'ivanov@mail.ru' })).order;
}

const cellStatus = (number) => cellRepository.findByNumber(number).status;
const orderRow = (id) => getDb().prepare('SELECT * FROM Orders WHERE id = ?').get(id);

test('выдача: статус «Выдан», дата выдачи, ячейка свободна', async () => {
  await prepare();
  const order = await receive('PVZ180000001');
  assert.equal(cellStatus(1), 'Занята');

  const result = orderService.issueOrder(order.id);

  assert.equal(result.order.status, 'Выдан');
  assert.ok(result.order.issuedAt, 'дата выдачи заполнена');
  assert.equal(result.cell.cellNumber, 1);
  assert.equal(result.cell.status, 'Свободна');
  assert.equal(cellStatus(1), 'Свободна');

  const row = orderRow(order.id);
  assert.equal(row.status, 'Выдан');
  assert.ok(row.issued_at);
  assert.equal(row.cell_id, cellRepository.findByNumber(1).id, 'ячейка сохранена в истории заказа');
});

test('освобождённая ячейка снова назначается следующему заказу', async () => {
  await prepare();
  const first = await receive('PVZ180000002');
  await receive('PVZ180000003');
  orderService.issueOrder(first.id);

  const next = await receive('PVZ180000004');
  assert.equal(next.cell.cellNumber, 1, 'первая свободная ячейка — освобождённая № 1');
});

test('выданный заказ нельзя выдать повторно', async () => {
  await prepare();
  const order = await receive('PVZ180000005');
  orderService.issueOrder(order.id);

  assert.throws(() => orderService.issueOrder(order.id), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'ORDER_ALREADY_ISSUED');
    return true;
  });
});

test('заказ «В пути» выдать нельзя', async () => {
  const { client } = await prepare();
  const id = getDb().prepare("INSERT INTO Orders (track_number, user_id, status) VALUES ('PVZ180000006', ?, 'В пути')")
    .run(client.id).lastInsertRowid;

  assert.throws(() => orderService.issueOrder(id), { status: 409, code: 'ORDER_NOT_READY' });
  assert.equal(orderRow(id).status, 'В пути');
});

test('несуществующий заказ — 404', async () => {
  await prepare();
  assert.throws(() => orderService.issueOrder(99999), { status: 404 });
});

test('транзакция: при сбое освобождения ячейки заказ остаётся «Готов к выдаче»', async () => {
  await prepare();
  const order = await receive('PVZ180000007');

  const original = cellRepository.updateStatus;
  cellRepository.updateStatus = () => { throw new Error('сбой записи'); };
  try {
    assert.throws(() => orderService.issueOrder(order.id), /сбой записи/);
  } finally {
    cellRepository.updateStatus = original;
  }

  assert.equal(orderRow(order.id).status, 'Готов к выдаче', 'выдача отменена');
  assert.equal(orderRow(order.id).issued_at, null);
  assert.equal(cellStatus(1), 'Занята', 'ячейка не освобождена');
});

test('после выдачи заказ виден в списке со статусом «Выдан»', async () => {
  const { client } = await prepare();
  const order = await receive('PVZ180000008');
  orderService.issueOrder(order.id);

  const { orders, counts } = orderService.listMyOrders({ status: 'issued' }, client);
  assert.equal(orders.length, 1);
  assert.equal(counts.ready, 0);
  assert.equal(counts.issued, 1);
});

// ---------------------------------------------------------------------------
//  Адрес API
// ---------------------------------------------------------------------------

async function withServer(run) {
  await prepare();
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = async (email) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return (await response.json()).token;
  };
  const post = async (path, token) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${path}`, { method: 'POST', headers });
    return { status: response.status, body: await response.json() };
  };

  try {
    await run({ login, post });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /api/orders/:id/issue выдаёт заказ (200)', async () => {
  await withServer(async ({ login, post }) => {
    const order = await receive('PVZ180000009');
    const response = await post(`/api/orders/${order.id}/issue`, await login('admin@mail.ru'));

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.order.status, 'Выдан');
    assert.equal(response.body.cell.status, 'Свободна');
    assert.match(response.body.message, /ячейка № 1 свободна/);
  });
});

test('повторная выдача через API — 409 с понятным сообщением', async () => {
  await withServer(async ({ login, post }) => {
    const token = await login('admin@mail.ru');
    const order = await receive('PVZ180000010');
    await post(`/api/orders/${order.id}/issue`, token);
    const again = await post(`/api/orders/${order.id}/issue`, token);

    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ORDER_ALREADY_ISSUED');
    assert.match(again.body.error.message, /уже выдан/);
  });
});

test('выдавать заказы может только администратор', async () => {
  await withServer(async ({ login, post }) => {
    const order = await receive('PVZ180000011');

    assert.equal((await post(`/api/orders/${order.id}/issue`, await login('ivanov@mail.ru'))).status, 403);
    assert.equal((await post(`/api/orders/${order.id}/issue`, null)).status, 401);
    assert.equal(orderRow(order.id).status, 'Готов к выдаче');

    assert.equal((await post('/api/orders/abc/issue', await login('admin@mail.ru'))).status, 400);
    assert.equal((await post('/api/orders/99999/issue', await login('admin@mail.ru'))).status, 404);
  });
});

test.after(() => closeDb());
