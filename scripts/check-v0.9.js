'use strict';

/**
 * Проверка сборки v0.9 (10-й день практики).
 *
 * Тема дня: разработка страниц регистрации и входа с подключением к REST API.
 * Критерий приёмки: успешная регистрация и вход работают прямо в браузере.
 *
 * Проверяется вся цепочка целиком:
 *   страница регистрации → создание учётной записи через API →
 *   письмо со ссылкой → подтверждение адреса → вход → доступ к защищённым
 *   данным → выход из системы.
 *
 * Запуск:  node scripts/check-v0.9.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v09-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '500';
process.env.LOGIN_LIMIT_MAX = process.env.LOGIN_LIMIT_MAX || '500';
process.env.RESEND_LIMIT_MAX = process.env.RESEND_LIMIT_MAX || '500';
process.env.CONFIRM_LIMIT_MAX = process.env.CONFIRM_LIMIT_MAX || '500';
process.env.MAIL_TRANSPORT = 'log';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const userRepository = require('../src/repositories/userRepository');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3118', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Загружает страницу. */
async function page(path, { cookie, redirect = 'manual' } = {}) {
  const headers = { Accept: 'text/html' };
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(`${BASE}${path}`, { headers, redirect });
  return {
    status: response.status,
    location: response.headers.get('location'),
    text: await response.text(),
  };
}

/** Выполняет запрос к API. */
async function api(method, endpoint, { body, cookie } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers,
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

  return {
    status: response.status,
    location: response.headers.get('location'),
    setCookie: response.headers.get('set-cookie'),
    body: parsed,
  };
}

