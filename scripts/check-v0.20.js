'use strict';

/**
 * Проверка сборки v0.20 (21-й день практики).
 *
 * Тема дня: автообновление статусов заказов на стороне клиента (polling).
 * Критерий приёмки: статусы обновляются на экране клиента без ручной
 * перезагрузки страницы.
 *
 * Сценарий повторяет работу страницы клиента: открывает её, загружает
 * список, затем администратор принимает и выдаёт посылку, а «страница»
 * делает очередной опрос и с помощью функций модуля ordersLive.js
 * определяет, у каких заказов сменился статус.
 *
 * Запуск:  node scripts/check-v0.20.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v020-${process.pid}.db`);
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

const PORT = Number.parseInt(process.env.CHECK_PORT || '3129', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Xk9#mQ2$vL7p';
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(method, address, token, { body, accept = 'application/json' } = {}) {
  const headers = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${address}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, body: json, headers: response.headers };
}

async function createAndLogin(name, email, role) {
  userRepository.create({ name, email, passwordHash: await hashPassword(PASSWORD), role, isConfirmed: true });
  return (await request('POST', '/api/auth/login', null, { body: { email, password: PASSWORD } })).body.token;
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — автообновление статусов заказов`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();

  const liveFile = path.join(config.rootDir, 'public', 'js', 'ordersLive.js');
  check('Модуль автообновления (public/js/ordersLive.js)', fs.existsSync(liveFile));
  const window = {};
  vm.runInNewContext(fs.readFileSync(liveFile, 'utf8'), { window });
  const live = window.PVH_LIVE;
  check('Интервал опроса — 15 секунд', live.INTERVAL_MS === 15000);

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, BASE);

  try {
    const stamp = Date.now();
    const clientEmail = `ivanov_${stamp}@mail.ru`;
    const adminToken = await createAndLogin('Администратор ПВЗ', `admin_${stamp}@mail.ru`, 'admin');
    const clientToken = await createAndLogin('Иванов Иван', clientEmail, 'client');

    const page = await request('GET', '/orders', clientToken, { accept: 'text/html' });
    check('Страница клиента подключает автообновление', page.text.includes('/js/ordersLive.js'));
    check('На странице индикатор обновления', page.text.includes('id="orders-live"'));
    check('Индикатор объявляется программам чтения (aria-live)', /id="orders-live" aria-live="polite"/.test(page.text));

    await request('POST', '/api/orders/expected', adminToken, { body: { trackNumber: 'PVZ200000001', clientEmail } });
    const poll = () => request('GET', '/api/orders/my?status=all&sort=receivedAt&order=desc', clientToken);

    // --- Опрос 1: заказ в пути ---------------------------------------------------------
    const first = await poll();
    check('Опрос 1: заказ «В пути»', first.body.orders[0].status === 'В пути');
    check('Ответ списка не кешируется (всегда свежие данные)', first.headers.get('cache-control') === 'no-store');

    // --- Администратор принимает посылку -----------------------------------------------
    await request('POST', '/api/orders', adminToken, { body: { trackNumber: 'PVZ200000001', clientEmail } });
    const second = await poll();
    const diff1 = live.diffOrders(first.body.orders, second.body.orders);
    check('Опрос 2: обнаружена смена статуса', diff1.changed.length === 1);
    const message = live.describe(diff1.changed[0]);
    check('Сообщение клиенту называет статус и ячейку', /Готов к выдаче», ячейка № \d+/.test(message), message);
    check('Счётчик вкладки «Готов к выдаче» обновился', second.body.counts.ready === 1);

    // --- Опрос без изменений -----------------------------------------------------------
    const third = await poll();
    const diff2 = live.diffOrders(second.body.orders, third.body.orders);
    check('Опрос 3: без изменений — сообщения нет', diff2.changed.length === 0 && diff2.added.length === 0);

    // --- Администратор выдаёт заказ ----------------------------------------------------
    await request('POST', `/api/orders/${second.body.orders[0].id}/issue`, adminToken);
    const fourth = await poll();
    const diff3 = live.diffOrders(third.body.orders, fourth.body.orders);
    check('Опрос 4: статус «Выдан» обнаружен', diff3.changed.length === 1 && diff3.changed[0].status === 'Выдан');

    // --- Новый заказ ---------------------------------------------------------------------
    await request('POST', '/api/orders', adminToken, { body: { trackNumber: 'PVZ200000002', clientEmail } });
    const fifth = await poll();
    check('Опрос 5: новый заказ обнаружен', live.diffOrders(fourth.body.orders, fifth.body.orders).added.length === 1);

    check('При ошибках сети интервал растёт до 2 минут', live.nextDelay(60000, true) === 120000
      && live.nextDelay(120000, false) === 15000);

    const liveJs = fs.readFileSync(liveFile, 'utf8');
    check('Скрытая вкладка ставит опрос на паузу', liveJs.includes("visibilityState === 'hidden'"));

    const health = await request('GET', '/health');
    check('Эндпоинт /health по-прежнему возвращает OK', health.body?.status === 'OK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${TMP_DB}${suffix}`, { force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log('-'.repeat(78));
  console.log(`Всего проверок: ${results.length}, пройдено: ${results.length - failed.length}, ошибок: ${failed.length}`);
  if (failed.length === 0) {
    console.log(`РЕЗУЛЬТАТ: сборка v${config.version} соответствует критерию приёмки — `
      + 'статусы обновляются на экране клиента без перезагрузки страницы.');
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
