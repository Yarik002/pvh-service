'use strict';

/**
 * Проверка сборки v0.15 (16-й день практики).
 *
 * Тема дня: API списков «Мои заказы» и «Все заказы» с фильтрацией
 * по статусу и сортировкой.
 * Критерий приёмки: API корректно отдаёт списки заказов с применением фильтров.
 *
 * Сценарий поднимает сервер на временной базе, принимает несколько заказов
 * через API (как это делает администратор на странице приёмки) и проверяет
 * списки с разными фильтрами от имени клиента и администратора.
 *
 * Запуск:  node scripts/check-v0.15.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v015-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.LOGIN_LIMIT_MAX = process.env.LOGIN_LIMIT_MAX || '500';
process.env.MAIL_TRANSPORT = 'log';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { hashPassword } = require('../src/utils/password');
const userRepository = require('../src/repositories/userRepository');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3124', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Xk9#mQ2$vL7p';
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Выполняет запрос к API. */
async function request(method, address, token, body) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${address}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, body: json, headers: response.headers };
}

/** Создаёт подтверждённого пользователя и выполняет вход. */
async function createAndLogin(name, email, role) {
  userRepository.create({ name, email, passwordHash: await hashPassword(PASSWORD), role, isConfirmed: true });
  const response = await request('POST', '/api/auth/login', null, { email, password: PASSWORD });
  return response.body.token;
}

