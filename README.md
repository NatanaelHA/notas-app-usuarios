# Notas App — Servicio de usuarios

Backend serverless responsable de la gestión de usuarios invitados de **Notas App**. Crea cuentas temporales en Amazon Cognito, elimina invitados vencidos y publica eventos para que otros servicios limpien los datos asociados.

Este repositorio forma parte de una arquitectura separada por servicios:

- [`notas-app-frontend`](https://github.com/NatanaelHA/notas-app-frontend): interfaz web.
- [`notas-app-backend`](https://github.com/NatanaelHA/notas-app-backend): notas, DynamoDB y S3.
- [`notas-app-usuarios`](https://github.com/NatanaelHA/notas-app-usuarios): usuarios invitados y Cognito (este repositorio).
- [`notas-app-notifications`](https://github.com/NatanaelHA/notas-app-notifications): notificaciones por correo.

## Responsabilidades

Este servicio es responsable de:

- Crear cuentas temporales de invitado en Cognito.
- Entregar credenciales temporales al frontend mediante un endpoint público.
- Marcar los invitados con el atributo `custom:esInvitado`.
- Mantener un máximo de 50 invitados simultáneos.
- Detectar cuentas invitadas creadas hace más de 24 horas.
- Eliminar invitados vencidos mediante una ejecución programada.
- Publicar el evento `InvitadoEliminado` antes de borrar una cuenta de Cognito.
- Paginar el listado de usuarios para revisar todas las páginas devueltas por Cognito.

Este servicio **no** almacena ni elimina notas directamente. La limpieza de notas pertenece a `notas-app-backend` y se solicita mediante EventBridge.

## Arquitectura

### Creación de un invitado

```text
Frontend
    ↓ POST /invitado
API Gateway
    ↓
crearInvitado
    ↓
Amazon Cognito
    ↓
Email y contraseña temporal
    ↓
Frontend
```

`crearInvitado` es la única Lambda de este servicio expuesta como endpoint HTTP.

Antes de crear una cuenta, la función cuenta los invitados existentes. Si ya existen 50, publica `InvitadoEliminado` para el más antiguo, lo elimina de Cognito y después crea el invitado nuevo.

### Limpieza automática de invitados

```text
Programación de EventBridge Scheduler (cada hora)
    ↓
limpiarInvitados
    ↓
lista todas las páginas de Cognito
    ↓
selecciona invitados con más de 24 horas
    ↓
publica InvitadoEliminado
    ↓
elimina el usuario de Cognito
```

La frecuencia de una hora está configurada en AWS. El criterio de 24 horas está definido en el código de `limpiarInvitados`.

Un invitado no necesariamente desaparece al cumplir exactamente 24 horas: se elimina durante la primera ejecución horaria que lo encuentre vencido. En la práctica, su duración aproximada es de 24 a 25 horas.

### Limpieza de notas asociadas

```text
notas-app-usuarios
    ↓ publica InvitadoEliminado
EventBridge (regla invitadoEliminadoARegistroNotas)
    ↓
eliminarNotasInvitado, en notas-app-backend
    ↓ consulta las notas activas en DynamoDB
    ├─ si existen, publica resumen_invitado en SQS (notas-emails)
    │      ↓
    │  mailer, en notas-app-notifications
    │      ↓
    │  SES envía el resumen al correo de auditoría
    │
    └─ después elimina todas las notas del invitado
```

La programación y `InvitadoEliminado` cumplen funciones diferentes:

- EventBridge Scheduler funciona como reloj y ejecuta `limpiarInvitados` cada hora.
- `InvitadoEliminado` es un evento de dominio publicado una vez por cada invitado que debe eliminarse.

El servicio de notas publica en `notas-emails` un mensaje de tipo `resumen_invitado` antes de borrar las notas. El servicio de notificaciones lo consume y envía por SES un correo de auditoría con las notas activas que conservaba el invitado.

## Orden de eliminación y manejo de fallos

El servicio publica el evento antes de eliminar al usuario de Cognito:

```text
Publicar InvitadoEliminado
    ↓ publicación aceptada
Eliminar usuario de Cognito
```

Este orden evita perder la solicitud de limpieza:

- Si EventBridge rechaza el evento, el invitado permanece en Cognito y puede volver a intentarse.
- Si EventBridge acepta el evento pero Cognito falla, las notas pueden eliminarse y el usuario permanece para un nuevo intento.
- Si el evento se publica nuevamente, el consumidor puede volver a eliminar las notas sin causar daño.

`eventBridgeService` verifica `FailedEntryCount`. Si AWS informa una entrada fallida, lanza un error e impide que el flujo continúe hacia la eliminación en Cognito.

La regla de EventBridge `invitadoEliminadoARegistroNotas` tiene configurada la cola SQS `eventos-invitados-fallidos` como DLQ. Si `eliminarNotasInvitado` agota todos los reintentos sin éxito, EventBridge deposita allí el evento original, incluido el `userId`, para que el fallo pueda revisarse y recuperarse manualmente. Esta redirección se configura en AWS sobre el destino de la regla y no desde el código de este servicio.

Cuando el fallo ocurre dentro de `limpiarInvitados`, se registra el `username` afectado y el resumen final informa cuántos invitados se eliminaron y cuántos fallaron. Los usuarios fallidos permanecen disponibles para la siguiente ejecución horaria.

## Servicios AWS utilizados

| Servicio | Uso dentro de este backend |
|---|---|
| AWS Lambda | Ejecuta `crearInvitado` y `limpiarInvitados`. |
| API Gateway | Expone públicamente el endpoint para crear invitados. |
| Amazon Cognito | Almacena y administra las cuentas de usuario. |
| Amazon EventBridge Scheduler | Ejecuta `limpiarInvitados` cada hora. |
| Amazon EventBridge | Transporta `InvitadoEliminado` mediante el Event Bus y su regla. |
| Amazon SQS | Conserva en `eventos-invitados-fallidos` los eventos que agotaron los reintentos del destino de EventBridge. |
| Amazon CloudWatch | Registra logs y métricas de las funciones. |

## Lambdas

| Función | Activación | Descripción |
|---|---|---|
| `crearInvitado` | API Gateway | Crea una cuenta temporal y elimina la más antigua si se alcanza el máximo de 50. |
| `limpiarInvitados` | EventBridge Scheduler | Elimina invitados creados hace más de 24 horas. |

## Endpoint

| Método | Ruta | Autenticación | Descripción |
|---|---|---|---|
| `POST` | `/invitado` | Pública | Crea una cuenta temporal y devuelve sus credenciales. |

Respuesta exitosa:

```json
{
  "email": "invitado-xxxxxxxx@invitado.notasapp.local",
  "password": "contraseña-temporal"
}
```

La Lambda responde con HTTP `201` cuando crea el invitado y con HTTP `500` si el proceso falla.

> La ruta, el throttling y la integración con Lambda están configurados directamente en API Gateway.

## Evento `InvitadoEliminado`

El servicio publica una entrada de EventBridge con:

```text
Source: notas-app.usuarios
DetailType: InvitadoEliminado
```

El detalle tiene esta estructura:

```json
{
  "tipo": "InvitadoEliminado",
  "userId": "sub-del-invitado",
  "eliminadoEn": "2026-08-20T00:00:00.000Z"
}
```

El `userId` corresponde al atributo `sub` de Cognito y permite que el servicio de notas encuentre los elementos asociados en DynamoDB.

## Paginación de Cognito

Cognito puede dividir los usuarios confirmados en varias páginas. `cognitoService` repite `ListUsersCommand` mientras reciba un `PaginationToken`, acumula todos los usuarios y después filtra aquellos cuyo atributo `custom:esInvitado` sea `true`.

Esto evita que un invitado quede fuera de la limpieza cuando existan suficientes usuarios confirmados para ocupar más de una página.

## Estructura del proyecto

```text
notas-app-usuarios/
├── functions/
│   ├── crearInvitado/
│   │   └── index.js
│   └── limpiarInvitados/
│       └── index.js
├── services/
│   ├── cognitoService.js
│   └── eventBridgeService.js
├── utils/
│   └── response.js
├── .github/
│   └── workflows/
│       └── deploy.yml
├── package.json
└── package-lock.json
```

## Instalación local

Requisitos:

- Node.js 22.
- npm.

Instala las versiones registradas en `package-lock.json`:

```bash
npm ci
```

## CI/CD

El workflow `.github/workflows/deploy.yml` está configurado para ejecutarse con pushes a:

- `develop`, usando el environment de GitHub `development`.
- `main`, usando el environment de GitHub `production`.

El workflow instala dependencias, genera `lambda.zip` y actualiza el código de las Lambdas existentes `crearInvitado` y `limpiarInvitados` mediante AWS CLI.

Secrets requeridos por el workflow:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

> El workflow actualiza código existente. La creación de Lambdas, API Gateway, Cognito, programaciones de EventBridge Scheduler, reglas de EventBridge, targets y permisos se administra directamente en AWS.

## Configuración actual

La región, el User Pool ID y el máximo de invitados están definidos actualmente en el código. Su traslado a variables de entorno queda pendiente para una futura separación completa entre desarrollo y producción.
