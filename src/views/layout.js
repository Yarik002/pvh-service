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
 *   'admin'    — только администратору;
 *   'guest'    — только тем, кто не вошёл.
 * adminTitle — название раздела для администратора, если отличается;
 * mobileOnly — пункт нужен только в меню на телефоне.
 */
const NAVIGATION = [
  { path: '/', title: 'Главная', roles: 'public' },
  { path: '/orders', title: 'Мои заказы', adminTitle: 'Все заказы', roles: 'user' },
  { path: '/cells', title: 'Ячейки', roles: 'user' },
  { path: '/receive', title: 'Приёмка товара', roles: 'admin' },
  { path: '/admin', title: 'Администрирование', roles: 'admin' },
  // Профиль открывается из блока пользователя в шапке; в меню он нужен
  // только на телефоне, где блок пользователя скрыт
  { path: '/profile', title: 'Профиль', roles: 'user', mobileOnly: true },
  // Гостю на телефоне кнопки входа и регистрации в шапке не помещаются
  { path: '/login', title: 'Вход', roles: 'guest', mobileOnly: true },
  { path: '/register', title: 'Регистрация', roles: 'guest', mobileOnly: true },
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
    if (item.roles === 'guest') return !isAuthenticated;
    return false;
  });

  const links = items.map((item) => {
    const active = isActive(path, item.path);
    const classes = ['nav__item'];
    if (item.roles === 'admin') classes.push('nav__item--admin');
    if (item.mobileOnly) classes.push('nav__item--mobile');
    const title = role === 'admin' && item.adminTitle ? item.adminTitle : item.title;

    return `        <li class="${classes.join(' ')}">
          <a class="nav__link" href="${escapeHtml(item.path)}"${
  active ? ' aria-current="page"' : ''
}>${escapeHtml(title)}</a>
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

    return `        <a class="header__user" href="/profile" title="Профиль: ${escapeHtml(user.email)}">
          <span class="header__avatar" aria-hidden="true">${escapeHtml(initial)}</span>
          <span class="header__user-text">
            <span class="header__user-name">${escapeHtml(user.name)}</span>
            <span class="header__user-role">${escapeHtml(roleLabel)}</span>
          </span>
        </a>
        <button class="btn btn--ghost btn--sm btn--inline" type="button" id="logout-button">Выйти</button>`;
  }

  return `        <a class="btn btn--ghost btn--sm btn--inline" href="/login.html">Войти</a>
        <a class="btn btn--sm btn--inline" href="/register.html">Регистрация</a>`;
}

/** Знак приложения: стеллаж 3×3, две ячейки заняты (жёлтые). */
const BRAND_MARK = `<span class="header__brand-mark" aria-hidden="true">ПВЗ${'<i></i>'.repeat(9)}</span>`;

/**
 * Шрифты подключаются с Google Fonts. Без интернета страница остаётся
 * читаемой: в таблице стилей указаны системные шрифты на замену.
 */
const FONTS = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600'
  + '&amp;family=Onest:wght@400;500;600;700&amp;family=Unbounded:wght@500;600;700&amp;display=swap';

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

  const footerLinks = isAuthenticated
    ? `<li><a href="/orders">${role === 'admin' ? 'Все заказы' : 'Мои заказы'}</a></li>
            <li><a href="/cells">Ячейки</a></li>
            <li><a href="/profile">Профиль</a></li>`
    : `<li><a href="/login.html">Вход</a></li>
            <li><a href="/register.html">Регистрация</a></li>`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#f3f1eb">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(fullTitle)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <!-- Тема применяется до загрузки стилей и отрисовки страницы,
       поэтому сценарий подключён без defer: так нет мерцания светлой темы -->
  <script src="/js/theme.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${FONTS}">
  <link rel="stylesheet" href="/css/main.css">
  <script src="/js/layout.js" defer></script>
${scriptTags}
</head>
<body data-role="${escapeHtml(role)}"${bodyAttributes ? ` ${bodyAttributes}` : ''}>
  <a class="skip-link" href="#main-content">Перейти к содержимому</a>

  <header class="header">
    <div class="container header__inner">
      <a class="header__brand" href="/" aria-label="Сервис ПВЗ — на главную">
        ${BRAND_MARK}
        <span class="header__brand-text">Сервис ПВЗ<small>трекинг · склад</small></span>
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
                aria-pressed="false" aria-label="Переключить тему оформления"
                title="Переключить тему оформления"><span aria-hidden="true">◐</span></button>
        <span class="visually-hidden" id="theme-status" aria-live="polite"></span>
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
          <p class="footer__brand">${BRAND_MARK} Сервис ПВЗ</p>
          <p class="footer__lead">Сервис трекинга заказов и инвентаря для ПВЗ.
             Учебный проект по предмету «Разработка и сопровождение программного
             обеспечения». Минский колледж предпринимательства, 2026 год.</p>
        </div>
        <div>
          <p class="footer__title">Разделы</p>
          <ul class="footer__list">
            <li><a href="/">Главная</a></li>
            ${footerLinks}
          </ul>
        </div>
        <div>
          <p class="footer__title">О проекте</p>
          <ul class="footer__list">
            <li>Исполнитель: Кирдун Я.С.</li>
            <li>Группа: ПО-2409</li>
            <li>Версия: ${escapeHtml(config.version)}</li>
          </ul>
        </div>
      </div>
      <div class="footer__bottom">
        <span>© 2026 Минский колледж предпринимательства</span>
        <span>Сборка v${escapeHtml(config.version)} · Node.js · Express · SQLite</span>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

/**
 * Схема стеллажа на главной странице: реальная занятость ячеек.
 * Номера заказов и получатели не показываются — только состояние ячеек.
 *
 * @param {{cellNumber: number, status: string}[]} cells
 * @returns {string}
 */
function renderLocker(cells = []) {
  const busy = cells.filter((cell) => cell.status === 'Занята').length;
  const free = cells.length - busy;
  const percent = cells.length ? Math.round((busy / cells.length) * 100) : 0;

  const items = cells.map((cell) => {
    const isBusy = cell.status === 'Занята';
    return `            <li class="locker__cell${isBusy ? ' locker__cell--busy' : ''}"
                title="Ячейка ${cell.cellNumber}: ${escapeHtml(String(cell.status).toLowerCase())}">${cell.cellNumber}</li>`;
  }).join('\n');

  return `        <figure class="locker" aria-label="Состояние склада: занято ${busy} из ${cells.length} ячеек">
          <div class="locker__head">
            <p class="locker__title">Склад сейчас</p>
            <span class="badge badge--success badge--status badge--live">данные из базы</span>
          </div>
          <ul class="locker__grid">
${items || '            <li class="text-muted">Ячейки не заведены</li>'}
          </ul>
          <div class="locker__legend">
            <span><i class="legend-dot" aria-hidden="true"></i>свободно — ${free}</span>
            <span><i class="legend-dot legend-dot--busy" aria-hidden="true"></i>занято — ${busy}</span>
            <span>заполненность — ${percent}%</span>
          </div>
        </figure>`;
}

/**
 * Формирует содержимое главной страницы.
 *
 * @param {{isAuthenticated?: boolean, user?: object|null, cells?: object[]}} context
 * @returns {string}
 */
function renderHomeContent({ isAuthenticated = false, user = null, cells = [] } = {}) {
  const isAdmin = user?.role === 'admin';

  let actions;
  if (!isAuthenticated || !user) {
    actions = `<a class="btn btn--lg btn--inline" href="/register.html">Создать учётную запись</a>
            <a class="btn btn--secondary btn--lg btn--inline" href="/login.html">Войти</a>`;
  } else if (isAdmin) {
    actions = `<a class="btn btn--accent btn--lg btn--inline" href="/receive">Принять посылку</a>
            <a class="btn btn--lg btn--inline" href="/orders">Все заказы</a>`;
  } else {
    actions = `<a class="btn btn--lg btn--inline" href="/orders">Мои заказы</a>
            <a class="btn btn--secondary btn--lg btn--inline" href="/cells">Ячейки склада</a>`;
  }

  const greeting = isAuthenticated && user
    ? `<div class="alert alert--info" role="status">
         <span class="alert__icon" aria-hidden="true">i</span>
         <div class="alert__body">
           <strong class="alert__title">Вы вошли в систему</strong>
           ${escapeHtml(user.name)}, роль: ${isAdmin ? 'администратор' : 'клиент'}.
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
      href: '/orders',
      title: isAdmin ? 'Все заказы' : 'Мои заказы',
      text: 'Статусы посылок, фильтр по состоянию, поиск и сортировка по датам.',
    },
    {
      href: '/cells',
      title: 'Ячейки хранения',
      text: 'Занятость каждой ячейки стеллажа и сводка по складу.',
    },
    isAdmin
      ? { href: '/receive', title: 'Приёмка товара', text: 'Оформление посылки и назначение ячейки за пару секунд.' }
      : { href: '/profile', title: 'Профиль', text: 'Имя, смена пароля и удаление учётной записи.' },
    isAdmin
      ? { href: '/admin', title: 'Администрирование', text: 'Пользователи, сводка по заказам и справочник ячеек.' }
      : { href: '/register.html', title: 'Регистрация', text: 'Учётная запись с подтверждением адреса почты.' },
  ].map((item) => `        <a class="card card--link" href="${escapeHtml(item.href)}">
          <h3 class="card__title">${escapeHtml(item.title)}</h3>
          <p class="text-muted" style="margin: 0;">${escapeHtml(item.text)}</p>
        </a>`).join('\n');

  return `      <section class="hero">
        <div>
          <p class="eyebrow">Пункт выдачи заказов</p>
          <h1 class="hero__title">Каждая посылка&nbsp;— <mark>в&nbsp;своей ячейке</mark></h1>
          <p class="hero__lead">
            Приёмка посылок с автоматическим выбором ячейки, письмо клиенту
            о поступлении и выдача в одно нажатие. Клиент видит статус заказа
            и номер ячейки в своём кабинете.
          </p>
          <div class="hero__actions">
            ${actions}
          </div>
          <p class="hero__note">Статусы заказа: «В пути» → «Готов к выдаче» → «Выдан».</p>
        </div>
${renderLocker(cells)}
      </section>

      ${greeting}

      <div class="section-title"><h2>Как работает пункт выдачи</h2></div>
      <ol class="steps">
        <li class="step">
          <h3>Приёмка</h3>
          <p>Администратор вводит трек-номер и получателя. Система сама находит
             первую свободную ячейку — или ту, что выбрана вручную.</p>
        </li>
        <li class="step">
          <h3>Хранение</h3>
          <p>Заказ получает статус «Готов к выдаче», ячейка — «Занята».
             Клиенту уходит письмо с номером ячейки.</p>
        </li>
        <li class="step">
          <h3>Выдача</h3>
          <p>После подтверждения заказ становится «Выдан», а ячейка
             освобождается — всё в одной транзакции.</p>
        </li>
      </ol>

      <div class="section-title"><h2>Основные разделы</h2></div>
      <div class="grid grid--4">
${quickLinks}
      </div>

      <div class="section-title"><h2>Возможности сервиса</h2></div>
      <div class="grid grid--2">
        <div class="card role-card">
          <div class="role-card__head"><h3>Для клиента</h3><span class="badge badge--muted">client</span></div>
          <ul class="ticks">
            <li>статусы посылок обновляются на экране без перезагрузки страницы;</li>
            <li>фильтр по статусу, поиск по трек-номеру и сортировка;</li>
            <li>письмо на почту, когда заказ поступил в пункт выдачи;</li>
            <li>светлая и тёмная тема, удобная работа с телефона.</li>
          </ul>
        </div>
        <div class="card role-card">
          <div class="role-card__head"><h3>Для администратора</h3><span class="badge badge--info">admin</span></div>
          <ul class="ticks">
            <li>приёмка посылок с назначением ячейки хранения;</li>
            <li>выдача заказа с окном подтверждения и освобождением ячейки;</li>
            <li>редактирование и удаление заказов, ожидаемые поступления;</li>
            <li>контроль занятости склада и учётных записей.</li>
          </ul>
        </div>
      </div>`;
}

module.exports = {
  renderPage,
  renderLocker,
  renderNavigation,
  renderUserArea,
  renderHomeContent,
  escapeHtml,
  isActive,
  NAVIGATION,
};
