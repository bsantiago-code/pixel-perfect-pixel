-- =====================================================================================
-- Migración: comprobantes_gasto.seq (orden de captura de los renglones)   (MySQL 8.x)
--
-- Qué hace:
--   Agrega la columna `seq` (BIGINT AUTO_INCREMENT, única) que schema.sql ya define y que el API usa
--   en ORDER BY (GET /api/comprobantes). En bases creadas con un schema.sql anterior falta y ese
--   listado falla con "Unknown column 'c.seq'". Los renglones existentes reciben seq automáticamente.
--
-- Es IDEMPOTENTE: si la columna ya existe, no hace nada. No borra datos.
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-comprobantes-seq.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comprobantes_gasto' AND COLUMN_NAME = 'seq');
SET @sql := IF(@existe = 0,
  "ALTER TABLE comprobantes_gasto ADD COLUMN seq BIGINT NOT NULL AUTO_INCREMENT COMMENT 'Orden de captura de los renglones' AFTER id, ADD UNIQUE KEY uq_cg_seq (seq)",
  'DO 0');
PREPARE st FROM @sql;
EXECUTE st;
DEALLOCATE PREPARE st;
