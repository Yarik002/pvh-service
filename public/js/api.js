'use strict';

/**
 * Обёртка над REST API приложения.
 *
 * Все обращения к серверу из браузера выполняются через этот модуль.
 * Он решает три задачи:
 *   • единообразно формирует запросы (заголовки, тело, cookie);
 *   • приводит ответы сервера к одному виду;
 *   • преобразует ошибки сервера в понятные сообщения на русском языке.
 *
 * Сессия передаётся в cookie с флагом HttpOnly, поэтому токен вручную
 * не сохраняется и не подставляется в заголовки.
 */

(function () {
  'use strict';

  /** Базовый адрес API. */
  var BASE_URL = '/api';

  /** Предельное время ожидания ответа сервера, мс. */
  var TIMEOUT_MS = 15000;

  /**
   * Ошибка обращения к API.
   *
   * @param {string} message сообщение для пользователя
   * @param {object} [details] подробности
   */
  function ApiError(message, details) {
    var error = new Error(message);
    error.name = 'ApiError';
    error.status = details && details.status;
    error.code = details && details.code;
    error.fields = (details && details.fields) || null;
    error.notified = false;
    return error;
  }

  /** Коды ответа 401, означающие, что сеанс входа завершён. */
  var SESSION_CODES = ['MISSING_TOKEN', 'SESSION_NOT_FOUND', 'SESSION_EXPIRED', 'UNAUTHORIZED'];

  /**
   * Единый перехват ошибок API (22-й день).
   *
   * Ошибки, которые страница не может исправить сама, показываются
   * всплывающим уведомлением в одном месте, а не в каждом сценарии:
   *   • сеанс завершён (401) — уведомление и переход на страницу входа;
   *   • нет прав (403), слишком много запросов (429), ошибка сервера (5xx);
   *   • нет связи с сервером или сервер не ответил вовремя.
   * Ошибки полей формы (400, 404, 409) оставляются сценарию страницы:
   * он выводит их рядом с полями.
   *
   * Уведомлённая ошибка помечается error.notified = true, чтобы сценарий
   * страницы не показал то же сообщение второй раз.
   *
   * @param {Error} error ошибка ApiError
   * @param {string} path адрес запроса относительно /api
   * @param {object} settings параметры запроса (silent — не уведомлять)
   */
  function handleGlobalError(error, path, settings) {
    var PVH = window.PVH;
    if (!PVH || !PVH.toast || settings.silent) return;

    // Неверный пароль при входе — тоже 401, но это ошибка формы
    var isAuthForm = path.indexOf('/auth/login') === 0 || (path === '/auth/me' && settings.method !== 'GET');

    if (error.status === 401 && !isAuthForm && SESSION_CODES.indexOf(error.code) !== -1) {
      error.notified = true;
      PVH.toast('warning', error.message, 'Сеанс завершён');
      var next = window.location.pathname + window.location.search;
      window.setTimeout(function () {
        window.location.href = '/login?next=' + encodeURIComponent(next);
      }, 1800);
      return;
    }

    var titles = {
      403: 'Недостаточно прав',
      429: 'Слишком много запросов',
    };
    if (titles[error.status]) {
      error.notified = true;
      PVH.toast('warning', error.message, titles[error.status]);
    } else if (error.status >= 500) {
      error.notified = true;
      PVH.toast('danger', 'Сервер не смог выполнить запрос. Попробуйте ещё раз через минуту.', 'Ошибка сервера');
    } else if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') {
      error.notified = true;
      PVH.toast('danger', error.message, 'Нет связи с сервером');
    }
  }

  /**
   * Выполняет запрос к API.
   *
   * @param {string} method метод HTTP
   * @param {string} path путь относительно /api
   * @param {object} [options] { body, signal, silent }
   *        silent — не показывать уведомление об ошибке (фоновые запросы)
   * @returns {Promise<object>} разобранный ответ сервера
   */
  function request(method, path, options) {
    var settings = options || {};
    settings.method = method;

    var controller = null;
    var timer = null;
    var signal = settings.signal;

    // Ограничиваем время ожидания, чтобы интерфейс не «зависал»
    if (!signal && typeof AbortController !== 'undefined') {
      controller = new AbortController();
      signal = controller.signal;

      timer = window.setTimeout(function () {
        controller.abort();
      }, TIMEOUT_MS);
    }

    var fetchOptions = {
      method: method,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: signal,
    };

    if (settings.body !== undefined) {
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(settings.body);
    }

    return window.fetch(BASE_URL + path, fetchOptions)
      .then(function (response) {
        return response.text().then(function (text) {
          var data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (parseError) {
            data = null;
          }
          return { response: response, data: data };
        });
      })
      .then(function (result) {
        if (timer) window.clearTimeout(timer);

        var response = result.response;
        var data = result.data;

        if (response.ok) return data || {};

        // Сервер вернул ошибку в едином формате { success: false, error: {...} }
        var serverError = (data && data.error) || {};

        throw new ApiError(
          serverError.message || 'Не удалось выполнить запрос. Попробуйте ещё раз.',
          {
            status: response.status,
            code: serverError.code,
            fields: serverError.details,
          },
        );
      })
      .catch(function (error) {
        if (timer) window.clearTimeout(timer);

        var apiError;
        if (error && error.name === 'ApiError') {
          apiError = error;
        } else if (error && error.name === 'AbortError') {
          apiError = new ApiError('Сервер не отвечает. Проверьте подключение к сети и повторите попытку.', {
            code: 'TIMEOUT',
          });
        } else {
          apiError = new ApiError('Не удалось связаться с сервером. Проверьте подключение к сети.', {
            code: 'NETWORK_ERROR',
          });
        }

        handleGlobalError(apiError, path, settings);
        throw apiError;
      });
  }

  /** Разбирает ответ сервера на составляющие. */
  function parseError(error) {
    return {
      message: error && error.message
        ? error.message
        : 'Произошла неизвестная ошибка. Повторите попытку.',
      code: (error && error.code) || null,
      status: (error && error.status) || null,
      fields: (error && error.fields) || null,
    };
  }

  window.PVH_API = {
    /** Регистрация пользователя. */
    register: function (payload) {
      return request('POST', '/auth/register', { body: payload });
    },

    /** Вход в систему. */
    login: function (payload) {
      return request('POST', '/auth/login', { body: payload });
    },

    /** Выход из системы. */
    logout: function () {
      return request('POST', '/auth/logout');
    },

    /** Данные текущего пользователя. */
    me: function () {
      return request('GET', '/auth/me');
    },

    /** Повторная отправка письма с подтверждением. */
    resendConfirmation: function (payload) {
      return request('POST', '/auth/resend-confirmation', { body: payload });
    },

    /** Проверка ссылки подтверждения. */
    checkConfirmation: function (token) {
      return request('GET', '/auth/confirm/check?token=' + encodeURIComponent(token));
    },

    /** Оценка надёжности пароля. */
    checkPasswordStrength: function (password, context) {
      return request('POST', '/password/strength', {
        body: { password: password, name: context && context.name, email: context && context.email },
      });
    },

    /** Список ячеек хранения. */
    cells: function (query) {
      return request('GET', '/cells' + (query ? '?' + query : ''));
    },

    /** Только свободные ячейки хранения. */
    freeCells: function () {
      return request('GET', '/cells/free');
    },

    /** Сводка по складу: всего, свободно, занято, заполненность. */
    cellsSummary: function () {
      return request('GET', '/cells/summary');
    },

    /** Сведения об одной ячейке (администратор видит заказ в ячейке). */
    cell: function (id) {
      return request('GET', '/cells/' + encodeURIComponent(id));
    },

    /**
     * Какая ячейка будет назначена заказу (ячейка не занимается).
     * @param {{mode?: string, cellId?: string|number}} [choice]
     */
    suggestCell: function (choice) {
      var params = ['mode=' + encodeURIComponent((choice && choice.mode) || 'auto')];
      if (choice && choice.cellId) params.push('cellId=' + encodeURIComponent(choice.cellId));
      return request('GET', '/cells/suggest?' + params.join('&'));
    },

    /**
     * «Мои заказы» с фильтрами (16-й день).
     * @param {string} [query] строка параметров: status, search, sort, order
     */
    myOrders: function (query, options) {
      return request('GET', '/orders/my' + (query ? '?' + query : ''), options);
    },

    /** «Все заказы» с фильтрами (только администратор). */
    allOrders: function (query, options) {
      return request('GET', '/orders' + (query ? '?' + query : ''), options);
    },

    /** Выдача заказа (только администратор, 19-й день). */
    issueOrder: function (id) {
      return request('POST', '/orders/' + encodeURIComponent(id) + '/issue');
    },

    /** Ожидаемый заказ «В пути» (только администратор, 20-й день). */
    createExpectedOrder: function (payload) {
      return request('POST', '/orders/expected', { body: payload });
    },

    /** Изменение заказа (только администратор). */
    updateOrder: function (id, payload) {
      return request('PATCH', '/orders/' + encodeURIComponent(id), { body: payload });
    },

    /** Удаление заказа (только администратор). */
    deleteOrder: function (id) {
      return request('DELETE', '/orders/' + encodeURIComponent(id));
    },

    /** Изменение имени в профиле. */
    updateProfile: function (payload) {
      return request('PATCH', '/auth/me', { body: payload });
    },

    /** Удаление своей учётной записи (с подтверждением паролем). */
    deleteAccount: function (password) {
      return request('DELETE', '/auth/me', { body: { password: password } });
    },

    /** Смена пароля. */
    changePassword: function (payload) {
      return request('POST', '/password/change', { body: payload });
    },

    /** Удаление учётной записи пользователя (только администратор). */
    deleteUser: function (id) {
      return request('DELETE', '/admin/users/' + encodeURIComponent(id));
    },

    /** Приёмка заказа в пункт выдачи (только администратор). */
    receiveOrder: function (payload) {
      return request('POST', '/orders', { body: payload });
    },

    /** Сводка по состоянию ПВЗ (только администратор). */
    adminOverview: function () {
      return request('GET', '/admin/overview');
    },

    /** Список пользователей (только администратор). */
    adminUsers: function (query) {
      return request('GET', '/admin/users' + (query ? '?' + query : ''));
    },

    /** Общий обработчик ошибок. */
    parseError: parseError,
    handleGlobalError: handleGlobalError,
    ApiError: ApiError,
  };
}());
