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
const { optionalAuth } = require('../middleware/authenticate');

const router = express.Router();

/** Приводит данные пользователя к виду, нужному шаблону. */
function toViewUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role };
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

module.exports = router;
