const {
  obtenerUsuariosReales,
} = require('../../services/cognitoService')
const {
  publicarUsuarioParaLimpieza,
} = require('../../services/eventBridgeService')

exports.handler = async () => {
  const usuarios = await obtenerUsuariosReales()
  let publicados = 0
  let omitidos = 0
  const fallidos = []

  for (const usuario of usuarios) {
    const identificador = usuario.userId || usuario.username || 'desconocido'

    if (!usuario.userId || !usuario.email) {
      console.warn(
        `Usuario real omitido por datos incompletos: ${identificador}`,
      )
      omitidos++
      continue
    }

    if (!usuario.emailVerificado) {
      console.warn(
        `Usuario real omitido porque su correo no está verificado: ${identificador}`,
      )
      omitidos++
      continue
    }

    try {
      await publicarUsuarioParaLimpieza(usuario.userId, usuario.email)
      console.log(
        `Usuario real enviado a limpieza de notas: ${usuario.userId}`,
      )
      publicados++
    } catch (error) {
      console.error(
        `Fallo al publicar la limpieza del usuario ${usuario.userId}:`,
        error,
      )
      fallidos.push(usuario.userId)
    }
  }

  console.log(
    `Resumen limpieza semanal — encontrados: ${usuarios.length}, publicados: ${publicados}, omitidos: ${omitidos}, fallidos: ${fallidos.length}`,
  )

  if (fallidos.length > 0) {
    throw new Error(
      `No se pudo publicar la limpieza de estos usuarios: ${fallidos.join(', ')}`,
    )
  }
}
