# Notas App — Servicio de usuarios

Backend serverless responsable de la gestión de identidades de **Notas App**. Crea y elimina cuentas temporales en Amazon Cognito y coordina la limpieza programada de notas para invitados y usuarios reales mediante eventos.

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
- Listar usuarios reales confirmados y excluir las cuentas invitadas.
- Ejecutar semanalmente `limpiarUsuarios` sin eliminar las cuentas reales de Cognito.
- Publicar un evento `UsuarioParaLimpieza` por cada usuario real procesable.
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

### Limpieza semanal de notas de usuarios reales

```text
EventBridge Scheduler (limpiarUsuariosSemanal)
    ↓ domingos a las 03:00, America/Santiago
limpiarUsuarios
    ↓ lista usuarios confirmados en Cognito
    ↓ excluye invitados
    ↓ publica UsuarioParaLimpieza con userId
EventBridge (regla usuarioParaLimpiezaARegistroNotas)
    ↓
eliminarNotasUsuario, en notas-app-backend
    ↓ publica resumen_usuario en notas-emails
    ↓ elimina las notas del usuario
mailer, en notas-app-notifications
    ↓
SES envía el resumen al correo de auditoría
```

`limpiarUsuarios` no elimina cuentas reales de Cognito. Su función es iniciar el resumen y la eliminación semanal de sus notas. El Scheduler está habilitado, no utiliza una ventana flexible, conserva eventos durante un máximo de 24 horas, realiza hasta 3 reintentos de entrega y usa `eventos-invitados-fallidos` como DLQ.

El evento no transporta el correo del usuario real. El servicio de notas asigna posteriormente el correo de auditoría verificado en SES, por lo que este flujo es compatible con el modo sandbox actual.

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

Las reglas `invitadoEliminadoARegistroNotas` y `usuarioParaLimpiezaARegistroNotas` comparten la cola SQS `eventos-invitados-fallidos` como DLQ. Esta cola conserva eventos que EventBridge no pudo entregar a la Lambda de destino después de agotar su política de reintentos. No captura por sí misma errores ocurridos dentro del código después de que Lambda acepta la invocación; esos errores pertenecen al mecanismo asíncrono de Lambda.

Esta redirección se configura en AWS sobre cada destino de EventBridge y no desde el código de este servicio.

Cuando el fallo ocurre dentro de `limpiarInvitados`, se registra el `username` afectado y el resumen final informa cuántos invitados se eliminaron y cuántos fallaron. Los usuarios fallidos permanecen disponibles para la siguiente ejecución horaria.

## Servicios AWS utilizados

| Servicio | Uso dentro de este backend |
|---|---|
| AWS Lambda | Ejecuta `crearInvitado`, `limpiarInvitados` y `limpiarUsuarios`. |
| API Gateway | Expone públicamente el endpoint para crear invitados. |
| Amazon Cognito | Almacena y administra las cuentas de usuario. |
| Amazon EventBridge Scheduler | Ejecuta `limpiarInvitados` cada hora y `limpiarUsuarios` cada domingo a las 03:00. |
| Amazon EventBridge | Transporta `InvitadoEliminado` y `UsuarioParaLimpieza` mediante el Event Bus y sus reglas. |
| Amazon SQS | Conserva en `eventos-invitados-fallidos` los eventos que EventBridge no pudo entregar a sus destinos. |
| Amazon CloudWatch | Registra logs y métricas de las funciones. |

## Lambdas

| Función | Activación | Descripción |
|---|---|---|
| `crearInvitado` | API Gateway | Crea una cuenta temporal y elimina la más antigua si se alcanza el máximo de 50. |
| `limpiarInvitados` | EventBridge Scheduler | Elimina invitados creados hace más de 24 horas. |
| `limpiarUsuarios` | EventBridge Scheduler | Publica semanalmente `UsuarioParaLimpieza` para cada usuario real; no elimina su cuenta. |

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

## Evento `UsuarioParaLimpieza`

El servicio publica una entrada de EventBridge con:

```text
Source: notas-app.usuarios
DetailType: UsuarioParaLimpieza
```

El detalle incluye toda la información que necesita el servicio de notas, que no accede directamente a Cognito:

```json
{
  "tipo": "UsuarioParaLimpieza",
  "userId": "sub-del-usuario",
  "programadoEn": "2026-08-30T07:00:40.000Z"
}
```

## Paginación de Cognito

Cognito puede dividir los usuarios confirmados en varias páginas. `cognitoService` repite `ListUsersCommand` mientras reciba un `PaginationToken` y acumula todos los usuarios. Después reutiliza esa lista para separar invitados y usuarios reales.

Esto evita que una cuenta quede fuera de cualquiera de las limpiezas cuando existan suficientes usuarios confirmados para ocupar más de una página.

## Estructura del proyecto

```text
notas-app-usuarios/
├── functions/
│   ├── crearInvitado/
│   │   └── index.js
│   ├── limpiarInvitados/
│   │   └── index.js
│   └── limpiarUsuarios/
│       └── index.js
├── services/
│   ├── cognitoService.js
│   └── eventBridgeService.js
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

El workflow instala dependencias, genera `lambda.zip` y actualiza el código de `crearInvitado`, `limpiarInvitados` y `limpiarUsuarios` mediante AWS CLI.

Secrets requeridos por el workflow:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

> El workflow actualiza código existente. La creación de Lambdas, API Gateway, Cognito, programaciones de EventBridge Scheduler, reglas de EventBridge, targets y permisos se administra directamente en AWS.

## Configuración actual

La región, el User Pool ID y el máximo de invitados están definidos actualmente en el código. Su traslado a variables de entorno queda pendiente para una futura separación completa entre desarrollo y producción.
