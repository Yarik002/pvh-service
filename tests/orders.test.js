'use strict';

/**
 * Тесты приёмки заказа (14-й день практики).
 *
 * Проверяется:
 *   • заказ сохраняется со статусом «Готов к выдаче», ячейка становится «Занята»;
 *   • автоматический и ручной выбор ячейки;
 *   • проверка трек-номера, описания и получателя;
 *   • повторная приёмка одного трек-номера невозможна;
 *   • приёмка заказа, который уже был в системе со статусом «В пути»;
 *   • транзакция: при сбое не остаётся ни заказа без ячейки, ни ячейки без заказа;
 *   • письмо клиенту о поступлении заказа (настоящий SMTP-обмен);
 *   • адреса POST /api/orders и GET /api/orders/:id и права доступа к ним.
 *
 * Запуск:  node tests/orders.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';
process.env.MAIL_FROM = 'no-reply@pvh.local';
process.env.LOGIN_LIMIT_MAX = '500';
process.env.RATE_LIMIT_MAX = '500';

const { TestSmtpServer } = require('./helpers/testSmtpServer');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/password');
const userRepository = require('../src/repositories/userRepository');
const orderRepository = require('../src/repositories/orderRepository');
const orderService = require('../src/services/orderService');
const mailer = require('../src/mail/mailer');

const PASSWORD = 'Xk9#mQ2$vL7p';

/** Готовит базу: 20 свободных ячеек, клиент и администратор. */
async function prepare() {
  runMigrations();
  getDb().exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');

  const insert = getDb().prepare("INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')");
  getDb().transaction(() => {
    for (let number = 1; number <= 20; number += 1) insert.run(number);
  })();

  const passwordHash = await hashPassword(PASSWORD);
  const client = userRepository.create({
    name: 'Иванов Иван', email: 'ivanov@mail.ru', passwordHash, role: 'client', isConfirmed: true,
  });
  const other = userRepository.create({
    name: 'Петров Пётр', email: 'petrov@mail.ru', passwordHash, role: 'client', isConfirmed: true,
  });
  const admin = userRepository.create({
    name: 'Администратор', email: 'admin@mail.ru', passwordHash, role: 'admin', isConfirmed: true,
  });

  return { client, other, admin };
}

/** Состояние ячейки по номеру. */
function cellStatus(number) {
  return getDb().prepare('SELECT status FROM Storage_Cells WHERE cell_number = ?').get(number).status;
}

/** Количество занятых ячеек. */
function busyCount() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM Storage_Cells WHERE status = 'Занята'").get().n;
}

/** Ожидает отказ приёмки с указанным статусом и кодом. */
async function assertRejects(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status, error.message);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
//  Приёмка заказа
// ---------------------------------------------------------------------------

test('принятый заказ появляется в базе, ячейка становится занятой', async () => {
  await prepare();

  const result = await orderService.receiveOrder({
    trackNumber: 'RA123456789BY',
    clientEmail: 'ivanov@mail.ru',
    description: 'Книга',
  });

  const row = getDb().prepare('SELECT * FROM Orders WHERE track_number = ?').get('RA123456789BY');
  assert.ok(row, 'заказ сохранён в базе');
  assert.equal(row.status, 'Готов к выдаче');
  assert.ok(row.received_at, 'дата поступления заполнена');
  assert.equal(row.issued_at, null);

  assert.equal(result.order.cell.cellNumber, 1, 'назначена первая свободная ячейка');
  assert.equal(cellStatus(1), 'Занята');
  assert.equal(result.order.client.email, 'ivanov@mail.ru');
  assert.equal(result.assignment.mode, 'auto');
  assert.equal(result.fromTransit, false);
});

test('следующий заказ получает следующую свободную ячейку', async () => {
  await prepare();

  await orderService.receiveOrder({ trackNumber: 'PVZ000000001', clientEmail: 'ivanov@mail.ru' });
  const second = await orderService.receiveOrder({ trackNumber: 'PVZ000000002', clientEmail: 'ivanov@mail.ru' });

  assert.equal(second.order.cell.cellNumber, 2);
  assert.equal(busyCount(), 2);
});

test('ячейку можно выбрать вручную', async () => {
  await prepare();

  const result = await orderService.receiveOrder({
    trackNumber: 'PVZ000000007',
    clientEmail: 'ivanov@mail.ru',
    cellMode: 'manual',
    cellNumber: 7,
  });

  assert.equal(result.order.cell.cellNumber, 7);
  assert.equal(result.assignment.mode, 'manual');
  assert.equal(cellStatus(7), 'Занята');
  assert.equal(cellStatus(1), 'Свободна');
});

test('получателя можно указать идентификатором', async () => {
  const { client } = await prepare();

  const result = await orderService.receiveOrder({ trackNumber: 'PVZ000000010', clientId: client.id });
  assert.equal(result.order.client.id, client.id);
});

test('трек-номер приводится к верхнему регистру', async () => {
  await prepare();

  const result = await orderService.receiveOrder({ trackNumber: '  ra123456789by ', clientEmail: 'ivanov@mail.ru' });
  assert.equal(result.order.trackNumber, 'RA123456789BY');
});