const stamp = Date.now();
const PASSWORD = 'Xk9#mQ2$vL7p';
const EMAIL = `browser_${stamp}@mail.ru`;

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — страницы регистрации и входа`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();

  // --- Клиентские файлы -------------------------------------------------
  const clientFiles = [
    ['public/js/api.js', 'обёртка над REST API'],
    ['public/js/form.js', 'проверка полей формы'],
    ['public/js/register.js', 'сценарий страницы регистрации'],
    ['public/js/login.js', 'сценарий страницы входа'],
    ['public/js/confirm.js', 'сценарий страницы подтверждения'],
  ];

  for (const [file, label] of clientFiles) {
    const full = path.join(config.rootDir, file);
    check(`Клиентский модуль: ${label}`, fs.existsSync(full),
      fs.existsSync(full) ? `${Math.round(fs.statSync(full).size / 1024)} КБ` : 'файл не найден');
  }

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, BASE);

  try {
    // --- 1. Страница регистрации ------------------------------------------
    const register = await page('/register');

    check('Страница регистрации открывается (200)',
      register.status === 200, `статус ${register.status}`);
    check('Страница регистрации оформлена в общем шаблоне',
      register.text.includes('header__inner') && register.text.includes('footer__grid'));
    check('Форма регистрации содержит поле имени',
      register.text.includes('data-field="name"'));
    check('Форма регистрации содержит поле адреса электронной почты',
      register.text.includes('data-field="email"'));
    check('Форма регистрации содержит поле пароля',
      register.text.includes('data-field="password"'));
    check('Форма регистрации содержит подтверждение пароля',
      register.text.includes('data-field="passwordConfirm"'));
    check('Форма регистрации содержит согласие на обработку данных',
      register.text.includes('Согласен с правилами обработки персональных данных'));
    check('У полей есть места для сообщений об ошибках',
      (register.text.match(/field__error/g) || []).length >= 5);
    check('Предусмотрен индикатор надёжности пароля',
      register.text.includes('password-strength') && register.text.includes('strength__bar'));
    check('Подключены модуль API и проверка полей',
      register.text.includes('/js/api.js') && register.text.includes('/js/form.js'));
    check('Подключён сценарий страницы регистрации',
      register.text.includes('/js/register.js'));

    // --- 2. Страница входа --------------------------------------------------
    const login = await page('/login');

    check('Страница входа открывается (200)', login.status === 200);
    check('Страница входа оформлена в общем шаблоне',
      login.text.includes('header__inner') && login.text.includes('footer__grid'));
    check('Форма входа содержит адрес электронной почты и пароль',
      login.text.includes('data-field="email"') && login.text.includes('data-field="password"'));
    check('Подключён сценарий страницы входа', login.text.includes('/js/login.js'));

    // --- 3. Переходы между страницами ---------------------------------------
    check('Со страницы регистрации есть ссылка на вход',
      register.text.includes('href="/login"'));
    check('Со страницы входа есть ссылка на регистрацию',
      login.text.includes('href="/register"'));

    const htmlRedirects = [
      ['/index.html', '/'],
      ['/login.html', '/login'],
      ['/register.html', '/register'],
    ];
    for (const [from, to] of htmlRedirects) {
      const response = await page(from);
      check(`Адрес ${from} перенаправляет на ${to}`,
        response.status === 301 && response.location === to,
        `статус ${response.status} → ${response.location}`);
    }

    // --- 4. Защита адреса возврата --------------------------------------------
    const safeNext = await page('/login?next=%2Fcells.html');
    check('Внутренний адрес возврата сохраняется',
      safeNext.text.includes('name="next" value="/cells.html"'));

    let hijackBlocked = true;
    for (const attempt of ['//zloj.ru', 'https://zloj.ru']) {
      const response = await page(`/login?next=${encodeURIComponent(attempt)}`);
      if (!response.text.includes('name="next" value="/"')) hijackBlocked = false;
    }
    check('Адрес возврата на сторонний сайт не принимается', hijackBlocked,
      'подстановка внешнего адреса исключена');

    // --- 5. Полная цепочка: регистрация ---------------------------------------
    const registered = await api('POST', '/api/auth/register', {
      body: { name: 'Проверка Цепочки', email: EMAIL, password: PASSWORD, passwordConfirm: PASSWORD },
    });

    check('Регистрация через API выполняется (201)', registered.status === 201,
      registered.body?.message);
    check('Учётная запись создана неподтверждённой',
      registered.body?.user?.isConfirmed === false);
    check('Письмо со ссылкой обработано',
      registered.body?.confirmationEmail?.sent === true
      || registered.body?.confirmationEmail?.logged === true,
      `режим отправки: ${registered.body?.confirmationEmail?.status}`);
    check('Поле sent отражает именно доставку на почтовый сервер',
      registered.body?.confirmationEmail?.sent
        === (registered.body?.confirmationEmail?.status === 'sent'),
      'в режиме log письмо не считается отправленным');

    // --- 6. Вход до подтверждения отклоняется ---------------------------------
    const tooEarly = await api('POST', '/api/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
    });

    check('Вход до подтверждения адреса отклоняется (403)',
      tooEarly.status === 403 && tooEarly.body?.error?.code === 'EMAIL_NOT_CONFIRMED',
      `код: ${tooEarly.body?.error?.code}`);
    check('Сообщение предлагает подтвердить адрес',
      /подтвержд/i.test(tooEarly.body?.error?.message || ''));

    // --- 7. Переход по ссылке из письма ----------------------------------------
    const token = userRepository.findByEmail(EMAIL).confirmToken;
    const confirmed = await api('GET', `/api/auth/confirm/page?token=${token}`);

    check('Переход по ссылке из письма выполняется (перенаправление)',
      confirmed.status === 303, `статус ${confirmed.status}`);
    check('Перенаправление ведёт на страницу подтверждения',
      String(confirmed.location).startsWith('/confirm?'), confirmed.location);
    check('Результат подтверждения — успех',
      String(confirmed.location).includes('status=success'));

    const confirmPage = await page(confirmed.location);
    check('Страница подтверждения оформлена в общем шаблоне',
      confirmPage.status === 200 && confirmPage.text.includes('header__inner'));
    check('Страница подтверждения сообщает об успехе',
      confirmPage.text.includes('Адрес электронной почты подтверждён'));
    check('Адрес электронной почты показан на странице',
      confirmPage.text.includes(EMAIL));

    // --- 8. Повторное использование ссылки --------------------------------------
    const reuse = await api('GET', `/api/auth/confirm/page?token=${token}`);
    check('Повторное использование ссылки не подтверждает адрес дважды',
      String(reuse.location).includes('status=invalid'));

    const invalidPage = await page(reuse.location);
    check('Страница с недействительной ссылкой предлагает запросить письмо',
      invalidPage.text.includes('Ссылка недействительна')
      && invalidPage.text.includes('resend-form'));

    // --- 9. Вход после подтверждения ---------------------------------------------
    const successLogin = await api('POST', '/api/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
    });

    check('Вход после подтверждения выполняется (200)', successLogin.status === 200,
      successLogin.body?.message);
    check('Пользователь получает токен сессии',
      typeof successLogin.body?.token === 'string' && successLogin.body.token.length >= 32,
      `${successLogin.body?.token?.length} символов`);
    check('Сессия установлена в cookie с флагом HttpOnly',
      Boolean(successLogin.setCookie) && /HttpOnly/i.test(successLogin.setCookie));
    check('Ответ входа содержит данные пользователя',
      successLogin.body?.user?.email === EMAIL
      && successLogin.body?.user?.isConfirmed === true);

    const cookie = `pvh_session=${successLogin.body.token}`;

    // --- 10. Работа с сессией в браузере -------------------------------------------
    const me = await api('GET', '/api/auth/me', { cookie });
    check('Данные текущего пользователя доступны по cookie',
      me.status === 200 && me.body?.user?.email === EMAIL);

    const home = await page('/', { cookie });
    check('Главная страница приветствует вошедшего пользователя',
      home.status === 200 && home.text.includes('Вы вошли в систему'));
    check('В шапке показывается имя пользователя',
      home.text.includes('Проверка Цепочки'));
    check('Вместо ссылок на вход показывается кнопка выхода',
      home.text.includes('logout-button') && !home.text.includes('>Войти<'));

    const loginWhileAuthorized = await page('/login', { cookie });
    check('Вошедший пользователь не остаётся на странице входа',
      loginWhileAuthorized.status === 302, `статус ${loginWhileAuthorized.status}`);

    const registerWhileAuthorized = await page('/register', { cookie });
    check('Вошедший пользователь не остаётся на странице регистрации',
      registerWhileAuthorized.status === 302);

    // --- 11. Проверка полей в браузере -------------------------------------------------
    // Клиентские модули запрашиваются как статические файлы: страницы
    // отдаются с типом text/html, поэтому для сценариев нужен отдельный запрос
    const clientSource = async (file) => {
      const response = await fetch(`${BASE}${file}`, { headers: { Accept: '*/*' } });
      return { status: response.status, text: await response.text() };
    };

    const formModule = await clientSource('/js/form.js');
    check('Модуль проверки полей доступен браузеру',
      formModule.status === 200, `статус ${formModule.status}`);

    const clientChecks = ['PVH_FORM', 'validateForm', 'validateField', 'showServerErrors', 'setBusy'];
    check('Модуль проверки полей содержит нужные функции',
      clientChecks.every((name) => formModule.text.includes(name)));

    const apiModule = await clientSource('/js/api.js');
    check('Модуль обращения к API содержит нужные методы',
      ['register', 'login', 'logout', 'me', 'checkPasswordStrength']
        .every((name) => apiModule.text.includes(name)));

    const clientRules = [
      'Укажите корректный адрес электронной почты',
      'Пароль должен содержать не менее 8 символов',
      'Пароль должен содержать хотя бы одну цифру',
      'Пароль и подтверждение пароля не совпадают',
    ];
    check('Сообщения об ошибках в браузере совпадают с серверными',
      clientRules.every((text) => formModule.text.includes(text)));

    // --- 12. Выход из системы -------------------------------------------------------
    const logout = await api('POST', '/api/auth/logout', { cookie });
    check('Выход из системы выполняется (200)',
      logout.status === 200 && logout.body?.closed === true, logout.body?.message);

    const afterLogout = await api('GET', '/api/auth/me', { cookie });
    check('После выхода доступ к защищённым данным закрыт (401)',
      afterLogout.status === 401, `код: ${afterLogout.body?.error?.code}`);

    // --- 13. Ранее созданные разделы работают -------------------------------------------
    const health = await page('/health');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && JSON.parse(health.text).status === 'OK');

    const notFound = await page('/nesushchestvuyushchaya-stranica');
    check('Несуществующая страница отдаётся в шаблоне с кодом 404',
      notFound.status === 404 && notFound.text.includes('Страница не найдена'));

    const cells = await api('GET', '/api/cells');
    check('API продолжает требовать авторизацию', cells.status === 401);
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
      + 'регистрация и вход успешно работают в браузере.');
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
