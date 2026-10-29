'use strict';

/**
 * Проверка сборки v0.10 (11-й день практики).
 *
 * Тема дня: переключатель светлой и тёмной темы с сохранением настроек.
 * Критерий приёмки: тема переключается и сохраняется в localStorage
 * после перезагрузки страницы.
 *
 * Проверяется:
 *   • модуль темы подключается до таблицы стилей (нет мерцания при загрузке);
 *   • три режима: светлая, тёмная, как в системе;
 *   • выбор сохраняется в localStorage и восстанавливается после перезагрузки
 *     (сценарий темы выполняется в модели браузера);
 *   • контраст текста в обеих темах не ниже 4,5:1;
 *   • исправлены замечания к сборке v0.9.
 *
 * Запуск:  node scripts/check-v0.10.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v010-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.MAIL_TRANSPORT = 'log';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3119', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Загружает адрес и возвращает статус и текст ответа. */
async function load(address, accept = 'text/html') {
  const response = await fetch(`${BASE}${address}`, { headers: { Accept: accept }, redirect: 'manual' });
  return {
    status: response.status,
    location: response.headers.get('location'),
    text: await response.text(),
  };
}

/**
 * Выполняет модуль темы в модели браузера с заданным содержимым
 * localStorage и возвращает выставленную тему.
 */
function runThemeModule(source, storage, systemDark = false) {
  const attributes = {};
  const window = {
    localStorage: {
      getItem: (key) => (key in storage ? storage[key] : null),
      setItem: (key, value) => { storage[key] = String(value); },
    },
    matchMedia: () => ({ matches: systemDark }),
  };
  const document = {
    documentElement: {
      style: {},
      setAttribute: (name, value) => { attributes[name] = value; },
    },
  };

  vm.runInNewContext(source, { window, document });
  return { theme: attributes['data-theme'], mode: attributes['data-theme-mode'], api: window.PVH_THEME };
}

