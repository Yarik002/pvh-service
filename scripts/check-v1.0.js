'use strict';

/**
 * Проверка релиза v1.0 (24-й день практики).
 *
 * Тема дня: финальная отладка, функциональное тестирование и исправление
 * найденных дефектов.
 * Критерий приёмки: сборка v1.0 (релиз-кандидат) без ошибок, зафиксирована
 * в репозитории.
 *
 * Сценарий проходит полный путь работы пункта выдачи так, как его
 * показывают на защите: регистрация клиента с подтверждением почты, вход,
 * ожидаемый заказ, приёмка, автообновление у клиента, выдача, изменение
 * и удаление заказа, профиль, все страницы для каждой роли, обработка
 * ошибок. Каждая функция ТЗ проверяется одной или несколькими точками.
 *
 * Запуск:  node scripts/check-v1.0.js   (или npm run check)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v10-${process.pid}.db`);
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

const PORT = Number.parseInt(process.env.CHECK_PORT || '3131', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 70 - title.length))}`);
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
  return { status: response.status, text, body: json, headers: response.headers };
}

const login = async (email, password) => (await request('POST', '/api/auth/login', null, { body: { email, password } })).body;

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА РЕЛИЗА v${config.version} — полный путь работы пункта выдачи`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();
  check('Версия релиза 1.0.0', config.version === '1.0.0', config.version);

  // Администратор, как после npm run seed: логин admin, пароль admin
  userRepository.create({
    name: 'Администратор ПВЗ', email: config.seed.adminEmail,
    passwordHash: await hashPassword('admin'), role: 'admin', isConfirmed: true,
  });
  check('В справочнике 20 ячеек хранения',
    getDb().prepare('SELECT COUNT(*) AS n FROM Storage_Cells').get().n === 20);

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, BASE);

  try {
    const email = `client_${Date.now()}@mail.ru`;
    const password = 'Kp7#zR4!wq';

    section('1. Регистрация и вход');
    const registered = await request('POST', '/api/auth/register', null,
      { body: { name: 'Мария Клиентова', email, password, passwordConfirm: password, agree: true } });
    check('Регистрация клиента (201)', registered.status === 201, registered.body?.message);
    const early = await request('POST', '/api/auth/login', null, { body: { email, password } });
    check('До подтверждения почты вход запрещён', early.status === 403 && early.body?.error?.code === 'EMAIL_NOT_CONFIRMED');

    const token = getDb().prepare('SELECT confirm_token FROM Users WHERE email = ?').get(email).confirm_token;
    const confirmed = await request('GET', `/api/auth/confirm?token=${token}`, null, { accept: 'text/html' });
    check('Переход по ссылке из письма подтверждает адрес', confirmed.status === 200
      && userRepository.findByEmail(email).isConfirmed);
    check('Страница подтверждения в фирменном оформлении', confirmed.text.includes('#ffcd2e'));

    const client = await login(email, password);
    check('Вход клиента выдаёт токен сессии', Boolean(client?.token));
    const admin = await login('admin', 'admin');
    check('Вход администратора: логин admin, пароль admin', admin?.user?.role === 'admin');

    section('2. Роли и страницы');
    const pages = [
      ['/', 200, 200], ['/orders', 200, 200], ['/cells', 200, 200], ['/profile', 200, 200],
      ['/receive', 403, 200], ['/admin', 403, 200],
    ];
    for (const [address, forClient, forAdmin] of pages) {
      const c = await request('GET', address, client.token, { accept: 'text/html' });
      const a = await request('GET', address, admin.token, { accept: 'text/html' });
      check(`Страница ${address}: клиент ${forClient}, администратор ${forAdmin}`,
        c.status === forClient && a.status === forAdmin, `${c.status} / ${a.status}`);
    }
    const guestOrders = await request('GET', '/orders', null, { accept: 'text/html' });
    check('Гостю — страница «Нужно войти» с возвратом после входа',
      guestOrders.status === 401 && guestOrders.text.includes('Нужно войти в систему')
        && guestOrders.text.includes('/login?next=%2Forders'));
    const clientAdmin = await request('GET', '/admin', client.token, { accept: 'text/html' });
    check('Клиенту в разделе администратора — страница «Доступ запрещён»',
      clientAdmin.text.includes('Доступ запрещён') && !clientAdmin.text.includes('"success":false'));
    const notFound = await request('GET', '/no-such-page', null, { accept: 'text/html' });
    check('Несуществующая страница — оформленная 404', notFound.status === 404 && notFound.text.includes('error-page__code'));

    section('3. Приёмка, автообновление, выдача');
    const expected = await request('POST', '/api/orders/expected', admin.token,
      { body: { trackNumber: 'RA100000001BY', clientEmail: email, description: 'Наушники' } });
    check('Ожидаемый заказ «В пути»', expected.status === 201 && expected.body.order.status === 'В пути');

    const before = (await request('GET', '/api/orders/my', client.token)).body.orders;
    const received = await request('POST', '/api/orders', admin.token, { body: { trackNumber: 'RA100000001BY', clientEmail: email } });
    check('Приёмка: ячейка назначена автоматически', received.status === 201 && received.body.order.cell.cellNumber === 1);
    check('Клиенту отправлено письмо о поступлении', ['sent', 'logged'].includes(received.body.notification.status));
    const manual = await request('POST', '/api/orders', admin.token,
      { body: { trackNumber: 'PVZ100000002', clientEmail: email, cellMode: 'manual', cellNumber: 7 } });
    check('Приёмка с ручным выбором ячейки № 7', manual.body?.order?.cell?.cellNumber === 7);

    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(config.rootDir, 'public', 'js', 'ordersLive.js'), 'utf8'), { window });
    const after = (await request('GET', '/api/orders/my', client.token)).body.orders;
    const diff = window.PVH_LIVE.diffOrders(before, after);
    check('Автообновление у клиента замечает смену статуса и новый заказ',
      diff.changed.length === 1 && diff.added.length === 1);

    const home = await request('GET', '/', null, { accept: 'text/html' });
    check('Схема склада на главной: занято 2 ячейки', (home.text.match(/locker__cell--busy/g) || []).length === 2);

    const issued = await request('POST', `/api/orders/${received.body.order.id}/issue`, admin.token);
    check('Выдача: «Выдан», ячейка № 1 свободна', issued.status === 200 && issued.body.cell.status === 'Свободна');
    check('Повторная выдача невозможна', (await request('POST', `/api/orders/${received.body.order.id}/issue`, admin.token)).status === 409);

    section('4. Списки, фильтры, сортировка');
    const mine = await request('GET', '/api/orders/my?status=all&sort=receivedAt&order=desc', client.token);
    check('«Мои заказы»: 2 заказа, счётчики по статусам',
      mine.body.total === 2 && mine.body.counts.issued === 1 && mine.body.counts.ready === 1);
    const all = await request('GET', '/api/orders?status=ready&sort=cell&order=asc', admin.token);
    check('«Все заказы»: фильтр «Готов к выдаче» и сортировка по ячейке', all.body.total === 1 && all.body.orders[0].cell.cellNumber === 7);
    check('Клиенту «Все заказы» недоступны', (await request('GET', '/api/orders', client.token)).status === 403);

    section('5. Изменение и удаление (CRUD)');
    const edited = await request('PATCH', `/api/orders/${manual.body.order.id}`, admin.token, { body: { description: 'Книга' } });
    check('Изменение описания заказа', edited.body?.order?.description === 'Книга');
    const blocked = await request('DELETE', '/api/auth/me', client.token, { body: { password } });
    check('Профиль не удаляется, пока заказ лежит в ячейке', blocked.status === 409);
    const removed = await request('DELETE', `/api/orders/${manual.body.order.id}`, admin.token);
    check('Удаление заказа освобождает ячейку № 7', removed.status === 200 && removed.body.freedCell?.cellNumber === 7);
    const renamed = await request('PATCH', '/api/auth/me', client.token, { body: { name: 'Мария Иванова' } });
    check('Изменение имени в профиле', renamed.body?.user?.name === 'Мария Иванова');
    const changed = await request('POST', '/api/password/change', client.token,
      { body: { currentPassword: password, newPassword: 'Nw8$hT3!zx', newPasswordConfirm: 'Nw8$hT3!zx' } });
    check('Смена пароля', changed.status === 200);
    const deleted = await request('DELETE', '/api/auth/me', client.token, { body: { password: 'Nw8$hT3!zx' } });
    check('Удаление учётной записи', deleted.status === 200 && !userRepository.findByEmail(email));

    section('6. Ошибки и безопасность');
    check('Неверный пароль администратора — 401', (await request('POST', '/api/auth/login', null,
      { body: { email: 'admin', password: 'wrong' } })).status === 401);
    const injection = await request('GET', `/api/orders?sort=${encodeURIComponent('id; DROP TABLE Orders')}`, admin.token);
    check('Внедрение SQL через сортировку отклонено', injection.status === 400);
    const xss = await request('POST', '/api/orders/expected', admin.token,
      { body: { trackNumber: 'PVZ100000003', clientEmail: 'nobody@mail.ru', description: '<script>alert(1)</script>' } });
    check('Неизвестный получатель — 404 с понятным текстом', xss.status === 404 && /[а-яё]/i.test(xss.body.error.message));
    const broken = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    check('Некорректный JSON — 400, а не 500', broken.status === 400);
    check('Заголовки безопасности (nosniff, X-Frame-Options)',
      home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('x-frame-options') === 'SAMEORIGIN');

    const health = await request('GET', '/health');
    check('Эндпоинт /health: сервер и база данных в порядке', health.body?.status === 'OK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${TMP_DB}${suffix}`, { force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${'-'.repeat(78)}`);
  console.log(`Всего проверок: ${results.length}, пройдено: ${results.length - failed.length}, ошибок: ${failed.length}`);
  if (failed.length === 0) {
    console.log(`РЕЗУЛЬТАТ: релиз v${config.version} соответствует критерию приёмки — `
      + 'все функции работают без ошибок.');
    console.log('='.repeat(78));
    return 0;
  }
  console.log('РЕЗУЛЬТАТ: релиз НЕ прошёл проверку. Не пройденные проверки:');
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
