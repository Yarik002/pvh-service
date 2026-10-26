'use strict';

/**
 * Страницы приложения.
 *
 * Адреса вида «/имя-страницы» отдают HTML, построенный на общем шаблоне
 * (src/views/layout.js). Файловая система для этого не используется:
 * разметка формируется на сервере, что позволяет сразу подставлять
 * сведения о текущем пользователе и его роль.
 *
 * Статические файлы (таблица стилей, сценарии, изображения) отдаются
 * middleware express.static из каталога public.
 */

const express = require('express');

const logger = require('../utils/logger');
const { renderPage, renderHomeContent } = require('../views/layout');
const {
  renderLoginContent,
  renderRegisterContent,
  renderConfirmContent,
  renderNotFoundContent,
} = require('../views/authPages');
const { renderAdminContent } = require('../views/adminPage');
const { optionalAuth, requireAuth, requireRole } = require('../middleware/authenticate');

const router = express.Router();

/** Приводит данные пользователя к виду, нужному шаблону. */
function toViewUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/**
 * Определяет, куда направить пользователя после входа.
 *
 * Если в адресе указан параметр next, пользователь возвращается на ту
 * страницу, с которой его перенаправили на вход. Значение проверяется:
 * принимаются только внутренние адреса, иначе злоумышленник мог бы
 * использовать форму входа для перенаправления на сторонний сайт.
 *
 * @param {string} value значение параметра next
 * @returns {string} безопасный адрес перехода
 */
function safeRedirect(value) {
  const target = String(value || '').trim();

  if (target === '' || !target.startsWith('/') || target.startsWith('//')) return '/';
  if (target.includes('\\') || target.includes('@')) return '/';

  return target;
}

/**
 * GET /
 * Главная страница приложения.
 */
