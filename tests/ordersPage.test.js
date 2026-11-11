'use strict';

/**
 * Тесты страниц «Мои заказы» и «Все заказы» (17-й день практики).
 *
 * Проверяется:
 *   • страница /orders открывается клиенту и администратору, гостю — нет;
 *   • вместо заглушки показаны таблица заказов и панель фильтров;
 *   • у администратора есть столбцы «Клиент» и «Действия», у клиента — нет;
 *   • каждое поле сортировки из заголовков таблицы принимается API;
 *   • сценарий страницы обращается к API списков с параметрами фильтра;
 *   • разметка строится через textContent (защита от внедрения HTML).
 *
 * Запуск:  node tests/ordersPage.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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
const { renderOrdersContent } = require('../src/views/ordersPage');

const PASSWORD = 'Xk9#mQ2$vL7p';
const ORDERS_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'orders.js'), 'utf8');
const API_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');

/** Поднимает сервер с клиентом и администратором и выполняет сценарий. */
async function withServer(run) {
  runMigrations();
  getDb().exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users;');
  const passwordHash = await hashPassword(PASSWORD);
  userRepository.create({ name: 'Иванов Иван', email: 'ivanov@mail.ru', passwordHash, role: 'client', isConfirmed: true });
  userRepository.create({ name: 'Администратор', email: 'admin@mail.ru', passwordHash, role: 'admin', isConfirmed: true });

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

  const get = async (address, token, accept = 'text/html') => {
    const headers = { Accept: accept };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${address}`, { headers, redirect: 'manual' });
    return { status: response.status, text: await response.text(), location: response.headers.get('location') };
  };

  try {
    await run({ login, get });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
//  Разметка
// ---------------------------------------------------------------------------

test('клиенту: «Мои заказы», без столбцов «Клиент» и «Действия»', () => {
  const html = renderOrdersContent({ isAdmin: false });

  assert.ok(html.includes('<h1>Мои заказы</h1>'));
  assert.ok(html.includes('id="orders-table"'));
  assert.ok(html.includes('data-admin="false"'));
  assert.ok(!html.includes('data-sort="client"'), 'нет сортировки по клиенту');
  assert.ok(!html.includes('>Действия<'));
  assert.ok(html.includes('id="pickup-banner"'), 'плашка «заказы ждут выдачи»');
});

test('администратору: «Все заказы» со столбцами «Клиент» и «Действия»', () => {
  const html = renderOrdersContent({ isAdmin: true });

  assert.ok(html.includes('<h1>Все заказы</h1>'));
  assert.ok(html.includes('data-admin="true"'));
  assert.ok(html.includes('data-sort="client"'));
  assert.ok(html.includes('>Действия<'));
  assert.ok(html.includes('href="/receive"'), 'переход к приёмке посылки');
  assert.ok(!html.includes('id="pickup-banner"'));
});

test('панель фильтров: вкладки статусов со счётчиками, поиск и сортировка', () => {
  const html = renderOrdersContent({ isAdmin: true });

  for (const status of ['all', 'transit', 'ready', 'issued']) {
    assert.ok(html.includes(`data-status="${status}"`), `вкладка ${status}`);
    assert.ok(html.includes(`id="count-${status}"`), `счётчик ${status}`);
  }
  assert.ok(html.includes('id="orders-search"') && html.includes('type="search"'));
  assert.ok(html.includes('maxlength="100"'), 'длина поиска совпадает с ограничением API');
  assert.ok(html.includes('id="orders-sort"'));
  assert.ok(html.includes('aria-sort="none"'), 'заголовки сообщают о сортировке программам чтения');
  assert.ok(html.includes('id="orders-empty"'), 'сообщение для пустого списка');
});

test('каждое поле сортировки на странице допустимо для API', () => {
  const { SORT_COLUMNS } = require('../src/repositories/orderRepository');
  const html = renderOrdersContent({ isAdmin: true });

  const fromHeaders = [...html.matchAll(/data-sort="(\w+)"/g)].map((match) => match[1]);
  const fromSelect = [...html.matchAll(/<option value="(\w+):(asc|desc)"/g)].map((match) => match[1]);

  assert.ok(fromHeaders.length >= 5);
  for (const key of [...fromHeaders, ...fromSelect]) {
    assert.ok(Object.prototype.hasOwnProperty.call(SORT_COLUMNS, key), `поле ${key} есть в API`);
  }
});

// ---------------------------------------------------------------------------
//  Сценарий страницы
// ---------------------------------------------------------------------------

test('сценарий обращается к API списков с параметрами фильтра', () => {
  assert.ok(API_JS.includes("request('GET', '/orders/my'"), 'метод myOrders');
  assert.ok(API_JS.includes("request('GET', '/orders'"), 'метод allOrders');

  assert.ok(ORDERS_JS.includes('API.allOrders(apiQuery(), options)'));
  assert.ok(ORDERS_JS.includes('API.myOrders(apiQuery(), options)'));
  for (const param of ["params.set('status'", "params.set('sort'", "params.set('order'", "params.set('search'"]) {
    assert.ok(ORDERS_JS.includes(param), `передаётся ${param}`);
  }
});

test('фильтры сохраняются в адресе страницы', () => {
  assert.ok(ORDERS_JS.includes('history.replaceState'));
  assert.ok(ORDERS_JS.includes('new URLSearchParams(window.location.search)'));
});

test('повторное нажатие на заголовок меняет направление сортировки', () => {
  assert.match(ORDERS_JS, /state\.order = state\.order === 'asc' \? 'desc' : 'asc'/);
});

test('данные заказов выводятся через textContent, а не innerHTML', () => {
  assert.ok(!/innerHTML\s*=/.test(ORDERS_JS), 'innerHTML не используется');
  assert.ok(ORDERS_JS.includes('textContent'));
});

test('устаревший ответ не перезаписывает новый список', () => {
  assert.ok(ORDERS_JS.includes('current !== requestId'));
});

// ---------------------------------------------------------------------------
//  Страница на сервере
// ---------------------------------------------------------------------------

test('страница /orders: клиенту и администратору — свой вариант', async () => {
  await withServer(async ({ login, get }) => {
    const client = await get('/orders', await login('ivanov@mail.ru'));
    assert.equal(client.status, 200);
    assert.ok(client.text.includes('<h1>Мои заказы</h1>'));
    assert.ok(client.text.includes('/js/orders.js') && client.text.includes('/js/api.js'));
    assert.ok(!client.text.includes('Раздел находится в разработке'));

    const admin = await get('/orders', await login('admin@mail.ru'));
    assert.equal(admin.status, 200);
    assert.ok(admin.text.includes('<h1>Все заказы</h1>'));
    assert.ok(admin.text.includes('>Все заказы</a>'), 'пункт меню администратора называется «Все заказы»');
  });
});

test('гостя страница заказов отправляет на вход', async () => {
  await withServer(async ({ get }) => {
    const page = await get('/orders', null);
    assert.ok([302, 401].includes(page.status), `статус ${page.status}`);
  });
});

test('адрес /orders.html по-прежнему ведёт на /orders', async () => {
  await withServer(async ({ get }) => {
    const page = await get('/orders.html?status=ready', null);
    assert.equal(page.status, 301);
    assert.equal(page.location, '/orders?status=ready');
  });
});

test.after(() => closeDb());
