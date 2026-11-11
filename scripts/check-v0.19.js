'use strict';

/**
 * Проверка сборки v0.19 (20-й день практики).
 *
 * Тема дня: редактирование и удаление заказа, удаление профиля пользователя (CRUD).
 * Критерий приёмки: CRUD-операции для заказов и профиля работают без ошибок.
 *
 * Запуск:  node scripts/check-v0.19.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v019-${process.pid}.db`);
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

const PORT = Number.parseInt(process.env.CHECK_PORT || '3128', 10);
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
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, body: json };
}

async function createAndLogin(name, email, role) {
  userRepository.create({ name, email, passwordHash: await hashPassword(PASSWORD), role, isConfirmed: true });
  return (await request('POST', '/api/auth/login', null, { body: { email, password: PASSWORD } })).body.token;
}

const cellStatus = (id) => getDb().prepare('SELECT status FROM Storage_Cells WHERE id = ?').get(id).status;

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — CRUD заказов и профиля`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();
  for (const file of ['src/services/profileService.js', 'src/views/profilePage.js', 'public/js/profile.js']) {
    check(`Модуль ${file}`, fs.existsSync(path.join(config.rootDir, file)));
  }

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, BASE);

  try {
    const stamp = Date.now();
    const ivanov = `ivanov_${stamp}@mail.ru`;
    const petrov = `petrov_${stamp}@mail.ru`;
    const adminToken = await createAndLogin('Администратор ПВЗ', `admin_${stamp}@mail.ru`, 'admin');
    const ivanovToken = await createAndLogin('Иванов Иван', ivanov, 'client');
    const petrovToken = await createAndLogin('Петров Пётр', petrov, 'client');

    // --- 1. Create: ожидаемый заказ и приёмка -------------------------------------------
    const created = await request('POST', '/api/orders/expected', adminToken,
      { body: { trackNumber: 'PVZ190000001', clientEmail: ivanov, description: 'Ноутбук' } });
    check('Create: ожидаемый заказ «В пути» (201)', created.status === 201 && created.body.order.status === 'В пути');
    const duplicate = await request('POST', '/api/orders/expected', adminToken,
      { body: { trackNumber: 'PVZ190000001', clientEmail: ivanov } });
    check('Create: повтор трек-номера — 409 у поля', duplicate.status === 409 && Boolean(duplicate.body.error.details?.trackNumber));
    const received = await request('POST', '/api/orders', adminToken, { body: { trackNumber: 'PVZ190000001', clientEmail: ivanov } });
    check('Ожидаемый заказ принимается в ячейку', received.status === 201 && received.body.fromTransit === true);
    const order = received.body.order;

    // --- 2. Read -------------------------------------------------------------------------
    const read = await request('GET', `/api/orders/${order.id}`, ivanovToken);
    check('Read: клиент видит свой заказ', read.status === 200 && read.body.order.description === 'Ноутбук');

    // --- 3. Update -----------------------------------------------------------------------
    const updated = await request('PATCH', `/api/orders/${order.id}`, adminToken,
      { body: { description: 'Ноутбук, 2 кг', trackNumber: 'pvz190000099' } });
    check('Update: описание и трек-номер изменены',
      updated.status === 200 && updated.body.order.description === 'Ноутбук, 2 кг'
        && updated.body.order.trackNumber === 'PVZ190000099');
    const moved = await request('PATCH', `/api/orders/${order.id}`, adminToken, { body: { clientEmail: petrov } });
    check('Update: получатель изменён', moved.body?.order?.client?.email === petrov);
    const badUpdate = await request('PATCH', `/api/orders/${order.id}`, adminToken, { body: { trackNumber: '1' } });
    check('Update: неверный трек-номер — 400', badUpdate.status === 400);
    check('Update: клиенту запрещено (403)',
      (await request('PATCH', `/api/orders/${order.id}`, petrovToken, { body: { description: 'x' } })).status === 403);

    // --- 4. Delete -----------------------------------------------------------------------
    const removed = await request('DELETE', `/api/orders/${order.id}`, adminToken);
    check('Delete: заказ удалён (200)', removed.status === 200, removed.body?.message);
    check('Delete: ячейка заказа освобождена', cellStatus(order.cell.id) === 'Свободна');
    check('Delete: повторное удаление — 404', (await request('DELETE', `/api/orders/${order.id}`, adminToken)).status === 404);

    // --- 5. Профиль ----------------------------------------------------------------------
    const page = await request('GET', '/profile', ivanovToken, { accept: 'text/html' });
    check('Страница профиля открывается', page.status === 200
      && ['profile-form', 'password-form', 'delete-form'].every((id) => page.text.includes(`id="${id}"`)));
    const renamed = await request('PATCH', '/api/auth/me', ivanovToken, { body: { name: 'Иван Иванов' } });
    check('Профиль: имя изменено', renamed.body?.user?.name === 'Иван Иванов');
    check('Профиль: пустое имя — 400', (await request('PATCH', '/api/auth/me', ivanovToken, { body: { name: '' } })).status === 400);

    const keep = await request('POST', '/api/orders', adminToken, { body: { trackNumber: 'PVZ190000002', clientEmail: ivanov } });
    const blocked = await request('DELETE', '/api/auth/me', ivanovToken, { body: { password: PASSWORD } });
    check('Удаление профиля с заказом в ячейке — 409', blocked.status === 409 && blocked.body.error.code === 'HAS_ACTIVE_ORDERS');
    await request('POST', `/api/orders/${keep.body.order.id}/issue`, adminToken);
    check('Удаление профиля с неверным паролем — 401',
      (await request('DELETE', '/api/auth/me', ivanovToken, { body: { password: 'неверно' } })).status === 401);
    const deleted = await request('DELETE', '/api/auth/me', ivanovToken, { body: { password: PASSWORD } });
    check('Delete профиля: учётная запись удалена', deleted.status === 200 && !userRepository.findByEmail(ivanov));
    check('После удаления сессия недействительна', (await request('GET', '/api/auth/me', ivanovToken)).status === 401);

    const byAdmin = await request('DELETE', `/api/admin/users/${userRepository.findByEmail(petrov).id}`, adminToken);
    check('Администратор удаляет клиента', byAdmin.status === 200 && !userRepository.findByEmail(petrov));

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
      + 'CRUD-операции для заказов и профиля работают без ошибок.');
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
