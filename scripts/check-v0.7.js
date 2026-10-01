'use strict';

/**
 * Проверка сборки v0.7 (8-й день практики).
 *
 * Тема дня: ролевая модель (client и admin) и middleware защиты
 * административных маршрутов.
 * Критерий приёмки: клиент получает отказ 403 Forbidden при попытке доступа
 * к административным разделам.
 *
 * Запуск:  node scripts/check-v0.7.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v07-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '500';
process.env.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS || '60000';
process.env.LOGIN_LIMIT_MAX = process.env.LOGIN_LIMIT_MAX || '500';
process.env.LOGIN_LIMIT_WINDOW_MS = process.env.LOGIN_LIMIT_WINDOW_MS || '60000';
process.env.MAIL_TRANSPORT = 'log';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const userRepository = require('../src/repositories/userRepository');
const cellRepository = require('../src/repositories/cellRepository');
const confirmationService = require('../src/services/confirmationService');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3114', 10);
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(method, endpoint, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return { status: response.status, body: parsed };
}

const stamp = Date.now();
const PASSWORD = 'Xk9#mQ2$vL7p';

/** Создаёт подтверждённого пользователя с ролью и возвращает его токен. */
async function createAndLogin(prefix, role = 'client') {
  const email = `${prefix}_${stamp}@mail.ru`;

  await request('POST', '/api/auth/register', {
    body: { name: 'Проверочный Пользователь', email, password: PASSWORD, passwordConfirm: PASSWORD },
  });

  const user = userRepository.findByEmail(email);
  confirmationService.confirmEmail(user.confirmToken);

  if (role !== 'client') {
    getDb().prepare('UPDATE Users SET role = ? WHERE id = ?').run(role, user.id);
  }

  const login = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  return { email, token: login.body?.token, id: user.id };
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — ролевая модель и права доступа`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();
  check('Схема базы данных актуальна', true, TMP_DB);

  check('В справочнике 20 ячеек хранения', cellRepository.count() === 20,
    `ячеек: ${cellRepository.count()}`);

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, `http://127.0.0.1:${PORT}`);

  try {
    const client = await createAndLogin('client', 'client');
    const admin = await createAndLogin('admin', 'admin');

    check('Учётная запись клиента создана и подтверждена', Boolean(client.token),
      `роль: client`);
    check('Учётная запись администратора создана', Boolean(admin.token), 'роль: admin');

    // --- 1. Главное требование дня: клиент получает 403 --------------------
    const forbidden = [
      ['GET', '/api/admin/overview', undefined],
      ['GET', '/api/admin/users', undefined],
      ['GET', '/api/admin/sessions', undefined],
      ['POST', '/api/cells', { cellNumber: 500 }],
      ['PATCH', '/api/cells/1/status', { status: 'Занята' }],
      ['DELETE', '/api/cells/1', undefined],
    ];

    for (const [method, endpoint, body] of forbidden) {
      const response = await request(method, endpoint, { token: client.token, body });
      check(`Клиент получает 403 на ${method} ${endpoint}`,
        response.status === 403 && response.body?.error?.code === 'FORBIDDEN',
        `статус ${response.status}, код ${response.body?.error?.code}`);
    }

    const message = await request('GET', '/api/admin/overview', { token: client.token });
    check('Сообщение об отказе понятно пользователю',
      /Недостаточно прав/.test(message.body?.error?.message || ''),
      message.body?.error?.message);

    // --- 2. Без авторизации — 401, а не 403 --------------------------------
    const anonymous = await request('GET', '/api/admin/overview');
    check('Без авторизации возвращается 401 (а не 403)',
      anonymous.status === 401 && anonymous.body?.error?.code === 'MISSING_TOKEN',
      `код: ${anonymous.body?.error?.code}`);

    // --- 3. Администратор имеет полный доступ ------------------------------
    const overview = await request('GET', '/api/admin/overview', { token: admin.token });
    check('Администратор получает сводку по ПВЗ (200)',
      overview.status === 200 && Boolean(overview.body?.overview?.users),
      `пользователей: ${overview.body?.overview?.users?.total}, ячеек: ${overview.body?.overview?.cells?.total}`);
    check('Сводка содержит разделы: пользователи, ячейки, заказы, сессии',
      ['users', 'cells', 'orders', 'sessions']
        .every((section) => overview.body?.overview?.[section] !== undefined));

    const users = await request('GET', '/api/admin/users', { token: admin.token });
    check('Администратор получает список пользователей',
      users.status === 200 && users.body?.total >= 2, `пользователей: ${users.body?.total}`);
    check('В списке пользователей нет хеша пароля и токенов',
      !JSON.stringify(users.body).includes('passwordHash')
      && !JSON.stringify(users.body).includes('token_hash'));

    const sessions = await request('GET', '/api/admin/sessions', { token: admin.token });
    check('Администратор видит активные сессии',
      sessions.status === 200 && sessions.body?.total >= 2, `сессий: ${sessions.body?.total}`);

    // --- 4. Администратор имеет доступ и к маршрутам клиента ----------------
    const cellsForAdmin = await request('GET', '/api/cells', { token: admin.token });
    check('Администратор имеет доступ к маршрутам клиента',
      cellsForAdmin.status === 200, `ячеек: ${cellsForAdmin.body?.summary?.total}`);

    // --- 5. Справочник ячеек: просмотр клиентом разрешён ---------------------
    const cellsForClient = await request('GET', '/api/cells', { token: client.token });
    check('Клиент видит список ячеек (200)',
      cellsForClient.status === 200, `ячеек: ${cellsForClient.body?.summary?.total}`);
    check('Сводка по ячейкам содержит количество свободных и занятых',
      cellsForClient.body?.summary?.free !== undefined
      && cellsForClient.body?.summary?.busy !== undefined,
      `свободно: ${cellsForClient.body?.summary?.free}, занято: ${cellsForClient.body?.summary?.busy}`);

    const freeOnly = await request('GET', '/api/cells?free=true', { token: client.token });
    check('Фильтр «только свободные» работает',
      freeOnly.status === 200
      && freeOnly.body?.cells?.every((cell) => cell.status === 'Свободна'),
      `вернулось ячеек: ${freeOnly.body?.cells?.length}`);

    const cellsAnonymous = await request('GET', '/api/cells');
    check('Без авторизации список ячеек недоступен (401)', cellsAnonymous.status === 401);

    // --- 6. Изменение справочника администратором ---------------------------
    const created = await request('POST', '/api/cells', { token: admin.token, body: { cellNumber: 200 } });
    check('Администратор добавляет ячейку (201)',
      created.status === 201 && created.body?.cell?.cellNumber === 200,
      created.body?.message);

    const autoNumbered = await request('POST', '/api/cells', { token: admin.token, body: {} });
    check('Номер ячейки назначается автоматически',
      autoNumbered.status === 201 && autoNumbered.body?.cell?.cellNumber === 201,
      `номер: ${autoNumbered.body?.cell?.cellNumber}`);

    const duplicate = await request('POST', '/api/cells', { token: admin.token, body: { cellNumber: 200 } });
    check('Повторяющийся номер ячейки отклоняется (409)',
      duplicate.status === 409, `код: ${duplicate.body?.error?.code}`);

    const invalidNumber = await request('POST', '/api/cells', { token: admin.token, body: { cellNumber: -1 } });
    check('Некорректный номер ячейки отклоняется (400)', invalidNumber.status === 400);

    const changed = await request('PATCH', `/api/cells/${autoNumbered.body.cell.id}/status`, {
      token: admin.token,
      body: { status: 'Занята' },
    });
    check('Администратор изменяет состояние ячейки (200)',
      changed.status === 200 && changed.body?.cell?.status === 'Занята',
      changed.body?.message);

    const invalidStatus = await request('PATCH', `/api/cells/${autoNumbered.body.cell.id}/status`, {
      token: admin.token,
      body: { status: 'Сломана' },
    });
    check('Недопустимое состояние ячейки отклоняется (400)', invalidStatus.status === 400);

    const removed = await request('DELETE', `/api/cells/${autoNumbered.body.cell.id}`, { token: admin.token });
    check('Администратор удаляет ячейку (200)', removed.status === 200);

    const missing = await request('GET', '/api/cells/99999', { token: admin.token });
    check('Несуществующая ячейка — ошибка 404', missing.status === 404);

    // --- 7. Фильтры списка пользователей -------------------------------------
    const adminsOnly = await request('GET', '/api/admin/users?role=admin', { token: admin.token });
    check('Фильтр пользователей по роли admin работает',
      adminsOnly.body?.users?.every((user) => user.role === 'admin'),
      `найдено: ${adminsOnly.body?.total}`);

    const badRole = await request('GET', '/api/admin/users?role=superuser', { token: admin.token });
    check('Недопустимая роль в фильтре отклоняется (400)', badRole.status === 400);

    // --- 8. Принудительное завершение сессии ----------------------------------
    const sessionsBefore = await request('GET', '/api/admin/sessions', { token: admin.token });
    const clientSession = sessionsBefore.body.sessions.find((item) => item.role === 'client');
    check('Сессия клиента видна администратору', Boolean(clientSession));

    const closeSession = await request('DELETE', `/api/admin/sessions/${clientSession.id}`, { token: admin.token });
    check('Администратор завершает сессию клиента (200)', closeSession.status === 200);

    const clientAfter = await request('GET', '/api/auth/me', { token: client.token });
    check('После завершения сессии доступ клиента закрыт (401)',
      clientAfter.status === 401, `код: ${clientAfter.body?.error?.code}`);

    await request('DELETE', `/api/cells/${created.body.cell.id}`, { token: admin.token });

    // --- 9. Ранее созданные эндпоинты работают ---------------------------------
    const health = await request('GET', '/health');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && health.body?.status === 'OK');

    const root = await request('GET', '/');
    check('В перечне эндпоинтов указаны ячейки и административный раздел',
      Boolean(root.body?.endpoints?.cells) && Boolean(root.body?.endpoints?.adminOverview));
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
      + 'клиент получает 403 Forbidden при доступе к административным разделам.');
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
