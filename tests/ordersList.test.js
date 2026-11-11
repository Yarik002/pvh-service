'use strict';

/**
 * Тесты списков заказов (16-й день практики).
 *
 * Проверяется:
 *   • «Мои заказы» отдают только заказы текущего пользователя;
 *   • «Все заказы» доступны только администратору;
 *   • фильтр по статусу (русское название и латинское обозначение);
 *   • сортировка по дате, трек-номеру, статусу, ячейке и клиенту;
 *   • поиск по части трек-номера, описания, имени и адреса клиента;
 *   • счётчики заказов по статусам для вкладок фильтра;
 *   • недопустимые значения параметров отклоняются с понятной ошибкой.
 *
 * Запуск:  node tests/ordersList.test.js
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
const orderRepository = require('../src/repositories/orderRepository');
const orderService = require('../src/services/orderService');

const PASSWORD = 'Xk9#mQ2$vL7p';

/**
 * Готовит базу: 20 ячеек, два клиента, администратор и шесть заказов
 * во всех трёх статусах с разными датами.
 */
async function prepare() {
  runMigrations();
  const db = getDb();
  db.exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');

  const insertCell = db.prepare("INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')");
  for (let number = 1; number <= 20; number += 1) insertCell.run(number);

  const passwordHash = await hashPassword(PASSWORD);
  const ivanov = userRepository.create({
    name: 'Иванов Иван', email: 'ivanov@mail.ru', passwordHash, role: 'client', isConfirmed: true,
  });
  const petrov = userRepository.create({
    name: 'Петров Пётр', email: 'petrov@mail.ru', passwordHash, role: 'client', isConfirmed: true,
  });
  const admin = userRepository.create({
    name: 'Администратор', email: 'admin@mail.ru', passwordHash, role: 'admin', isConfirmed: true,
  });

  const cellId = (number) => db.prepare('SELECT id FROM Storage_Cells WHERE cell_number = ?').get(number).id;
  const insertOrder = db.prepare(
    `INSERT INTO Orders (track_number, description, user_id, cell_id, status, received_at, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const busy = db.prepare("UPDATE Storage_Cells SET status = 'Занята' WHERE id = ?");

  // Заказы Иванова: два готовы к выдаче, один выдан, один в пути
  insertOrder.run('PVZ000000001', 'Книга', ivanov.id, cellId(3), 'Готов к выдаче', '2026-10-01 10:00:00', null);
  insertOrder.run('PVZ000000002', 'Наушники', ivanov.id, cellId(1), 'Готов к выдаче', '2026-10-03 12:00:00', null);
  insertOrder.run('RA100000003BY', 'Куртка', ivanov.id, cellId(5), 'Выдан', '2026-09-20 09:00:00', '2026-09-21 18:00:00');
  insertOrder.run('PVZ000000004', 'Чехол 50% скидка', ivanov.id, null, 'В пути', null, null);
  // Заказы Петрова: один готов к выдаче, один в пути
  insertOrder.run('PVZ000000005', 'Зарядное устройство', petrov.id, cellId(2), 'Готов к выдаче', '2026-10-02 15:30:00', null);
  insertOrder.run('PVZ000000006', null, petrov.id, null, 'В пути', null, null);
  [3, 1, 2].forEach((number) => busy.run(cellId(number)));

  return { ivanov, petrov, admin };
}

/** Поднимает сервер на свободном порту и выполняет сценарий. */
async function withServer(run) {
  const users = await prepare();
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

  const get = async (path, token) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${path}`, { headers });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };

  try {
    await run({ ...users, login, get });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const tracks = (orders) => orders.map((order) => order.trackNumber);

// ---------------------------------------------------------------------------
//  Репозиторий и сервис
// ---------------------------------------------------------------------------

test('«Мои заказы» содержат только заказы клиента', async () => {
  const { ivanov } = await prepare();
  const { orders, counts } = orderService.listMyOrders({}, ivanov);

  assert.equal(orders.length, 4);
  assert.ok(orders.every((order) => order.client.id === ivanov.id));
  assert.deepEqual(counts, { all: 4, inTransit: 1, ready: 2, issued: 1 });
});

test('по умолчанию новые заказы выше, заказы без даты поступления — в конце', async () => {
  const { ivanov } = await prepare();
  const { orders } = orderService.listMyOrders({}, ivanov);

  assert.deepEqual(tracks(orders), ['PVZ000000002', 'PVZ000000001', 'RA100000003BY', 'PVZ000000004']);
});

test('сортировка по дате поступления по возрастанию', async () => {
  const { ivanov } = await prepare();
  const { orders } = orderService.listMyOrders({ sort: 'receivedAt', order: 'asc' }, ivanov);

  assert.deepEqual(tracks(orders), ['RA100000003BY', 'PVZ000000001', 'PVZ000000002', 'PVZ000000004']);
});

test('сортировка по трек-номеру, статусу и номеру ячейки', async () => {
  const { ivanov } = await prepare();

  const byTrack = orderService.listMyOrders({ sort: 'trackNumber', order: 'asc' }, ivanov).orders;
  assert.deepEqual(tracks(byTrack), ['PVZ000000001', 'PVZ000000002', 'PVZ000000004', 'RA100000003BY']);

  // Статусы сортируются по жизненному циклу заказа, а не по алфавиту
  const byStatus = orderService.listMyOrders({ sort: 'status', order: 'asc' }, ivanov).orders;
  assert.deepEqual(byStatus.map((order) => order.status),
    ['В пути', 'Готов к выдаче', 'Готов к выдаче', 'Выдан']);

  const byCell = orderService.listMyOrders({ sort: 'cell', order: 'asc' }, ivanov).orders;
  assert.deepEqual(byCell.map((order) => order.cell && order.cell.cellNumber), [1, 3, 5, null]);
});

test('фильтр по статусу принимает русское название и латинское обозначение', async () => {
  const { ivanov } = await prepare();

  const ready = orderService.listMyOrders({ status: 'Готов к выдаче' }, ivanov).orders;
  assert.equal(ready.length, 2);
  assert.ok(ready.every((order) => order.status === 'Готов к выдаче'));

  assert.equal(orderService.listMyOrders({ status: 'ready' }, ivanov).orders.length, 2);
  assert.equal(orderService.listMyOrders({ status: 'ISSUED' }, ivanov).orders.length, 1);
  assert.equal(orderService.listMyOrders({ status: 'transit' }, ivanov).orders.length, 1);
  assert.equal(orderService.listMyOrders({ status: 'all' }, ivanov).orders.length, 4);
});

test('поиск по части трек-номера и описания без учёта регистра', async () => {
  const { ivanov } = await prepare();

  assert.deepEqual(tracks(orderService.listMyOrders({ search: 'ra1000' }, ivanov).orders), ['RA100000003BY']);
  assert.deepEqual(tracks(orderService.listMyOrders({ search: 'книга' }, ivanov).orders), ['PVZ000000001']);
});

test('знаки % и _ в строке поиска ищутся как обычные символы', async () => {
  const { ivanov } = await prepare();

  assert.deepEqual(tracks(orderService.listMyOrders({ search: '50%' }, ivanov).orders), ['PVZ000000004']);
  assert.equal(orderService.listMyOrders({ search: '%' }, ivanov).orders.length, 1, '% не означает «всё»');
  assert.equal(orderService.listMyOrders({ search: '_' }, ivanov).orders.length, 0);
});

test('фильтр, поиск и сортировка применяются вместе', async () => {
  const { ivanov } = await prepare();
  const { orders } = orderService.listMyOrders({
    status: 'ready', search: 'PVZ', sort: 'receivedAt', order: 'asc',
  }, ivanov);

  assert.deepEqual(tracks(orders), ['PVZ000000001', 'PVZ000000002']);
});

test('«Все заказы»: сортировка по клиенту и отбор по клиенту', async () => {
  const { petrov } = await prepare();

  const all = orderService.listAllOrders({ sort: 'client', order: 'asc' });
  assert.equal(all.orders.length, 6);
  assert.deepEqual(all.counts, { all: 6, inTransit: 2, ready: 3, issued: 1 });
  assert.equal(all.orders[0].client.name, 'Иванов Иван');
  assert.equal(all.orders[5].client.name, 'Петров Пётр');

  const onlyPetrov = orderService.listAllOrders({ clientId: String(petrov.id) });
  assert.equal(onlyPetrov.orders.length, 2);
  assert.equal(onlyPetrov.counts.all, 2);
  assert.equal(onlyPetrov.filters.clientId, petrov.id);

  assert.deepEqual(tracks(orderService.listAllOrders({ search: 'petrov@' }).orders),
    ['PVZ000000005', 'PVZ000000006']);
});

test('недопустимые параметры списка отклоняются с кодом BAD_FILTER', async () => {
  await prepare();

  const cases = [
    [{ status: 'потерян' }, 'status'],
    [{ sort: 'password_hash' }, 'sort'],
    [{ sort: 'receivedAt; DROP TABLE Orders' }, 'sort'],
    [{ order: 'вверх' }, 'order'],
    [{ search: 'x'.repeat(101) }, 'search'],
    [{ clientId: 'abc' }, 'clientId'],
  ];

  for (const [query, field] of cases) {
    assert.throws(() => orderService.listAllOrders(query), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'BAD_FILTER');
      assert.ok(error.details[field], `ошибка указывает параметр ${field}`);
      return true;
    });
  }

  assert.equal(orderRepository.count(), 6, 'таблица заказов не пострадала');
});

