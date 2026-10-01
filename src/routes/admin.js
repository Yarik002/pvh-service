'use strict';

/**
 * Административные маршруты: /api/admin
 *
 * Все маршруты этого раздела защищены проверкой роли: middleware requireAuth()
 * убеждается, что сессия действительна, а requireRole('admin') — что
 * пользователь является администратором. Клиент, обратившийся к любому
 * маршруту раздела, получает ошибку 403 Forbidden.
 *
 * Это требование технического задания (п. 3.3): разграничение прав доступа
 * к функциям системы по ролям пользователей.
 */

const express = require('express');

const logger = require('../utils/logger');
const userRepository = require('../repositories/userRepository');
const cellRepository = require('../repositories/cellRepository');
const sessionRepository = require('../repositories/sessionRepository');
const { getDb } = require('../db/connection');
const { requireAuth, requireRole } = require('../middleware/authenticate');

const router = express.Router();

// Проверка роли применяется ко всему разделу сразу
router.use(requireAuth(), requireRole('admin'));

/**
 * GET /api/admin/overview
 * Сводка по состоянию пункта выдачи: пользователи, ячейки, заказы, сессии.
 * Используется главной страницей администратора.
 */
router.get('/overview', (req, res, next) => {
  try {
    const db = getDb();

    const users = {
      total: userRepository.count(),
      confirmed: db.prepare('SELECT COUNT(*) AS n FROM Users WHERE is_confirmed = 1').get().n,
      unconfirmed: db.prepare('SELECT COUNT(*) AS n FROM Users WHERE is_confirmed = 0').get().n,
      admins: db.prepare("SELECT COUNT(*) AS n FROM Users WHERE role = 'admin'").get().n,
      clients: db.prepare("SELECT COUNT(*) AS n FROM Users WHERE role = 'client'").get().n,
    };

    const cells = {
      total: cellRepository.count(),
      free: cellRepository.countByStatus('Свободна'),
      busy: cellRepository.countByStatus('Занята'),
    };

    const orders = {
      total: db.prepare('SELECT COUNT(*) AS n FROM Orders').get().n,
      inTransit: db.prepare("SELECT COUNT(*) AS n FROM Orders WHERE status = 'В пути'").get().n,
      readyForPickup: db.prepare("SELECT COUNT(*) AS n FROM Orders WHERE status = 'Готов к выдаче'").get().n,
      issued: db.prepare("SELECT COUNT(*) AS n FROM Orders WHERE status = 'Выдан'").get().n,
    };

    res.status(200).json({
      success: true,
      overview: {
        users,
        cells,
        orders,
        sessions: { active: sessionRepository.count() },
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/users
 * Список пользователей системы. Доступен только администратору.
 *
 * Параметры запроса:
 *   role        — фильтр по роли: client или admin;
 *   confirmed   — «true» или «false» — фильтр по подтверждению адреса.
 *
 * Хеш пароля и токен подтверждения в ответ не попадают.
 */
router.get('/users', (req, res, next) => {
  try {
    const conditions = [];
    const params = {};

    if (req.query.role) {
      const role = String(req.query.role).toLowerCase();
      if (!['client', 'admin'].includes(role)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'Недопустимое значение фильтра роли. Допустимые значения: client, admin.',
          },
        });
      }
      conditions.push('role = @role');
      params.role = role;
    }

    if (req.query.confirmed !== undefined && req.query.confirmed !== '') {
      const confirmed = String(req.query.confirmed).toLowerCase() === 'true';
      conditions.push('is_confirmed = @confirmed');
      params.confirmed = confirmed ? 1 : 0;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const users = getDb()
      .prepare(
        `SELECT id, name, email, role, is_confirmed
           FROM Users
           ${where}
          ORDER BY id`,
      )
      .all(params)
      .map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        isConfirmed: row.is_confirmed === 1,
      }));

    return res.status(200).json({ success: true, users, total: users.length });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/admin/sessions
 * Список активных сессий пользователей (диагностика).
 * Токены и их хеши в ответ не попадают.
 */
router.get('/sessions', (req, res, next) => {
  try {
    const sessions = getDb()
      .prepare(
        `SELECT s.id, s.user_id, u.email, u.role,
                s.created_at, s.expires_at, s.last_used_at, s.ip_address
           FROM Sessions s
           JOIN Users u ON u.id = s.user_id
          WHERE s.expires_at > datetime('now')
          ORDER BY s.created_at DESC`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        email: row.email,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        ipAddress: row.ip_address,
      }));

    res.status(200).json({ success: true, sessions, total: sessions.length });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/sessions/:id
 * Принудительное завершение сессии пользователя администратором.
 * Применяется при подозрении на компрометацию учётной записи.
 */
router.delete('/sessions/:id', (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const removed = sessionRepository.remove(id);

    if (!removed) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Сессия с идентификатором ${id} не найдена` },
      });
    }

    logger.info(`Администратор id=${req.user.id} завершил сессию id=${id}`);

    return res.status(200).json({
      success: true,
      message: 'Сессия завершена.',
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
