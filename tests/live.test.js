'use strict';

/**
 * Тесты автообновления статусов заказов (21-й день практики).
 *
 * Функции модуля public/js/ordersLive.js выполняются в изолированном
 * контексте (как в браузере, но без страницы): сравнение списков,
 * текст сообщения о смене статуса, интервал опроса после ошибок.
 * Отдельно проверяется, что страница подключает модуль и что новый
 * статус действительно приходит при повторном запросе.
 *
 * Запуск:  node tests/live.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';
process.env.LOGIN_LIMIT_MAX = '500';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { hashPassword } = require('../src/utils/password');
const userRepository = require('../src/repositories/userRepository');
const orderService = require('../src/services/orderService');

const LIVE_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ordersLive.js'), 'utf8');

function loadLive() {
  const window = {};
  vm.runInNewContext(LIVE_JS, { window });
  return window.PVH_LIVE;
}

const order = (id, status, cellNumber) => ({
  id, trackNumber: `PVZ21000000${id}`, status, cell: cellNumber ? { cellNumber } : null,
});

test('модуль загружается без страницы и открывает свои функции', () => {
  const live = loadLive();
  assert.equal(typeof live.diffOrders, 'function');
  assert.equal(live.INTERVAL_MS, 15000, 'опрос раз в 15 секунд');
});

test('смена статуса обнаруживается', () => {
  const { diffOrders } = loadLive();
  const result = diffOrders(
    [order(1, 'В пути'), order(2, 'Готов к выдаче', 3)],
    [order(1, 'Готов к выдаче', 7), order(2, 'Готов к выдаче', 3)],
  );
  assert.deepEqual(Array.from(result.changed, (o) => o.id), [1]);
  assert.equal(result.added.length, 0);
});

test('новый заказ отличается от смены статуса', () => {
  const { diffOrders } = loadLive();
  const result = diffOrders([order(1, 'В пути')], [order(1, 'В пути'), order(2, 'Готов к выдаче', 1)]);
  assert.deepEqual(Array.from(result.added, (o) => o.id), [2]);
  assert.equal(result.changed.length, 0);
});

test('без изменений — пустой результат; первый запрос не считается изменением', () => {
  const { diffOrders } = loadLive();
  assert.deepEqual(JSON.parse(JSON.stringify(diffOrders([order(1, 'Выдан')], [order(1, 'Выдан')]))), { changed: [], added: [] });
  assert.equal(diffOrders([], [order(1, 'Выдан')]).changed.length, 0);
});

test('сообщение называет статус и номер ячейки', () => {
  const { describe } = loadLive();
  assert.equal(describe(order(1, 'Готов к выдаче', 7)), 'Заказ PVZ210000001 — «Готов к выдаче», ячейка № 7.');
  assert.equal(describe(order(2, 'Выдан', 7)), 'Заказ PVZ210000002 — «Выдан».');
});

test('после ошибок интервал растёт до 2 минут, после успеха — снова 15 секунд', () => {
  const { nextDelay } = loadLive();
  assert.equal(nextDelay(15000, true), 30000);
  assert.equal(nextDelay(60000, true), 120000);
  assert.equal(nextDelay(120000, true), 120000, 'не больше предела');
  assert.equal(nextDelay(120000, false), 15000);
});

test('скрытая вкладка ставит опрос на паузу, возврат — обновляет сразу', () => {
  assert.ok(LIVE_JS.includes("document.visibilityState === 'hidden'"));
  assert.ok(LIVE_JS.includes("addEventListener('visibilitychange'"));
});

test('страница заказов подключает автообновление после сценария списка', () => {
  const pages = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'pages.js'), 'utf8');
  assert.ok(pages.includes("'/js/orders.js', '/js/ordersLive.js'"));
});

test('новый статус приходит при повторном запросе списка', async () => {
  runMigrations();
  getDb().exec('DELETE FROM Orders; DELETE FROM Users;');
  const client = userRepository.create({
    name: 'Иванов Иван', email: 'ivanov@mail.ru', passwordHash: await hashPassword('Xk9#mQ2$vL7p'), role: 'client', isConfirmed: true,
  });
  orderService.createExpectedOrder({ trackNumber: 'PVZ210000009', clientEmail: 'ivanov@mail.ru' });

  const before = orderService.listMyOrders({}, client).orders;
  await orderService.receiveOrder({ trackNumber: 'PVZ210000009', clientEmail: 'ivanov@mail.ru' });
  const after = orderService.listMyOrders({}, client).orders;

  const { changed } = loadLive().diffOrders(JSON.parse(JSON.stringify(before)), JSON.parse(JSON.stringify(after)));
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'Готов к выдаче');
});

test.after(() => closeDb());
