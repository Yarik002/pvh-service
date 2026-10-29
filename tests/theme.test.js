'use strict';

/**
 * Тесты темы оформления (11-й день практики).
 *
 * Проверяется:
 *   • модуль public/js/theme.js: три режима (светлая, тёмная, как в системе),
 *     чтение и сохранение выбора в localStorage, поведение при недоступном
 *     хранилище;
 *   • кнопка в шапке (public/js/layout.js): переключение по кругу,
 *     плавная смена цветов, синхронизация между вкладками, следование
 *     настройке системы;
 *   • подключение модуля темы до таблицы стилей (нет мерцания при загрузке);
 *   • читаемость: контраст текста и фона в обеих темах не ниже 4,5:1;
 *   • исправления замечаний к сборке v0.9: индикатор надёжности пароля,
 *     кнопки «Показать пароль», ссылки на разделы с главной страницы.
 *
 * Сценарии браузера выполняются в изолированном контексте node:vm
 * с простой моделью документа — библиотеки для работы с DOM не нужны.
 *
 * Запуск:  node tests/theme.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const { renderPage } = require('../src/views/layout');

const PUBLIC = path.join(__dirname, '..', 'public');
const THEME_JS = fs.readFileSync(path.join(PUBLIC, 'js', 'theme.js'), 'utf8');
const LAYOUT_JS = fs.readFileSync(path.join(PUBLIC, 'js', 'layout.js'), 'utf8');
const REGISTER_JS = fs.readFileSync(path.join(PUBLIC, 'js', 'register.js'), 'utf8');
const MAIN_CSS = fs.readFileSync(path.join(PUBLIC, 'css', 'main.css'), 'utf8');

// ---------------------------------------------------------------------------
//  Простая модель браузера
// ---------------------------------------------------------------------------

/** Элемент страницы: атрибуты, классы, стили и обработчики событий. */
class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.attributes = {};
    this.classes = new Set();
    this.style = {};
    this.listeners = {};
    this.innerHTML = '';
    this.textContent = '';
    this.hidden = false;
    this.type = 'text';
    this.value = '';
    this.disabled = false;
    this.dataset = {};

    const classes = this.classes;
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name) => (classes.has(name) ? (classes.delete(name), false) : (classes.add(name), true)),
    };
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }

  removeAttribute(name) { delete this.attributes[name]; }

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  dispatch(type, event = {}) {
    (this.listeners[type] || []).forEach((handler) => handler({ target: this, ...event }));
  }

  click() { this.dispatch('click'); }
}

/**
 * Создаёт модель окна браузера.
 *
 * @param {{saved?: string, systemDark?: boolean, storageBroken?: boolean,
 *          reduceMotion?: boolean, elements?: FakeElement[]}} [options]
 */
function createBrowser(options = {}) {
  const store = new Map();
  if (options.saved !== undefined) store.set('pvh.theme', options.saved);

  const state = { systemDark: Boolean(options.systemDark) };
  const mediaListeners = [];
  const timers = [];
  const windowListeners = {};
  const documentListeners = {};
  const elements = new Map((options.elements || []).map((element) => [element.id, element]));

  const localStorage = {
    getItem(key) {
      if (options.storageBroken) throw new Error('доступ запрещён');
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      if (options.storageBroken) throw new Error('доступ запрещён');
      store.set(key, String(value));
    },
  };

  const root = new FakeElement('html');

  const document = {
    documentElement: root,
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: (selector) => {
      const match = /^\[([\w-]+)\]$/.exec(selector);
      if (!match) return [];
      return [...elements.values()].filter((element) => element.getAttribute(match[1]) !== null);
    },
    addEventListener: (type, handler) => {
      (documentListeners[type] = documentListeners[type] || []).push(handler);
    },
    createElement: () => new FakeElement(),
    createTextNode: (text) => ({ text }),
  };

  const window = {
    localStorage,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia(query) {
      return {
        get matches() {
          if (query.includes('prefers-color-scheme: dark')) return state.systemDark;
          if (query.includes('prefers-reduced-motion')) return Boolean(options.reduceMotion);
          return false;
        },
        addEventListener: (type, handler) => mediaListeners.push(handler),
      };
    },
    addEventListener: (type, handler) => {
      (windowListeners[type] = windowListeners[type] || []).push(handler);
    },
    setTimeout: (handler) => { timers.push(handler); return timers.length; },
    clearTimeout: () => {},
    innerWidth: 1280,
    location: { href: '/' },
  };
  window.window = window;

  const context = vm.createContext({ window, document, console });

  return {
    window,
    document,
    root,
    store,
    context,
    run(source) { vm.runInContext(source, context); },
    ready() { (documentListeners.DOMContentLoaded || []).forEach((handler) => handler()); },
    runTimers() { timers.splice(0).forEach((handler) => handler()); },
    setSystemDark(value) {
      state.systemDark = value;
      mediaListeners.forEach((handler) => handler());
    },
    fireStorage(key) {
      (windowListeners.storage || []).forEach((handler) => handler({ key }));
    },
  };
}

