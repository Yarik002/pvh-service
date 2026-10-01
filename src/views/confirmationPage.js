'use strict';

/**
 * Страницы результата подтверждения адреса электронной почты.
 *
 * Пользователь переходит по ссылке из письма в браузере, поэтому ответ
 * эндпоинта подтверждения — не JSON, а готовая HTML-страница с понятным
 * сообщением и дальнейшими действиями.
 *
 * Страницы оформлены автономно (стили включены в документ): полноценный шаблон
 * приложения появится на 9–10-м дне, и эти страницы будут подключены к нему.
 */

const config = require('../config');
const { CONFIRM_STATUS } = require('../services/confirmationService');

/** Экранирует специальные символы HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Описание внешнего вида страницы для каждого результата. */
const APPEARANCE = {
  [CONFIRM_STATUS.CONFIRMED]: {
    icon: '&#10004;',
    color: '#1e7e34',
    background: '#e8f5e9',
    title: 'Адрес электронной почты подтверждён',
    hint: 'Учётная запись активирована. Теперь вы можете войти в систему, используя свой адрес электронной почты и пароль.',
    action: { label: 'Перейти ко входу', href: '/login.html' },
  },
  [CONFIRM_STATUS.ALREADY_CONFIRMED]: {
    icon: '&#10004;',
    color: '#1e7e34',
    background: '#e8f5e9',
    title: 'Адрес уже подтверждён',
    hint: 'Эта ссылка уже была использована ранее. Повторное подтверждение не требуется — можно войти в систему.',
    action: { label: 'Перейти ко входу', href: '/login.html' },
  },
  [CONFIRM_STATUS.EXPIRED]: {
    icon: '&#9201;',
    color: '#b26a00',
    background: '#fff4e5',
    title: 'Срок действия ссылки истёк',
    hint: 'Ссылка подтверждения действует ограниченное время. Запросите новое письмо — оно придёт на тот же адрес.',
    action: { label: 'Получить новое письмо', href: '/resend-confirmation.html' },
  },
  [CONFIRM_STATUS.INVALID_TOKEN]: {
    icon: '&#10006;',
    color: '#c62828',
    background: '#fdecea',
    title: 'Ссылка недействительна',
    hint: 'Возможно, ссылка была использована ранее или скопирована не полностью. Проверьте, что адрес скопирован целиком, либо запросите новое письмо.',
    action: { label: 'Получить новое письмо', href: '/resend-confirmation.html' },
  },
  [CONFIRM_STATUS.MISSING_TOKEN]: {
    icon: '&#10006;',
    color: '#c62828',
    background: '#fdecea',
    title: 'В ссылке нет токена подтверждения',
    hint: 'Похоже, адрес скопирован не полностью. Откройте письмо и перейдите по ссылке целиком либо запросите новое письмо.',
    action: { label: 'Получить новое письмо', href: '/resend-confirmation.html' },
  },
};

/**
 * Формирует HTML-страницу результата подтверждения.
 *
 * @param {{status: string, message: string, user: object|null}} result
 * @returns {string} HTML-документ
 */
function confirmationPage(result) {
  const view = APPEARANCE[result.status] || APPEARANCE[CONFIRM_STATUS.INVALID_TOKEN];
  const user = result.user;

  const details = user
    ? `<dl class="details">
         <dt>Имя</dt><dd>${escapeHtml(user.name)}</dd>
         <dt>Адрес электронной почты</dt><dd>${escapeHtml(user.email)}</dd>
         <dt>Статус</dt><dd>${user.isConfirmed ? 'подтверждён' : 'не подтверждён'}</dd>
       </dl>`
    : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(view.title)} — ${escapeHtml(config.appName)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #f4f5f7; color: #202124; padding: 24px 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    }
    .card {
      width: 100%; max-width: 520px; background: #fff; border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.06); overflow: hidden;
    }
    .head { padding: 22px 28px; background: #1a56db; color: #fff; font-size: 15px; font-weight: 600; }
    .body { padding: 28px; }
    .icon {
      width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center;
      justify-content: center; font-size: 26px; margin-bottom: 16px;
      color: ${view.color}; background: ${view.background};
    }
    h1 { margin: 0 0 12px; font-size: 20px; line-height: 1.3; }
    p { margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #3c4043; }
    .details {
      margin: 0 0 20px; padding: 16px 18px; background: #f8f9fa; border-radius: 8px;
      font-size: 14px; display: grid; grid-template-columns: auto 1fr; gap: 8px 16px;
    }
    .details dt { color: #5f6368; }
    .details dd { margin: 0; font-weight: 600; word-break: break-word; }
    .action {
      display: inline-block; padding: 12px 24px; background: #1a56db; color: #fff;
      text-decoration: none; border-radius: 6px; font-size: 15px; font-weight: 600;
    }
    .action:hover { background: #1746b0; }
    .foot { padding: 14px 28px; background: #f8f9fa; color: #5f6368; font-size: 12px; line-height: 1.5; }
    @media (prefers-color-scheme: dark) {
      body { background: #16181d; color: #e8eaed; }
      .card { background: #202124; }
      .body p { color: #bdc1c6; }
      .details { background: #292a2d; }
      .details dt { color: #9aa0a6; }
      .foot { background: #292a2d; color: #9aa0a6; }
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="head">${escapeHtml(config.appName)}</div>
    <div class="body">
      <div class="icon">${view.icon}</div>
      <h1>${escapeHtml(view.title)}</h1>
      <p>${escapeHtml(result.message)}</p>
      ${details}
      <p>${escapeHtml(view.hint)}</p>
      <a class="action" href="${escapeHtml(view.action.href)}">${escapeHtml(view.action.label)}</a>
    </div>
    <div class="foot">
      Учебный проект по предмету «Разработка и сопровождение программного обеспечения».
    </div>
  </main>
</body>
</html>`;
}

/**
 * Формирует упрощённую HTML-страницу для ответа на POST-запрос
 * (когда браузер отправляет форму, а не открывает ссылку).
 */
function confirmationPageForPost(result) {
  return confirmationPage(result);
}

module.exports = { confirmationPage, confirmationPageForPost, escapeHtml, APPEARANCE };