test('клиенту недоступна сортировка по клиенту', async () => {
  const { ivanov } = await prepare();
  assert.throws(() => orderService.listMyOrders({ sort: 'client' }, ivanov), { code: 'BAD_FILTER' });
});

// ---------------------------------------------------------------------------
//  Адреса API
// ---------------------------------------------------------------------------

test('GET /api/orders/my отдаёт список, счётчики и применённые фильтры', async () => {
  await withServer(async ({ login, get }) => {
    const response = await get('/api/orders/my?status=ready&sort=trackNumber&order=asc',
      await login('ivanov@mail.ru'));

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.total, 2);
    assert.deepEqual(tracks(response.body.orders), ['PVZ000000001', 'PVZ000000002']);
    assert.deepEqual(response.body.counts, { all: 4, inTransit: 1, ready: 2, issued: 1 });
    assert.deepEqual(response.body.filters, {
      status: 'Готов к выдаче', search: '', sort: 'trackNumber', order: 'asc',
    });
    assert.equal(response.headers.get('cache-control'), 'no-store', 'список не кешируется');
  });
});

test('в заказе есть всё для таблицы: статус, ячейка, даты, получатель', async () => {
  await withServer(async ({ login, get }) => {
    const { body } = await get('/api/orders/my?status=issued', await login('ivanov@mail.ru'));
    const [order] = body.orders;

    assert.equal(order.trackNumber, 'RA100000003BY');
    assert.equal(order.status, 'Выдан');
    assert.equal(order.cell.cellNumber, 5);
    assert.equal(order.receivedAt, '2026-09-20T09:00:00.000Z');
    assert.equal(order.issuedAt, '2026-09-21T18:00:00.000Z');
    assert.equal(order.client.email, 'ivanov@mail.ru');
  });
});