test('описание необязательно и ограничено 500 символами', async () => {
  await prepare();

  const empty = await orderService.receiveOrder({ trackNumber: 'PVZ000000011', clientEmail: 'ivanov@mail.ru' });
  assert.equal(empty.order.description, null);

  await assertRejects(orderService.receiveOrder({
    trackNumber: 'PVZ000000012', clientEmail: 'ivanov@mail.ru', description: 'а'.repeat(501),
  }), 400);
});

test('неверный трек-номер отклоняется с ошибкой у поля', async () => {
  await prepare();

  for (const trackNumber of ['', '123', 'трек12345', 'RA 123 456', '-RA12345', 'A'.repeat(41)]) {
    await assert.rejects(
      orderService.receiveOrder({ trackNumber, clientEmail: 'ivanov@mail.ru' }),
      (error) => error.status === 400 && Boolean(error.details?.trackNumber),
      `трек-номер «${trackNumber}»`,
    );
  }
  assert.equal(busyCount(), 0, 'ячейки не заняты');
});

test('получатель обязателен, должен существовать и быть клиентом', async () => {
  const { admin } = await prepare();

  await assertRejects(orderService.receiveOrder({ trackNumber: 'PVZ000000020' }), 400, 'CLIENT_REQUIRED');
  await assertRejects(orderService.receiveOrder({
    trackNumber: 'PVZ000000020', clientEmail: 'nikto@mail.ru',
  }), 404, 'CLIENT_NOT_FOUND');
  await assertRejects(orderService.receiveOrder({
    trackNumber: 'PVZ000000020', clientId: 999999,
  }), 404, 'CLIENT_NOT_FOUND');
  await assertRejects(orderService.receiveOrder({
    trackNumber: 'PVZ000000020', clientId: admin.id,
  }), 400, 'NOT_A_CLIENT');

  assert.equal(orderRepository.count(), 0);
});

test('один трек-номер нельзя принять дважды', async () => {
  await prepare();

  await orderService.receiveOrder({ trackNumber: 'PVZ000000030', clientEmail: 'ivanov@mail.ru' });

  await assert.rejects(
    orderService.receiveOrder({ trackNumber: 'pvz000000030', clientEmail: 'ivanov@mail.ru' }),
    (error) => error.status === 409 && error.code === 'TRACK_EXISTS' && /ячейке № 1/.test(error.message),
  );
  assert.equal(busyCount(), 1, 'вторая ячейка не занята');
  assert.equal(orderRepository.count(), 1);
});

test('заказ «В пути» при приёмке становится «Готов к выдаче»', async () => {
  const { client } = await prepare();
  getDb().prepare(
    "INSERT INTO Orders (track_number, description, user_id, status) VALUES (?, 'Ожидается', ?, 'В пути')",
  ).run('PVZ000000040', client.id);

  const result = await orderService.receiveOrder({ trackNumber: 'PVZ000000040', clientEmail: 'ivanov@mail.ru' });

  assert.equal(result.fromTransit, true);
  assert.equal(result.order.status, 'Готов к выдаче');
  assert.equal(result.order.description, 'Ожидается', 'прежнее описание сохранено');
  assert.equal(orderRepository.count(), 1, 'новый заказ не создан');
});

test('заказ «В пути» другого клиента принять на этого клиента нельзя', async () => {
  const { other } = await prepare();
  getDb().prepare("INSERT INTO Orders (track_number, user_id, status) VALUES (?, ?, 'В пути')")
    .run('PVZ000000041', other.id);

  await assertRejects(orderService.receiveOrder({
    trackNumber: 'PVZ000000041', clientEmail: 'ivanov@mail.ru',
  }), 409, 'TRACK_OTHER_CLIENT');
  assert.equal(busyCount(), 0);
});

// ---------------------------------------------------------------------------
//  Отказы назначения ячейки и транзакция
// ---------------------------------------------------------------------------

test('если свободных ячеек нет, заказ не принимается', async () => {
  await prepare();
  getDb().exec("UPDATE Storage_Cells SET status = 'Занята'");

  await assertRejects(orderService.receiveOrder({
    trackNumber: 'PVZ000000050', clientEmail: 'ivanov@mail.ru',
  }), 409, 'NO_FREE_CELLS');
  assert.equal(orderRepository.count(), 0);
});

test('в занятую ячейку заказ не кладётся', async () => {
  await prepare();
  await orderService.receiveOrder({ trackNumber: 'PVZ000000051', clientEmail: 'ivanov@mail.ru' });

  await assertRejects(orderService.receiveOrder({
    trackNumber: 'PVZ000000052', clientEmail: 'ivanov@mail.ru', cellMode: 'manual', cellNumber: 1,
  }), 409, 'CELL_BUSY');
  assert.equal(orderRepository.count(), 1);
});

