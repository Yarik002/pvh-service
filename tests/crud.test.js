'use strict';

/**
 * Тесты CRUD-операций (20-й день практики).
 *
 * Заказы: создание ожидаемого заказа «В пути», изменение, удаление
 * с освобождением ячейки. Профиль: изменение имени, удаление своей учётной
 * записи с подтверждением паролем, удаление клиента администратором.
 *
 * Запуск:  node tests/crud.test.js
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
const profileService = require('../src/services/profileService');

const PASSWORD = 'Xk9#mQ2$vL7p';

async function prepare() {
  runMigrations();
  const db = getDb();
  db.exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');
  const insert = db.prepare("INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')");
  for (let number = 1; number <= 20; number += 1) insert.run(number);

  const passwordHash = await hashPassword(PASSWORD);
  const ivanov = userRepository.create({ name: 'Иванов Иван', email: 'ivanov@mail.ru', passwordHash, role: 'client', isConfirmed: true });
  const petrov = userRepository.create({ name: 'Петров Пётр', email: 'petrov@mail.ru', passwordHash, role: 'client', isConfirmed: true });
  const admin = userRepository.create({ name: 'Администратор', email: 'admin@mail.ru', passwordHash, role: 'admin', isConfirmed: true });
  return { ivanov, petrov, admin };
}

const receive = async (trackNumber, clientEmail = 'ivanov@mail.ru') => (
  await orderService.receiveOrder({ trackNumber, clientEmail })).order;
const orderCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM Orders').get().n;

// ---------------------------------------------------------------------------
//  Заказы
// ---------------------------------------------------------------------------

test('ожидаемый заказ создаётся «В пути» без ячейки, затем принимается', async () => {
  await prepare();
  const order = orderService.createExpectedOrder({ trackNumber: 'pvz200000001', clientEmail: 'ivanov@mail.ru', description: 'Ноутбук' });

  assert.equal(order.status, 'В пути');
  assert.equal(order.trackNumber, 'PVZ200000001', 'трек-номер в верхнем регистре');
  assert.equal(order.cell, null);
  assert.equal(order.receivedAt, null);

  const received = await orderService.receiveOrder({ trackNumber: 'PVZ200000001', clientEmail: 'ivanov@mail.ru' });
  assert.equal(received.fromTransit, true, 'приёмка переводит ожидаемый заказ');
  assert.equal(received.order.status, 'Готов к выдаче');
});

test('ожидаемый заказ: повтор трек-номера и неверные поля отклоняются', async () => {
  await prepare();
  orderService.createExpectedOrder({ trackNumber: 'PVZ200000002', clientEmail: 'ivanov@mail.ru' });

  assert.throws(() => orderService.createExpectedOrder({ trackNumber: 'PVZ200000002', clientEmail: 'petrov@mail.ru' }),
    { status: 409, code: 'TRACK_EXISTS' });
  assert.throws(() => orderService.createExpectedOrder({ trackNumber: '12', clientEmail: 'ivanov@mail.ru' }), { status: 400 });
  assert.throws(() => orderService.createExpectedOrder({ trackNumber: 'PVZ200000003', clientEmail: 'nobody@mail.ru' }), { status: 404 });
  assert.throws(() => orderService.createExpectedOrder({ trackNumber: 'PVZ200000003', clientEmail: 'admin@mail.ru' }), { status: 400 });
});

test('изменение заказа: трек-номер, описание и получатель', async () => {
  const { petrov } = await prepare();
  const order = await receive('PVZ200000004');

  const updated = orderService.updateOrder(order.id, {
    trackNumber: 'pvz200000099', description: 'Исправленное описание', clientEmail: 'petrov@mail.ru',
  });

  assert.equal(updated.trackNumber, 'PVZ200000099');
  assert.equal(updated.description, 'Исправленное описание');
  assert.equal(updated.client.id, petrov.id);
  assert.equal(updated.status, 'Готов к выдаче', 'статус не меняется');
  assert.equal(updated.cell.cellNumber, 1, 'ячейка не меняется');
});

test('изменение: можно передать только одно поле, пустое описание очищается', async () => {
  await prepare();
  const order = await receive('PVZ200000005');
  orderService.updateOrder(order.id, { description: 'Было' });

  const updated = orderService.updateOrder(order.id, { description: '' });
  assert.equal(updated.description, null);
  assert.equal(updated.trackNumber, 'PVZ200000005');
});

test('изменение: занятый трек-номер и выданный заказ — 409', async () => {
  await prepare();
  const first = await receive('PVZ200000006');
  const second = await receive('PVZ200000007');

  assert.throws(() => orderService.updateOrder(second.id, { trackNumber: 'PVZ200000006' }), { status: 409, code: 'TRACK_EXISTS' });

  orderService.issueOrder(first.id);
  assert.throws(() => orderService.updateOrder(first.id, { description: 'x' }), { status: 409, code: 'ORDER_READONLY' });
  assert.throws(() => orderService.updateOrder(99999, {}), { status: 404 });
});

test('удаление заказа «Готов к выдаче» освобождает ячейку', async () => {
  await prepare();
  const order = await receive('PVZ200000008');
  assert.equal(cellRepository.findByNumber(1).status, 'Занята');

  const result = orderService.deleteOrder(order.id);

  assert.equal(result.order.trackNumber, 'PVZ200000008');
  assert.equal(result.freedCell.cellNumber, 1);
  assert.equal(cellRepository.findByNumber(1).status, 'Свободна');
  assert.equal(orderCount(), 0);
});

test('удаление выданного заказа не трогает ячейку с новым заказом', async () => {
  await prepare();
  const old = await receive('PVZ200000009');
  orderService.issueOrder(old.id);
  await receive('PVZ200000010');            // заняла ту же ячейку № 1

  const result = orderService.deleteOrder(old.id);
  assert.equal(result.freedCell, null);
  assert.equal(cellRepository.findByNumber(1).status, 'Занята', 'ячейка нового заказа осталась занятой');
});

// ---------------------------------------------------------------------------
//  Профиль
// ---------------------------------------------------------------------------

test('изменение имени проверяется по правилам регистрации', async () => {
  const { ivanov } = await prepare();

  assert.equal(profileService.updateProfile(ivanov.id, { name: '  Иван Иванов ' }).name, 'Иван Иванов');
  assert.throws(() => profileService.updateProfile(ivanov.id, { name: 'И' }), { status: 400 });
  assert.throws(() => profileService.updateProfile(ivanov.id, {}), { status: 400 });
});

test('удаление учётной записи требует верный пароль', async () => {
  const { ivanov } = await prepare();

  await assert.rejects(profileService.deleteOwnAccount(ivanov.id, {}), { status: 400 });
  await assert.rejects(profileService.deleteOwnAccount(ivanov.id, { password: 'wrong' }), { status: 401 });
  assert.ok(userRepository.findById(ivanov.id), 'запись не удалена');

  await profileService.deleteOwnAccount(ivanov.id, { password: PASSWORD });
  assert.equal(userRepository.findById(ivanov.id), null);
});

test('нельзя удалить учётную запись, пока заказ лежит в ячейке', async () => {
  const { ivanov } = await prepare();
  const order = await receive('PVZ200000011');

  await assert.rejects(profileService.deleteOwnAccount(ivanov.id, { password: PASSWORD }),
    { status: 409, code: 'HAS_ACTIVE_ORDERS' });

  // После выдачи удаление разрешено, история заказов удаляется каскадно
  orderService.issueOrder(order.id);
  await profileService.deleteOwnAccount(ivanov.id, { password: PASSWORD });
  assert.equal(orderCount(), 0);
});

test('нельзя удалить единственного администратора', async () => {
  const { admin } = await prepare();
  await assert.rejects(profileService.deleteOwnAccount(admin.id, { password: PASSWORD }),
    { status: 409, code: 'LAST_ADMIN' });
});

test('администратор удаляет клиента, но не себя', async () => {
  const { petrov, admin } = await prepare();

  profileService.deleteUserByAdmin(petrov.id, admin);
  assert.equal(userRepository.findById(petrov.id), null);

  assert.throws(() => profileService.deleteUserByAdmin(admin.id, admin), { status: 400 });
  assert.throws(() => profileService.deleteUserByAdmin(99999, admin), { status: 404 });
});

// ---------------------------------------------------------------------------
//  Адреса API
// ---------------------------------------------------------------------------

async function withServer(run) {
  await prepare();
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => (await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  })).json()).token;
  const call = async (method, path, token, body) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  };
  try {
    await run({ login, call });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('API заказов: создать, изменить, удалить (администратор)', async () => {
  await withServer(async ({ login, call }) => {
    const token = await login('admin@mail.ru');

    const created = await call('POST', '/api/orders/expected', token, { trackNumber: 'PVZ200000020', clientEmail: 'ivanov@mail.ru' });
    assert.equal(created.status, 201);
    assert.equal(created.body.order.status, 'В пути');

    const changed = await call('PATCH', `/api/orders/${created.body.order.id}`, token, { description: 'Телефон' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.order.description, 'Телефон');

    const removed = await call('DELETE', `/api/orders/${created.body.order.id}`, token);
    assert.equal(removed.status, 200);
    assert.equal(orderCount(), 0);
    assert.equal((await call('DELETE', `/api/orders/${created.body.order.id}`, token)).status, 404);
  });
});

test('API заказов: клиенту изменение и удаление запрещены', async () => {
  await withServer(async ({ login, call }) => {
    const order = await receive('PVZ200000021');
    const token = await login('ivanov@mail.ru');

    assert.equal((await call('POST', '/api/orders/expected', token, { trackNumber: 'PVZ200000022', clientEmail: 'ivanov@mail.ru' })).status, 403);
    assert.equal((await call('PATCH', `/api/orders/${order.id}`, token, { description: 'x' })).status, 403);
    assert.equal((await call('DELETE', `/api/orders/${order.id}`, token)).status, 403);
    assert.equal(orderCount(), 1);
  });
});

test('API профиля: имя меняется, удаление очищает cookie сессии', async () => {
  await withServer(async ({ login, call }) => {
    const token = await login('petrov@mail.ru');

    const renamed = await call('PATCH', '/api/auth/me', token, { name: 'Пётр Петров' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.user.name, 'Пётр Петров');

    const wrong = await call('DELETE', '/api/auth/me', token, { password: 'неверный' });
    assert.equal(wrong.status, 401);
    assert.ok(wrong.body.error.details.password);

    const removed = await call('DELETE', '/api/auth/me', token, { password: PASSWORD });
    assert.equal(removed.status, 200);
    assert.match(removed.cookie || '', /Max-Age=0|Expires=Thu, 01 Jan 1970/i, 'cookie сессии очищена');
    assert.equal((await call('GET', '/api/auth/me', token)).status, 401, 'сессия удалена вместе с пользователем');
  });
});

test('API администратора: удаление клиента', async () => {
  await withServer(async ({ login, call }) => {
    const token = await login('admin@mail.ru');
    const petrov = userRepository.findByEmail('petrov@mail.ru');

    assert.equal((await call('DELETE', `/api/admin/users/${petrov.id}`, token)).status, 200);
    assert.equal((await call('DELETE', '/api/admin/users/abc', token)).status, 400);
    assert.equal((await call('DELETE', `/api/admin/users/${petrov.id}`, await login('ivanov@mail.ru'))).status, 403);
  });
});

test.after(() => closeDb());
