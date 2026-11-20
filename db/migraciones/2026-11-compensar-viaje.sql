-- =====================================================================================
-- Migración: Compensar viaje (Finanzas / Compras)                                (MySQL 8.4)
--
-- Qué hace:
--   1. compensaciones → tabla nueva: cierre del viaje con la decisión sobre el gasto excedente
--                        (reembolsar / no reembolsar / sin excedente), montos y comentario.
--   2. roles.permisos → agrega "compensar_viaje": true a finanzas, compras_corporativas y a los roles cuyo
--                        nombre empieza con "compras", solo si aún no tienen la clave (no pisa lo que el
--                        administrador ya haya definido en Permisos).
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces; no borra datos.
-- Úsalo en bases que ya existen (con `npm run db:setup` no hace falta: schema.sql ya lo incluye,
-- pero db:setup BORRA todo).
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-compensar-viaje.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

-- 1. Tabla de compensaciones.
CREATE TABLE IF NOT EXISTS compensaciones (
  id               VARCHAR(40)   NOT NULL,
  solicitud_id     VARCHAR(40)   NOT NULL,
  decision         ENUM('reembolsar','no_reembolsar','sin_excedente') NOT NULL,
  monto_solicitado DECIMAL(12,2) NOT NULL COMMENT 'Fotografía al compensar',
  monto_comprobado DECIMAL(12,2) NOT NULL COMMENT 'Lo aplicado a los renglones (tope = solicitado)',
  monto_excedente  DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Facturado por encima de lo solicitado',
  monto_reembolso  DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'Lo que se le reembolsa al viajero (≤ excedente)',
  comentario       TEXT          NULL,
  compensado_por   VARCHAR(40)   NOT NULL,
  compensado_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_compensacion_solicitud (solicitud_id),
  CONSTRAINT fk_comp_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 2. Permiso nuevo (solo donde falta la clave).
UPDATE roles
   SET permisos = JSON_SET(permisos, '$.compensar_viaje', CAST('true' AS JSON))
 WHERE (nombre IN ('finanzas', 'compras_corporativas') OR nombre LIKE 'compras%')
   AND JSON_EXTRACT(permisos, '$.compensar_viaje') IS NULL;

-- Verificación rápida:
--   DESCRIBE compensaciones;
--   SELECT nombre, JSON_EXTRACT(permisos, '$.compensar_viaje') AS compensar_viaje FROM roles;
