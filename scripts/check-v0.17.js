'use strict';

/**
 * Проверка сборки v0.17 (18-й день практики).
 *
 * Тема дня: API выдачи заказа (смена статуса на «Выдан» и освобождение
 * связанной ячейки).
 * Критерий приёмки: транзакция выдачи работает — статус меняется,
 * ячейка освобождается.
 *
 * Запуск:  node scripts/check-v0.17.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v017-${process.pid}.db`);
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

const PORT = Number.parseInt(process.env.CHECK_PORT || '3126', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Xk9#mQ2$vL7p';
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(method, address, token, body) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${address}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, body: json };
}

async function createAndLogin(name, email, role) {
  userRepository.create({ name, email, passwordHash: await hashPassword(PASSWORD), role, isConfirmed: true });
  return (await request('POST', '/api/auth/login', null, { email, password: PASSWORD })).body.token;
}

const cellStatus = (number) => getDb().prepare('SELECT status FROM Storage_Cells WHERE cell_number = ?').get(number).status;
const orderRow = (id) => getDb().prepare('SELECT status, issued_at, cell_id FROM Orders WHERE id = ?').get(id);

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — выдача заказа`);
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
    const clientEmail = `ivanov_${stamp}@mail.ru`;
    const adminToken = await createAndLogin('Администратор ПВЗ', `admin_${stamp}@mail.ru`, 'admin');
    const clientToken = await createAndLogin('Иванов Иван', clientEmail, 'client');

    const received = await request('POST', '/api/orders', adminToken, { trackNumber: 'PVZ170000001', clientEmail });
    const order = received.body.order;
    const cellNumber = order.cell.cellNumber;
    check('Заказ принят и лежит в ячейке', received.status === 201 && cellStatus(cellNumber) === 'Занята',
      `ячейка № ${cellNumber}`);

    // --- 1. Выдача ------------------------------------------------------------------
    const issued = await request('POST', `/api/orders/${order.id}/issue`, adminToken);
    check('POST /api/orders/:id/issue отвечает 200', issued.status === 200, issued.body?.message);
    check('В ответе статус «Выдан» и дата выдачи',
      issued.body?.order?.status === 'Выдан' && Boolean(issued.body.order.issuedAt));
    check('В ответе освобождённая ячейка', issued.body?.cell?.status === 'Свободна');

    const row = orderRow(order.id);
    check('В базе: статус «Выдан», дата выдачи заполнена', row.status === 'Выдан' && Boolean(row.issued_at));
    check(`В базе: ячейка № ${cellNumber} стала «Свободна»`, cellStatus(cellNumber) === 'Свободна');
    check('Ячейка сохранена в заказе как история выдачи', row.cell_id === order.cell.id);

    const summary = await request('GET', '/api/cells/summary', adminToken);
    check('Сводка по складу: снова 20 свободных ячеек', summary.body?.summary?.free === 20
      || summary.body?.free === 20, JSON.stringify(summary.body?.summary || summary.body).slice(0, 80));

    const next = await request('POST', '/api/orders', adminToken, { trackNumber: 'PVZ170000002', clientEmail });
    check('Освобождённая ячейка назначается следующему заказу', next.body?.order?.cell?.cellNumber === cellNumber);

    // --- 2. Отказы --------------------------------------------------------------------
    const again = await request('POST', `/api/orders/${order.id}/issue`, adminToken);
    check('Повторная выдача: 409 ORDER_ALREADY_ISSUED',
      again.status === 409 && again.body?.error?.code === 'ORDER_ALREADY_ISSUED', again.body?.error?.message);

    const transitId = getDb().prepare("INSERT INTO Orders (track_number, user_id, status) VALUES ('PVZ170000003', ?, 'В пути')")
      .run(userRepository.findByEmail(clientEmail).id).lastInsertRowid;
    const transit = await request('POST', `/api/orders/${transitId}/issue`, adminToken);
    check('Заказ «В пути»: 409 ORDER_NOT_READY', transit.status === 409 && transit.body?.error?.code === 'ORDER_NOT_READY');

    check('Несуществующий заказ: 404', (await request('POST', '/api/orders/999999/issue', adminToken)).status === 404);
    check('Неверный идентификатор: 400', (await request('POST', '/api/orders/abc/issue', adminToken)).status === 400);

    const byClient = await request('POST', `/api/orders/${next.body.order.id}/issue`, clientToken);
    check('Клиент выдать заказ не может (403)', byClient.status === 403);
    check('Без входа выдача недоступна (401)', (await request('POST', `/api/orders/${next.body.order.id}/issue`)).status === 401);
    check('После отказов заказ остался «Готов к выдаче»', orderRow(next.body.order.id).status === 'Готов к выдаче');

    // --- 3. Списки и справка ------------------------------------------------------------
    const mine = await request('GET', '/api/orders/my?status=issued', clientToken);
    check('Клиент видит выданный заказ во вкладке «Выдан»', mine.body?.total === 1);

    const index = await request('GET', '/api');
    check('Адрес выдачи в справке GET /api', Boolean(index.body?.endpoints?.issueOrder));

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
      + 'транзакция выдачи работает: статус меняется, ячейка освобождается.');
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
