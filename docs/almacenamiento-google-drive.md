# Archivos de comprobantes en Google Drive

El portal ya está listo para guardar los XML/PDF/fotos de las facturas en Google Drive. Mientras no se configure,
sigue guardándolos en la base de datos (`STORAGE_DRIVER=db`), así que **nada se rompe** por no tener las llaves.

## Qué hay que pedirle a Infraestructura

1. **Habilitar la API de Google Drive** en el proyecto de Google Cloud que se use.
2. Una **cuenta de servicio** y su **llave JSON** (contiene `client_email` y `private_key`).
3. Una **carpeta raíz** en Drive (puede ser una unidad compartida) y su **ID**
   (en la URL: `https://drive.google.com/drive/folders/<ID>`).
4. **Compartir esa carpeta con el correo de la cuenta de servicio** (`client_email`) como **Editor**.
5. Opcional: si en lugar de compartir la carpeta usan *delegación de dominio*, el correo del usuario a suplantar.

> Si Infraestructura entrega otro tipo de credencial (por ejemplo un cliente OAuth con token de actualización),
> solo cambia la función de autenticación en `server/storage/drive.ts` (`crearClienteDrive`); el resto no cambia.

## Qué se configura (solo `.env.local`, nunca en git)

```
STORAGE_DRIVER=drive
GDRIVE_CREDENTIALS_FILE=C:\ruta\segura\cuenta-servicio.json   # o bien GDRIVE_CREDENTIALS_JSON={"type":"service_account",...} en una línea
GDRIVE_ROOT_FOLDER_ID=<ID de la carpeta raíz>
# GDRIVE_IMPERSONATE=usuario@cklass.net                       # solo con delegación de dominio
```

Reinicia la API. Si falta algo, se niega a arrancar y dice qué falta. Después, en **Configuración → Almacenamiento de
facturas**, pulsa **Probar almacenamiento**: escribe, lee y manda a la papelera un archivo de prueba en la carpeta
raíz (`_prueba/`). Si funciona, ya quedó.

## Cómo se guardan los archivos

```
<carpeta raíz>/<Sociedad>/<Año>/<Folio sin #>/<archivo original>
ej.  WATA GROUP/2026/0036/factura-hotel.xml
```

- Las carpetas se crean solas. Los archivos son **privados**: el portal los entrega solo a los usuarios con acceso a la
  solicitud (mismo control de siempre); no se generan enlaces públicos.
- En la BD, `facturas.ruta` guarda la referencia (`drive:<fileId>`) y **no** se guarda copia del contenido.
- Al eliminar un comprobante en el portal, los archivos van a la **papelera de Drive** (recuperables), no se borran
  definitivamente.
- Si Drive falla al subir, el comprobante **no se guarda** y el usuario ve el error; si la base falla después de subir, los
  archivos subidos se mandan a la papelera.

## Mover lo que ya está en la base de datos

Cuando el almacenamiento esté configurado:

```
npm run storage:migrar -- --dry-run   # solo lista lo que movería
npm run storage:migrar                # sube, verifica que sea idéntico, guarda la ruta y borra el blob
npm run storage:migrar -- --conservar # igual, pero deja el blob en la BD
```

Es repetible: solo procesa las facturas que aún no tienen `ruta`.

## Alternativa sin API: carpeta sincronizada

Si Infraestructura prefiere montar Drive en el servidor (Google Drive para escritorio) o usar una ruta de red:

```
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=G:\Mi unidad\Viaticos
```

Misma estructura de carpetas; al eliminar, los archivos se mueven a `_papelera/` dentro de esa carpeta.
