'use strict';

/**
 * Проверка сборки v0.16 (17-й день практики).
 *
 * Тема дня: страницы отображения заказов в виде таблиц с панелью фильтров.
 * Критерий приёмки: списки заказов отображаются в браузере с работающей
 * сортировкой.
 *
 * Сценарий открывает страницы так же, как браузер, проверяет разметку
 * таблицы и панели фильтров, а затем выполняет те же запросы, что сценарий
 * страницы при нажатии на вкладки и заголовки столбцов. Дополнительно
 * проверяется новое оформление интерфейса и вход администратора по логину.
 *
 * Ручная проверка в браузере описана в отчёте за 17-й день.
 *
 * Запуск:  node scripts/check-v0.16.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v016-${process.pid}.db`);
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

const PORT = Number.parseInt(process.env.CHECK_PORT || '3125', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Xk9#mQ2$vL7p';
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Выполняет запрос. */
async function request(method, address, token, { body, accept = 'application/json' } = {}) {
  const headers = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${address}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, body: json, headers: response.headers };
}

async function login(email, password = PASSWORD) {
  return (await request('POST', '/api/auth/login', null, { body: { email, password } })).body?.token;
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — страницы заказов с таблицами и фильтрами`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();

  for (const [file, label] of [
    ['src/views/ordersPage.js', 'разметка страницы заказов'],
    ['public/js/orders.js', 'сценарий страницы заказов'],
  ]) {
    check(`Модуль: ${label}`, fs.existsSync(path.join(config.rootDir, file)), file);
  }

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, BASE);

  try {
    const stamp = Date.now();
    const clientEmail = `ivanov_${stamp}@mail.ru`;
    const passwordHash = await hashPassword(PASSWORD);
    userRepository.create({ name: 'Иванов Иван', email: clientEmail, passwordHash, role: 'client', isConfirmed: true });
    // Администратор с паролем admin: вход по короткому логину admin
    userRepository.create({
      name: 'Администратор ПВЗ', email: config.seed.adminEmail,
      passwordHash: await hashPassword('admin'), role: 'admin', isConfirmed: true,
    });

    const adminToken = await login('admin', 'admin');
    check('Вход администратора по логину admin и паролю admin', Boolean(adminToken));
    const clientToken = await login(clientEmail);

    // Три заказа клиента через API приёмки, один выдан
    for (const [track, desc] of [['PVZ160000001', 'Книга'], ['PVZ160000002', 'Наушники'], ['RA160000003BY', 'Куртка']]) {
      await request('POST', '/api/orders', adminToken, { body: { trackNumber: track, clientEmail, description: desc } });
    }
    getDb().prepare(`UPDATE Orders SET status = 'Выдан', issued_at = datetime('now')
                      WHERE track_number = 'RA160000003BY'`).run();
    getDb().prepare("UPDATE Storage_Cells SET status = 'Свободна' WHERE cell_number = 3").run();

    // --- 1. Страница клиента ---------------------------------------------------------
    const clientPage = await request('GET', '/orders', clientToken, { accept: 'text/html' });
    check('Страница /orders открывается клиенту (200)', clientPage.status === 200);
    check('Вместо заглушки — таблица «Мои заказы»',
      clientPage.text.includes('<h1>Мои заказы</h1>') && clientPage.text.includes('id="orders-table"')
        && !clientPage.text.includes('Раздел находится в разработке'));
    check('Панель фильтров: вкладки статусов со счётчиками',
      ['all', 'transit', 'ready', 'issued'].every((s) => clientPage.text.includes(`data-status="${s}"`)
        && clientPage.text.includes(`id="count-${s}"`)));
    check('Панель фильтров: поиск и выбор сортировки',
      clientPage.text.includes('id="orders-search"') && clientPage.text.includes('id="orders-sort"'));
    const sortKeys = [...clientPage.text.matchAll(/data-sort="(\w+)"/g)].map((m) => m[1]);
    check('Заголовки столбцов с сортировкой', sortKeys.length === 5, sortKeys.join(', '));
    check('У клиента нет столбца «Клиент»', !sortKeys.includes('client'));
    check('Подключены сценарии API и страницы заказов',
      clientPage.text.includes('/js/api.js') && clientPage.text.includes('/js/orders.js'));

    // --- 2. Страница администратора ---------------------------------------------------
    const adminPage = await request('GET', '/orders', adminToken, { accept: 'text/html' });
    check('Администратору — «Все заказы» со столбцом «Клиент»',
      adminPage.text.includes('<h1>Все заказы</h1>') && adminPage.text.includes('data-sort="client"'));
    check('Пункт меню администратора называется «Все заказы»', adminPage.text.includes('>Все заказы</a>'));

    const guest = await request('GET', '/orders', null, { accept: 'text/html' });
    check('Гость на страницу заказов не попадает', [302, 401].includes(guest.status), `статус ${guest.status}`);

    // --- 3. Запросы страницы: вкладки и сортировка ------------------------------------
    const first = await request('GET', '/api/orders/my?status=all&sort=receivedAt&order=desc', clientToken);
    check('Загрузка списка при открытии страницы', first.status === 200 && first.body.total === 3);
    check('Счётчики вкладок: все 3, готово 2, выдано 1',
      first.body.counts.all === 3 && first.body.counts.ready === 2 && first.body.counts.issued === 1);

    const ready = await request('GET', '/api/orders/my?status=ready&sort=receivedAt&order=desc', clientToken);
    check('Вкладка «Готов к выдаче»', ready.body.total === 2);

    for (const key of sortKeys) {
      const asc = await request('GET', `/api/orders/my?status=all&sort=${key}&order=asc`, clientToken);
      const desc = await request('GET', `/api/orders/my?status=all&sort=${key}&order=desc`, clientToken);
      check(`Сортировка по столбцу ${key} в обе стороны`, asc.status === 200 && desc.status === 200);
    }

    const byTrack = await request('GET', '/api/orders/my?sort=trackNumber&order=asc', clientToken);
    const tracks = byTrack.body.orders.map((o) => o.trackNumber);
    check('Порядок по трек-номеру соответствует нажатию на заголовок',
      tracks.join() === ['PVZ160000001', 'PVZ160000002', 'RA160000003BY'].join(), tracks.join(', '));

    const search = await request('GET', `/api/orders/my?search=${encodeURIComponent('наушники')}`, clientToken);
    check('Поиск из поля на странице', search.body.total === 1);

    const all = await request('GET', '/api/orders?status=all&sort=client&order=asc', adminToken);
    check('«Все заказы»: сортировка по клиенту', all.status === 200 && all.body.total === 3);

    // --- 4. Сценарий страницы -----------------------------------------------------------
    const ordersJs = (await request('GET', '/js/orders.js', null, { accept: '*/*' })).text;
    check('Сценарий меняет направление при повторном нажатии на заголовок',
      ordersJs.includes("state.order === 'asc' ? 'desc' : 'asc'"));
    check('Сценарий сохраняет фильтры в адресе страницы', ordersJs.includes('history.replaceState'));
    check('Данные выводятся через textContent (без innerHTML)', !/innerHTML\s*=/.test(ordersJs));

    // --- 5. Оформление -------------------------------------------------------------------
    const css = (await request('GET', '/css/main.css', null, { accept: 'text/css' })).text;
    check('Таблица превращается в карточки на телефоне (.table--cards и data-label)',
      css.includes('.table--cards') && css.includes('attr(data-label)'));
    check('Стрелка направления сортировки (aria-sort)', css.includes('th[aria-sort="ascending"]'));
    check('Светлая и тёмная темы описаны', css.includes('[data-theme="dark"]') && css.includes('prefers-color-scheme: dark'));

    const home = await request('GET', '/', null, { accept: 'text/html' });
    check('На главной схема стеллажа по данным базы',
      home.text.includes('class="locker"') && (home.text.match(/locker__cell--busy/g) || []).length === 2);
    const favicon = await request('GET', '/favicon.svg', null, { accept: '*/*' });
    check('Значок сайта (favicon.svg)', favicon.status === 200);

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
      + 'списки заказов отображаются в браузере с работающей сортировкой.');
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
