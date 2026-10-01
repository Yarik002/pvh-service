'use strict';

/**
 * Проверка отправки писем в контейнере Docker.
 *
 * Выполняется весь путь целиком: регистрация пользователя через API →
 * проверка, что письмо принято перехватчиком mailpit → переход по ссылке
 * из письма → вход в систему.
 *
 * Запуск (на компьютере, приложение уже поднято в Docker):
 *   node scripts/check-docker-mail.js
 */

const API = process.env.API_URL || 'http://127.0.0.1:3000';
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const EMAIL = process.env.CHECK_EMAIL || `docker${Date.now()}@example.com`;
const PASSWORD = 'Xk9#mQ2$vL7p';

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Запрос к API приложения. */
async function api(method, path, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API}${path}`, {
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

  return { status: response.status, location: response.headers.get('location'), body: parsed };
}

/** Запрос к перехватчику писем. */
async function mailpit(path) {
  const response = await fetch(`${MAILPIT}${path}`, { headers: { Accept: 'application/json' } });
  return response.json();
}

async function main() {
  console.log('='.repeat(74));
  console.log('ПРОВЕРКА ОТПРАВКИ ПИСЕМ В КОНТЕЙНЕРЕ DOCKER');
  console.log('='.repeat(74));

  // --- 1. Приложение доступно ------------------------------------------
  const health = await api('GET', '/health');
  check('Приложение отвечает на /health', health.status === 200,
    `версия ${health.body?.version}, режим ${health.body?.environment}`);

  // --- 2. Перехватчик писем доступен ------------------------------------
  let mailpitOk = true;
  try {
    const info = await mailpit('/api/v1/info');
    check('Перехватчик писем доступен', true, `писем в ящике: ${info.messages || 0}`);
  } catch (error) {
    mailpitOk = false;
    check('Перехватчик писем доступен', false, error.message);
  }

  // --- 3. Регистрация ----------------------------------------------------
  const registered = await api('POST', '/api/auth/register', {
    body: {
      name: 'Проверка Docker',
      email: EMAIL,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    },
  });

  check('Регистрация выполняется', registered.status === 201, registered.body?.message);
  check('Письмо передано почтовому серверу',
    registered.body?.confirmationEmail?.sent === true,
    `статус отправки: ${registered.body?.confirmationEmail?.status}`);
  check('Ошибки отправки нет',
    !registered.body?.confirmationEmail?.error,
    registered.body?.confirmationEmail?.error || 'ошибок нет');

  // --- 4. Письмо действительно получено ----------------------------------
  let message = null;

  if (mailpitOk) {
    // Небольшая задержка: письмо обрабатывается сервером не мгновенно
    for (let attempt = 0; attempt < 10 && !message; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));

      const list = await mailpit('/api/v1/messages?limit=50');
      const found = (list.messages || []).find((item) => item.To
        && item.To.some((recipient) => recipient.Address === EMAIL));

      if (found) message = found;
    }

    check('Письмо получено перехватчиком', Boolean(message),
      message ? `тема «${message.Subject}», от ${message.From?.Address}` : 'письмо не найдено');

    if (message) {
      check('Тема письма содержит подтверждение адреса',
        /подтвержд/i.test(message.Subject || ''), message.Subject);

      const full = await mailpit(`/api/v1/message/${message.ID}`);
      const text = full.Text || '';
      const html = full.HTML || '';

      check('Письмо содержит текст и HTML-версию',
        text.length > 0 && html.length > 0,
        `текст ${text.length} символов, HTML ${html.length} символов`);

      check('В письме есть ссылка подтверждения',
        /\/api\/auth\/confirm\?token=/.test(text) || /\/api\/auth\/confirm\?token=/.test(html));

      // --- 5. Переход по ссылке из письма ---------------------------------
      const match = (text + html).match(/(https?:\/\/[^\s"'<>]+\/api\/auth\/confirm\?token=[A-Za-z0-9_-]+)/);

      if (match) {
        const confirmUrl = match[1].replace(/&amp;/g, '&');
        check('Ссылка ведёт на адрес приложения',
          confirmUrl.startsWith(API), confirmUrl.split('?')[0]);

        // Переход по ссылке подтверждает адрес. Ответ может быть двух видов:
        // перенаправление на страницу результата (303) либо готовая страница (200).
        const response = await fetch(confirmUrl, { redirect: 'manual' });
        const location = response.headers.get('location');
        const pageText = response.status === 200 ? await response.text() : '';

        const confirmed = response.status === 303 && Boolean(location)
          || response.status === 200 && /подтвержд/i.test(pageText);

        check('Переход по ссылке подтверждает адрес', confirmed,
          `статус ${response.status}${location ? ` → ${location}` : ''}`);

        // Подтверждение одноразовое: повторный переход по той же ссылке
        // не должен подтверждать адрес второй раз
        const second = await fetch(confirmUrl, { redirect: 'manual' });
        const secondText = second.status === 200 ? await second.text() : '';
        const secondLocation = second.headers.get('location') || '';

        check('Повторный переход по ссылке не подтверждает адрес дважды',
          !(second.status === 303 && secondLocation.includes('status=success'))
          && !/подтверждён\. Учётная запись активирована/.test(secondText),
          `статус ${second.status}${secondLocation ? ` → ${secondLocation}` : ''}`);
      } else {
        check('Ссылка подтверждения найдена в письме', false, 'адрес не найден в тексте');
      }
    }
  }

  // --- 6. Вход после подтверждения ---------------------------------------
  const loginReal = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  check('Вход после подтверждения выполняется', loginReal.status === 200,
    loginReal.status === 200 ? 'токен получен' : JSON.stringify(loginReal.body?.error));

  if (loginReal.body?.token) {
    check('Сессия создана', Boolean(loginReal.body.token), `${loginReal.body.token.length} символов`);
    check('Данные пользователя возвращаются',
      loginReal.body.user?.isConfirmed === true, loginReal.body.user?.email);
  }

  // --- Итог ---------------------------------------------------------------
  const failed = results.filter((r) => !r.passed);
  console.log('-'.repeat(74));
  console.log(`Всего проверок: ${results.length}, пройдено: ${results.length - failed.length}, ошибок: ${failed.length}`);

  if (failed.length === 0) {
    console.log('РЕЗУЛЬТАТ: письма успешно отправляются и принимаются почтовым сервером.');
    console.log(`Просмотреть письмо: ${MAILPIT}`);
    console.log('='.repeat(74));
    return 0;
  }

  console.log('Не пройденные проверки:');
  failed.forEach((r) => console.log(`  • ${r.name} (${r.detail})`));
  console.log('='.repeat(74));
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Ошибка проверки:', error.message);
    process.exit(1);
  });
