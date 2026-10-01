'use strict';

/**
 * Базовый шаблон страниц приложения.
 *
 * Модуль формирует HTML-документ с общей для всех страниц частью:
 *   • шапка сайта с наименованием, меню и элементами управления;
 *   • подвал с контактными сведениями и ссылками;
 *   • подключение таблицы стилей и общих сценариев.
 *
 * Каждая страница описывает только своё содержимое, поэтому разметка шапки
 * и подвала не дублируется. Состав меню зависит от роли пользователя:
 * разделы администратора показываются только при наличии соответствующей роли.
 */

const config = require('../config');

/** Экранирует специальные символы HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Разделы меню приложения.
 *
 * roles — роли, которым доступен раздел:
 *   'public'   — доступен всем;
 *   'user'     — авторизованным пользователям;
 *   'admin'    — только администратору.
 */
const NAVIGATION = [
  { path: '/', title: 'Главная', roles: 'public' },
  { path: '/orders.html', title: 'Мои заказы', roles: 'user' },
  { path: '/cells.html', title: 'Ячейки', roles: 'user' },
  { path: '/receive.html', title: 'Приёмка товара', roles: 'admin' },
  { path: '/admin.html', title: 'Администрирование', roles: 'admin' },
];

/**
 * Определяет активный раздел меню по адресу страницы.
 *
 * @param {string} currentPath путь запрошенной страницы
 * @param {string} itemPath    путь раздела меню
 * @returns {boolean}
 */
function isActive(currentPath, itemPath) {
  if (itemPath === '/') return currentPath === '/' || currentPath === '/index.html';
  return currentPath === itemPath || currentPath.startsWith(itemPath.replace(/\.html$/, ''));
}

/**
 * Формирует разметку меню.
 *
 * @param {{path: string, role?: string, isAuthenticated?: boolean}} context
 * @returns {string}
 */
function renderNavigation({ path = '/', role = 'guest', isAuthenticated = false } = {}) {
  const items = NAVIGATION.filter((item) => {
    if (item.roles === 'public') return true;
    if (item.roles === 'user') return isAuthenticated;
    if (item.roles === 'admin') return role === 'admin';
    return false;
  });

  const links = items.map((item) => {
    const active = isActive(path, item.path);
    const adminClass = item.roles === 'admin' ? ' nav__item--admin' : '';

    return `        <li class="nav__item${adminClass}">
          <a class="nav__link" href="${escapeHtml(item.path)}"${
  active ? ' aria-current="page"' : ''
}>${escapeHtml(item.title)}</a>
        </li>`;
  }).join('\n');

  return `      <ul class="nav__list">
${links}
      </ul>`;
}

/**
 * Формирует блок пользователя в шапке: имя, роль и кнопку выхода —
 * либо ссылки на вход и регистрацию для неавторизованного посетителя.
 *
 * @param {{isAuthenticated?: boolean, user?: object|null}} context
 * @returns {string}
 */
function renderUserArea({ isAuthenticated = false, user = null } = {}) {
  // Роль записывается в атрибут body: по ней показываются разделы меню
  // администратора, даже если сценарий не успел выполниться
  if (isAuthenticated && user) {
    const roleLabel = user.role === 'admin' ? 'администратор' : 'клиент';
    const initial = String(user.name || user.email || '?').trim().charAt(0).toUpperCase();

    return `        <div class="header__user">
          <span class="badge badge--muted" title="Роль: ${escapeHtml(roleLabel)}">${escapeHtml(initial)}</span>
          <span class="header__user-name" title="${escapeHtml(user.email)}">${escapeHtml(user.name)}</span>
        </div>
        <button class="btn btn--secondary btn--sm btn--inline" type="button" id="logout-button">Выйти</button>`;
  }

  return `        <a class="btn btn--secondary btn--sm btn--inline" href="/login.html">Войти</a>
        <a class="btn btn--sm btn--inline" href="/register.html">Регистрация</a>`;
}

/**
 * Формирует HTML-документ страницы.
 *
 * @param {{
 *   title: string,
 *   path?: string,
 *   description?: string,
 *   content: string,
 *   isAuthenticated?: boolean,
 *   user?: object|null,
 *   scripts?: string[],
 *   bodyAttributes?: string
 * }} options
 * @returns {string} HTML-документ
 */
