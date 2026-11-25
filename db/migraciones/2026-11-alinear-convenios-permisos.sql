-- =====================================================================================
-- Migración: alinear una base existente con db/schema.sql                       (MySQL 8.x)
--
-- Qué hace:
--   1. convenios.direccion   → columna que faltaba (la pantalla de Convenios y Solicitar la usan).
--   2. Triggers de convenios → trg_convenios_ai / trg_convenios_au con la bitácora completa (hotel, dirección…).
--   3. roles                 → permiso compensar_viaje para finanzas y compras_corporativas (sin él, "Compensar
--                              viaje" responde 403). No pisa un valor que el administrador ya haya fijado.
--   4. configuracion         → listas de palabras prohibidas (alcohol, tabaco, higiene) sembradas con los valores
--                              por omisión; si la clave ya existe no se toca.
--
-- Es IDEMPOTENTE y no borra datos. Complementa a 2026-11-xml-duplicado.sql (uuid_xml + índice único).
--
-- Ejecución (respalda antes: mysqldump portal_viaticos > respaldo.sql):
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-alinear-convenios-permisos.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

-- 1. convenios.direccion (solo si falta).
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'convenios' AND COLUMN_NAME = 'direccion') = 0,
  'ALTER TABLE convenios ADD COLUMN direccion VARCHAR(300) NOT NULL DEFAULT '''' COMMENT ''Dirección del hotel (se muestra al reservar en Solicitar)'' AFTER correo',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Permiso compensar_viaje (solo si la clave no existe en el rol).
UPDATE roles
   SET permisos = JSON_SET(permisos, '$.compensar_viaje', true)
 WHERE nombre IN ('finanzas', 'compras_corporativas')
   AND JSON_EXTRACT(permisos, '$.compensar_viaje') IS NULL;

-- 4. Listas de palabras prohibidas (valores por omisión).
INSERT IGNORE INTO configuracion (clave, valor) VALUES
  ('palabras_prohibidas_alcohol', '["cerveza","vino","tequila","mezcal","whisky","whiskey","ron","vodka","ginebra","brandy","coñac","cognac","licor","sidra","champagne","champaña","aguardiente","bacardi","destilado"]'),
  ('palabras_prohibidas_tabaco', '["cigarro","cigarrillo","cigarrillos","vape","vapeador","tabaco","puro","nicotina","habano"]'),
  ('palabras_prohibidas_higiene', '["shampoo","champu","pasta dental","desodorante","maquillaje","cepillo dental","enjuague bucal","rastrillo","crema corporal","toalla sanitaria","tampon","perfume","rimel","labial"]');

-- 2. Triggers de convenios (mismas definiciones que db/schema.sql).
DELIMITER $$

DROP TRIGGER IF EXISTS trg_convenios_ai$$
CREATE TRIGGER trg_convenios_ai AFTER INSERT ON convenios FOR EACH ROW
BEGIN
  CALL sp_registrar_log('convenio_alta', 'convenio', NEW.id, @ckl_usuario_id,
    JSON_OBJECT('hotel', NEW.nombre_comercial, 'destino', NEW.destino, 'anio', NEW.anio,
                'costo_sencilla', NEW.costo_sencilla, 'costo_doble', NEW.costo_doble));
END$$

DROP TRIGGER IF EXISTS trg_convenios_au$$
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
