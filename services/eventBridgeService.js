const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge')

const eventBridge = new EventBridgeClient({ region: 'us-east-1' })

const publicarInvitadoEliminado = async (userId) => {
  await eventBridge.send(new PutEventsCommand({
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
}

module.exports = {
  publicarInvitadoEliminado,
}