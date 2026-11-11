'use strict';

/**
 * Проверка сборки v0.18 (19-й день практики).
 *
 * Тема дня: выдача заказа в интерфейсе администратора с окном подтверждения.
 * Критерий приёмки: заказ успешно выдаётся клиенту через нажатие кнопки
 * в интерфейсе.
 *
 * Сценарий открывает страницу «Все заказы», проверяет кнопку и окно
 * подтверждения, затем выполняет тот же запрос, что отправляет кнопка
 * «Выдать заказ», и проверяет базу и обновлённый список.
 * Ручная проверка в браузере описана в отчёте за 19-й день.
 *
 * Запуск:  node scripts/check-v0.18.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v018-${process.pid}.db`);
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

const PORT = Number.parseInt(process.env.CHECK_PORT || '3127', 10);
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

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — выдача заказа в интерфейсе администратора`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();
  check('Модуль: действия администратора (public/js/orderActions.js)',
    fs.existsSync(path.join(config.rootDir, 'public', 'js', 'orderActions.js')));

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

    const received = await request('POST', '/api/orders', adminToken,
      { body: { trackNumber: 'PVZ180000001', clientEmail, description: 'Книга' } });
    const order = received.body.order;
    check('Подготовлен заказ «Готов к выдаче»', received.status === 201, `ячейка № ${order.cell.cellNumber}`);

    // --- 1. Страница и окно ------------------------------------------------------------
    const page = await request('GET', '/orders', adminToken, { accept: 'text/html' });
    check('Страница «Все заказы» открывается', page.status === 200);
    check('На странице окно подтверждения выдачи (<dialog>)', page.text.includes('<dialog class="modal" id="issue-dialog"'));
    check('Фокус в окне — на кнопке «Отмена»', /value="cancel" autofocus>Отмена</.test(page.text));
    check('В окне: ячейка, трек-номер, получатель, описание',
      ['issue-cell', 'issue-track', 'issue-client', 'issue-description'].every((id) => page.text.includes(`id="${id}"`)));
    check('Подключён сценарий действий до сценария списка',
      page.text.indexOf('/js/orderActions.js') !== -1
        && page.text.indexOf('/js/orderActions.js') < page.text.indexOf('/js/orders.js'));

    const clientPage = await request('GET', '/orders', clientToken, { accept: 'text/html' });
    check('У клиента нет окна выдачи и сценария действий',
      !clientPage.text.includes('issue-dialog') && !clientPage.text.includes('orderActions.js'));

    const actionsJs = (await request('GET', '/js/orderActions.js', null, { accept: '*/*' })).text;
    check('Кнопка «Выдать» только для статуса «Готов к выдаче»', actionsJs.includes("order.status === 'Готов к выдаче'"));
    check('Окно открывается модально (showModal)', actionsJs.includes('dialog.showModal()'));

    // --- 2. Нажатие «Выдать заказ» -------------------------------------------------------
    const issued = await request('POST', `/api/orders/${order.id}/issue`, adminToken);
    check('Нажатие «Выдать заказ»: сервер подтвердил выдачу', issued.status === 200, issued.body?.message);

    const row = getDb().prepare('SELECT status, issued_at FROM Orders WHERE id = ?').get(order.id);
    check('Заказ в базе «Выдан» с датой выдачи', row.status === 'Выдан' && Boolean(row.issued_at));
    const cell = getDb().prepare('SELECT status FROM Storage_Cells WHERE id = ?').get(order.cell.id);
    check('Ячейка освобождена', cell.status === 'Свободна');

    const list = await request('GET', '/api/orders?status=all&sort=receivedAt&order=desc', adminToken);
    check('Обновлённый список: счётчики «Готов 0 / Выдан 1»',
      list.body?.counts?.ready === 0 && list.body?.counts?.issued === 1);

    const mine = await request('GET', '/api/orders/my', clientToken);
    check('Клиент видит свой заказ со статусом «Выдан»', mine.body?.orders?.[0]?.status === 'Выдан');

    const again = await request('POST', `/api/orders/${order.id}/issue`, adminToken);
    check('Повторное нажатие: окно покажет «уже выдан» (409)',
      again.status === 409 && /уже выдан/.test(again.body?.error?.message || ''));

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
      + 'заказ выдаётся клиенту нажатием кнопки в интерфейсе.');
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
