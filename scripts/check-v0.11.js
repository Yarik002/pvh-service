'use strict';

/**
 * Проверка сборки v0.11 (12-й день практики).
 *
 * Тема дня: API управления ячейками — получение списка всех и только
 * свободных ячеек.
 * Критерий приёмки: API отдаёт актуальный статус 20 ячеек в формате JSON.
 *
 * Сценарий имитирует работу пункта выдачи: часть ячеек занимается
 * заказами, после чего проверяется, что API сразу отражает изменения.
 *
 * Запуск:  node scripts/check-v0.11.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v011-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.LOGIN_LIMIT_MAX = process.env.LOGIN_LIMIT_MAX || '500';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '500';
process.env.MAIL_TRANSPORT = 'log';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { hashPassword } = require('../src/utils/password');
const userRepository = require('../src/repositories/userRepository');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3120', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Xk9#mQ2$vL7p';
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Выполняет запрос к API. */
async function api(endpoint, token, accept = 'application/json') {
  const headers = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE}${endpoint}`, { headers, redirect: 'manual' });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

/** Создаёт подтверждённого пользователя и выполняет вход. */
async function createAndLogin(email, role) {
  userRepository.create({
    name: role === 'admin' ? 'Администратор Проверки' : 'Клиент Проверки',
    email,
    passwordHash: await hashPassword(PASSWORD),
    role,
    isConfirmed: true,
  });

  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (await response.json()).token;
}

/** Кладёт заказ в ячейку с указанным номером. */
function putOrder(cellNumber, email, trackNumber) {
  const db = getDb();
  const user = db.prepare('SELECT id FROM Users WHERE email = ?').get(email);
  const cell = db.prepare('SELECT id FROM Storage_Cells WHERE cell_number = ?').get(cellNumber);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO Orders (track_number, description, user_id, cell_id, status, received_at)
       VALUES (?, 'Проверочная посылка', ?, ?, 'Готов к выдаче', datetime('now'))`,
    ).run(trackNumber, user.id, cell.id);
    db.prepare("UPDATE Storage_Cells SET status = 'Занята' WHERE id = ?").run(cell.id);
  })();

  return cell.id;
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — API управления ячейками`);
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
    const clientEmail = `client_${stamp}@mail.ru`;
    const clientToken = await createAndLogin(clientEmail, 'client');
    const adminToken = await createAndLogin(`admin_${stamp}@mail.ru`, 'admin');
    check('Подготовлены учётные записи клиента и администратора',
      Boolean(clientToken) && Boolean(adminToken));

    // --- 1. Список всех ячеек ----------------------------------------------------
    const all = await api('/api/cells', clientToken);
    check('GET /api/cells отвечает 200 в формате JSON',
      all.status === 200 && /application\/json/.test(all.headers.get('content-type')));
    check('API отдаёт состояние 20 ячеек', all.body.cells?.length === 20,
      `ячеек: ${all.body.cells?.length}`);
    check('Ячейки отсортированы по номеру',
      all.body.cells.every((cell, index) => index === 0
        || cell.cellNumber > all.body.cells[index - 1].cellNumber));
    check('У каждой ячейки указаны идентификатор, номер и состояние',
      all.body.cells.every((cell) => Number.isInteger(cell.id) && Number.isInteger(cell.cellNumber)
        && ['Свободна', 'Занята'].includes(cell.status)));
    check('Изначально все ячейки свободны',
      all.body.summary.free === 20 && all.body.summary.busy === 0);

    // --- 2. Актуальность после приёмки заказов ------------------------------------------
    putOrder(1, clientEmail, `PVZ${stamp}01`);
    putOrder(2, clientEmail, `PVZ${stamp}02`);
    const busyCellId = putOrder(7, clientEmail, `PVZ${stamp}07`);

    const after = await api('/api/cells', clientToken);
    check('Занятые ячейки сразу отображаются в списке',
      after.body.cells.filter((cell) => cell.status === 'Занята').length === 3);
    check('Сводка: 17 свободно, 3 занято',
      after.body.summary.free === 17 && after.body.summary.busy === 3);
    check('Сводка согласована: свободные + занятые = всего',
      after.body.summary.free + after.body.summary.busy === after.body.summary.total);
    check('Заполненность склада рассчитана (15 %)', after.body.summary.occupancyPercent === 15);
    check('Указана первая свободная ячейка (№ 3)', after.body.summary.firstFreeNumber === 3);
    check('Указано время формирования сводки',
      !Number.isNaN(Date.parse(after.body.summary.generatedAt)));
    check('Ответ не кешируется браузером (Cache-Control: no-store)',
      after.headers.get('cache-control') === 'no-store');

    // --- 3. Только свободные ячейки ----------------------------------------------------------
    const free = await api('/api/cells/free', clientToken);
    check('GET /api/cells/free отвечает 200', free.status === 200);
    check('Возвращены только свободные ячейки',
      free.body.cells.length === 17 && free.body.cells.every((cell) => cell.status === 'Свободна'));
    check('Занятые ячейки 1, 2, 7 в список не попали',
      !free.body.cells.some((cell) => [1, 2, 7].includes(cell.cellNumber)));
    check('Первая свободная ячейка — № 3', free.body.firstFreeNumber === 3, free.body.message);

    const freeFilter = await api('/api/cells?free=true', clientToken);
    check('Прежний фильтр ?free=true по-прежнему работает', freeFilter.body.cells?.length === 17);

    const busyFilter = await api(`/api/cells?status=${encodeURIComponent('Занята')}`, clientToken);
    check('Фильтр по состоянию «Занята»', busyFilter.body.cells?.length === 3);

    const badFilter = await api('/api/cells?status=abc', clientToken);
    check('Недопустимое значение фильтра отклоняется (400)', badFilter.status === 400);

    // --- 4. Сводка ---------------------------------------------------------------------------
    const summary = await api('/api/cells/summary', clientToken);
    check('GET /api/cells/summary отдаёт сводку без списка ячеек',
      summary.status === 200 && summary.body.summary?.total === 20 && summary.body.cells === undefined);

    // --- 5. Одна ячейка ------------------------------------------------------------------------
    const single = await api(`/api/cells/${busyCellId}`, adminToken);
    check('Администратор видит заказ в ячейке',
      single.body.cell?.order?.trackNumber === `PVZ${stamp}07`);
    check('Администратор видит получателя заказа',
      single.body.cell?.order?.client?.email === clientEmail);

    const singleForClient = await api(`/api/cells/${busyCellId}`, clientToken);
    check('Клиент видит состояние ячейки, но не сведения о заказе',
      singleForClient.body.cell?.status === 'Занята' && singleForClient.body.cell?.order === undefined);

    const withOrdersForClient = await api('/api/cells?withOrders=true', clientToken);
    check('Клиент не получает трек-номера через параметр withOrders',
      !JSON.stringify(withOrdersForClient.body).includes(`PVZ${stamp}`));

    const withOrdersForAdmin = await api('/api/cells?withOrders=true', adminToken);
    check('Администратор получает трек-номера в списке',
      withOrdersForAdmin.body.cells.filter((cell) => cell.trackNumber).length === 3);

    const badId = await api('/api/cells/abc', clientToken);
    check('Неверный идентификатор ячейки отклоняется (400)',
      badId.status === 400 && /целым положительным/.test(badId.body.error?.message));

    const missing = await api('/api/cells/99999', clientToken);
    check('Несуществующая ячейка — 404', missing.status === 404);

    // --- 6. Доступ -----------------------------------------------------------------------------
    const anonymousFree = await api('/api/cells/free');
    const anonymousSummary = await api('/api/cells/summary');
    check('Без авторизации данные о ячейках недоступны (401)',
      anonymousFree.status === 401 && anonymousSummary.status === 401);

    // --- 7. Страница «Ячейки хранения» ------------------------------------------------------------
    const page = await api('/cells', clientToken, 'text/html');
    check('Страница /cells открывается (200)', page.status === 200);
    check('Вместо заглушки показана сетка ячеек',
      page.body.includes('id="cells-grid"') && !page.body.includes('Раздел находится в разработке'));
    check('На странице есть фильтр и кнопка обновления',
      page.body.includes('data-cells-filter="free"') && page.body.includes('id="cells-refresh"'));

    const script = await api('/js/cells.js', null, '*/*');
    check('Сценарий страницы обращается к API ячеек',
      script.status === 200 && script.body.includes('API.cells') && script.body.includes('API.cell('));

    // --- 8. Ранее созданные разделы ---------------------------------------------------------------
    const health = await api('/health');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && health.body.status === 'OK');

    const create = await fetch(`${BASE}/api/cells`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    check('Клиенту по-прежнему запрещено изменять справочник (403)', create.status === 403);
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
      + 'API отдаёт актуальный статус 20 ячеек в формате JSON.');
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
