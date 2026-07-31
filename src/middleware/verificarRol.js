// Middleware para restringir una ruta a ciertos roles.
// Se usa DESPUÉS de verificarToken (necesita que req.user ya exista).
//
// Uso: router.get("/ruta", verificarToken, verificarRol("admin"), handler)
//      router.get("/ruta", verificarToken, verificarRol("admin", "vendedor"), handler)
export function verificarRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.user || !rolesPermitidos.includes(req.user.rol)) {
      return res.status(403).json({ error: "No tenés permiso para acceder a este recurso" });
    }
    next();
  };
}