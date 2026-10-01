'use strict';

/**
 * Тесты страниц регистрации и входа (10-й день практики).
 *
 * Проверяется, что страницы отдаются в общем шаблоне, содержат все поля
 * с подписями и сообщениями об ошибках, подключены к API и защищены
 * от подстановки внешнего адреса возврата.
 *
 * Запуск:  node tests/authPages.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';
process.env.LOGIN_LIMIT_MAX = '500';
process.env.RATE_LIMIT_MAX = '500';
process.env.RESEND_LIMIT_MAX = '500';
process.env.CONFIRM_LIMIT_MAX = '500';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const userRepository = require('../src/repositories/userRepository');
const confirmationService = require('../src/services/confirmationService');
const authPages = require('../src/views/authPages');

const PASSWORD = 'Xk9#mQ2$vL7p';
let server;
let baseUrl;

/** Готовит базу данных и поднимает сервер на свободном порту. */
async function startServer() {
  runMigrations();
  getDb().exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users;');

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

/** Загружает страницу. */
async function getPage(path, options = {}) {
  const headers = { Accept: options.accept || 'text/html' };
  if (options.cookie) headers.Cookie = options.cookie;

  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    redirect: options.redirect || 'manual',
  });

  const text = await response.text();
  return { status: response.status, location: response.headers.get('location'), text };
}

/** Отправляет запрос к API. */
async function api(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return { status: response.status, location: response.headers.get('location'), body: parsed };
}

/** Регистрирует пользователя напрямую через API. */
function register(email, name = 'Новый Пользователь') {
  return api('POST', '/api/auth/register', {
    name, email, password: PASSWORD, passwordConfirm: PASSWORD,
  });
}

// ---------------------------------------------------------------------------
//  Отдача страниц
// ---------------------------------------------------------------------------

test('страница регистрации отдаётся в общем шаблоне', async () => {
  await startServer();
  try {
    const page = await getPage('/register');

    assert.equal(page.status, 200);
    assert.ok(page.text.includes('header__inner'), 'шапка приложения');
    assert.ok(page.text.includes('footer__grid'), 'подвал приложения');
    assert.ok(page.text.includes('id="register-form"'), 'форма регистрации');
  } finally {
    await stopServer();
  }
});

test('страница входа отдаётся в общем шаблоне', async () => {
  await startServer();
  try {
    const page = await getPage('/login');

    assert.equal(page.status, 200);
    assert.ok(page.text.includes('header__inner'));
    assert.ok(page.text.includes('id="login-form"'));
  } finally {
    await stopServer();
  }
});

test('адреса .html перенаправляются на страницы приложения', async () => {
  await startServer();
  try {
    const cases = [
      ['/index.html', '/'],
      ['/login.html', '/login'],
      ['/register.html', '/register'],
    ];

    for (const [from, to] of cases) {
      const page = await getPage(from);
      assert.equal(page.status, 301, `${from}: ожидалось перенаправление`);
      assert.equal(page.location, to);
    }
  } finally {
    await stopServer();
  }
});

