'use strict';

/**
 * Прикладная ошибка с HTTP-статусом.
 *
 * Позволяет в любом месте кода «выбросить» ошибку с нужным кодом ответа,
 * а централизованный обработчик (src/middleware/errorHandler.js) сам
 * сформирует корректный JSON-ответ клиенту.
 */
class AppError extends Error {
  /**
   * @param {string} message  сообщение для клиента (на русском языке)
   * @param {number} status   HTTP-статус ответа
   * @param {string} [code]   машиночитаемый код ошибки для клиентской части
   * @param {object} [details] дополнительные сведения (например, ошибки полей)
   */
  constructor(message, status = 500, code = 'INTERNAL_ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, AppError);
  }

  /** 400 — некорректные данные запроса */
  static badRequest(message, details) {
    return new AppError(message, 400, 'BAD_REQUEST', details);
  }

  /** 401 — пользователь не авторизован (будет использоваться с 7-го дня) */
  static unauthorized(message = 'Требуется авторизация') {
    return new AppError(message, 401, 'UNAUTHORIZED');
  }

  /** 403 — недостаточно прав (будет использоваться с 8-го дня) */
  static forbidden(message = 'Недостаточно прав для выполнения операции') {
    return new AppError(message, 403, 'FORBIDDEN');
  }

  /** 404 — объект не найден */
  static notFound(message = 'Запрашиваемый ресурс не найден') {
    return new AppError(message, 404, 'NOT_FOUND');
  }

  /** 409 — конфликт данных (например, повтор Email или занятая ячейка) */
  static conflict(message, details) {
    return new AppError(message, 409, 'CONFLICT', details);
  }

  /** 429 — превышена частота запросов */
  static tooManyRequests(message = 'Слишком много запросов') {
    return new AppError(message, 429, 'TOO_MANY_REQUESTS');
  }

  /** 503 — сервис временно недоступен */
  static unavailable(message = 'Сервис временно недоступен') {
    return new AppError(message, 503, 'SERVICE_UNAVAILABLE');
  }
}

module.exports = AppError;
