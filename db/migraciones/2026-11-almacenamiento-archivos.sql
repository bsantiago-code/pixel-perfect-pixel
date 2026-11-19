-- =====================================================================================
-- Migración: archivos de comprobantes en almacenamiento externo (Google Drive / carpeta)   (MySQL 8.4)
--
-- No cambia la estructura: facturas.ruta (VARCHAR(500) NULL) ya existía y ahora se usa para guardar la
-- referencia del archivo (`drive:<fileId>` o `local:<ruta relativa>`). Con almacenamiento externo ya no se
-- inserta fila en factura_archivos (el LONGBLOB solo se usa con STORAGE_DRIVER=db o en archivos sin migrar).
--
-- Este script solo actualiza los COMENTARIOS de las dos tablas para que todas las bases queden iguales.
-- Es IDEMPOTENTE y no toca datos.
--
-- Después de configurar el almacenamiento (.env.local) puedes mover los archivos que ya están en la BD:
--     npm run storage:migrar -- --dry-run     (solo lista)
--     npm run storage:migrar                  (sube, verifica, guarda la referencia y borra el blob)
--
-- Ejecución:
--     mysql -u root -p --default-character-set=utf8mb4 portal_viaticos < db/migraciones/2026-11-almacenamiento-archivos.sql
-- =====================================================================================

SET NAMES utf8mb4;
USE portal_viaticos;

ALTER TABLE facturas
  MODIFY COLUMN ruta VARCHAR(500) NULL
  COMMENT 'Archivo en almacenamiento externo: drive:<fileId> o local:<ruta>. NULL = el contenido está en factura_archivos';

ALTER TABLE factura_archivos
  COMMENT = 'Contenido en BD (solo con STORAGE_DRIVER=db o sin migrar); con Drive/carpeta local no hay fila aquí';
