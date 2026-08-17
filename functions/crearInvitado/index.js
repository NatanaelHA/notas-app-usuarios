const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
} = require('@aws-sdk/client-cognito-identity-provider')
const { response } = require('../../utils/response')
const {
  obtenerInvitadosOrdenadosPorFecha,
  eliminarInvitado,
} = require('../../services/cognitoService')
const {
  publicarInvitadoEliminado,
} = require('../../services/eventBridgeService')

const cognito = new CognitoIdentityProviderClient({ region: 'us-east-1' })
const USER_POOL_ID = 'us-east-1_fn7wolGpK'
const MAX_INVITADOS = 50

const generarSufijo = () => Math.random().toString(36).substring(2, 10)

const generarPassword = () => {
  const sufijo = generarSufijo()
  return `Invitado${sufijo}1!`
}

exports.handler = async () => {
  try {
    const invitados = await obtenerInvitadosOrdenadosPorFecha()

    if (invitados.length >= MAX_INVITADOS) {
      const masViejo = invitados[0]
      const username = masViejo.Username
      const subAttr = masViejo.Attributes.find((a) => a.Name === 'sub')

      await eliminarInvitado(username)

      if (subAttr?.Value) {
        await publicarInvitadoEliminado(subAttr.Value)
      }

      console.log(`Límite alcanzado, invitado más viejo eliminado: ${username}`)
    }

    const sufijo = generarSufijo()
    const email = `invitado-${sufijo}@invitado.notasapp.local`
    const password = generarPassword()

    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'custom:esInvitado', Value: 'true' },
        ],
        MessageAction: 'SUPPRESS',
      }),
    )

    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    )

    return response(201, { email, password })
  } catch (error) {
    console.error('Error al crear invitado:', error)
    return response(500, { mensaje: 'Error al crear cuenta de invitado' })
  }
}
