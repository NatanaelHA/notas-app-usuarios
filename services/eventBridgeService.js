const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge')

const eventBridge = new EventBridgeClient({ region: 'us-east-1' })

const publicarInvitadoEliminado = async (userId) => {
  const resultado = await eventBridge.send(new PutEventsCommand({
    Entries: [
      {
        Source: 'notas-app.usuarios',
        DetailType: 'InvitadoEliminado',
        Detail: JSON.stringify({
          tipo: 'InvitadoEliminado',
          userId,
          eliminadoEn: new Date().toISOString(),
        }),
      },
    ],
  }))

  if (resultado.FailedEntryCount > 0) {
    const entradasFallidas = (resultado.Entries || []).filter(
      (entrada) => entrada.ErrorCode || entrada.ErrorMessage,
    )

    throw new Error(
      `No se pudo publicar InvitadoEliminado: ${JSON.stringify(entradasFallidas)}`,
    )
  }
}

module.exports = {
  publicarInvitadoEliminado,
}