/** Контраст двух цветов по методике WCAG 2.1. */
function contrast(first, second) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Значения переменных цвета из блока таблицы стилей. */
function readColors(css, selector) {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf('}', start));
  const colors = {};
  for (const [, name, value] of block.matchAll(/--(color-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    colors[name] = value;
  }
  return colors;
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — переключатель темы оформления`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();

  const themeFile = path.join(config.rootDir, 'public', 'js', 'theme.js');
  check('Модуль темы оформления (public/js/theme.js)', fs.existsSync(themeFile),
    fs.existsSync(themeFile) ? `${Math.round(fs.statSync(themeFile).size / 1024)} КБ` : 'файл не найден');

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, BASE);

  try {
    // --- 1. Подключение темы на страницах --------------------------------------
    for (const address of ['/', '/login', '/register', '/template-demo']) {
      const page = await load(address);
      const themeTag = '<script src="/js/theme.js"></script>';
      check(`Страница ${address}: тема применяется до загрузки стилей`,
        page.status === 200 && page.text.includes(themeTag)
        && page.text.indexOf(themeTag) < page.text.indexOf('/css/main.css'),
        'сценарий без defer стоит перед таблицей стилей');
    }

    const home = await load('/');
    check('Страница сообщает браузеру о поддержке двух тем',
      home.text.includes('<meta name="color-scheme" content="light dark">'));
    check('В шапке есть кнопка переключения темы', home.text.includes('id="theme-toggle"'));
    check('Есть область для объявления смены темы программам чтения с экрана',
      home.text.includes('id="theme-status"') && home.text.includes('aria-live="polite"'));

    // --- 2. Модуль темы -------------------------------------------------------------
    const themeJs = await load('/js/theme.js', '*/*');
    check('Модуль темы отдаётся сервером (200)', themeJs.status === 200);
    check('Выбор хранится в localStorage под ключом pvh.theme',
      themeJs.text.includes('localStorage') && themeJs.text.includes("'pvh.theme'"));
    check('Поддерживаются три режима: светлая, тёмная, как в системе',
      ["'light'", "'dark'", "'system'"].every((mode) => themeJs.text.includes(mode)));
    check('Режим «как в системе» учитывает настройку операционной системы',
      themeJs.text.includes('prefers-color-scheme: dark'));

    // --- 3. Сохранение выбора и перезагрузка страницы -----------------------------------
    const storage = {};
    const firstVisit = runThemeModule(themeJs.text, storage, false);
    check('При первом посещении действует режим «как в системе»',
      firstVisit.mode === 'system' && firstVisit.theme === 'light');

    firstVisit.api.saveMode('dark');
    check('Выбор тёмной темы записывается в localStorage', storage['pvh.theme'] === 'dark');

    const afterReload = runThemeModule(themeJs.text, storage, false);
    check('После перезагрузки страницы тёмная тема сохраняется',
      afterReload.theme === 'dark' && afterReload.mode === 'dark',
      `тема: ${afterReload.theme}`);

    storage['pvh.theme'] = 'system';
    const systemDark = runThemeModule(themeJs.text, storage, true);
    check('Режим «как в системе» включает тёмную тему при тёмной системе',
      systemDark.theme === 'dark' && systemDark.mode === 'system');

    storage['pvh.theme'] = 'light';
    const lightOverSystem = runThemeModule(themeJs.text, storage, true);
    check('Явно выбранная светлая тема важнее настройки системы', lightOverSystem.theme === 'light');

    const broken = runThemeModule(themeJs.text, { 'pvh.theme': 'neizvestno' }, false);
    check('Неизвестное значение в хранилище не ломает страницу', broken.mode === 'system');

    // --- 4. Кнопка в шапке ---------------------------------------------------------------
    const layoutJs = await load('/js/layout.js', '*/*');
    check('Кнопка переключает режимы по кругу', layoutJs.text.includes('nextMode'));
    check('Выбор из другой вкладки применяется сразу (событие storage)',
      layoutJs.text.includes("addEventListener('storage'"));
    check('Цвета меняются плавно при переключении', layoutJs.text.includes('theme-transition'));
    check('Учитывается системная настройка «уменьшить движение»',
      layoutJs.text.includes('prefers-reduced-motion'));

    // --- 5. Таблица стилей и читаемость ----------------------------------------------------
    const css = (await load('/css/main.css', 'text/css')).text;
    check('Описаны светлая и тёмная темы',
      css.includes('[data-theme="dark"]') && css.includes('prefers-color-scheme: dark'));
    check('Плавная смена цветов отключается при уменьшенном движении',
      /prefers-reduced-motion[\s\S]*\.theme-transition[\s\S]*transition: none/.test(css));

    const pairs = [
      ['color-text', 'color-surface'], ['color-text-muted', 'color-surface'],
      ['color-primary', 'color-surface'], ['color-primary-contrast', 'color-primary'],
      ['color-danger-contrast', 'color-danger'], ['color-success', 'color-success-bg'],
      ['color-warning', 'color-warning-bg'], ['color-danger', 'color-danger-bg'],
    ];
    for (const [label, selector] of [['светлой', ':root'], ['тёмной', '[data-theme="dark"]']]) {
      const colors = { ...readColors(css, ':root'), ...readColors(css, selector) };
      const ratios = pairs.map(([text, bg]) => contrast(colors[text], colors[bg]));
      const minimum = Math.min(...ratios);
      check(`Контраст текста в ${label} теме не ниже 4,5:1`, minimum >= 4.5,
        `наименьший контраст ${minimum.toFixed(2)}`);
    }

    // --- 6. Исправление замечаний к сборке v0.9 ------------------------------------------------
    check('Ссылки на разделы с главной страницы ведут на существующие адреса',
      home.text.includes('href="/orders"') && !home.text.includes('href="/orders.html"'));

    const ordersRedirect = await load('/orders.html');
    check('Адрес /orders.html перенаправляет на /orders',
      ordersRedirect.status === 301 && ordersRedirect.location === '/orders');

    const registerJs = await load('/js/register.js', '*/*');
    check('Индикатор надёжности пароля читает оценку из ответа сервера',
      registerJs.text.includes('data && data.strength'));
    check('Кнопки «Показать пароль» подключаются на всех страницах',
      layoutJs.text.includes('setupPasswordToggles'));

    const confirmPage = await load('/api/auth/confirm?token=nesushchestvuyushchij');
    check('Страница недействительной ссылки ведёт на форму повторной отправки',
      confirmPage.text.includes('/confirm?status=invalid')
      && !confirmPage.text.includes('resend-confirmation.html'));

    // --- 7. Ранее созданные разделы работают -------------------------------------------------
    const health = await load('/health', 'application/json');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && JSON.parse(health.text).status === 'OK');

    const cells = await load('/api/cells', 'application/json');
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
      + 'тема переключается и сохраняется после перезагрузки страницы.');
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
