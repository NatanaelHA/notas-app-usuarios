const {
  obtenerInvitadosOrdenadosPorFecha,
  eliminarInvitado,
  filtrarInvitadosVencidos,
} = require('../../services/cognitoService')
const {
  publicarInvitadoEliminado,
} = require('../../services/eventBridgeService')

exports.handler = async () => {
  let exitosos = 0
  let fallidos = 0

  try {
    const invitados = await obtenerInvitadosOrdenadosPorFecha()
    const vencidos = filtrarInvitadosVencidos(invitados, 24)

    for (const invitado of vencidos) {
      const username = invitado.Username

      try {
        const subAttr = invitado.Attributes.find((a) => a.Name === 'sub')
        const userId = subAttr?.Value

        if (userId) {
          await publicarInvitadoEliminado(userId)
        }

        await eliminarInvitado(username)

        console.log(`Invitado eliminado correctamente: ${username}`)
        exitosos++
      } catch (errorIndividual) {
        console.error(
          `Fallo al eliminar invitado ${username}:`,
          errorIndividual,
        )
        fallidos++
      }
    }

    console.log(
      `Resumen limpieza diaria — total detectados: ${vencidos.length}, eliminados: ${exitosos}, fallidos: ${fallidos}`,
    )
  } catch (error) {
    console.error(
      'Error crítico: no se pudo ni siquiera listar los invitados:',
      error,
    )
  }
}
