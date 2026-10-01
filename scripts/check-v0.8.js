'use strict';

/**
 * Проверка сборки v0.8 (9-й день практики).
 *
 * Тема дня: базовый адаптивный шаблон приложения (шапка, меню, подвал).
 * Критерий приёмки: готовый HTML/CSS макет, корректно работающий
 * на персональных компьютерах и мобильных устройствах.
 *
 * Проверяются:
 *   • состав HTML-документа (кодировка, viewport, заголовок, язык);
 *   • наличие шапки с наименованием, меню и элементами управления;
 *   • наличие подвала со сведениями о проекте;
 *   • зависимость состава меню от роли пользователя;
 *   • отдача статических файлов (таблица стилей, сценарии);
 *   • поддержка адаптивности и тёмной темы в таблице стилей;
 *   • доступность: ссылка перехода к содержимому, подписи элементов,
 *     контур фокуса для навигации с клавиатуры.
 *
 * Запуск:  node scripts/check-v0.8.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v08-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '500';
process.env.LOGIN_LIMIT_MAX = process.env.LOGIN_LIMIT_MAX || '500';
process.env.MAIL_TRANSPORT = 'log';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const userRepository = require('../src/repositories/userRepository');
const confirmationService = require('../src/services/confirmationService');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3116', 10);
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Загружает страницу и возвращает ответ. */
async function getPage(path, token, accept = 'text/html') {
  const headers = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers });
  const text = await response.text();

  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    text,
  };
}

