'use strict';

/**
 * Работа с паролями пользователей: смена пароля и оценка его надёжности.
 *
 * Смена пароля выполняется в два этапа:
 *   1) проверка новой формы (обязательные поля, стойкость, отсутствие личных данных);
 *   2) проверка текущего пароля по сохранённому хешу.
 * Только после успешной проверки обоих этапов в базу данных записывается новый хеш.
 */

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { hashPassword, verifyPassword } = require('../utils/password');
const { analyzePassword, findWeaknessReason } = require('../utils/passwordStrength');
const { validate } = require('../validators/rules');
const { changePasswordSchema } = require('../validators/schemas');
const userRepository = require('../repositories/userRepository');

/**
 * Изменяет пароль пользователя.
 *
 * @param {number} userId идентификатор пользователя
 * @param {{currentPassword: string, newPassword: string, newPasswordConfirm: string}} payload
 * @returns {Promise<{user: object}>}
 * @throws {AppError} 400 — форма заполнена неверно; 401 — неверный текущий пароль;
 *                    404 — пользователь не найден
 */
async function changePassword(userId, payload) {
  const user = userRepository.findById(userId);
  if (!user) {
    throw AppError.notFound('Пользователь не найден');
  }

  // Этап 1. Проверка полей новой формы
  const data = validate(payload, changePasswordSchema);

  // Этап 1.1. Проверка, что новый пароль не содержит личных данных пользователя.
  // Имя и адрес берутся из записи пользователя, поэтому проверка выполняется
  // здесь, а не в схеме формы.
  const weakness = findWeaknessReason(data.newPassword, {
    name: user.name,
    email: user.email,
  });
  if (weakness) {
    throw AppError.badRequest(weakness.message, {
      newPassword: { code: weakness.code, message: weakness.message },
    });
  }

  // Этап 2. Проверка текущего пароля
  const currentIsValid = await verifyPassword(data.currentPassword, user.passwordHash);
  if (!currentIsValid) {
    throw new AppError('Текущий пароль указан неверно', 401, 'INVALID_CURRENT_PASSWORD');
  }

  // Формирование и сохранение нового хеша
  const newHash = await hashPassword(data.newPassword);
  const updated = userRepository.updatePasswordHash(userId, newHash);

  logger.info(`Пользователь id=${userId} (${user.email}) сменил пароль`);

  return { user: userRepository.toPublic(updated) };
}

/**
 * Оценивает надёжность пароля и возвращает подробный отчёт.
 * Используется интерфейсом для подсказки пользователю при вводе пароля.
 *
 * @param {string} password проверяемый пароль
 * @param {{name?: string, email?: string}} [user]
 * @returns {object} результат анализа (оценка, уровень, перечень проверок)
 */
function checkStrength(password, user = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw AppError.badRequest('Передайте пароль для проверки в поле password');
  }
  if (password.length > 200) {
    throw AppError.badRequest('Пароль слишком длинный для проверки (не более 200 символов)');
  }

  return analyzePassword(password, user);
}

module.exports = { changePassword, checkStrength };