function renderPage(options) {
  const {
    title,
    path = '/',
    description = 'Сервис трекинга заказов и инвентаря для пункта выдачи заказов.',
    content,
    isAuthenticated = false,
    user = null,
    scripts = [],
    bodyAttributes = '',
  } = options;

  const role = user?.role || 'guest';
  const fullTitle = `${title} — ${config.appName}`;

  // Подключаемые сценарии страницы
  const scriptTags = scripts
    .map((src) => `  <script src="${escapeHtml(src)}" defer></script>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#1a56db">
  <title>${escapeHtml(fullTitle)}</title>
  <link rel="stylesheet" href="/css/main.css">
  <script src="/js/layout.js" defer></script>
${scriptTags}
</head>
<body data-role="${escapeHtml(role)}"${bodyAttributes ? ` ${bodyAttributes}` : ''}>
  <a class="skip-link" href="#main-content">Перейти к содержимому</a>

  <header class="header">
    <div class="container header__inner">
      <a class="header__brand" href="/">
        <span class="header__brand-mark" aria-hidden="true">ПВЗ</span>
        <span class="header__brand-text">Сервис ПВЗ</span>
      </a>

      <button class="header__toggle" type="button" id="menu-toggle"
              aria-controls="main-nav" aria-expanded="false" aria-label="Открыть меню">
        <span class="header__toggle-bars" aria-hidden="true"></span>
      </button>

      <nav class="nav" id="main-nav" aria-label="Основное меню">
${renderNavigation({ path, role, isAuthenticated })}
      </nav>

      <div class="header__actions">
        <button class="header__theme" type="button" id="theme-toggle"
                aria-pressed="false" aria-label="Переключить тему оформления"></button>
${renderUserArea({ isAuthenticated, user })}
      </div>
    </div>
  </header>

  <main class="main" id="main-content">
    <div class="container">
      <div id="alerts" aria-live="polite"></div>
${content}
    </div>
  </main>

  <footer class="footer">
    <div class="container">
      <div class="footer__grid">
        <div>
          <p class="footer__title">Сервис трекинга заказов и инвентаря для ПВЗ</p>
          <p>Учебный проект по предмету «Разработка и сопровождение программного
             обеспечения». Минский колледж предпринимательства, 2026 год.</p>
        </div>
        <div>
          <p class="footer__title">Разделы</p>
          <ul class="footer__list">
            <li><a href="/">Главная</a></li>
            <li><a href="/login.html">Вход</a></li>
            <li><a href="/register.html">Регистрация</a></li>
          </ul>
        </div>
        <div>
          <p class="footer__title">Сведения о проекте</p>
          <ul class="footer__list">
            <li>Исполнитель: Кирдун Я.С.</li>
            <li>Группа: ПО-2409</li>
            <li>Версия: ${escapeHtml(config.version)}</li>
          </ul>
        </div>
      </div>
      <div class="footer__bottom">
        <span>© 2026 Минский колледж предпринимательства</span>
        <span>Сборка v${escapeHtml(config.version)}</span>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

/**
 * Формирует содержимое главной страницы.
 *
 * @param {{isAuthenticated?: boolean, user?: object|null}} context
 * @returns {string}
 */
function renderHomeContent({ isAuthenticated = false, user = null } = {}) {
  const greeting = isAuthenticated && user
    ? `<div class="alert alert--info" role="status">
         <span class="alert__icon" aria-hidden="true">i</span>
         <div class="alert__body">
           <strong class="alert__title">Вы вошли в систему</strong>
           ${escapeHtml(user.name)}, роль: ${user.role === 'admin' ? 'администратор' : 'клиент'}.
         </div>
       </div>`
    : `<div class="alert alert--info" role="status">
         <span class="alert__icon" aria-hidden="true">i</span>
         <div class="alert__body">
           <strong class="alert__title">Требуется вход в систему</strong>
           Чтобы отслеживать заказы и оформлять приёмку посылок,
           <a href="/login.html">войдите</a> или
           <a href="/register.html">зарегистрируйтесь</a>.
         </div>
       </div>`;

  const quickLinks = [
    {
      href: '/register.html',
      title: 'Регистрация',
      text: 'Создайте учётную запись и подтвердите адрес электронной почты.',
    },
    {
      href: '/login.html',
      title: 'Вход',
      text: 'Войдите, чтобы отслеживать свои заказы и получать уведомления.',
    },
    {
      href: '/orders.html',
      title: 'Мои заказы',
      text: 'Статусы посылок, фильтрация по состоянию и сортировка по датам.',
    },
    {
      href: '/cells.html',
      title: 'Ячейки хранения',
      text: 'Сведения о занятости ячеек на складе пункта выдачи.',
    },
  ].map((item) => `        <article class="card">
          <h3 class="card__title">${escapeHtml(item.title)}</h3>
          <p class="text-muted">${escapeHtml(item.text)}</p>
          <a class="btn btn--secondary btn--sm btn--inline" href="${escapeHtml(item.href)}">Перейти</a>
        </article>`).join('\n');

  return `      <div class="page-header">
        <h1>Сервис трекинга заказов и инвентаря для ПВЗ</h1>
        <p class="page-header__subtitle">
          Учёт посылок, адресное хранение в ячейках и выдача заказов клиентам.
        </p>
      </div>

      ${greeting}

      <h2>Основные разделы</h2>
      <div class="grid grid--4">
${quickLinks}
      </div>

      <h2>Возможности сервиса</h2>
      <div class="grid grid--2">
        <div class="card">
          <h3 class="card__title">Для клиента</h3>
          <ul>
            <li>отслеживание статуса посылок в режиме реального времени;</li>
            <li>фильтрация и сортировка списка заказов;</li>
            <li>уведомления о поступлении заказа на электронную почту;</li>
            <li>адаптивный интерфейс и выбор светлой или тёмной темы.</li>
          </ul>
        </div>
        <div class="card">
          <h3 class="card__title">Для администратора</h3>
          <ul>
            <li>приёмка посылок с назначением ячейки хранения;</li>
            <li>выдача заказов с автоматическим освобождением ячейки;</li>
            <li>управление справочником ячеек и контроль занятости склада;</li>
            <li>просмотр всех заказов и учётных записей пользователей.</li>
          </ul>
        </div>
      </div>`;
}

module.exports = {
  renderPage,
  renderNavigation,
  renderUserArea,
  renderHomeContent,
  escapeHtml,
  isActive,
  NAVIGATION,
};