/** Открывает страницу со скриптами темы и шапки и возвращает кнопку. */
function openPage(options = {}) {
  const button = new FakeElement('theme-toggle');
  const status = new FakeElement('theme-status');
  const browser = createBrowser({ ...options, elements: [button, status, ...(options.elements || [])] });

  browser.run(THEME_JS);
  browser.run(LAYOUT_JS);
  browser.ready();

  return { ...browser, button, status };
}

// ---------------------------------------------------------------------------
//  Модуль темы (theme.js)
// ---------------------------------------------------------------------------

test('без сохранённого выбора тема следует настройке системы', () => {
  const dark = createBrowser({ systemDark: true });
  dark.run(THEME_JS);
  assert.equal(dark.root.getAttribute('data-theme'), 'dark');
  assert.equal(dark.root.getAttribute('data-theme-mode'), 'system');

  const light = createBrowser({ systemDark: false });
  light.run(THEME_JS);
  assert.equal(light.root.getAttribute('data-theme'), 'light');
});

test('сохранённый выбор важнее настройки системы', () => {
  const browser = createBrowser({ saved: 'light', systemDark: true });
  browser.run(THEME_JS);

  assert.equal(browser.root.getAttribute('data-theme'), 'light');
  assert.equal(browser.root.getAttribute('data-theme-mode'), 'light');
  assert.equal(browser.root.style.colorScheme, 'light', 'системные элементы окрашены по теме');
});

test('неизвестное значение в хранилище считается режимом «как в системе»', () => {
  const browser = createBrowser({ saved: 'purple', systemDark: true });
  browser.run(THEME_JS);

  assert.equal(browser.window.PVH_THEME.readMode(), 'system');
  assert.equal(browser.root.getAttribute('data-theme'), 'dark');
});

test('недоступное хранилище не ломает страницу', () => {
  const browser = createBrowser({ storageBroken: true });

  assert.doesNotThrow(() => browser.run(THEME_JS));
  assert.equal(browser.window.PVH_THEME.readMode(), 'system');
  assert.equal(browser.window.PVH_THEME.saveMode('dark'), false, 'сохранение сообщает о неудаче');
});

test('режимы переключаются по кругу: светлая → тёмная → как в системе', () => {
  const browser = createBrowser();
  browser.run(THEME_JS);
  const { nextMode } = browser.window.PVH_THEME;

  assert.equal(nextMode('light'), 'dark');
  assert.equal(nextMode('dark'), 'system');
  assert.equal(nextMode('system'), 'light');
});

// ---------------------------------------------------------------------------
//  Кнопка в шапке (layout.js)
// ---------------------------------------------------------------------------

test('нажатие кнопки переключает тему и сохраняет выбор в localStorage', () => {
  const page = openPage({ saved: 'light' });

  page.button.click();
  assert.equal(page.root.getAttribute('data-theme'), 'dark');
  assert.equal(page.store.get('pvh.theme'), 'dark');

  page.button.click();
  assert.equal(page.store.get('pvh.theme'), 'system');

  page.button.click();
  assert.equal(page.store.get('pvh.theme'), 'light');
  assert.equal(page.root.getAttribute('data-theme'), 'light');
});

test('выбор сохраняется после перезагрузки страницы', () => {
  const first = openPage({ saved: 'light' });
  first.button.click();

  // «Перезагрузка»: новая страница с тем же хранилищем
  const second = createBrowser({ saved: first.store.get('pvh.theme') });
  second.run(THEME_JS);

  assert.equal(second.root.getAttribute('data-theme'), 'dark');
});