/** Выполняет запрос к API. */
async function api(method, endpoint, { body, token } = {}) {
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

/** Создаёт подтверждённого пользователя и возвращает токен сессии. */
async function createUser(prefix, role, name) {
  const email = `${prefix}_${stamp}@mail.ru`;

  const registered = await api('POST', '/api/auth/register', {
    body: { name, email, password: PASSWORD, passwordConfirm: PASSWORD },
  });

  if (registered.status !== 201) {
    throw new Error(`Не удалось зарегистрировать пользователя ${email}: `
      + `статус ${registered.status}, ответ ${JSON.stringify(registered.body?.error || registered.body)}`);
  }

  const user = userRepository.findByEmail(email);
  if (!user) throw new Error(`Пользователь ${email} не найден в базе данных после регистрации`);

  confirmationService.confirmEmail(user.confirmToken);

  if (role !== 'client') {
    getDb().prepare('UPDATE Users SET role = ? WHERE id = ?').run(role, user.id);
  }

  const login = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  if (!login.body?.token) {
    throw new Error(`Не удалось выполнить вход ${email}: ${JSON.stringify(login.body?.error || login.body)}`);
  }

  return { email, token: login.body.token };
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — базовый шаблон приложения`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();

  // --- Статические файлы шаблона --------------------------------
  const cssPath = path.join(config.publicDir, 'css', 'main.css');
  const jsPath = path.join(config.publicDir, 'js', 'layout.js');

  check('Таблица стилей шаблона существует', fs.existsSync(cssPath),
    fs.existsSync(cssPath) ? `${Math.round(fs.statSync(cssPath).size / 1024)} КБ` : 'файл не найден');
  check('Сценарий шаблона существует', fs.existsSync(jsPath),
    fs.existsSync(jsPath) ? `${Math.round(fs.statSync(jsPath).size / 1024)} КБ` : 'файл не найден');

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, `http://127.0.0.1:${PORT}`);

  try {
    // --- 1. Документ главной страницы ------------------------------------
    const home = await getPage('/');

    check('Главная страница отдаётся как HTML (200)',
      home.status === 200 && home.contentType.includes('text/html'),
      `Content-Type: ${home.contentType}`);

    check('Документ начинается с объявления типа HTML',
      home.text.startsWith('<!DOCTYPE html>'));
    check('Указана кодировка UTF-8', home.text.includes('<meta charset="UTF-8">'));
    check('Указан язык документа — русский', home.text.includes('<html lang="ru">'));
    check('Указан viewport для адаптивности',
      home.text.includes('name="viewport"') && home.text.includes('width=device-width'),
      'страница корректно отображается на мобильных устройствах');
    check('Заголовок страницы содержит название приложения',
      /<title>[^<]*Сервис трекинга заказов/.test(home.text));
    check('Указано описание страницы для поисковых систем',
      home.text.includes('name="description"'));

    // --- 2. Шапка сайта ---------------------------------------------------
    check('Шапка содержит наименование приложения',
      home.text.includes('header__brand') && home.text.includes('Сервис ПВЗ'));
    check('В шапке есть меню приложения',
      home.text.includes('id="main-nav"') && home.text.includes('nav__list'));
    check('В шапке есть кнопка меню для мобильных устройств',
      home.text.includes('id="menu-toggle"')
      && home.text.includes('aria-controls="main-nav"')
      && home.text.includes('aria-expanded="false"'),
      'состояние кнопки описано для программ чтения с экрана');
    check('В шапке есть переключатель темы оформления',
      home.text.includes('id="theme-toggle"'));

    // --- 3. Подвал --------------------------------------------------------
    check('Подвал содержит сведения об учебном проекте',
      home.text.includes('footer') && home.text.includes('Минский колледж предпринимательства'));
    check('Подвал содержит сведения об исполнителе',
      home.text.includes('Кирдун Я.С.') && home.text.includes('ПО-2409'));
    check('В подвале указана версия сборки', /Сборка v\d/.test(home.text));

    // --- 4. Подключение ресурсов ------------------------------------------
    check('Подключена таблица стилей', home.text.includes('/css/main.css'));
    check('Подключён общий сценарий шаблона', home.text.includes('/js/layout.js'));

    // --- 5. Доступность ---------------------------------------------------
    check('Есть ссылка перехода к основному содержимому',
      home.text.includes('skip-link') && home.text.includes('#main-content'),
      'нужна для навигации с клавиатуры');
    check('Основное содержимое размечено тегом main',
      home.text.includes('<main') && home.text.includes('id="main-content"'));

    // --- 6. Меню для гостя -------------------------------------------------
    check('Гостю показываются общие разделы меню',
      home.text.includes('Главная') && !home.text.includes('Приёмка товара'),
      'разделы администратора скрыты');
    check('Гостю предлагаются вход и регистрация',
      home.text.includes('/login.html') && home.text.includes('/register.html'));

    // --- 7. Меню для клиента ------------------------------------------------
    const client = await createUser('client', 'client', 'Иванов Иван');
    const clientPage = await getPage('/', client.token);

    check('Авторизованному пользователю подставляется имя',
      clientPage.text.includes('Иванов Иван'));
    check('Роль пользователя указана в атрибуте разметки',
      clientPage.text.includes('data-role="client"'));
    check('Клиенту показываются разделы клиента',
      clientPage.text.includes('Мои заказы') && clientPage.text.includes('Ячейки'));
    check('Клиенту не показываются разделы администратора',
      !clientPage.text.includes('Приёмка товара')
      && !clientPage.text.includes('Администрирование'));
    check('Авторизованному пользователю доступна кнопка выхода',
      clientPage.text.includes('logout-button') && !clientPage.text.includes('>Войти<'),
      'вместо ссылок на вход показывается кнопка завершения сессии');
    check('Главная страница приветствует авторизованного пользователя',
      clientPage.text.includes('Вы вошли в систему'));

    // --- 8. Меню для администратора -----------------------------------------
    const admin = await createUser('admin', 'admin', 'Администратор ПВЗ');
    const adminPage = await getPage('/', admin.token);

    check('Администратору показываются разделы администратора',
      adminPage.text.includes('Приёмка товара') && adminPage.text.includes('Администрирование'));
    check('Роль администратора указана в разметке',
      adminPage.text.includes('data-role="admin"'));

    // --- 9. Страница проверки шаблона ----------------------------------------
    const demo = await getPage('/template-demo');
    check('Страница проверки шаблона доступна (200)', demo.status === 200);

    const demoElements = [
      ['уведомления', 'alert--success'],
      ['кнопки', 'btn--danger'],
      ['таблица', 'table-wrap'],
      ['значки состояния', 'badge--success'],
      ['поля формы', 'field__input'],
      ['сообщение об ошибке поля', 'field__error'],
      ['индикатор надёжности пароля', 'strength__bar'],
      ['показатели', 'stat__value'],
    ];
    for (const [label, marker] of demoElements) {
      check(`Страница проверки содержит элемент оформления: ${label}`,
        demo.text.includes(marker));
    }

    // --- 10. Статические файлы через HTTP ------------------------------------
    const cssResponse = await fetch(`http://127.0.0.1:${PORT}/css/main.css`);
    const css = await cssResponse.text();

    check('Таблица стилей отдаётся сервером', cssResponse.status === 200,
      `${Math.round(css.length / 1024)} КБ`);
    check('В таблице стилей определены переменные оформления',
      css.includes('--color-primary') && css.includes('--font-body'));
    check('Описана тёмная тема оформления',
      css.includes('[data-theme="dark"]') && css.includes('prefers-color-scheme: dark'));
    check('Описана адаптивность для планшетов',
      css.includes('@media (max-width: 1024px)'));
    check('Описана адаптивность для мобильных устройств',
      css.includes('@media (max-width: 768px)'));
    check('Описана адаптивность для узких экранов',
      css.includes('@media (max-width: 480px)'));
    check('Меню скрывается и раскрывается на мобильных устройствах',
      css.includes('.nav--open') && css.includes('.header__toggle'));
    check('Размеры элементов управления удобны для касания',
      css.includes('min-height: 44px'),
      'рекомендация по доступности для мобильных устройств');
    check('Предусмотрены стили для печати', css.includes('@media print'));

    const jsResponse = await fetch(`http://127.0.0.1:${PORT}/js/layout.js`);
    const js = await jsResponse.text();

    check('Сценарий шаблона отдаётся сервером', jsResponse.status === 200,
      `${Math.round(js.length / 1024)} КБ`);
    check('Сценарий переключает тему оформления',
      js.includes('THEME_KEY') && js.includes('pvh.theme'));
    check('Выбранная тема сохраняется между страницами',
      js.includes('localStorage'), 'настройка сохраняется после перезагрузки');
    check('Сценарий управляет меню на мобильных устройствах',
      js.includes('nav--open') && js.includes('Escape'));
    check('Сценарий поддерживает вывод уведомлений',
      js.includes('showAlert') && js.includes('alert--'));

    // --- 11. Ранее созданные разделы работают ---------------------------------
    const health = await getPage('/health', null, 'application/json');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && JSON.parse(health.text).status === 'OK');

    const apiHelp = await getPage('/api', null, 'application/json');
    check('Справка API доступна по адресу /api',
      apiHelp.status === 200 && Boolean(JSON.parse(apiHelp.text).pages?.home));

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
      + 'базовый адаптивный шаблон готов, корректно работает на ПК и мобильных устройствах.');
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