router.get('/', optionalAuth(), (req, res, next) => {
  try {
    const user = toViewUser(req.user);
    const isAuthenticated = Boolean(user);

    const html = renderPage({
      title: 'Главная',
      path: '/',
      description: 'Сервис трекинга заказов и инвентаря для пункта выдачи заказов: '
        + 'учёт посылок, адресное хранение и выдача заказов.',
      content: renderHomeContent({ isAuthenticated, user }),
      isAuthenticated,
      user,
    });

    res.status(200).type('html').send(html);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /template-demo
 * Страница проверки шаблона: показывает все элементы оформления
 * (кнопки, поля, уведомления, таблицу, показатели).
 *
 * Используется при проверке адаптивности на разных разрешениях экрана
 * и при защите проекта для демонстрации готовых компонентов.
 */
router.get('/template-demo', (req, res, next) => {
  try {
    const user = toViewUser(req.user);
    const isAuthenticated = Boolean(user);

    const content = `      <div class="page-header">
        <h1>Проверка базового шаблона</h1>
        <p class="page-header__subtitle">
          Страница содержит все элементы оформления приложения и служит
          для проверки вёрстки на разных разрешениях экрана.
        </p>
      </div>

      <h2>Уведомления</h2>
      <div class="stack" style="margin-bottom: var(--space-5);">
        <div class="alert alert--success" role="status">
          <span class="alert__icon" aria-hidden="true">✓</span>
          <div class="alert__body">
            <strong class="alert__title">Операция выполнена</strong>
            Сообщение об успешном действии.
          </div>
        </div>
        <div class="alert alert--warning" role="status">
          <span class="alert__icon" aria-hidden="true">!</span>
          <div class="alert__body">
            <strong class="alert__title">Обратите внимание</strong>
            Предупреждение о возможной проблеме.
          </div>
        </div>
        <div class="alert alert--danger" role="alert">
          <span class="alert__icon" aria-hidden="true">✕</span>
          <div class="alert__body">
            <strong class="alert__title">Ошибка</strong>
            Сообщение об ошибке, понятное пользователю.
          </div>
        </div>
        <div class="alert alert--info" role="status">
          <span class="alert__icon" aria-hidden="true">i</span>
          <div class="alert__body">
            <strong class="alert__title">Подсказка</strong>
            Информационное сообщение.
          </div>
        </div>
      </div>

      <h2>Показатели</h2>
      <div class="grid grid--4" style="margin-bottom: var(--space-5);">
        <div class="stat"><div class="stat__value">20</div><div class="stat__label">ячеек хранения</div></div>
        <div class="stat"><div class="stat__value">18</div><div class="stat__label">свободно</div></div>
        <div class="stat"><div class="stat__value">2</div><div class="stat__label">занято</div></div>
        <div class="stat"><div class="stat__value">10 %</div><div class="stat__label">заполненность</div></div>
      </div>

      <h2>Кнопки</h2>
      <div class="row" style="margin-bottom: var(--space-5);">
        <button class="btn btn--inline" type="button">Основная кнопка</button>
        <button class="btn btn--secondary btn--inline" type="button">Второстепенная</button>
        <button class="btn btn--danger btn--inline" type="button">Удалить</button>
        <button class="btn btn--sm btn--inline" type="button">Небольшая</button>
        <button class="btn btn--inline" type="button" disabled>Недоступна</button>
      </div>

      <h2>Таблица</h2>
      <div class="table-wrap" style="margin-bottom: var(--space-5);">
        <table class="table">
          <thead>
            <tr><th>Трек-номер</th><th>Клиент</th><th>Ячейка</th><th>Статус</th><th>Дата поступления</th></tr>
          </thead>
          <tbody>
            <tr><td class="text-mono">PVZ100000001</td><td>Иванов И.И.</td><td>7</td>
                <td><span class="badge badge--success">Готов к выдаче</span></td><td>01.10.2026 10:15</td></tr>
            <tr><td class="text-mono">PVZ100000002</td><td>Петров П.П.</td><td>—</td>
                <td><span class="badge badge--warning">В пути</span></td><td>—</td></tr>
            <tr><td class="text-mono">PVZ100000003</td><td>Сидоров С.С.</td><td>12</td>
                <td><span class="badge badge--muted">Выдан</span></td><td>28.09.2026 14:40</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Поля формы</h2>
      <div class="grid grid--2">
        <div class="card">
          <div class="field">
            <label class="field__label" for="demo-name">Имя <span class="field__required">*</span></label>
            <input class="field__input" id="demo-name" type="text" value="Иванов Иван">
            <span class="field__hint">От 2 до 100 символов.</span>
          </div>
          <div class="field" style="margin-top: var(--space-4);">
            <label class="field__label" for="demo-email">Адрес электронной почты</label>
            <input class="field__input" id="demo-email" type="email" value="ivanov@mail.ru">
          </div>
        </div>
        <div class="card">
          <div class="field field--invalid">
            <label class="field__label" for="demo-error">Поле с ошибкой</label>
            <input class="field__input" id="demo-error" type="text" value="неверное значение">
            <span class="field__error">Укажите корректное значение поля.</span>
          </div>
          <div class="field" style="margin-top: var(--space-4);">
            <label class="field__label" for="demo-password">Пароль</label>
            <div class="field__password">
              <input class="field__input" id="demo-password" type="password" value="parol12345">
              <button class="field__password-toggle" type="button"
                      data-password-toggle="demo-password" aria-label="Показать пароль">Показать</button>
            </div>
            <div class="strength">
              <div class="strength__track"><div class="strength__bar" style="width: 82%; background: var(--color-success);"></div></div>
              <span class="strength__label">Надёжность пароля: высокая</span>
            </div>
          </div>
        </div>
      </div>`;

    const html = renderPage({
      title: 'Проверка шаблона',
      path: '/template-demo',
      content,
      isAuthenticated,
      user,
      scripts: ['/js/template-demo.js'],
    });

    res.status(200).type('html').send(html);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /register
 * Страница регистрации.
 *
 * Уже вошедшего пользователя незачем регистрировать заново: он направляется
 * на главную страницу.
 */
router.get('/register', optionalAuth(), (req, res, next) => {
  try {
    const user = toViewUser(req.user);

    if (user) {
      logger.debug(`Пользователь ${user.email} уже авторизован, страница регистрации не требуется`);
      return res.redirect(302, '/');
    }

    const html = renderPage({
      title: 'Регистрация',
      path: '/register.html',
      description: 'Создание учётной записи в сервисе трекинга заказов и инвентаря для ПВЗ.',
      content: renderRegisterContent(),
      isAuthenticated: false,
      user: null,
      scripts: ['/js/api.js', '/js/form.js', '/js/register.js'],
    });

    return res.status(200).type('html').send(html);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /login
 * Страница входа в систему.
 *
 * Уже вошедший пользователь направляется на главную страницу либо
 * на адрес, указанный в параметре next.
 */
router.get('/login', optionalAuth(), (req, res, next) => {
  try {
    const user = toViewUser(req.user);

    if (user) {
      return res.redirect(302, safeRedirect(req.query.next));
    }

    const html = renderPage({
      title: 'Вход',
      path: '/login.html',
      description: 'Вход в личный кабинет сервиса трекинга заказов и инвентаря для ПВЗ.',
      content: renderLoginContent({ next: safeRedirect(req.query.next) }),
      isAuthenticated: false,
      user: null,
      scripts: ['/js/api.js', '/js/form.js', '/js/login.js'],
    });

    return res.status(200).type('html').send(html);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /confirm
 * Страница результата подтверждения адреса электронной почты.
 *
 * Серверный маршрут подтверждения (/api/auth/confirm) выполняет проверку
 * токена и перенаправляет пользователя сюда, передавая результат
 * в параметрах запроса.
 */
router.get('/confirm', (req, res, next) => {
  try {
    const status = String(req.query.status || 'unknown');
    const email = String(req.query.email || '');

    const html = renderPage({
      title: 'Подтверждение адреса',
      path: '/confirm.html',
      description: 'Результат подтверждения адреса электронной почты.',
      content: renderConfirmContent({ status, email }),
      isAuthenticated: false,
      user: null,
      scripts: ['/js/confirm.js'],
    });

    res.status(200).type('html').send(html);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /admin
 * Страница администратора: сводка по ПВЗ, пользователи и ячейки.
 *
 * Доступна только пользователям с ролью admin. Клиент, открывший адрес,
 * получит отказ 403 — данные всё равно защищены на уровне API,
 * но страница не должна открываться даже визуально.
 */
router.get(
  '/admin',
  requireAuth(),
  requireRole('admin'),
  (req, res, next) => {
    try {
      const user = toViewUser(req.user);

      const html = renderPage({
        title: 'Администрирование',
        path: '/admin',
        description: 'Сводка по состоянию пункта выдачи, учётные записи '
          + 'и справочник ячеек хранения.',
        content: renderAdminContent(),
        isAuthenticated: true,
        user,
        scripts: ['/js/api.js', '/js/admin.js'],
      });

      res.status(200).type('html').send(html);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Содержимое страницы раздела, который ещё не реализован.
 *
 * Ссылки на такие разделы уже есть в меню, поэтому вместо ошибки 404
 * пользователь видит понятное сообщение с указанием этапа разработки.
 *
 * @param {{title: string, description: string, plannedStage: string}} options
 * @returns {string}
 */
function renderPlannedContent({ title, description, plannedStage }) {
  return `      <div class="page-header">
        <h1>${title}</h1>
        <p class="page-header__subtitle">${description}</p>
      </div>

      <div class="alert alert--info" role="status">
        <span class="alert__icon" aria-hidden="true">i</span>
        <div class="alert__body">
          <strong class="alert__title">Раздел находится в разработке</strong>
          Он будет реализован на этапе «${plannedStage}» согласно плану практики.
          Сейчас доступны регистрация, вход, подтверждение адреса
          и административная сводка.
        </div>
      </div>

      <p>
        <a class="btn btn--inline" href="/">На главную</a>
        <a class="btn btn--secondary btn--inline" href="/admin">Администрирование</a>
      </p>`;
}

/**
 * GET /orders
 * Страница заказов клиента (реализуется на 16–17-м дне практики).
 */
router.get('/orders', requireAuth(), (req, res, next) => {
  try {
    const html = renderPage({
      title: 'Мои заказы',
      path: '/orders',
      content: renderPlannedContent({
        title: 'Мои заказы',
        description: 'Список ваших заказов с фильтрацией по состоянию.',
        plannedStage: 'дни 16–17, списки заказов',
      }),
      isAuthenticated: true,
      user: toViewUser(req.user),
    });

    res.status(200).type('html').send(html);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /cells
 * Страница ячеек хранения (реализуется на 12–13-м дне практики).
 */
router.get('/cells', requireAuth(), (req, res, next) => {
  try {
    const html = renderPage({
      title: 'Ячейки хранения',
      path: '/cells',
      content: renderPlannedContent({
        title: 'Ячейки хранения',
        description: 'Занятость ячеек на складе пункта выдачи.',
        plannedStage: 'дни 12–13, управление ячейками',
      }),
      isAuthenticated: true,
      user: toViewUser(req.user),
    });

    res.status(200).type('html').send(html);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /receive
 * Страница приёмки товара (реализуется на 15-м дне практики).
 */
router.get(
  '/receive',
  requireAuth(),
  requireRole('admin'),
  (req, res, next) => {
    try {
      const html = renderPage({
        title: 'Приёмка товара',
        path: '/receive',
        content: renderPlannedContent({
          title: 'Приёмка товара',
          description: 'Оформление поступления посылки с назначением ячейки.',
          plannedStage: 'дни 14–15, приёмка заказов',
        }),
        isAuthenticated: true,
        user: toViewUser(req.user),
      });

      res.status(200).type('html').send(html);
    } catch (error) {
      next(error);
    }
  },
);

// --- Обработчики адресов файлов --------------------------------------------
// Ссылки вида /login.html и /register.html встречаются в разметке шапки
// и подвала. Они перенаправляются на соответствующие страницы, чтобы адреса
// были единообразными и не зависели от расширения файла.

const EXTENSION_REDIRECTS = {
  '/index.html': '/',
  '/login.html': '/login',
  '/register.html': '/register',
  '/confirm.html': '/confirm',
  '/template-demo.html': '/template-demo',
  '/admin.html': '/admin',
};

Object.entries(EXTENSION_REDIRECTS).forEach(([from, to]) => {
  router.get(from, (req, res) => {
    const query = new URLSearchParams(req.query).toString();
    res.redirect(301, query ? `${to}?${query}` : to);
  });
});

/**
 * Страница «не найдено» для остальных адресов.
 *
 * Здесь только передаётся ошибка 404: формат ответа (оформленная страница
 * для браузера либо JSON для программы) выбирает обработчик ошибок
 * в зависимости от заголовка Accept. Такой порядок сохраняет единый
 * формат ответов API и оформленные страницы для браузера.
 */
router.use((req, res, next) => next());

module.exports = router;

