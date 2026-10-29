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
    return error;
  }

  /**
   * Выполняет запрос к API.
   *
   * @param {string} method метод HTTP
   * @param {string} path путь относительно /api
   * @param {object} [options] { body, signal }
   * @returns {Promise<object>} разобранный ответ сервера
   */
  function request(method, path, options) {
    var settings = options || {};

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

        if (error && error.name === 'ApiError') throw error;

        if (error && error.name === 'AbortError') {
          throw new ApiError('Сервер не отвечает. Проверьте подключение к сети и повторите попытку.', {
            code: 'TIMEOUT',
          });
        }

        throw new ApiError('Не удалось связаться с сервером. Проверьте подключение к сети.', {
          code: 'NETWORK_ERROR',
        });
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
    ApiError: ApiError,
  };
}());
