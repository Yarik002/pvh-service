'use strict';

/**
 * Проверка сборки v0.13 (14-й день практики).
 *
 * Тема дня: API приёмки заказа (транзакция: сохранение заказа + занятие ячейки).
 * Критерий приёмки: заказ корректно появляется в БД, выбранная ячейка
 * становится «Занята».
 *
 * Сценарий принимает заказы через REST API и после каждого шага проверяет
 * содержимое базы данных напрямую.
 *
 * Запуск:  node scripts/check-v0.13.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v013-${process.pid}.db`);
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

const PORT = Number.parseInt(process.env.CHECK_PORT || '3122', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Xk9#mQ2$vL7p';
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Выполняет запрос к API. */
async function api(method, endpoint, token, body) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Создаёт подтверждённого пользователя и выполняет вход. */
async function createAndLogin(name, email, role) {
  userRepository.create({
    name, email, passwordHash: await hashPassword(PASSWORD), role, isConfirmed: true,
  });

  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (await response.json()).token;
}

/** Строка заказа в базе данных. */
function orderRow(trackNumber) {
  return getDb().prepare(
    `SELECT o.*, c.cell_number, c.status AS cell_status
       FROM Orders o LEFT JOIN Storage_Cells c ON c.id = o.cell_id
      WHERE o.track_number = ?`,
  ).get(trackNumber);
}

/** Состояние ячейки по номеру. */
function cellStatus(number) {
  return getDb().prepare('SELECT status FROM Storage_Cells WHERE cell_number = ?').get(number).status;
}