test('кнопка показывает текущий режим и подсказывает следующий', () => {
  const page = openPage({ saved: 'dark' });

  assert.equal(page.button.getAttribute('data-mode'), 'dark');
  assert.equal(page.button.getAttribute('aria-pressed'), 'true');
  assert.match(page.button.getAttribute('title'), /Тема: тёмная.*как в системе/);
  assert.ok(page.button.innerHTML.includes('☾'));

  page.button.click();
  assert.match(page.button.getAttribute('title'), /Тема: как в системе.*светлая/);
  assert.equal(page.status.textContent, 'Тема оформления: как в системе',
    'смена темы объявляется программам чтения с экрана');
});

test('цвета меняются плавно только на время переключения', () => {
  const page = openPage({ saved: 'light' });

  page.button.click();
  assert.ok(page.root.classList.contains('theme-transition'), 'плавная смена включена');

  page.runTimers();
  assert.ok(!page.root.classList.contains('theme-transition'), 'после смены класс снят');
});

test('при отключённой анимации тема меняется мгновенно', () => {
  const page = openPage({ saved: 'light', reduceMotion: true });

  page.button.click();
  assert.ok(!page.root.classList.contains('theme-transition'));
  assert.equal(page.root.getAttribute('data-theme'), 'dark');
});

test('выбор в другой вкладке применяется без перезагрузки', () => {
  const page = openPage({ saved: 'light' });

  page.store.set('pvh.theme', 'dark');
  page.fireStorage('pvh.theme');

  assert.equal(page.root.getAttribute('data-theme'), 'dark');
  assert.equal(page.button.getAttribute('data-mode'), 'dark');
});

test('в режиме «как в системе» тема следует за настройкой системы', () => {
  const page = openPage({ saved: 'system', systemDark: false });
  assert.equal(page.root.getAttribute('data-theme'), 'light');

  page.setSystemDark(true);
  assert.equal(page.root.getAttribute('data-theme'), 'dark');
});

test('явно выбранная тема не меняется вслед за системой', () => {
  const page = openPage({ saved: 'light', systemDark: false });

  page.setSystemDark(true);
  assert.equal(page.root.getAttribute('data-theme'), 'light');
});

// ---------------------------------------------------------------------------
//  Подключение темы на страницах
// ---------------------------------------------------------------------------

test('модуль темы подключается до таблицы стилей и без defer', () => {
  const html = renderPage({ title: 'Проверка', content: '<p>текст</p>' });

  const themeTag = '<script src="/js/theme.js"></script>';
  assert.ok(html.includes(themeTag), 'сценарий выполняется сразу, без defer');
  assert.ok(html.indexOf(themeTag) < html.indexOf('/css/main.css'),
    'тема выставляется раньше, чем загружаются стили — без мерцания');
  assert.ok(html.includes('<meta name="color-scheme" content="light dark">'));
  assert.ok(html.includes('id="theme-status"'), 'область для объявления смены темы');
});

