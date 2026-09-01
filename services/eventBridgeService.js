const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge')

const eventBridge = new EventBridgeClient({ region: 'us-east-1' })

/* ------------------------------------------------------------------------- */
/* PUBLICACIÓN COMPARTIDA                                                    */
/* ------------------------------------------------------------------------- */

const publicarEvento = async (detailType, detail) => {
  const resultado = await eventBridge.send(new PutEventsCommand({
    Entries: [
      {
        Source: 'notas-app.usuarios',
        DetailType: detailType,
        Detail: JSON.stringify(detail),
      },
    ],
  }))

  if (resultado.FailedEntryCount > 0) {
    const entradasFallidas = (resultado.Entries || []).filter(
      (entrada) => entrada.ErrorCode || entrada.ErrorMessage,
    )

    throw new Error(
      `No se pudo publicar ${detailType}: ${JSON.stringify(entradasFallidas)}`,
    )
  }
}

/* ------------------------------------------------------------------------- */
/* USUARIOS INVITADOS                                                        */
/* ------------------------------------------------------------------------- */

const publicarInvitadoEliminado = async (userId) => {
  await publicarEvento('InvitadoEliminado', {
    tipo: 'InvitadoEliminado',
    userId,
    eliminadoEn: new Date().toISOString(),
  })
}

/* ------------------------------------------------------------------------- */
/* USUARIOS REALES                                                           */
/* ------------------------------------------------------------------------- */

const publicarUsuarioParaLimpieza = async (userId) => {
  await publicarEvento('UsuarioParaLimpieza', {
    tipo: 'UsuarioParaLimpieza',
    userId,
    programadoEn: new Date().toISOString(),
  })
}

module.exports = {
  // Invitados
  publicarInvitadoEliminado,

  // Usuarios reales
  publicarUsuarioParaLimpieza,
}
