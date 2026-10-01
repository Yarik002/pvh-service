-- =====================================================================
--  База данных веб-приложения «Сервис трекинга заказов и инвентаря для ПВЗ»
--  СУБД: SQLite 3
--  Таблицы: Users, Storage_Cells, Orders
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- 1. Пользователи
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 100),
    email          TEXT    NOT NULL UNIQUE COLLATE NOCASE
                           CHECK (email LIKE '_%@_%._%'),
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL DEFAULT 'client'
                           CHECK (role IN ('client', 'admin')),
    is_confirmed   INTEGER NOT NULL DEFAULT 0
                           CHECK (is_confirmed IN (0, 1)),
    confirm_token  TEXT    UNIQUE            -- токен из письма-подтверждения
);

-- ---------------------------------------------------------------------
-- 2. Ячейки хранения
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Storage_Cells (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cell_number  INTEGER NOT NULL UNIQUE CHECK (cell_number > 0),
    status       TEXT    NOT NULL DEFAULT 'Свободна'
                         CHECK (status IN ('Свободна', 'Занята'))
);

-- ---------------------------------------------------------------------
-- 3. Заказы
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    track_number  TEXT    NOT NULL UNIQUE,
    description   TEXT,
    user_id       INTEGER NOT NULL,
    cell_id       INTEGER,                   -- NULL, пока ячейка не назначена
    status        TEXT    NOT NULL DEFAULT 'В пути'
                          CHECK (status IN ('В пути', 'Готов к выдаче', 'Выдан')),
    received_at   TEXT,                      -- дата поступления (YYYY-MM-DD HH:MM:SS)
    issued_at     TEXT,                      -- дата выдачи      (YYYY-MM-DD HH:MM:SS)

    FOREIGN KEY (user_id) REFERENCES Users (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (cell_id) REFERENCES Storage_Cells (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    -- дата выдачи заполнена тогда и только тогда, когда заказ выдан
    CHECK ((status = 'Выдан') = (issued_at IS NOT NULL)),
    -- заказ, лежащий в ячейке, обязан иметь ячейку и дату поступления
    CHECK (status <> 'Готов к выдаче' OR (cell_id IS NOT NULL AND received_at IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- Индексы
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_user_id     ON Orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_cell_id     ON Orders (cell_id);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON Orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_received_at ON Orders (received_at);

-- Одна ячейка одновременно обслуживает только один активный заказ
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_active_cell
    ON Orders (cell_id) WHERE status = 'Готов к выдаче';

-- ---------------------------------------------------------------------
-- Триггер: при удалении невыданного заказа (в т.ч. каскадно, при удалении
-- пользователя) ячейка освобождается
-- ---------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_orders_free_cell_on_delete
AFTER DELETE ON Orders
WHEN OLD.status = 'Готов к выдаче' AND OLD.cell_id IS NOT NULL
BEGIN
    UPDATE Storage_Cells SET status = 'Свободна' WHERE id = OLD.cell_id;
END;

-- ---------------------------------------------------------------------
-- Начальные данные: 20 ячеек хранения
-- ---------------------------------------------------------------------
WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20)
INSERT OR IGNORE INTO Storage_Cells (cell_number) SELECT x FROM n;
