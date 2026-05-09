import { Router } from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { verificarToken } from "../middleware/auth.js";
import { verificarAdmin } from "../middleware/verificarAdmin.js";

const router = Router();
const SECRET = process.env.JWT_SECRET;

// REGISTRAR USUARIO
router.post(
  "/register",
  verificarToken,
  verificarAdmin,
  async (req, res) => {

    const { nombre, email, password, rol } = req.body;

    // VALIDAR EMAIL
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: "Correo inválido"
      });
    }

    // VALIDAR PASSWORD
    const passwordSegura =
      password.length >= 8 &&
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /[0-9]/.test(password);

    if (!passwordSegura) {
      return res.status(400).json({
        error:
          "La contraseña debe tener mínimo 8 caracteres, mayúscula, minúscula y número"
      });
    }

    const existe = await pool.query(
      "SELECT * FROM usuarios WHERE email = $1",
      [email]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({
        error: "El email ya está registrado"
      });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, password, rol)
       VALUES ($1,$2,$3,$4)
       RETURNING id, nombre, email, rol`,
      [nombre, email, hash, rol || "vendedor"]
    );

    res.json(result.rows[0]);
});

// LOGIN
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const result = await pool.query(
    "SELECT * FROM usuarios WHERE email = $1",
    [email]
  );

  const user = result.rows[0];

  if (!user) {
    return res.status(400).json({ error: "Usuario no existe" });
  }
  if (!user.activo) {
    return res.status(403).json({
      error: "Cuenta desactivada"
    });
  }

  // comparar contraseña encriptada
  const valid = await bcrypt.compare(password, user.password);

  if (!valid) {
    return res.status(400).json({ error: "Contraseña incorrecta" });
  }

  // generar token
  const token = jwt.sign(
    {
      id: user.id,
      nombre: user.nombre,
      rol: user.rol
    },
    SECRET,
    { expiresIn: "8h" }
  );
  res.json({ token });
});

// LISTAR USUARIOS
router.get(
  "/usuarios",
  verificarToken,
  verificarAdmin,
  async (req, res) => {

    const result = await pool.query(`
      SELECT id, nombre, email, rol, activo
      FROM usuarios
      ORDER BY id DESC
    `);

    res.json(result.rows);
});

// ACTIVAR / DESACTIVAR
// ACTIVAR / DESACTIVAR
router.put(
  "/usuarios/:id/activo",
  verificarToken,
  verificarAdmin,
  async (req, res) => {

    const { id } = req.params;
    const { activo } = req.body;

    // impedir desactivarse a sí mismo
    if (Number(id) === req.user.id) {
      return res.status(400).json({
        error: "No puedes desactivar tu propia cuenta"
      });
    }

    await pool.query(
      "UPDATE usuarios SET activo = $1 WHERE id = $2",
      [activo, id]
    );

    res.json({
      ok: true
    });
});

// CAMBIAR CONTRASEÑA
router.put(
  "/cambiar-password",
  verificarToken,
  async (req, res) => {

    const { actual, nueva } = req.body;

    const result = await pool.query(
      "SELECT * FROM usuarios WHERE id = $1",
      [req.user.id]
    );

    const user = result.rows[0];

    const valid = await bcrypt.compare(actual, user.password);

    if (!valid) {
      return res.status(400).json({
        error: "Contraseña actual incorrecta"
      });
    }

    const hash = await bcrypt.hash(nueva, 10);

    await pool.query(
      "UPDATE usuarios SET password = $1 WHERE id = $2",
      [hash, req.user.id]
    );

    res.json({
      ok: true
    });
});

// CAMBIAR CORREO
router.put(
  "/cambiar-email",
  verificarToken,
  async (req, res) => {

    const { email } = req.body;

    await pool.query(
      "UPDATE usuarios SET email = $1 WHERE id = $2",
      [email, req.user.id]
    );

    res.json({
      ok: true
    });
});

export default router;