'use strict';

/**
 * Проверка сборки v0.14 (15-й день практики).
 *
 * Тема дня: страница «Приёмка товара» для администратора, связанная с API.
 * Критерий приёмки: приёмка посылки полностью работает через графический
 * интерфейс.
 *
 * Сценарий повторяет то, что делает страница в браузере: открывает её,
 * загружает подсказки и свободные ячейки, показывает назначаемую ячейку,
 * отправляет форму, а затем проверяет базу данных и обновление склада.
 * Правила проверки полей в браузере выполняются в изолированном контексте
 * и сравниваются с серверными.
 *
 * Ручная проверка в браузере описана в отчёте за 15-й день.
 *
 * Запуск:  node scripts/check-v0.14.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v014-${process.pid}.db`);
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
const { validate } = require('../src/validators/rules');
const { receiveOrderSchema } = require('../src/validators/schemas');
const userRepository = require('../src/repositories/userRepository');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3123', 10);
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
  return { status: response.status, text, body: json };
}

/** Создаёт подтверждённого пользователя и выполняет вход. */
async function createAndLogin(name, email, role) {
  userRepository.create({ name, email, passwordHash: await hashPassword(PASSWORD), role, isConfirmed: true });
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (await response.json()).token;
}

/** Правила проверки полей из клиентского модуля form.js. */
function loadClientRules() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(config.rootDir, 'public', 'js', 'form.js'), 'utf8'), {
    window, document: { querySelector: () => null },
  });
  return window.PVH_FORM;
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — страница «Приёмка товара»`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();

  for (const [file, label] of [
    ['src/views/receivePage.js', 'разметка страницы приёмки'],
    ['public/js/receive.js', 'сценарий страницы приёмки'],
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

    // --- 1. Страница ------------------------------------------------------------
    const page = await request('GET', '/receive', adminToken, { accept: 'text/html' });
    check('Страница /receive открывается администратору (200)', page.status === 200);
    check('Вместо заглушки показана форма приёмки',
      page.text.includes('id="receive-form"') && !page.text.includes('Раздел находится в разработке'));
    check('Форма содержит трек-номер, получателя и описание',
      ['trackNumber', 'clientEmail', 'description'].every((name) => page.text.includes(`name="${name}"`)));
    check('Форма содержит выбор ячейки: автоматически или вручную',
      page.text.includes('value="auto" checked') && page.text.includes('value="manual"')
      && page.text.includes('name="cellId"'));
    check('У каждого поля есть место для сообщения об ошибке',
      ['trackNumber', 'clientEmail', 'description', 'cellId']
        .every((name) => page.text.includes(`id="error-field-${name}"`)));
    check('Предусмотрен показ назначаемой ячейки и результата приёмки',
      page.text.includes('id="cell-preview"') && page.text.includes('id="result-cell"'));
    check('Подключены модули API, проверки полей и сценарий страницы',
      ['/js/api.js', '/js/form.js', '/js/receive.js'].every((src) => page.text.includes(src)));

    const forClient = await request('GET', '/receive', clientToken, { accept: 'text/html' });
    const forGuest = await request('GET', '/receive', null, { accept: 'text/html' });
    check('Клиенту и гостю страница недоступна (403 / 401)',
      forClient.status === 403 && forGuest.status === 401);

    // --- 2. Проверка полей в браузере -----------------------------------------------
    const FORM = loadClientRules();
    const samples = ['RA123456789BY', 'ra123456789by', 'PVZ-0001', '12', '', 'RA 12345', 'трек123456', 'A'.repeat(41)];
    const sameAsServer = samples.every((value) => {
      let server = true;
      try {
        validate({ trackNumber: value }, { trackNumber: receiveOrderSchema.trackNumber });
      } catch {
        server = false;
      }
      return (FORM.RULES.trackNumber(value) === null) === server;
    });
    check('Правила трек-номера в браузере совпадают с серверными', sameAsServer,
      `проверено значений: ${samples.length}`);
    check('При ручном выборе ячейка обязательна',
      FORM.RULES.cellId('', { cellMode: 'manual' }) !== null && FORM.RULES.cellId('', { cellMode: 'auto' }) === null);
    check('Из группы переключателей учитывается только выбранный',
      FORM.collectValues({
        querySelectorAll: () => [
          { name: 'cellMode', type: 'radio', value: 'auto', checked: true },
          { name: 'cellMode', type: 'radio', value: 'manual', checked: false },
        ],
      }).cellMode === 'auto');

    // --- 3. Запросы страницы ---------------------------------------------------------
    const clients = await request('GET', '/api/admin/users?role=client', adminToken);
    check('Подсказки получателя загружаются', clients.body?.users?.some((user) => user.email === clientEmail));

    const free = await request('GET', '/api/cells/free', adminToken);
    check('Список свободных ячеек загружается', free.body?.count === 20);

    const preview = await request('GET', '/api/cells/suggest?mode=auto', adminToken);
    check('Назначаемая ячейка показывается до отправки формы',
      preview.body?.message === 'Будет назначена ячейка № 1 — первая свободная.', preview.body?.message);

    // --- 4. Отправка формы ----------------------------------------------------------
    const received = await request('POST', '/api/orders', adminToken, {
      body: { trackNumber: 'RA987654321BY', clientEmail, description: 'Наушники', cellMode: 'auto' },
    });
    check('Отправка формы принимает посылку (201)', received.status === 201, received.body?.message);
    check('В ответе есть номер ячейки для показа администратору',
      received.body?.order?.cell?.cellNumber === 1);
    check('В ответе есть результат отправки письма клиенту',
      typeof received.body?.notification?.status === 'string', received.body?.notification?.status);

    const row = getDb().prepare(
      `SELECT o.status, c.cell_number, c.status AS cell_status FROM Orders o
         JOIN Storage_Cells c ON c.id = o.cell_id WHERE o.track_number = 'RA987654321BY'`,
    ).get();
    check('Заказ сохранён в базе данных со статусом «Готов к выдаче»', row?.status === 'Готов к выдаче');
    check('Ячейка № 1 стала «Занята»', row?.cell_number === 1 && row?.cell_status === 'Занята');

    const manualCell = free.body.cells.find((cell) => cell.cellNumber === 7);
    const manual = await request('POST', '/api/orders', adminToken, {
      body: { trackNumber: 'PVZ100000007', clientEmail, cellMode: 'manual', cellId: String(manualCell.id) },
    });
    check('Посылка с ручным выбором ячейки № 7 принята', manual.body?.order?.cell?.cellNumber === 7);

    const after = await request('GET', '/api/cells/free', adminToken);
    check('После приёмки страница получает обновлённый список ячеек',
      after.body?.count === 18 && after.body?.firstFreeNumber === 2);

    // --- 5. Ошибки, которые страница выводит у полей ------------------------------------
    const duplicate = await request('POST', '/api/orders', adminToken, {
      body: { trackNumber: 'ra987654321by', clientEmail },
    });
    check('Повторный трек-номер: ошибка у поля трек-номера',
      duplicate.status === 409 && Boolean(duplicate.body?.error?.details?.trackNumber),
      duplicate.body?.error?.message);

    const busy = await request('POST', '/api/orders', adminToken, {
      body: { trackNumber: 'PVZ100000099', clientEmail, cellMode: 'manual', cellId: String(manualCell.id) },
    });
    check('Занятая ячейка: ошибка у поля выбора ячейки',
      busy.status === 409 && Boolean(busy.body?.error?.details?.cell), busy.body?.error?.message);

    const noClient = await request('POST', '/api/orders', adminToken, { body: { trackNumber: 'PVZ100000098' } });
    check('Без получателя: ошибка у поля получателя', Boolean(noClient.body?.error?.details?.client));

    // --- 6. Связанные страницы ----------------------------------------------------------
    const cellsPage = await request('GET', '/api/cells?withOrders=true', adminToken);
    check('На странице «Ячейки» принятые посылки видны с трек-номерами',
      cellsPage.body?.cells?.filter((cell) => cell.trackNumber).length === 2);

    const menu = await request('GET', '/', adminToken, { accept: 'text/html' });
    check('В меню администратора есть раздел «Приёмка товара»', menu.text.includes('href="/receive"'));

    const css = fs.readFileSync(path.join(config.rootDir, 'public', 'css', 'main.css'), 'utf8');
    check('Скрытые блоки формы не показываются (правило [hidden])',
      /\[hidden\]\s*\{\s*display:\s*none\s*!important;/.test(css));

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
      + 'приёмка посылки работает через графический интерфейс.');
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
