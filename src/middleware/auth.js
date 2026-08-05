import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const SECRET = process.env.JWT_SECRET;

export const verificarToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(401).json({ error: "Token requerido" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Token inválido" });
  }

  try {
    const decoded = jwt.verify(token, SECRET);

    // Chequeamos en la base de datos que la cuenta siga activa.
    // Sin esto, una cuenta recién desactivada podía seguir usando la
    // app hasta que el token expirara solo (hasta 8 horas después).
    const result = await pool.query(
      "SELECT activo FROM usuarios WHERE id = $1",
      [decoded.id]
    );

    const usuario = result.rows[0];

    if (!usuario || !usuario.activo) {
      return res.status(403).json({ error: "Cuenta desactivada" });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Token inválido" });
  }
};