const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminDeleteUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider')

const cognito = new CognitoIdentityProviderClient({ region: 'us-east-1' })
const USER_POOL_ID = 'us-east-1_fn7wolGpK'

const obtenerInvitadosOrdenadosPorFecha = async () => {
  const usuarios = []
  let paginationToken

  do {
    const result = await cognito.send(
      new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Filter: 'cognito:user_status = "CONFIRMED"',
        ...(paginationToken && { PaginationToken: paginationToken }),
      }),
    )

    usuarios.push(...(result.Users || []))
    paginationToken = result.PaginationToken
  } while (paginationToken)

  const invitados = usuarios.filter((usuario) =>
    usuario.Attributes.some(
      (attr) => attr.Name === 'custom:esInvitado' && attr.Value === 'true',
    ),
  )

  invitados.sort(
    (a, b) => new Date(a.UserCreateDate) - new Date(b.UserCreateDate),
  )

  return invitados
}

const eliminarInvitado = async (username) => {
  await cognito.send(
    new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    }),
  )
}

// Filtra de una lista de invitados solo los que ya pasaron X horas desde su creación
const filtrarInvitadosVencidos = (invitados, horasLimite = 24) => {
  const ahora = Date.now()
  const limiteMs = horasLimite * 60 * 60 * 1000

  return invitados.filter((invitado) => {
    const creadoEn = new Date(invitado.UserCreateDate).getTime()
    return ahora - creadoEn > limiteMs
  })
}

module.exports = {
  obtenerInvitadosOrdenadosPorFecha,
  eliminarInvitado,
  filtrarInvitadosVencidos,
}