const tracks = (response) => (response.body?.orders || []).map((order) => order.trackNumber);

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — списки «Мои заказы» и «Все заказы»`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, BASE);

  try {
    const stamp = Date.now();
    const ivanovEmail = `ivanov_${stamp}@mail.ru`;
    const petrovEmail = `petrov_${stamp}@mail.ru`;
    const adminToken = await createAndLogin('Администратор ПВЗ', `admin_${stamp}@mail.ru`, 'admin');
    const ivanovToken = await createAndLogin('Иванов Иван', ivanovEmail, 'client');
    const petrovToken = await createAndLogin('Петров Пётр', petrovEmail, 'client');

    // --- 1. Подготовка: приёмка заказов через API ----------------------------------
    const receive = (trackNumber, clientEmail, description) => request('POST', '/api/orders', adminToken,
      { trackNumber, clientEmail, description });

    const received = [
      await receive('PVZ150000001', ivanovEmail, 'Книга'),
      await receive('PVZ150000002', ivanovEmail, 'Наушники'),
      await receive('RA150000003BY', ivanovEmail, 'Куртка'),
      await receive('PVZ150000004', petrovEmail, 'Зарядное устройство'),
    ];
    check('Через API принято 4 заказа', received.every((r) => r.status === 201));

    // Один заказ выдан, один ожидается («В пути») — чтобы были все три статуса
    const db = getDb();
    db.prepare(`UPDATE Orders SET status = 'Выдан', issued_at = datetime('now')
                 WHERE track_number = 'RA150000003BY'`).run();
    db.prepare(`INSERT INTO Orders (track_number, description, user_id, status)
                VALUES ('PVZ150000005', 'Чехол', ?, 'В пути')`)
      .run(userRepository.findByEmail(ivanovEmail).id);
    check('Подготовлены заказы во всех трёх статусах', true, 'В пути, Готов к выдаче, Выдан');

    // --- 2. «Мои заказы» ----------------------------------------------------------
    const mine = await request('GET', '/api/orders/my', ivanovToken);
    check('GET /api/orders/my отвечает 200', mine.status === 200);
    check('В «Моих заказах» только заказы клиента',
      mine.body?.total === 4 && mine.body.orders.every((order) => order.client.email === ivanovEmail),
      `заказов: ${mine.body?.total}`);
    check('Счётчики по статусам для вкладок фильтра',
      JSON.stringify(mine.body?.counts) === JSON.stringify({ all: 4, inTransit: 1, ready: 2, issued: 1 }),
      JSON.stringify(mine.body?.counts));
    check('По умолчанию заказ без даты поступления в конце списка',
      tracks(mine).at(-1) === 'PVZ150000005', tracks(mine).join(', '));

    const petrovList = await request('GET', '/api/orders/my', petrovToken);
    check('Другой клиент видит только свой заказ',
      petrovList.body?.total === 1 && tracks(petrovList)[0] === 'PVZ150000004');

    // --- 3. Фильтр по статусу -------------------------------------------------------
    const ready = await request('GET', '/api/orders/my?status=ready', ivanovToken);
    check('Фильтр status=ready: только «Готов к выдаче»',
      ready.body?.total === 2 && ready.body.orders.every((order) => order.status === 'Готов к выдаче'));

    const issuedRu = await request('GET', `/api/orders/my?status=${encodeURIComponent('Выдан')}`, ivanovToken);
    check('Фильтр по русскому названию статуса «Выдан»',
      issuedRu.body?.total === 1 && tracks(issuedRu)[0] === 'RA150000003BY');

    const transit = await request('GET', '/api/orders/my?status=transit', ivanovToken);
    check('Фильтр status=transit: заказ «В пути» без ячейки',
      transit.body?.total === 1 && transit.body.orders[0].cell === null);

    // --- 4. Сортировка --------------------------------------------------------------
    const byTrackAsc = await request('GET', '/api/orders/my?sort=trackNumber&order=asc', ivanovToken);
    check('Сортировка по трек-номеру по возрастанию', tracks(byTrackAsc).join() === [
      'PVZ150000001', 'PVZ150000002', 'PVZ150000005', 'RA150000003BY'].join(), tracks(byTrackAsc).join(', '));

    const byTrackDesc = await request('GET', '/api/orders/my?sort=trackNumber&order=desc', ivanovToken);
    check('Сортировка по трек-номеру по убыванию — обратный порядок',
      tracks(byTrackDesc).join() === [...tracks(byTrackAsc)].reverse().join());

    const byStatus = await request('GET', '/api/orders/my?sort=status&order=asc', ivanovToken);
    check('Сортировка по статусу идёт по жизненному циклу заказа',
      byStatus.body?.orders.map((o) => o.status).join() === 'В пути,Готов к выдаче,Готов к выдаче,Выдан');

    const byCell = await request('GET', '/api/orders/my?sort=cell&order=asc&status=ready', ivanovToken);
    const cells = (byCell.body?.orders || []).map((order) => order.cell.cellNumber);
    check('Сортировка по номеру ячейки вместе с фильтром',
      cells.length === 2 && cells[0] < cells[1], cells.join(', '));

    // --- 5. Поиск -------------------------------------------------------------------
    const search = await request('GET', `/api/orders/my?search=${encodeURIComponent('книга')}`, ivanovToken);
    check('Поиск по описанию без учёта регистра (кириллица)', tracks(search).join() === 'PVZ150000001');

    const searchTrack = await request('GET', '/api/orders/my?search=ra15', ivanovToken);
    check('Поиск по части трек-номера', tracks(searchTrack).join() === 'RA150000003BY');

    // --- 6. «Все заказы» -----------------------------------------------------------
    const all = await request('GET', '/api/orders?sort=client&order=asc', adminToken);
    check('GET /api/orders: администратор видит все заказы',
      all.status === 200 && all.body?.total === 5, `заказов: ${all.body?.total}`);
    check('Сортировка по клиенту (только в «Всех заказах»)',
      all.body?.orders[0].client.name === 'Иванов Иван' && all.body.orders.at(-1).client.name === 'Петров Пётр');

    const byClient = await request('GET',
      `/api/orders?clientId=${userRepository.findByEmail(petrovEmail).id}`, adminToken);
    check('Отбор заказов одного клиента (clientId)', byClient.body?.total === 1);

    const searchClient = await request('GET', '/api/orders?search=petrov_', adminToken);
    check('Поиск по адресу клиента', searchClient.body?.total === 1);

    // --- 7. Права доступа и ошибки --------------------------------------------------
    check('Клиенту «Все заказы» недоступны (403)',
      (await request('GET', '/api/orders', ivanovToken)).status === 403);
    check('Без входа списки недоступны (401)',
      (await request('GET', '/api/orders/my')).status === 401);

    const badStatus = await request('GET', '/api/orders/my?status=lost', ivanovToken);
    check('Недопустимый статус: 400 BAD_FILTER с указанием параметра',
      badStatus.status === 400 && badStatus.body?.error?.code === 'BAD_FILTER'
        && Boolean(badStatus.body.error.details?.status), badStatus.body?.error?.message);

    const injection = await request('GET',
      `/api/orders?sort=${encodeURIComponent('id; DROP TABLE Orders')}`, adminToken);
    const ordersLeft = db.prepare('SELECT COUNT(*) AS n FROM Orders').get().n;
    check('Попытка внедрить SQL через сортировку отклонена, таблица цела',
      injection.status === 400 && ordersLeft === 5);

    check('Ответы со списками не кешируются', mine.headers.get('cache-control') === 'no-store');

    const index = await request('GET', '/api');
    check('Новые адреса перечислены в справке GET /api',
      Boolean(index.body?.endpoints?.myOrders && index.body?.endpoints?.allOrders));

    const health = await request('GET', '/health');
    check('Эндпоинт /health по-прежнему возвращает OK', health.body?.status === 'OK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${TMP_DB}${suffix}`, { force: true });
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log('-'.repeat(78));
  console.log(`Всего проверок: ${results.length}, пройдено: ${results.length - failed.length}, ошибок: ${failed.length}`);

  if (failed.length === 0) {
    console.log(`РЕЗУЛЬТАТ: сборка v${config.version} соответствует критерию приёмки — `
      + 'API отдаёт списки заказов с применением фильтров.');
    console.log('='.repeat(78));
    return 0;
  }

  console.log('РЕЗУЛЬТАТ: сборка НЕ прошла проверку. Не пройденные проверки:');
  failed.forEach((r) => console.log(`  • ${r.name} (${r.detail})`));
  console.log('='.repeat(78));
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    logger.error('Ошибка выполнения проверки:', error);
    closeDb();
    process.exit(1);
  });