test('модуль темы отдаётся сервером', async () => {
  runMigrations();
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/js/theme.js`);
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.ok(text.includes('PVH_THEME'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
//  Читаемость: контраст цветов в обеих темах
// ---------------------------------------------------------------------------

/** Извлекает значения переменных цвета из блока таблицы стилей. */
function readColors(selector) {
  const start = MAIN_CSS.indexOf(`${selector} {`);
  const block = MAIN_CSS.slice(start, MAIN_CSS.indexOf('}', start));
  const colors = {};
  for (const [, name, value] of block.matchAll(/--(color-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    colors[name] = value;
  }
  return colors;
}

/** Контраст двух цветов по методике WCAG 2.1. */
function contrast(first, second) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Пары «текст — фон», которые встречаются в интерфейсе. */
const READABLE_PAIRS = [
  ['color-text', 'color-surface', 'основной текст'],
  ['color-text-muted', 'color-surface', 'второстепенный текст'],
  ['color-primary', 'color-surface', 'ссылки'],
  ['color-primary-contrast', 'color-primary', 'текст основной кнопки'],
  ['color-danger-contrast', 'color-danger', 'текст кнопки удаления'],
  ['color-success', 'color-success-bg', 'сообщение об успехе'],
  ['color-warning', 'color-warning-bg', 'предупреждение'],
  ['color-danger', 'color-danger-bg', 'сообщение об ошибке'],
  ['color-primary', 'color-info-bg', 'информационное сообщение'],
];

for (const [themeName, selector] of [['светлой', ':root'], ['тёмной', '[data-theme="dark"]']]) {
  test(`в ${themeName} теме контраст текста не ниже 4,5:1`, () => {
    const colors = { ...readColors(':root'), ...readColors(selector) };

    for (const [text, background, label] of READABLE_PAIRS) {
      assert.ok(colors[text] && colors[background], `цвета для «${label}» определены`);
      const ratio = contrast(colors[text], colors[background]);
      assert.ok(ratio >= 4.5, `${label}: контраст ${ratio.toFixed(2)} (нужно не ниже 4,5)`);
    }
  });
}

test('кнопка удаления берёт цвет текста из темы', () => {
  assert.ok(MAIN_CSS.includes('.btn--danger { background: var(--color-danger); color: var(--color-danger-contrast); }'));
  assert.ok(MAIN_CSS.includes('.theme-transition'), 'описана плавная смена цветов');
});

// ---------------------------------------------------------------------------
//  Исправления замечаний к сборке v0.9
// ---------------------------------------------------------------------------

test('кнопки «Показать пароль» работают на всех страницах', () => {
  const input = new FakeElement('field-password');
  input.type = 'password';
  const toggle = new FakeElement('toggle');
  toggle.setAttribute('data-password-toggle', 'field-password');

  const page = openPage({ elements: [input, toggle] });

  toggle.click();
  assert.equal(input.type, 'text', 'пароль показан');
  assert.equal(toggle.textContent, 'Скрыть');

  // Повторный вызов не подключает кнопку второй раз
  page.window.PVH.setupPasswordToggles();
  toggle.click();
  assert.equal(input.type, 'password', 'пароль снова скрыт одним нажатием');
});

test('индикатор надёжности пароля показывает оценку сервера', async () => {
  const form = new FakeElement('register-form');
  const passwordInput = new FakeElement('password-input');
  const block = new FakeElement('password-strength');
  const bar = new FakeElement('strength-bar');
  const label = new FakeElement('strength-label');
  block.hidden = true;
  form.querySelector = (selector) => (selector === '[name="password"]' ? passwordInput : null);

  const browser = createBrowser({ elements: [form, block, bar, label] });
  let password = 'Xk9#mQ2$vL7p';

  browser.window.PVH_FORM = {
    watchFields() {},
    collectValues: () => ({ password, name: 'Иванов Иван', email: 'ivanov@mail.ru' }),
  };
  browser.window.PVH_API = {
    // Ответ имеет тот же вид, что и у POST /api/password/strength
    checkPasswordStrength: async () => ({
      success: true,
      strength: { score: 82, level: 'strong', label: 'Высокая' },
    }),
  };

  browser.run(REGISTER_JS);
  browser.ready();

  passwordInput.dispatch('input');
  browser.runTimers();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(block.hidden, false, 'индикатор показан');
  assert.equal(bar.style.width, '82%');
  assert.match(label.textContent, /высокая \(82 из 100\)/);

  // Пустой пароль — индикатор скрывается
  password = '';
  passwordInput.dispatch('input');
  browser.runTimers();
  assert.equal(block.hidden, true);
});

test('ссылки на разделы с главной страницы ведут на существующие адреса', async () => {
  runMigrations();
  getDb();
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const home = await (await fetch(`${base}/`, { headers: { Accept: 'text/html' } })).text();

    assert.ok(home.includes('href="/orders"') && home.includes('href="/cells"'));
    assert.ok(!home.includes('/orders.html') && !home.includes('/cells.html'));

    for (const [from, to] of [['/orders.html', '/orders'], ['/cells.html', '/cells']]) {
      const response = await fetch(`${base}${from}`, { redirect: 'manual' });
      assert.equal(response.status, 301, `${from} перенаправляется`);
      assert.equal(response.headers.get('location'), to);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => closeDb());
