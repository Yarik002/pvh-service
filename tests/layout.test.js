'use strict';

/**
 * Тесты базового шаблона страниц (9-й день практики).
 *
 * Проверяется серверная часть шаблона: состав документа, шапка с меню,
 * подвал, подстановка сведений о пользователе и его роли, экранирование
 * значений, а также отдача статических файлов.
 *
 * Запуск:  node tests/layout.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';
process.env.LOGIN_LIMIT_MAX = '500';
process.env.RATE_LIMIT_MAX = '500';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const authService = require('../src/services/authService');
const confirmationService = require('../src/services/confirmationService');
const userRepository = require('../src/repositories/userRepository');
const layout = require('../src/views/layout');

const PASSWORD = 'Xk9#mQ2$vL7p';
let server;
let baseUrl;

/** Готовит базу данных и поднимает сервер на свободном порту. */
async function startServer() {
  runMigrations();
  getDb().exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');

  server = await new Promise((resolve, reject) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

/** Останавливает сервер. */
async function stopServer() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
}

/** Создаёт пользователя, подтверждает адрес и возвращает токен сессии. */
async function loginAs(email, role = 'client', name = 'Иванов Иван') {
  const { user } = await authService.register({
    name, email, password: PASSWORD, passwordConfirm: PASSWORD,
  });

  confirmationService.confirmEmail(userRepository.findById(user.id).confirmToken);

  if (role !== 'client') {
    getDb().prepare('UPDATE Users SET role = ? WHERE id = ?').run(role, user.id);
  }

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  return (await response.json()).token;
}

/** Загружает страницу и возвращает текст ответа. */
async function getPage(path, token) {
  const headers = { Accept: 'text/html' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { status: response.status, contentType: response.headers.get('content-type'), html: await response.text() };
}

// ---------------------------------------------------------------------------
//  Модуль шаблона напрямую
// ---------------------------------------------------------------------------

test('renderPage формирует полноценный HTML-документ', () => {
  const html = layout.renderPage({ title: 'Проверка', content: '<p>Содержимое</p>' });

  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /<meta charset="UTF-8">/);
  assert.ok(html.includes('name="viewport"'), 'указан viewport для адаптивности');
  assert.ok(html.includes('<p>Содержимое</p>'), 'содержимое страницы подставлено');
  assert.ok(html.trimEnd().endsWith('</html>'));
});

test('заголовок страницы включает название приложения', () => {
  const html = layout.renderPage({ title: 'Вход', content: '' });
  assert.match(html, /<title>Вход — /);
});

test('шапка содержит наименование, меню и элементы управления', () => {
  const html = layout.renderPage({ title: 'Проверка', content: '' });

  assert.ok(html.includes('header__brand'), 'наименование приложения');
  assert.ok(html.includes('id="main-nav"'), 'меню приложения');
  assert.ok(html.includes('id="menu-toggle"'), 'кнопка меню для мобильных устройств');
  assert.ok(html.includes('id="theme-toggle"'), 'переключатель темы');
  assert.ok(html.includes('skip-link'), 'ссылка перехода к содержимому');
});

test('подвал содержит сведения о проекте и разделы', () => {
  const html = layout.renderPage({ title: 'Проверка', content: '' });

  assert.ok(html.includes('footer__grid'));
  assert.ok(html.includes('Минский колледж предпринимательства'));
  assert.ok(html.includes('Кирдун Я.С.'));
  assert.ok(html.includes('ПО-2409'));
});

test('подключаются таблица стилей и сценарий шаблона', () => {
  const html = layout.renderPage({ title: 'Проверка', content: '' });

  assert.ok(html.includes('/css/main.css'));
  assert.ok(html.includes('/js/layout.js'));
});

test('сценарии страницы подключаются дополнительно', () => {
  const html = layout.renderPage({
    title: 'Проверка',
    content: '',
    scripts: ['/js/login.js', '/js/common.js'],
  });

  assert.ok(html.includes('/js/login.js'));
  assert.ok(html.includes('/js/common.js'));
});

// ---------------------------------------------------------------------------
//  Меню: зависимость от роли
// ---------------------------------------------------------------------------

test('гость видит только общие разделы меню', () => {
  const html = layout.renderPage({ title: 'Проверка', content: '' });

  assert.ok(html.includes('Главная'));
  assert.ok(!html.includes('Мои заказы'), 'разделы клиента скрыты');
  assert.ok(!html.includes('Приёмка товара'), 'разделы администратора скрыты');
});

test('авторизованный клиент видит разделы клиента', () => {
  const html = layout.renderPage({
    title: 'Проверка',
    content: '',
    isAuthenticated: true,
    user: { name: 'Иванов Иван', email: 'ivanov@mail.ru', role: 'client' },
  });

  assert.ok(html.includes('Мои заказы'));
  assert.ok(html.includes('Ячейки'));
  assert.ok(!html.includes('Приёмка товара'), 'разделы администратора скрыты');
});

test('администратор видит разделы администратора', () => {
  const html = layout.renderPage({
    title: 'Проверка',
    content: '',
    isAuthenticated: true,
    user: { name: 'Администратор', email: 'admin@pvh.local', role: 'admin' },
  });

  assert.ok(html.includes('Приёмка товара'));
  assert.ok(html.includes('Администрирование'));
});

test('роль записывается в атрибут data-role', () => {
  const admin = layout.renderPage({
    title: 'Проверка', content: '', isAuthenticated: true,
    user: { name: 'Администратор', email: 'a@mail.ru', role: 'admin' },
  });
  const guest = layout.renderPage({ title: 'Проверка', content: '' });

  assert.ok(admin.includes('data-role="admin"'));
  assert.ok(guest.includes('data-role="guest"'));
});

test('текущий раздел помечается как активный', () => {
  const html = layout.renderPage({
    title: 'Заказы', path: '/orders', content: '',
    isAuthenticated: true, user: { name: 'Клиент', email: 'c@mail.ru', role: 'client' },
  });

  assert.match(html, /href="\/orders" aria-current="page"/);
});

test('функция isActive определяет активный раздел', () => {
  assert.equal(layout.isActive('/', '/'), true);
  assert.equal(layout.isActive('/index.html', '/'), true);
  assert.equal(layout.isActive('/orders', '/orders'), true);
  assert.equal(layout.isActive('/cells', '/orders'), false);
  assert.equal(layout.isActive('/login', '/'), false);
});

// ---------------------------------------------------------------------------
//  Область пользователя
// ---------------------------------------------------------------------------

test('гость видит ссылки на вход и регистрацию', () => {
  const html = layout.renderUserArea({ isAuthenticated: false });

  assert.ok(html.includes('/login.html'));
  assert.ok(html.includes('/register.html'));
  assert.ok(!html.includes('logout-button'));
});

test('авторизованный пользователь видит имя и кнопку выхода', () => {
  const html = layout.renderUserArea({
    isAuthenticated: true,
    user: { name: 'Иванов Иван', email: 'ivanov@mail.ru', role: 'client' },
  });

  assert.ok(html.includes('Иванов Иван'));
  assert.ok(html.includes('logout-button'));
  assert.ok(!html.includes('/login.html'), 'ссылка на вход не показывается');
});

// ---------------------------------------------------------------------------
//  Экранирование значений
// ---------------------------------------------------------------------------

test('значения экранируются при подстановке в разметку', () => {
  const html = layout.renderPage({
    title: 'Проверка',
    content: '',
    isAuthenticated: true,
    user: { name: '<script>alert(1)</script>', email: 'test@mail.ru', role: 'client' },
  });

  assert.ok(!html.includes('<script>alert(1)</script>'), 'опасный код не попадает в разметку');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('заголовок страницы экранируется', () => {
  const html = layout.renderPage({ title: '"><script>alert(1)</script>', content: '' });

  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('функция escapeHtml обрабатывает основные символы', () => {
  assert.equal(layout.escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.equal(layout.escapeHtml('ООО & Ко'), 'ООО &amp; Ко');
  assert.equal(layout.escapeHtml(null), '');
});

// ---------------------------------------------------------------------------
//  Страницы через HTTP
// ---------------------------------------------------------------------------

test('главная страница отдаётся как HTML', async () => {
  await startServer();
  try {
    const page = await getPage('/');

    assert.equal(page.status, 200);
    assert.match(page.contentType, /text\/html/);
    assert.ok(page.html.includes('Сервис трекинга заказов'));
    assert.ok(page.html.includes('header__inner'));
    assert.ok(page.html.includes('footer__grid'));
  } finally {
    await stopServer();
  }
});

test('главная страница показывает приглашение войти для гостя', async () => {
  await startServer();
  try {
    const page = await getPage('/');

    assert.ok(page.html.includes('Требуется вход в систему'));
    assert.ok(!page.html.includes('Вы вошли в систему'));
  } finally {
    await stopServer();
  }
});

test('главная страница приветствует авторизованного пользователя', async () => {
  await startServer();
  try {
    const token = await loginAs('client@mail.ru', 'client');
    const page = await getPage('/', token);

    assert.equal(page.status, 200);
    assert.ok(page.html.includes('Вы вошли в систему'));
    assert.ok(page.html.includes('Иванов Иван'));
    assert.ok(page.html.includes('data-role="client"'));
  } finally {
    await stopServer();
  }
});

test('администратору на главной странице показываются его разделы', async () => {
  await startServer();
  try {
    const token = await loginAs('admin@mail.ru', 'admin', 'Администратор ПВЗ');
    const page = await getPage('/', token);

    assert.ok(page.html.includes('data-role="admin"'));
    assert.ok(page.html.includes('Администратор ПВЗ'));
    assert.ok(page.html.includes('Приёмка товара'));
  } finally {
    await stopServer();
  }
});

test('страница проверки шаблона содержит все элементы оформления', async () => {
  await startServer();
  try {
    const page = await getPage('/template-demo');

    assert.equal(page.status, 200);
    assert.equal(page.contentType.includes('text/html'), true);

    for (const marker of ['alert--success', 'alert--warning', 'alert--danger', 'alert--info',
      'btn--secondary', 'btn--danger', 'table', 'badge--success', 'field__input',
      'field__error', 'strength__bar', 'stat__value', 'grid--4']) {
      assert.ok(page.html.includes(marker), `отсутствует элемент оформления: ${marker}`);
    }
  } finally {
    await stopServer();
  }
});

test('таблица стилей отдаётся статикой', async () => {
  await startServer();
  try {
    const response = await fetch(`${baseUrl}/css/main.css`);
    const css = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/css/);
    assert.ok(css.includes('--color-primary'), 'переменные оформления определены');
    assert.ok(css.includes('[data-theme="dark"]'), 'тёмная тема описана');
    assert.ok(css.includes('@media (max-width: 768px)'), 'адаптивность для мобильных устройств');
    assert.ok(css.includes('@media print'), 'стили для печати');
  } finally {
    await stopServer();
  }
});

test('сценарий шаблона отдаётся статикой', async () => {
  await startServer();
  try {
    const response = await fetch(`${baseUrl}/js/layout.js`);
    const js = await response.text();

    assert.equal(response.status, 200);
    assert.ok(js.includes('pvh.theme'), 'работа с темой оформления');
    assert.ok(js.includes('nav--open'), 'переключение меню на мобильных устройствах');
    assert.ok(js.includes('showAlert'), 'вывод уведомлений');
  } finally {
    await stopServer();
  }
});

test('несуществующая страница возвращает 404', async () => {
  await startServer();
  try {
    const response = await fetch(`${baseUrl}/no-such-page`, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404);
  } finally {
    await stopServer();
  }
});

test('справка API доступна по адресу /api', async () => {
  await startServer();
  try {
    const response = await fetch(`${baseUrl}/api`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(body.endpoints, 'перечень эндпоинтов');
    assert.ok(body.pages.home, 'перечень страниц');
  } finally {
    await stopServer();
  }
});

test('завершение работы: сервер остановлен, соединение закрыто', async () => {
  await stopServer();
  closeDb();
});