test('несуществующая страница отдаётся в шаблоне с кодом 404', async () => {
  await startServer();
  try {
    const page = await getPage('/nesushchestvuyushchaya-stranica');

    assert.equal(page.status, 404);
    assert.ok(page.text.includes('header__inner'), 'оформлена как страница приложения');
    assert.ok(page.text.includes('Страница не найдена'));
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Состав формы регистрации
// ---------------------------------------------------------------------------

test('форма регистрации содержит все поля с подписями', async () => {
  await startServer();
  try {
    const page = await getPage('/register');

    for (const field of ['name', 'email', 'password', 'passwordConfirm']) {
      assert.ok(page.text.includes(`data-field="${field}"`),
        `отсутствует поле ${field}`);
      assert.ok(page.text.includes(`name="${field}"`),
        `у поля ${field} нет атрибута name`);
    }

    assert.ok(page.text.includes('Согласен с правилами обработки персональных данных'),
      'отсутствует согласие на обработку данных');
  } finally {
    await stopServer();
  }
});

test('обязательные поля отмечены и подписаны', async () => {
  await startServer();
  try {
    const page = await getPage('/register');

    assert.ok(page.text.includes('field__required'), 'обязательные поля отмечены');
    assert.ok(page.text.includes('autocomplete="email"'),
      'полю адреса указана подсказка автозаполнения');
    assert.ok(page.text.includes('autocomplete="new-password"'),
      'полям пароля указан тип автозаполнения');
  } finally {
    await stopServer();
  }
});

test('у полей есть места для вывода сообщений об ошибках', async () => {
  await startServer();
  try {
    const page = await getPage('/register');

    const errorSlots = page.text.match(/class="field__error"/g) || [];
    assert.ok(errorSlots.length >= 5,
      `мест для сообщений об ошибках: ${errorSlots.length}, ожидалось не менее 5`);
  } finally {
    await stopServer();
  }
});

test('страница регистрации подключает нужные сценарии', async () => {
  await startServer();
  try {
    const page = await getPage('/register');

    assert.ok(page.text.includes('/js/api.js'), 'обёртка над API');
    assert.ok(page.text.includes('/js/form.js'), 'проверка полей');
    assert.ok(page.text.includes('/js/register.js'), 'сценарий страницы');
  } finally {
    await stopServer();
  }
});

test('на странице регистрации есть ссылка на вход', async () => {
  await startServer();
  try {
    const page = await getPage('/register');
    assert.ok(page.text.includes('href="/login"'));
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Состав формы входа
// ---------------------------------------------------------------------------

test('форма входа содержит адрес электронной почты и пароль', async () => {
  await startServer();
  try {
    const page = await getPage('/login');

    assert.ok(page.text.includes('data-field="email"'));
    assert.ok(page.text.includes('data-field="password"'));
    assert.ok(page.text.includes('type="password"'));
    assert.ok(page.text.includes('autocomplete="current-password"'));
  } finally {
    await stopServer();
  }
});

test('форма входа передаёт адрес возврата', async () => {
  await startServer();
  try {
    const page = await getPage('/login?next=%2Fcells.html');
    assert.match(page.text, /name="next" value="\/cells\.html"/);
  } finally {
    await stopServer();
  }
});

test('адрес возврата на сторонний сайт не принимается', async () => {
  await startServer();
  try {
    const attempts = [
      '//zloj.ru',
      'https://zloj.ru',
      'http://zloj.ru/login',
      '/\\zloj.ru',
    ];

    for (const next of attempts) {
      const page = await getPage(`/login?next=${encodeURIComponent(next)}`);
      assert.match(page.text, /name="next" value="\/"/,
        `адрес «${next}» должен быть заменён на главную страницу`);
    }
  } finally {
    await stopServer();
  }
});

test('допустимый внутренний адрес возврата сохраняется', async () => {
  await startServer();
  try {
    const page = await getPage('/login?next=%2Forders.html');
    assert.match(page.text, /name="next" value="\/orders\.html"/);
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Полная цепочка: регистрация, подтверждение, вход
// ---------------------------------------------------------------------------

test('регистрация создаёт неподтверждённую учётную запись', async () => {
  await startServer();
  try {
    const response = await register('cepochka@mail.ru');

    assert.equal(response.status, 201);
    assert.ok(response.body.user, 'в ответе есть данные пользователя');
    assert.equal(response.body.user.isConfirmed, false, 'адрес ещё не подтверждён');
    assert.ok(response.body.confirmationEmail, 'в ответе есть сведения об отправке письма');
  } finally {
    await stopServer();
  }
});

test('вход до подтверждения адреса отклоняется (403)', async () => {
  await startServer();
  try {
    await register('nedoverennyj@mail.ru');

    const response = await api('POST', '/api/auth/login', {
      email: 'nedoverennyj@mail.ru', password: PASSWORD,
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'EMAIL_NOT_CONFIRMED');
  } finally {
    await stopServer();
  }
});

test('переход по ссылке из письма приводит на страницу подтверждения', async () => {
  await startServer();
  try {
    await register('ssylka@mail.ru');
    const token = userRepository.findByEmail('ssylka@mail.ru').confirmToken;

    const response = await api('GET', `/api/auth/confirm/page?token=${token}`);

    assert.equal(response.status, 303, 'выполняется перенаправление');
    assert.match(response.location, /^\/confirm\?/);
    assert.match(response.location, /status=success/);

    // Страница подтверждения оформлена в общем шаблоне
    const page = await getPage(response.location);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('header__inner'));
    assert.ok(page.text.includes('Адрес электронной почты подтверждён'));
  } finally {
    await stopServer();
  }
});

test('повторное использование ссылки не подтверждает адрес дважды', async () => {
  await startServer();
  try {
    await register('povtor@mail.ru');
    const token = userRepository.findByEmail('povtor@mail.ru').confirmToken;

    await api('GET', `/api/auth/confirm/page?token=${token}`);
    const second = await api('GET', `/api/auth/confirm/page?token=${token}`);

    assert.equal(second.status, 303);
    assert.match(second.location, /status=invalid/,
      'повторное использование ссылки не считается успехом');
  } finally {
    await stopServer();
  }
});

test('неверный токен приводит на страницу с сообщением об ошибке', async () => {
  await startServer();
  try {
    const response = await api('GET', '/api/auth/confirm/page?token=nesushchestvuyushchij');
    assert.match(response.location, /status=invalid/);

    const page = await getPage(response.location);
    assert.ok(page.text.includes('Ссылка недействительна'));
    assert.ok(page.text.includes('id="resend-form"'),
      'предлагается запросить новое письмо');
  } finally {
    await stopServer();
  }
});

test('страница подтверждения не подставляет произвольный параметр в разметку', async () => {
  await startServer();
  try {
    const page = await getPage('/confirm?status=%3Cscript%3Ealert(1)%3C%2Fscript%3E');

    assert.equal(page.status, 200);
    assert.ok(!page.text.includes('<script>alert(1)</script>'),
      'опасный код не попадает в разметку страницы');
  } finally {
    await stopServer();
  }
});

test('вход после подтверждения выдаёт сессию', async () => {
  await startServer();
  try {
    await register('vhod@mail.ru');
    const token = userRepository.findByEmail('vhod@mail.ru').confirmToken;
    confirmationService.confirmEmail(token);

    const response = await api('POST', '/api/auth/login', {
      email: 'vhod@mail.ru', password: PASSWORD,
    });

    assert.equal(response.status, 200);
    assert.ok(response.body.token, 'выдан токен сессии');
    assert.equal(response.body.user.isConfirmed, true);
  } finally {
    await stopServer();
  }
});

test('вошедший пользователь не остаётся на странице входа', async () => {
  await startServer();
  try {
    await register('uzhevoshel@mail.ru');
    const token = userRepository.findByEmail('uzhevoshel@mail.ru').confirmToken;
    confirmationService.confirmEmail(token);

    const login = await api('POST', '/api/auth/login', {
      email: 'uzhevoshel@mail.ru', password: PASSWORD,
    });

    const page = await fetch(`${baseUrl}/login`, {
      headers: { Accept: 'text/html', Cookie: `pvh_session=${login.body.token}` },
      redirect: 'manual',
    });

    assert.equal(page.status, 302, 'выполняется перенаправление');
    assert.equal(page.headers.get('location'), '/');
  } finally {
    await stopServer();
  }
});

test('вошедший пользователь не остаётся на странице регистрации', async () => {
  await startServer();
  try {
    await register('zanovo@mail.ru');
    const token = userRepository.findByEmail('zanovo@mail.ru').confirmToken;
    confirmationService.confirmEmail(token);

    const login = await api('POST', '/api/auth/login', {
      email: 'zanovo@mail.ru', password: PASSWORD,
    });

    const page = await fetch(`${baseUrl}/register`, {
      headers: { Accept: 'text/html', Cookie: `pvh_session=${login.body.token}` },
      redirect: 'manual',
    });

    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/');
  } finally {
    await stopServer();
  }
});

// ---------------------------------------------------------------------------
//  Модуль разметки напрямую
// ---------------------------------------------------------------------------

test('renderField формирует поле со всеми элементами', () => {
  const html = authPages.renderField({
    name: 'email',
    label: 'Адрес электронной почты',
    type: 'email',
    required: true,
    hint: 'Подсказка',
  });

  assert.ok(html.includes('data-field="email"'));
  assert.ok(html.includes('for="field-email"'));
  assert.ok(html.includes('id="field-email"'));
  assert.ok(html.includes('name="email"'));
  assert.ok(html.includes('type="email"'));
  assert.ok(html.includes('required'));
  assert.ok(html.includes('field__error'));
  assert.ok(html.includes('Подсказка'));
});

test('renderField экранирует подпись и подсказку', () => {
  const html = authPages.renderField({
    name: 'x', label: '<b>Метка</b>', hint: '<i>Подсказка</i>',
  });

  assert.ok(!html.includes('<b>Метка</b>'));
  assert.ok(html.includes('&lt;b&gt;'));
});

test('renderNotFoundContent содержит путь запроса', () => {
  const html = authPages.renderNotFoundContent({ path: '/nepravilnyj-adres' });
  assert.ok(html.includes('/nepravilnyj-adres'));
});

test('завершение работы: сервер остановлен, соединение закрыто', async () => {
  await stopServer();
  closeDb();
});
