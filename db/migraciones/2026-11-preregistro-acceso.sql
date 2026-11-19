-- =====================================================================================
-- Migración: Pre-Registro con acceso inmediato y estado "No Autorizado para Viajar"   (MySQL 8.4)
--
-- Qué hace:
--   1. usuarios.autorizado_viajar → 0 = "No Autorizado para Viajar": la cuenta entra al portal pero no puede
--      crear solicitudes hasta que su jefe inmediato la habilite. Las cuentas existentes quedan en 1 (autorizadas).
--   2. prealtas.usuario_id        → cuenta que se creó con el pre-registro.
--   3. roles.permisos             → permiso 'gestionar_preregistros' (Finanzas y Administrador): ver la lista de
--      pre-registros con datos bancarios, asignar jefe inmediato y recibir el aviso por correo del alta.
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces; no borra datos ni pisa permisos ya definidos.
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-preregistro-acceso.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

-- 1. usuarios.autorizado_viajar (MySQL no soporta ADD COLUMN IF NOT EXISTS)
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'autorizado_viajar') = 0,
  'ALTER TABLE usuarios ADD COLUMN autorizado_viajar TINYINT(1) NOT NULL DEFAULT 1 COMMENT ''0 = "No Autorizado para Viajar" (pre-registro): no puede crear solicitudes hasta que su jefe inmediato lo habilite'' AFTER activo',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. prealtas.usuario_id
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prealtas' AND COLUMN_NAME = 'usuario_id') = 0,
  'ALTER TABLE prealtas ADD COLUMN usuario_id VARCHAR(40) NULL COMMENT ''Cuenta creada con este pre-registro'' AFTER status',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE prealtas
  MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pendiente' COMMENT 'acceso_otorgado: la cuenta se crea al pre-registrarse';

-- 3. Permiso nuevo para Finanzas y Administrador (solo si aún no está definido)
UPDATE roles
   SET permisos = JSON_SET(permisos, '$.gestionar_preregistros', TRUE)
 WHERE nombre IN ('finanzas', 'administrador')
   AND JSON_EXTRACT(permisos, '$.gestionar_preregistros') IS NULL;

-- Verificación rápida:
--   DESCRIBE usuarios;  DESCRIBE prealtas;
--   SELECT nombre, JSON_EXTRACT(permisos, '$.gestionar_preregistros') FROM roles;
