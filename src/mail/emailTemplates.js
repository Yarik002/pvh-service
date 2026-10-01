'use strict';

/**
 * Шаблоны писем, отправляемых приложением.
 *
 * Каждое письмо формируется в двух вариантах: обычный текст и HTML. Текстовая
 * версия обязательна: часть почтовых клиентов не отображает HTML, а наличие
 * текстовой части снижает вероятность попадания письма в папку «Спам».
 *
 * Оформление вынесено в отдельный модуль, чтобы текст писем можно было
 * изменять, не затрагивая логику отправки.
 */

/** Экранирует специальные символы HTML в подставляемых значениях. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Общая «рамка» HTML-письма: заголовок, содержимое, подпись. */
function htmlLayout({ title, content }) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#202124;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#1a56db;padding:20px 28px;color:#ffffff;font-size:18px;font-weight:bold;">
              Сервис трекинга заказов и инвентаря для ПВЗ
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;background:#f8f9fa;color:#5f6368;font-size:12px;line-height:1.5;">
              Письмо отправлено автоматически, отвечать на него не нужно.<br>
              Учебный проект по предмету «Разработка и сопровождение программного обеспечения».
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Кнопка-ссылка для HTML-версии письма. */
function htmlButton(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="background:#1a56db;border-radius:6px;">
        <a href="${escapeHtml(url)}"
           style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>`;
}

/**
 * Письмо с ссылкой подтверждения адреса электронной почты.
 *
 * @param {{name: string, email: string, confirmUrl: string, token: string,
 *          expiresInHours?: number}} data
 * @returns {{subject: string, text: string, html: string}}
 */
function confirmationEmail({ name, email, confirmUrl, token, expiresInHours = 24 }) {
  const subject = 'Подтверждение адреса электронной почты — Сервис ПВЗ';
  const greeting = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';

  const text = [
    greeting,
    '',
    'Вы зарегистрировались в сервисе трекинга заказов и инвентаря для пункта выдачи заказов.',
    `Для учётной записи указан адрес: ${email}`,
    '',
    'Чтобы подтвердить адрес электронной почты и активировать учётную запись,',
    'перейдите по ссылке:',
    '',
    confirmUrl,
    '',
    `Ссылка действует ${expiresInHours} ч.`,
    '',
    'Если вы не регистрировались в сервисе, просто проигнорируйте это письмо —',
    'учётная запись останется неподтверждённой.',
    '',
    '---',
    'Сервис трекинга заказов и инвентаря для ПВЗ',
  ].join('\n');

  const html = htmlLayout({
    title: subject,
    content: `
      <p style="margin:0 0 12px;font-size:15px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
        Вы зарегистрировались в сервисе трекинга заказов и инвентаря для пункта выдачи заказов.
      </p>
      <p style="margin:0 0 4px;font-size:15px;line-height:1.6;">
        Для учётной записи указан адрес: <b>${escapeHtml(email)}</b>
      </p>
      <p style="margin:0;font-size:15px;line-height:1.6;">
        Чтобы подтвердить адрес и активировать учётную запись, нажмите кнопку:
      </p>
      ${htmlButton(confirmUrl, 'Подтвердить адрес')}
      <p style="margin:0 0 12px;font-size:13px;color:#5f6368;line-height:1.6;">
        Если кнопка не работает, скопируйте ссылку в адресную строку браузера:<br>
        <span style="word-break:break-all;color:#1a56db;">${escapeHtml(confirmUrl)}</span>
      </p>
      <p style="margin:0;font-size:13px;color:#5f6368;line-height:1.6;">
        Ссылка действует ${expiresInHours} ч. Если вы не регистрировались в сервисе,
        просто проигнорируйте это письмо.
      </p>
    `,
  });

  return { subject, text, html };
}

/**
 * Письмо об успешной приёмке заказа (потребуется на 14-м дне).
 *
 * @param {{name: string, trackNumber: string, cellNumber: number|string,
 *          description?: string}} data
 * @returns {{subject: string, text: string, html: string}}
 */
function orderReceivedEmail({ name, trackNumber, cellNumber, description }) {
  const subject = `Заказ ${trackNumber} принят в пункт выдачи`;
  const greeting = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';

  const text = [
    greeting,
    '',
    'Ваш заказ принят в пункт выдачи и размещён в ячейке хранения.',
    '',
    `Трек-номер: ${trackNumber}`,
    `Ячейка: ${cellNumber}`,
    description ? `Описание: ${description}` : '',
    '',
    'Заказ можно получить в пункте выдачи. Для этого назовите трек-номер оператору.',
    '',
    '---',
    'Сервис трекинга заказов и инвентаря для ПВЗ',
  ].filter((line) => line !== '').join('\n');

  const html = htmlLayout({
    title: subject,
    content: `
      <p style="margin:0 0 12px;font-size:15px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
        Ваш заказ принят в пункт выдачи и размещён в ячейке хранения.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0"
             style="margin:0 0 12px;font-size:15px;line-height:1.8;">
        <tr><td style="color:#5f6368;padding-right:12px;">Трек-номер:</td>
            <td><b>${escapeHtml(trackNumber)}</b></td></tr>
        <tr><td style="color:#5f6368;padding-right:12px;">Ячейка:</td>
            <td><b>${escapeHtml(cellNumber)}</b></td></tr>
        ${description
          ? `<tr><td style="color:#5f6368;padding-right:12px;">Описание:</td>
             <td>${escapeHtml(description)}</td></tr>`
          : ''}
      </table>
      <p style="margin:0;font-size:15px;line-height:1.6;">
        Заказ можно получить в пункте выдачи: назовите трек-номер оператору.
      </p>
    `,
  });

  return { subject, text, html };
}

module.exports = { confirmationEmail, orderReceivedEmail, htmlLayout, htmlButton, escapeHtml };
