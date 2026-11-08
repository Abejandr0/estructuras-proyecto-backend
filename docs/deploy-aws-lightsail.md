# Desplegar AIVerse en AWS Lightsail con MongoDB Atlas

Esta guía usa una instancia Linux de Lightsail para servir la app con Docker Compose y Caddy, y Atlas para cuentas, sesiones, repositorios y pull requests. Los objetos de los repositorios MiniGit se guardan en un volumen persistente de la instancia (`/srv/aiverse`), por lo que hay que respaldar ese volumen además de la base de datos.

## 1. Preparar MongoDB Atlas

1. En Atlas, crea o elige un proyecto y un clúster Free si todavía no tienes uno.
2. En **Database Access**, crea un usuario de base de datos dedicado para AIVerse. Dale permisos de lectura y escritura únicamente sobre la base `aiverse`; no uses las credenciales de tu cuenta de Atlas.
3. En **Network Access**, permite la IP pública estática de Lightsail. Añade también la IP desde la que desarrollarás localmente solo si vas a conectarte desde tu equipo.
4. En **Database > Clusters > Connect > Drivers**, elige Node.js y copia la URI `mongodb+srv://...`. Sustituye el marcador de contraseña por la contraseña del usuario de base de datos. Codifica los caracteres reservados de la contraseña para una URI (por ejemplo, `@` como `%40`).
5. Usa el nombre `aiverse` en la ruta de la URI. Mantén la URI en el `.env` del servidor y nunca la guardes en Git, en el frontend ni en Vercel.

Atlas exige una IP en la lista de acceso y un usuario de base de datos para conectar una app. Evita `0.0.0.0/0`; permite solo la IP estática de Lightsail.

## 2. Crear la instancia de Lightsail

1. En AWS Console abre **Lightsail** y crea una instancia Linux/Unix en una región cercana a tus usuarios y compatible con la región de Atlas.
2. Para empezar, el plan Linux de 2 GB de RAM suele dar más margen a Node, Nginx y Caddy que el de 1 GB. Revisa el precio mostrado para tu región antes de crearla. Los planes se cobran por hora hasta el tope mensual; los créditos solo aplican si sus condiciones incluyen Lightsail y no han vencido.
3. Crea una clave SSH y guarda la clave privada localmente.
4. En **Networking**, asigna una IP estática a la instancia.
5. En el firewall de Lightsail permite TCP `22` solo desde tu IP si es posible, y TCP `80` y `443` desde Internet. No abras `27017`, `4179` ni `5173`.

## 3. Apuntar un dominio

Necesitas un dominio para HTTPS automático. En el DNS del dominio crea un registro `A` para `aiverse.tudominio.com` que apunte a la IP estática. Espera a que el cambio de DNS se propague. Caddy obtendrá y renovará el certificado cuando el dominio resuelva a la instancia y los puertos `80` y `443` estén abiertos.

## 4. Instalar Docker y preparar el código

Conéctate por SSH a la instancia. Instala Docker Engine y el plugin Docker Compose desde la guía oficial de Docker para la distribución elegida. Luego:

```bash
git clone <URL-del-repositorio> aiverse
cd aiverse
cp .env.aws.example .env
nano .env
```

En `.env`, cambia `AIVERSE_DOMAIN` por el dominio real y pega la URI de Atlas en `MONGODB_URI`. No compartas ese archivo ni lo subas al repositorio. Si la contraseña contiene caracteres especiales, usa su versión codificada en la URI.

## 5. Permitir la instancia en Atlas y arrancar

Si aún no lo hiciste, añade en Atlas la IP estática de Lightsail a **Network Access**. Arranca la app desde la carpeta del proyecto:

```bash
docker compose -f docker-compose.aws.yml up -d --build
docker compose -f docker-compose.aws.yml ps
docker compose -f docker-compose.aws.yml logs -f backend caddy
```

Abre `https://aiverse.tudominio.com`. La API y los WebSockets pasan por el mismo dominio; el backend y la URI de Atlas no se publican directamente.

## 6. Verificar y mantener

- Comprueba `https://aiverse.tudominio.com/api/health/ready`: debe responder `{"ok":true,"database":"connected"}`.
- Crea una cuenta de prueba, inicia sesión y crea un repositorio para confirmar las escrituras en Atlas y en el volumen MiniGit.
- Actualiza el código con `git pull` y reconstruye con `docker compose -f docker-compose.aws.yml up -d --build`.
- Configura snapshots de Lightsail o una copia externa periódica de `/srv/aiverse`; la base de datos de Atlas no respalda automáticamente esos objetos MiniGit.
- Revisa **Billing > Credits** en AWS para verificar saldo, vencimiento y servicios admitidos. Un dominio, transferencia por encima del límite o snapshots pueden tener coste separado.

## URI que debes copiar

En Atlas: **Database > Clusters > Connect > Drivers > Node.js**. El formato esperado es:

```text
mongodb+srv://<usuario-bd>:<contraseña-codificada>@<cluster-host>/aiverse?retryWrites=true&w=majority
```

La URI contiene una credencial. Guárdala directamente en `.env` en Lightsail; no la publiques en el chat, en Git ni en variables `VITE_*` del frontend.