/** Количество заказов в базе. */
function ordersCount() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM Orders').get().n;
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — API приёмки заказа`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();

  for (const [file, label] of [
    ['src/services/orderService.js', 'сервис приёмки заказа'],
    ['src/repositories/orderRepository.js', 'запросы к таблице Orders'],
    ['src/routes/orders.js', 'маршруты /api/orders'],
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
    const adminToken = await createAndLogin('Администратор ПВЗ', `admin_${stamp}@mail.ru`, 'admin');
    const clientToken = await createAndLogin('Иванов Иван', clientEmail, 'client');
    const otherToken = await createAndLogin('Петров Пётр', `petrov_${stamp}@mail.ru`, 'client');

    // --- 1. Приёмка с автоматическим выбором ячейки --------------------------------
    const first = await api('POST', '/api/orders', adminToken, {
      trackNumber: 'ra100000001by', clientEmail, description: 'Книга, 0,5 кг',
    });
    check('Приёмка заказа выполняется (201)', first.status === 201, first.body.message);

    const row = orderRow('RA100000001BY');
    check('Заказ появился в базе данных', Boolean(row), 'таблица Orders');
    check('Трек-номер сохранён в верхнем регистре', row?.track_number === 'RA100000001BY');
    check('Статус заказа — «Готов к выдаче»', row?.status === 'Готов к выдаче');
    check('Заполнена дата поступления', Boolean(row?.received_at), row?.received_at);
    check('Заказ привязан к получателю',
      row?.user_id === userRepository.findByEmail(clientEmail).id);
    check('Назначена первая свободная ячейка № 1', row?.cell_number === 1);
    check('Ячейка № 1 стала «Занята»', cellStatus(1) === 'Занята');
    check('Описание посылки сохранено', row?.description === 'Книга, 0,5 кг');
    check('Клиенту сформировано письмо о поступлении заказа',
      first.body.notification?.logged === true || first.body.notification?.sent === true,
      `режим: ${first.body.notification?.status}`);

    // --- 2. Ручной выбор ячейки -----------------------------------------------------
    const manual = await api('POST', '/api/orders', adminToken, {
      trackNumber: 'PVZ100000012', clientEmail, cellMode: 'manual', cellNumber: 12,
    });
    check('Приёмка с ручным выбором ячейки № 12', manual.status === 201
      && orderRow('PVZ100000012')?.cell_number === 12 && cellStatus(12) === 'Занята');

    // --- 3. Отказы ------------------------------------------------------------------
    const countBefore = ordersCount();

    const duplicate = await api('POST', '/api/orders', adminToken, {
      trackNumber: 'RA100000001BY', clientEmail,
    });
    check('Повторная приёмка трек-номера отклоняется (409)',
      duplicate.status === 409 && duplicate.body.error?.code === 'TRACK_EXISTS', duplicate.body.error?.message);

    const busy = await api('POST', '/api/orders', adminToken, {
      trackNumber: 'PVZ100000099', clientEmail, cellMode: 'manual', cellNumber: 1,
    });
    check('Заказ в занятую ячейку не кладётся (409)',
      busy.status === 409 && busy.body.error?.code === 'CELL_BUSY', busy.body.error?.message);

    const badTrack = await api('POST', '/api/orders', adminToken, { trackNumber: '12', clientEmail });
    check('Неверный трек-номер отклоняется с ошибкой у поля (400)',
      badTrack.status === 400 && Boolean(badTrack.body.error?.details?.trackNumber));

    const noClient = await api('POST', '/api/orders', adminToken, { trackNumber: 'PVZ100000098' });
    check('Приёмка без получателя отклоняется (400)',
      noClient.status === 400 && noClient.body.error?.code === 'CLIENT_REQUIRED');

    const unknownClient = await api('POST', '/api/orders', adminToken, {
      trackNumber: 'PVZ100000097', clientEmail: `nikto_${stamp}@mail.ru`,
    });
    check('Незарегистрированный получатель — 404', unknownClient.status === 404);

    check('Отклонённые запросы не создали заказов и не заняли ячеек',
      ordersCount() === countBefore
      && getDb().prepare("SELECT COUNT(*) AS n FROM Storage_Cells WHERE status = 'Занята'").get().n === 2);

    // --- 4. Заказ «В пути» ------------------------------------------------------------
    getDb().prepare("INSERT INTO Orders (track_number, user_id, status) VALUES (?, ?, 'В пути')")
      .run('PVZ100000050', userRepository.findByEmail(clientEmail).id);
    const transit = await api('POST', '/api/orders', adminToken, { trackNumber: 'PVZ100000050', clientEmail });
    check('Заказ «В пути» при приёмке становится «Готов к выдаче»',
      transit.status === 201 && transit.body.fromTransit === true
      && orderRow('PVZ100000050')?.status === 'Готов к выдаче');

    // --- 5. Права доступа и просмотр заказа -------------------------------------------
    const byClient = await api('POST', '/api/orders', clientToken, { trackNumber: 'PVZ100000096', clientEmail });
    const byGuest = await api('POST', '/api/orders', null, { trackNumber: 'PVZ100000096', clientEmail });
    check('Клиент и гость не могут принимать заказы (403 / 401)',
      byClient.status === 403 && byGuest.status === 401);

    const own = await api('GET', `/api/orders/${first.body.order.id}`, clientToken);
    check('Клиент видит свой принятый заказ', own.status === 200 && own.body.order?.cell?.cellNumber === 1);

    const foreign = await api('GET', `/api/orders/${first.body.order.id}`, otherToken);
    check('Чужой заказ клиенту недоступен (404)', foreign.status === 404);

    // --- 6. Связь с API ячеек ----------------------------------------------------------
    const free = await api('GET', '/api/cells/free', adminToken);
    check('Занятые ячейки исчезли из списка свободных',
      free.body.count === 17 && !free.body.cells.some((cell) => [1, 2, 12].includes(cell.cellNumber)),
      `свободных: ${free.body.count}`);

    const cell = await api('GET', `/api/cells/${first.body.order.cell.id}`, adminToken);
    check('Администратор видит заказ в ячейке', cell.body.cell?.order?.trackNumber === 'RA100000001BY');

    // --- 7. Ранее созданные разделы ---------------------------------------------------
    const health = await api('GET', '/health');
    check('Эндпоинт /health по-прежнему возвращает OK', health.body.status === 'OK');
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
      + 'заказ появляется в базе данных, выбранная ячейка становится «Занята».');
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
