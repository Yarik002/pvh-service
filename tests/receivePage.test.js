'use strict';

/**
 * Тесты страницы «Приёмка товара» (15-й день практики).
 *
 * Проверяется:
 *   • страница открывается только администратору и содержит форму приёмки;
 *   • поля формы названы так же, как поля запроса POST /api/orders;
 *   • правила проверки полей в браузере совпадают с серверными;
 *   • из группы переключателей учитывается только выбранный;
 *   • последовательность запросов, которую выполняет страница, приводит
 *     к приёмке заказа и занятию ячейки.
 *
 * Запуск:  node tests/receivePage.test.js
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
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/password');
const { validate } = require('../src/validators/rules');
const { receiveOrderSchema } = require('../src/validators/schemas');
const userRepository = require('../src/repositories/userRepository');

const PASSWORD = 'Xk9#mQ2$vL7p';
const PUBLIC_JS = path.join(__dirname, '..', 'public', 'js');

/** Загружает модуль проверки полей в изолированном контексте. */
function loadFormModule() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC_JS, 'form.js'), 'utf8'), {
    window,
    document: { querySelector: () => null },
  });
  return window.PVH_FORM;
}

const FORM = loadFormModule();

/** Готовит базу данных и поднимает сервер. */
async function withServer(run) {
  runMigrations();
  getDb().exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');
  const insert = getDb().prepare("INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')");
  getDb().transaction(() => {
    for (let number = 1; number <= 20; number += 1) insert.run(number);
  })();

  const passwordHash = await hashPassword(PASSWORD);
  userRepository.create({ name: 'Администратор', email: 'admin@mail.ru', passwordHash, role: 'admin', isConfirmed: true });
  userRepository.create({ name: 'Иванов Иван', email: 'ivanov@mail.ru', passwordHash, role: 'client', isConfirmed: true });

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

  const request = async (method, address, token, { body, accept = 'application/json' } = {}) => {
    const headers = { Accept: accept };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${address}`, {
      method, headers, body: body && JSON.stringify(body), redirect: 'manual',
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, text, body: json };
  };

  try {
    await run({ login, request });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
//  Страница
// ---------------------------------------------------------------------------

test('администратор видит форму приёмки вместо заглушки', async () => {
  await withServer(async ({ login, request }) => {
    const page = await request('GET', '/receive', await login('admin@mail.ru'), { accept: 'text/html' });

    assert.equal(page.status, 200);
    assert.ok(page.text.includes('id="receive-form"'));
    assert.ok(!page.text.includes('Раздел находится в разработке'));
    for (const script of ['/js/api.js', '/js/form.js', '/js/receive.js']) {
      assert.ok(page.text.includes(script), `подключён ${script}`);
    }
  });
});

test('поля формы названы как поля запроса POST /api/orders', async () => {
  await withServer(async ({ login, request }) => {
    const page = await request('GET', '/receive', await login('admin@mail.ru'), { accept: 'text/html' });

    for (const name of ['trackNumber', 'clientEmail', 'description', 'cellMode', 'cellId']) {
      assert.ok(page.text.includes(`name="${name}"`), `поле ${name}`);
      assert.ok(page.text.includes(`data-field="${name}"`), `место для ошибки поля ${name}`);
    }
    assert.ok(page.text.includes('value="auto" checked'), 'по умолчанию ячейка выбирается автоматически');
    assert.ok(page.text.includes('id="cell-preview"'), 'показ назначаемой ячейки');
    assert.ok(page.text.includes('id="result-cell"'), 'крупный номер ячейки после приёмки');
  });
});

test('страница приёмки недоступна клиенту и гостю', async () => {
  await withServer(async ({ login, request }) => {
    const forClient = await request('GET', '/receive', await login('ivanov@mail.ru'), { accept: 'text/html' });
    const forGuest = await request('GET', '/receive', null, { accept: 'text/html' });

    assert.equal(forClient.status, 403);
    assert.equal(forGuest.status, 401);
  });
});

test('сценарий страницы обращается к нужным адресам API', () => {
  const source = fs.readFileSync(path.join(PUBLIC_JS, 'receive.js'), 'utf8');
  const api = fs.readFileSync(path.join(PUBLIC_JS, 'api.js'), 'utf8');

  for (const method of ['API.receiveOrder', 'API.suggestCell', 'API.freeCells', 'API.adminUsers']) {
    assert.ok(source.includes(method), method);
  }
  assert.ok(api.includes("request('POST', '/orders'"));
  assert.ok(api.includes("'/cells/suggest?'"));
  assert.ok(!/\.innerHTML\s*=/.test(source), 'данные выводятся без innerHTML');
});

// ---------------------------------------------------------------------------
//  Проверка полей в браузере
// ---------------------------------------------------------------------------

test('правила трек-номера в браузере совпадают с серверными', () => {
  const samples = ['RA123456789BY', 'ra123456789by', 'PVZ-0001', '123456', '12345', '', 'RA 12345',
    'трек123456', '-ABCDEF', 'ABCDEF-', 'A'.repeat(40), 'A'.repeat(41)];

  for (const value of samples) {
    const client = FORM.RULES.trackNumber(value) === null;
    let server = true;
    try {
      validate({ trackNumber: value }, { trackNumber: receiveOrderSchema.trackNumber });
    } catch {
      server = false;
    }
    assert.equal(client, server, `трек-номер «${value}»: браузер ${client}, сервер ${server}`);
  }
});

test('сообщение о неверном трек-номере совпадает с серверным', () => {
  let serverMessage = '';
  try {
    validate({ trackNumber: '12' }, { trackNumber: receiveOrderSchema.trackNumber });
  } catch (error) {
    serverMessage = error.message;
  }
  assert.equal(FORM.RULES.trackNumber('12'), serverMessage);
});

test('пустой трек-номер — одинаковое понятное сообщение в браузере и на сервере', () => {
  let serverMessage = '';
  try {
    validate({ trackNumber: '  ' }, { trackNumber: receiveOrderSchema.trackNumber });
  } catch (error) {
    serverMessage = error.message;
  }
  assert.equal(serverMessage, 'Укажите трек-номер');
  assert.equal(FORM.RULES.trackNumber('  '), serverMessage);
});

test('атрибут hidden скрывает блоки формы независимо от их класса', () => {
  // Найдено при проверке в браузере: .field { display: flex } перебивал hidden,
  // и список ячеек для ручного выбора был виден в автоматическом режиме
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'main.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});

test('получатель обязателен и проверяется по формату адреса', () => {
  assert.equal(FORM.RULES.clientEmail(''), 'Укажите получателя заказа');
  assert.match(FORM.RULES.clientEmail('ivanov@mail'), /корректный адрес/);
  assert.equal(FORM.RULES.clientEmail('ivanov@mail.ru'), null);
});

test('описание необязательно, но не длиннее 500 символов', () => {
  assert.equal(FORM.RULES.description(''), null);
  assert.equal(FORM.RULES.description('а'.repeat(500)), null);
  assert.match(FORM.RULES.description('а'.repeat(501)), /не более 500/);
});

test('при ручном выборе ячейка обязательна', () => {
  assert.equal(FORM.RULES.cellId('', { cellMode: 'auto' }), null);
  assert.match(FORM.RULES.cellId('', { cellMode: 'manual' }), /Выберите ячейку/);
  assert.equal(FORM.RULES.cellId('7', { cellMode: 'manual' }), null);
});

test('из группы переключателей учитывается только выбранный', () => {
  const elements = [
    { name: 'trackNumber', type: 'text', value: 'RA123456789BY' },
    { name: 'cellMode', type: 'radio', value: 'auto', checked: false },
    { name: 'cellMode', type: 'radio', value: 'manual', checked: true },
  ];
  const form = { querySelectorAll: () => elements };

  assert.equal(FORM.collectValues(form).cellMode, 'manual');

  elements[1].checked = true;
  elements[2].checked = false;
  assert.equal(FORM.collectValues(form).cellMode, 'auto', 'раньше всегда бралось последнее значение');
});

// ---------------------------------------------------------------------------
//  Работа страницы с API
// ---------------------------------------------------------------------------

test('запросы страницы приводят к приёмке заказа', async () => {
  await withServer(async ({ login, request }) => {
    const token = await login('admin@mail.ru');

    // 1. Подсказки получателя и список свободных ячеек
    const clients = await request('GET', '/api/admin/users?role=client', token);
    assert.ok(clients.body.users.some((user) => user.email === 'ivanov@mail.ru'));

    const free = await request('GET', '/api/cells/free', token);
    assert.equal(free.body.count, 20);

    // 2. Ячейка, которая будет назначена, показывается заранее
    const manualCell = free.body.cells.find((cell) => cell.cellNumber === 5);
    const suggest = await request('GET', `/api/cells/suggest?mode=manual&cellId=${manualCell.id}`, token);
    assert.match(suggest.body.message, /№ 5/);

    // 3. Отправка формы
    const received = await request('POST', '/api/orders', token, {
      body: {
        trackNumber: 'RA123456789BY', clientEmail: 'ivanov@mail.ru', description: '',
        cellMode: 'manual', cellId: String(manualCell.id),
      },
    });
    assert.equal(received.status, 201);
    assert.equal(received.body.order.cell.cellNumber, 5);

    // 4. Страница обновляет справочник ячеек
    const after = await request('GET', '/api/cells/free', token);
    assert.equal(after.body.count, 19);
    assert.ok(!after.body.cells.some((cell) => cell.cellNumber === 5));
  });
});

test('ошибки сервера содержат поля, которые страница выводит у формы', async () => {
  await withServer(async ({ login, request }) => {
    const token = await login('admin@mail.ru');

    const noClient = await request('POST', '/api/orders', token, { body: { trackNumber: 'RA123456789BY' } });
    assert.ok(noClient.body.error.details.client, 'поле client → clientEmail');

    await request('POST', '/api/orders', token, { body: { trackNumber: 'RA000000001BY', clientEmail: 'ivanov@mail.ru' } });
    const busyCellId = getDb().prepare('SELECT id FROM Storage_Cells WHERE cell_number = 1').get().id;
    const busy = await request('POST', '/api/orders', token, {
      body: { trackNumber: 'RA000000002BY', clientEmail: 'ivanov@mail.ru', cellMode: 'manual', cellId: busyCellId },
    });
    assert.equal(busy.body.error.code, 'CELL_BUSY');
    assert.ok(busy.body.error.details.cell, 'поле cell → cellId');
  });
});

test.after(() => closeDb());
