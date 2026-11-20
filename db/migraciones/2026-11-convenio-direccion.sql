-- =====================================================================================
-- Migración: Dirección del hotel en convenios                                    (MySQL 8.4)
--
-- Qué hace:
--   1. convenios.direccion → columna nueva (se muestra en la ficha del hotel al solicitar viáticos).
--   2. trg_convenios_au     → se recrea igual que en schema.sql, ahora registrando también los cambios
--                             de dirección en la bitácora del convenio.
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces; no borra datos.
-- Úsalo en bases que ya existen (con `npm run db:setup` no hace falta: schema.sql ya lo incluye,
-- pero db:setup BORRA todo).
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-convenio-direccion.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

-- 1. Columna (solo si falta).
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'convenios' AND COLUMN_NAME = 'direccion') = 0,
  'ALTER TABLE convenios ADD COLUMN direccion VARCHAR(300) NOT NULL DEFAULT '''' COMMENT ''Dirección del hotel (se muestra al reservar en Solicitar)'' AFTER correo',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Trigger de bitácora (copia exacta de db/schema.sql).
DROP TRIGGER IF EXISTS trg_convenios_au;
DELIMITER $$
CREATE TRIGGER trg_convenios_au AFTER UPDATE ON convenios FOR EACH ROW
BEGIN
  DECLARE v_cambios JSON DEFAULT JSON_OBJECT();
  IF OLD.activo = 1 AND NEW.activo = 0 THEN
    CALL sp_registrar_log('convenio_baja', 'convenio', NEW.id, @ckl_usuario_id,
      JSON_OBJECT('hotel', NEW.nombre_comercial, 'motivo', NEW.baja_motivo));
  ELSEIF OLD.activo = 0 AND NEW.activo = 1 THEN
    CALL sp_registrar_log('convenio_reactivacion', 'convenio', NEW.id, @ckl_usuario_id,
      JSON_OBJECT('hotel', NEW.nombre_comercial));
  ELSE
    IF NOT (OLD.anio <=> NEW.anio) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('anio', JSON_OBJECT('antes', OLD.anio, 'despues', NEW.anio)));
    END IF;
    IF NOT (OLD.tipo_sucursal <=> NEW.tipo_sucursal) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('tipo_sucursal', JSON_OBJECT('antes', OLD.tipo_sucursal, 'despues', NEW.tipo_sucursal)));
    END IF;
    IF NOT (OLD.no_sucursal <=> NEW.no_sucursal) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('no_sucursal', JSON_OBJECT('antes', OLD.no_sucursal, 'despues', NEW.no_sucursal)));
    END IF;
    IF NOT (OLD.destino <=> NEW.destino) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('destino', JSON_OBJECT('antes', OLD.destino, 'despues', NEW.destino)));
    END IF;
    IF NOT (OLD.estado <=> NEW.estado) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('estado', JSON_OBJECT('antes', OLD.estado, 'despues', NEW.estado)));
    END IF;
    IF NOT (OLD.nombre_comercial <=> NEW.nombre_comercial) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('nombre_comercial', JSON_OBJECT('antes', OLD.nombre_comercial, 'despues', NEW.nombre_comercial)));
    END IF;
    IF NOT (OLD.costo_sencilla <=> NEW.costo_sencilla) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('costo_sencilla', JSON_OBJECT('antes', OLD.costo_sencilla, 'despues', NEW.costo_sencilla)));
    END IF;
    IF NOT (OLD.costo_doble <=> NEW.costo_doble) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('costo_doble', JSON_OBJECT('antes', OLD.costo_doble, 'despues', NEW.costo_doble)));
    END IF;
    IF NOT (OLD.no_proveedor <=> NEW.no_proveedor) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('no_proveedor', JSON_OBJECT('antes', OLD.no_proveedor, 'despues', NEW.no_proveedor)));
    END IF;
    IF NOT (OLD.razon_social <=> NEW.razon_social) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('razon_social', JSON_OBJECT('antes', OLD.razon_social, 'despues', NEW.razon_social)));
    END IF;
    IF NOT (OLD.telefono <=> NEW.telefono) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('telefono', JSON_OBJECT('antes', OLD.telefono, 'despues', NEW.telefono)));
    END IF;
    IF NOT (OLD.contacto <=> NEW.contacto) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('contacto', JSON_OBJECT('antes', OLD.contacto, 'despues', NEW.contacto)));
    END IF;
    IF NOT (OLD.banco <=> NEW.banco) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('banco', JSON_OBJECT('antes', OLD.banco, 'despues', NEW.banco)));
    END IF;
    IF NOT (OLD.correo <=> NEW.correo) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('correo', JSON_OBJECT('antes', OLD.correo, 'despues', NEW.correo)));
    END IF;
    IF NOT (OLD.direccion <=> NEW.direccion) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('direccion', JSON_OBJECT('antes', OLD.direccion, 'despues', NEW.direccion)));
    END IF;
    IF NOT (OLD.notas <=> NEW.notas) THEN
      SET v_cambios = JSON_MERGE_PATCH(v_cambios, JSON_OBJECT('notas', JSON_OBJECT('antes', OLD.notas, 'despues', NEW.notas)));
    END IF;
    IF JSON_LENGTH(v_cambios) > 0 THEN
      CALL sp_registrar_log('convenio_modificacion', 'convenio', NEW.id, @ckl_usuario_id,
        JSON_OBJECT('hotel', NEW.nombre_comercial, 'cambios', v_cambios));
    END IF;
  END IF;
END$$
DELIMITER ;

-- Verificación rápida:
--   SHOW COLUMNS FROM convenios LIKE 'direccion';