test('GET /api/orders доступен администратору, клиенту — нет', async () => {
  await withServer(async ({ login, get }) => {
    const admin = await get('/api/orders?status=В пути', await login('admin@mail.ru'));
    assert.equal(admin.status, 200);
    assert.equal(admin.body.total, 2);
    assert.ok(admin.body.orders.every((order) => order.status === 'В пути'));

    assert.equal((await get('/api/orders', await login('ivanov@mail.ru'))).status, 403);
    assert.equal((await get('/api/orders', null)).status, 401);
    assert.equal((await get('/api/orders/my', null)).status, 401);
  });
});

test('ошибка фильтра возвращается в едином формате с указанием параметра', async () => {
  await withServer(async ({ login, get }) => {
    const response = await get('/api/orders/my?sort=password', await login('ivanov@mail.ru'));

    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'BAD_FILTER');
    assert.ok(response.body.error.details.sort);
  });
});

test('адрес /api/orders/my не перехватывается маршрутом /api/orders/:id', async () => {
  await withServer(async ({ login, get }) => {
    const token = await login('petrov@mail.ru');
    const response = await get('/api/orders/my', token);

    assert.equal(response.status, 200);
    assert.equal(response.body.total, 2);
    assert.ok(response.body.orders.every((order) => order.client.email === 'petrov@mail.ru'));
  });
});

test.after(() => closeDb());
