'use strict';

/**
 * Тесты единой обработки ошибок и всплывающих уведомлений (22-й день).
 *
 * Проверяется:
 *   • перехватчик ошибок API (public/js/api.js) показывает нужное уведомление
 *     для каждого вида ошибки и не мешает ошибкам полей формы;
 *   • при завершённом сеансе выполняется переход на страницу входа;
 *   • фоновые запросы (silent) уведомлений не показывают;
 *   • всплывающие уведомления (public/js/layout.js): типы, закрытие, лимит;
 *   • сервер отдаёт любые ошибки в едином формате JSON на русском языке.
 *
 * Запуск:  node tests/notifications.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';

const { closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { createApp } = require('../src/app');

const PUBLIC = path.join(__dirname, '..', 'public', 'js');
const API_JS = fs.readFileSync(path.join(PUBLIC, 'api.js'), 'utf8');
const LAYOUT_JS = fs.readFileSync(path.join(PUBLIC, 'layout.js'), 'utf8');

/** Загружает api.js в изолированном контексте с записью уведомлений. */
function loadApi() {
  const toasts = [];
  const timers = [];
  const window = {
    location: { pathname: '/orders', search: '?status=ready', href: '' },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    PVH: { toast: (type, message, title) => toasts.push({ type, message, title }) },
  };
  vm.runInNewContext(API_JS, { window });
  return { api: window.PVH_API, toasts, timers, window };
}

const apiError = (status, code, message = 'Сообщение сервера') => ({ name: 'ApiError', status, code, message, notified: false });

test('завершённый сеанс: уведомление и переход на вход с возвратом', () => {
  const { api, toasts, timers, window } = loadApi();
  const error = apiError(401, 'SESSION_EXPIRED', 'Срок действия сессии истёк. Войдите в систему заново.');

  api.handleGlobalError(error, '/orders/my', { method: 'GET' });

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, 'Сеанс завершён');
  assert.equal(error.notified, true, 'страница не покажет сообщение повторно');
  timers.forEach((fn) => fn());
  assert.equal(window.location.href, '/login?next=%2Forders%3Fstatus%3Dready');
});

test('неверный пароль при входе — ошибка формы, а не «сеанс завершён»', () => {
  const { api, toasts } = loadApi();
  api.handleGlobalError(apiError(401, 'INVALID_CREDENTIALS'), '/auth/login', { method: 'POST' });
  api.handleGlobalError(apiError(401, 'INVALID_PASSWORD'), '/auth/me', { method: 'DELETE' });
  assert.equal(toasts.length, 0);
});

test('нет прав, лимит запросов, ошибка сервера, нет сети — понятные заголовки', () => {
  const { api, toasts } = loadApi();
  api.handleGlobalError(apiError(403, 'FORBIDDEN'), '/orders', {});
  api.handleGlobalError(apiError(429, 'TOO_MANY_REQUESTS'), '/auth/login', {});
  api.handleGlobalError(apiError(500, 'INTERNAL_ERROR', 'Internal'), '/orders', {});
  api.handleGlobalError(apiError(undefined, 'NETWORK_ERROR', 'Не удалось связаться с сервером.'), '/orders', {});
  api.handleGlobalError(apiError(undefined, 'TIMEOUT', 'Сервер не отвечает.'), '/orders', {});

  assert.deepEqual(toasts.map((t) => t.title), [
    'Недостаточно прав', 'Слишком много запросов', 'Ошибка сервера', 'Нет связи с сервером', 'Нет связи с сервером',
  ]);
  assert.doesNotMatch(toasts[2].message, /Internal/, 'технический текст сервера не показывается');
});

test('ошибки полей формы (400, 404, 409) остаются странице', () => {
  const { api, toasts } = loadApi();
  for (const status of [400, 404, 409]) {
    const error = apiError(status, 'BAD_REQUEST');
    api.handleGlobalError(error, '/orders', {});
    assert.equal(error.notified, false);
  }
  assert.equal(toasts.length, 0);
});

test('фоновый запрос (silent) не показывает уведомлений', () => {
  const { api, toasts } = loadApi();
  api.handleGlobalError(apiError(undefined, 'NETWORK_ERROR'), '/orders/my', { silent: true });
  assert.equal(toasts.length, 0);
});

test('перехватчик вызывается для каждой ошибки запроса', () => {
  assert.ok(API_JS.includes('handleGlobalError(apiError, path, settings);'));
  assert.ok(API_JS.includes('throw apiError;'), 'ошибка передаётся дальше странице');
});

test('всплывающие уведомления: типы, закрытие, лимит, пауза при наведении', () => {
  assert.ok(LAYOUT_JS.includes('function toast(type, message, title)'));
  assert.ok(LAYOUT_JS.includes("node.setAttribute('role', kind === 'danger' ? 'alert' : 'status')"));
  assert.ok(LAYOUT_JS.includes("'Закрыть уведомление'"));
  assert.ok(LAYOUT_JS.includes('TOAST_LIMIT = 4'));
  assert.ok(LAYOUT_JS.includes("addEventListener('mouseenter'"));
  assert.ok(LAYOUT_JS.includes('toast: toast'), 'функция доступна страницам');
});

test('необработанная ошибка API всё равно показывается пользователю', () => {
  assert.ok(LAYOUT_JS.includes("addEventListener('unhandledrejection'"));
});

test('стили уведомлений описаны', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'main.css'), 'utf8');
  for (const selector of ['.toast-stack', '.toast--success', '.toast--danger', '.toast__close']) {
    assert.ok(css.includes(selector), selector);
  }
});

test('сервер отдаёт ошибки в едином формате JSON на русском языке', async () => {
  runMigrations();
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cases = [
      ['GET', '/api/nope', 404],
      ['GET', '/api/orders/my', 401],
      ['POST', '/api/orders/abc/issue', 401],
    ];
    for (const [method, address, status] of cases) {
      const response = await fetch(`${base}${address}`, { method, headers: { Accept: 'application/json' } });
      const body = await response.json();
      assert.equal(response.status, status, address);
      assert.equal(body.success, false);
      assert.equal(typeof body.error.code, 'string');
      assert.match(body.error.message, /[а-яё]/i, 'сообщение на русском');
    }

    const broken = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{неверный json',
    });
    const brokenBody = await broken.json();
    assert.equal(broken.status, 400);
    assert.match(brokenBody.error.message, /[а-яё]/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => closeDb());