test('при сбое сохранения заказа ячейка остаётся свободной', async () => {
  await prepare();

  const original = orderRepository.createReceived;
  orderRepository.createReceived = () => { throw new Error('сбой записи заказа'); };

  try {
    await assert.rejects(
      orderService.receiveOrder({ trackNumber: 'PVZ000000060', clientEmail: 'ivanov@mail.ru' }),
      /сбой записи заказа/,
    );
  } finally {
    orderRepository.createReceived = original;
  }

  assert.equal(cellStatus(1), 'Свободна', 'занятие ячейки отменено');
  assert.equal(orderRepository.count(), 0);
});

// ---------------------------------------------------------------------------
//  Письмо клиенту
// ---------------------------------------------------------------------------

test('клиенту отправляется письмо о поступлении заказа', async () => {
  await prepare();
  const server = new TestSmtpServer();
  const port = await server.listen();
  mailer.resetForTests({
    MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_SECURE: 'false', SMTP_PORT: port,
  });

  try {
    const result = await orderService.receiveOrder({
      trackNumber: 'RA555555555BY', clientEmail: 'ivanov@mail.ru', description: 'Наушники',
    });

    assert.equal(result.notification.sent, true, result.notification.error || '');
    assert.equal(server.messages.length, 1);

    const parsed = server.parseLastMessage();
    assert.equal(parsed.message.to[0], 'ivanov@mail.ru');

    const subject = TestSmtpServer.decodeHeader(parsed.headers.subject);
    assert.match(subject, /RA555555555BY/);

    const [text] = TestSmtpServer.extractParts(parsed);
    assert.ok(text.text.includes('Ячейка: 1'), 'в письме указана ячейка');
    assert.ok(text.text.includes('Наушники'), 'в письме указано описание');
  } finally {
    mailer.resetForTests({ MAIL_TRANSPORT: 'log' });
    await server.close();
  }
});

test('ошибка отправки письма не отменяет приёмку', async () => {
  await prepare();
  // Почтовый сервер недоступен: соединение будет отклонено
  mailer.resetForTests({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_SECURE: 'false', SMTP_PORT: 1 });

  try {
    const result = await orderService.receiveOrder({ trackNumber: 'PVZ000000070', clientEmail: 'ivanov@mail.ru' });

    assert.equal(result.notification.sent, false);
    assert.equal(result.notification.status, 'failed');
    assert.equal(result.order.status, 'Готов к выдаче', 'заказ принят');
    assert.equal(cellStatus(1), 'Занята');
  } finally {
    mailer.resetForTests({ MAIL_TRANSPORT: 'log' });
  }
});

// ---------------------------------------------------------------------------
//  REST API
// ---------------------------------------------------------------------------

/** Поднимает сервер и выполняет сценарий. */
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

  const call = async (method, path, token, body) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  try {
    await run({ ...users, login, call });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /api/orders принимает заказ (201)', async () => {
  await withServer(async ({ login, call }) => {
    const token = await login('admin@mail.ru');
    const response = await call('POST', '/api/orders', token, {
      trackNumber: 'RA111111111BY', clientEmail: 'ivanov@mail.ru', description: 'Куртка',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.order.status, 'Готов к выдаче');
    assert.equal(response.body.order.cell.cellNumber, 1);
    assert.match(response.body.message, /размещён в ячейке № 1/);
    assert.equal(response.body.notification.logged, true, 'в режиме log письмо выведено в журнал');

    const free = await call('GET', '/api/cells/free', token);
    assert.equal(free.body.count, 19, 'занятая ячейка исчезла из свободных');
  });
});

test('POST /api/orders возвращает ошибки полей в едином формате', async () => {
  await withServer(async ({ login, call }) => {
    const token = await login('admin@mail.ru');
    const response = await call('POST', '/api/orders', token, { trackNumber: '12' });

    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.ok(response.body.error.details.trackNumber);
  });
});

test('принимать заказы может только администратор', async () => {
  await withServer(async ({ login, call }) => {
    const clientToken = await login('ivanov@mail.ru');
    const body = { trackNumber: 'PVZ000000080', clientEmail: 'ivanov@mail.ru' };

    assert.equal((await call('POST', '/api/orders', clientToken, body)).status, 403);
    assert.equal((await call('POST', '/api/orders', null, body)).status, 401);
    assert.equal(orderRepository.count(), 0);
  });
});

test('клиент видит свой заказ, но не чужой', async () => {
  await withServer(async ({ login, call }) => {
    const adminToken = await login('admin@mail.ru');
    const created = await call('POST', '/api/orders', adminToken, {
      trackNumber: 'PVZ000000090', clientEmail: 'ivanov@mail.ru',
    });
    const id = created.body.order.id;

    const own = await call('GET', `/api/orders/${id}`, await login('ivanov@mail.ru'));
    assert.equal(own.status, 200);
    assert.equal(own.body.order.trackNumber, 'PVZ000000090');

    const foreign = await call('GET', `/api/orders/${id}`, await login('petrov@mail.ru'));
    assert.equal(foreign.status, 404, 'чужой заказ «не существует»');

    const forAdmin = await call('GET', `/api/orders/${id}`, adminToken);
    assert.equal(forAdmin.status, 200);

    assert.equal((await call('GET', '/api/orders/abc', adminToken)).status, 400);
  });
});

test.after(() => closeDb());
