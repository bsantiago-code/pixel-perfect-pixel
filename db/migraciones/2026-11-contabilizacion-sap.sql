-- =====================================================================================
-- Migración: Contabilización a SAP al compensar el viaje             (MySQL 8.4)
--
-- Qué hace:
--   1. factura_desglose  → desglose contable del XML (conceptos, IVA por tasa, retenciones, moneda), guardado al
--                          subir la factura. Las facturas anteriores se rellenan solas al contabilizar.
--   2. contabilizaciones → una por folio: estado del envío a SAP (enviando | enviado | error | cancelada), asiento
--                          enviado, respuesta, documento SAP e intentos. Su índice único evita doble contabilización.
--   3. configuracion     → sap_contabilizacion_activa (interruptor, apagado), sap_modo (simulado | real) y
--                          sap_cuentas (cuentas contables por concepto, IVA, retenciones y contrapartida).
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces; no borra datos ni pisa la configuración ya guardada.
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-contabilizacion-sap.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

CREATE TABLE IF NOT EXISTS factura_desglose (
  factura_id   VARCHAR(40)   NOT NULL COMMENT 'Fila XML de facturas',
  moneda       VARCHAR(3)    NOT NULL DEFAULT 'MXN',
  tipo_cambio  DECIMAL(12,6) NULL,
  subtotal     DECIMAL(14,2) NOT NULL DEFAULT 0,
  descuento    DECIMAL(14,2) NOT NULL DEFAULT 0,
  total        DECIMAL(14,2) NOT NULL DEFAULT 0,
  detalle      JSON          NOT NULL COMMENT 'Conceptos con sus traslados y retenciones, y los impuestos del comprobante',
  created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (factura_id),
  CONSTRAINT fk_fdes_factura FOREIGN KEY (factura_id) REFERENCES facturas (id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Desglose contable del CFDI (insumo del asiento a SAP)';

CREATE TABLE IF NOT EXISTS contabilizaciones (
  id             VARCHAR(40)  NOT NULL,
  solicitud_id   VARCHAR(10)  NOT NULL COMMENT 'Folio de la solicitud (solicitudes.folio)',
  referencia     VARCHAR(40)  NOT NULL COMMENT 'Folio como texto, sin "#": llave de idempotencia en SAP',
  estado         ENUM('enviando','enviado','error','cancelada') NOT NULL DEFAULT 'enviando',
  modo           VARCHAR(10)  NOT NULL DEFAULT 'simulado' COMMENT 'simulado | real',
  payload        JSON         NOT NULL COMMENT 'Asiento enviado a SAP',
  respuesta      JSON         NULL,
  documento_sap  VARCHAR(60)  NULL COMMENT 'Número de documento contable que devolvió SAP',
  error          TEXT         NULL,
  intentos       INT          NOT NULL DEFAULT 0,
  creado_por     VARCHAR(40)  NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  enviado_at     DATETIME(3)  NULL,
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contab_solicitud (solicitud_id),
  CONSTRAINT fk_contab_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_contab_usuario   FOREIGN KEY (creado_por)   REFERENCES usuarios (id)    ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Envío a SAP del asiento de un viaje al compensarlo';


-- Si la tabla se creó con una versión anterior de esta migración (solicitud_id = id interno), se convierte al folio.
SET @viejo := (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contabilizaciones' AND COLUMN_NAME = 'solicitud_id' AND CHARACTER_MAXIMUM_LENGTH > 10);
SET @sql := IF(@viejo > 0, 'ALTER TABLE contabilizaciones DROP FOREIGN KEY fk_contab_solicitud', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SET @sql := IF(@viejo > 0, 'UPDATE contabilizaciones t JOIN solicitudes s ON s.id = t.solicitud_id SET t.solicitud_id = s.folio', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SET @sql := IF(@viejo > 0, 'ALTER TABLE contabilizaciones MODIFY COLUMN solicitud_id VARCHAR(10) NOT NULL COMMENT ''Folio de la solicitud (solicitudes.folio)''', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SET @sql := IF(@viejo > 0, 'ALTER TABLE contabilizaciones ADD CONSTRAINT fk_contab_solicitud FOREIGN KEY (solicitud_id) REFERENCES solicitudes (folio) ON DELETE CASCADE ON UPDATE CASCADE', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

INSERT INTO configuracion (clave, valor) VALUES
  ('sap_contabilizacion_activa', 'false'),
  ('sap_modo', '"simulado"'),
  ('sap_cuentas', '{}')
ON DUPLICATE KEY UPDATE clave = clave;

-- Verificación rápida:
--   SHOW CREATE TABLE contabilizaciones;
--   SELECT clave, valor FROM configuracion WHERE clave LIKE 'sap_%';
