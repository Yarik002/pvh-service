'use strict';

/**
 * Проверка сборки v0.21 (22-й день практики).
 *
 * Тема дня: единая система перехвата ошибок API и вывода понятных
 * уведомлений (Toast/Alert).
 * Критерий приёмки: любые ошибки сервера выводятся пользователю
 * в понятном всплывающем окне.
 *
 * Сценарий вызывает разные виды ошибок на сервере (нет входа, нет прав,
 * не найдено, конфликт, неверные данные, сломанный JSON) и проверяет:
 * формат ответа, текст на русском и то, какое уведомление покажет
 * перехватчик ошибок из public/js/api.js (он выполняется в изолированном
 * контексте с записью уведомлений).
 *
 * Запуск:  node scripts/check-v0.21.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v021-${process.pid}.db`);
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

const PORT = Number.parseInt(process.env.CHECK_PORT || '3130', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Xk9#mQ2$vL7p';
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function raw(method, address, token, body, contentType = 'application/json') {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = contentType;
  const response = await fetch(`${BASE}${address}`, {
    method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, body: json };
}

async function createAndLogin(name, email, role) {
  userRepository.create({ name, email, passwordHash: await hashPassword(PASSWORD), role, isConfirmed: true });
  return (await raw('POST', '/api/auth/login', null, { email, password: PASSWORD })).body.token;
}

/** Перехватчик ошибок браузера с записью показанных уведомлений. */
function browserInterceptor() {
  const toasts = [];
  const window = {
    location: { pathname: '/orders', search: '', href: '' },
    setTimeout: () => 0,
    clearTimeout() {},
    PVH: { toast: (type, message, title) => toasts.push({ type, message, title }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(config.rootDir, 'public', 'js', 'api.js'), 'utf8'), { window });
  return { handle: window.PVH_API.handleGlobalError, toasts };
}

/** Какое уведомление увидит пользователь при этом ответе сервера. */
function shownToast(response, apiPath, method = 'GET') {
  const { handle, toasts } = browserInterceptor();
  const error = response.body?.error || {};
  handle({ name: 'ApiError', status: response.status, code: error.code, message: error.message, notified: false },
    apiPath, { method });
  return toasts[0] || null;
}

const russian = (text) => /[а-яё]/i.test(text || '');

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — перехват ошибок и всплывающие уведомления`);
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
    const clientToken = await createAndLogin('Иванов Иван', `ivanov_${stamp}@mail.ru`, 'client');

    // --- 1. Ошибки, которые показывает общий перехватчик ---------------------------------
    const noSession = await raw('GET', '/api/orders/my', 'invalid-token-0000');
    const toast401 = shownToast(noSession, '/orders/my');
    check('Сеанс завершён (401): уведомление «Сеанс завершён»',
      noSession.status === 401 && toast401?.title === 'Сеанс завершён' && russian(toast401.message), toast401?.message);

    const forbidden = await raw('GET', '/api/orders', clientToken);
    const toast403 = shownToast(forbidden, '/orders');
    check('Нет прав (403): уведомление «Недостаточно прав»',
      forbidden.status === 403 && toast403?.title === 'Недостаточно прав', toast403?.message);

    const server500 = shownToast({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера' } } }, '/orders');
    check('Ошибка сервера (5xx): уведомление «Ошибка сервера»', server500?.title === 'Ошибка сервера', server500?.message);

    const network = browserInterceptor();
    network.handle({ name: 'ApiError', code: 'NETWORK_ERROR', message: 'Не удалось связаться с сервером.' }, '/orders', {});
    check('Нет сети: уведомление «Нет связи с сервером»', network.toasts[0]?.title === 'Нет связи с сервером');

    // --- 2. Ошибки форм остаются у полей ----------------------------------------------------
    const badLogin = await raw('POST', '/api/auth/login', null, { email: `ivanov_${stamp}@mail.ru`, password: 'неверный' });
    check('Неверный пароль — ошибка формы, без «Сеанс завершён»',
      badLogin.status === 401 && shownToast(badLogin, '/auth/login', 'POST') === null);

    const invalid = await raw('POST', '/api/auth/register', null, { name: 'И', email: 'не почта', password: '1' });
    check('Ошибки полей (400) возвращаются с указанием полей',
      invalid.status === 400 && Object.keys(invalid.body?.error?.details || {}).length >= 2
        && shownToast(invalid, '/auth/register', 'POST') === null);

    // --- 3. Единый формат ответа ------------------------------------------------------------
    const responses = [
      ['не найдено', await raw('GET', '/api/orders/999999', clientToken), 404],
      ['неизвестный адрес API', await raw('GET', '/api/nothing-here'), 404],
      ['неверный идентификатор', await raw('GET', '/api/orders/abc', clientToken), 400],
      ['неверный фильтр', await raw('GET', '/api/orders/my?status=потерян', clientToken), 400],
      ['сломанный JSON', await raw('POST', '/api/auth/login', null, '{неверный json'), 400],
    ];
    for (const [label, response, status] of responses) {
      check(`Единый формат ошибки: ${label} (${status})`,
        response.status === status && response.body?.success === false
          && typeof response.body.error?.code === 'string' && russian(response.body.error.message),
        response.body?.error?.message);
    }

    // --- 4. Подключение на страницах -----------------------------------------------------------
    const layoutJs = fs.readFileSync(path.join(config.rootDir, 'public', 'js', 'layout.js'), 'utf8');
    check('Функция всплывающих уведомлений PVH.toast', layoutJs.includes('toast: toast'));
    check('Необработанные ошибки API тоже показываются', layoutJs.includes("'unhandledrejection'"));
    const css = fs.readFileSync(path.join(config.rootDir, 'public', 'css', 'main.css'), 'utf8');
    check('Оформление уведомлений описано', css.includes('.toast-stack') && css.includes('.toast--danger'));

    const health = await raw('GET', '/health');
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
      + 'ошибки сервера выводятся пользователю в понятном всплывающем окне.');
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
