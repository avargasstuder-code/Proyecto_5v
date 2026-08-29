import { Router } from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { verificarToken } from "../middleware/auth.js";
import { verificarAdmin } from "../middleware/verificarAdmin.js";

const router = Router();
const SECRET = process.env.JWT_SECRET;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Letras, números, punto y guión bajo, 3 a 20 caracteres
const USERNAME_REGEX = /^[a-zA-Z0-9_.]{3,20}$/;

// Roles válidos del sistema. Si en el futuro agregás uno nuevo
// (ej: "vendedor_repartidor"), sumalo acá también.
const ROLES_VALIDOS = ["admin", "vendedor"];

const esPasswordSegura = (password) =>
  typeof password === "string" &&
  password.length >= 8 &&
  /[A-Z]/.test(password) &&
  /[a-z]/.test(password) &&
  /[0-9]/.test(password);

// REGISTRAR USUARIO
router.post("/register", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { nombre, password, rol } = req.body;
    const username = req.body.username?.toLowerCase().trim();
    const email = req.body.email?.toLowerCase().trim() || null;

    if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
      return res.status(400).json({ error: "Nombre es obligatorio" });
    }

    if (!username || !USERNAME_REGEX.test(username)) {
      return res.status(400).json({
        error: "Username inválido (3 a 20 caracteres: letras, números, punto o guión bajo)"
      });
    }

    if (email && !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Correo inválido" });
    }

    if (!esPasswordSegura(password)) {
      return res.status(400).json({
        error:
          "La contraseña debe tener mínimo 8 caracteres, mayúscula, minúscula y número"
      });
    }

    const rolFinal = rol || "vendedor";
    if (!ROLES_VALIDOS.includes(rolFinal)) {
      return res.status(400).json({ error: "Rol inválido" });
    }

    const existe = await pool.query(
      "SELECT id FROM usuarios WHERE username = $1",
      [username]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({
        error: "Ese username ya está en uso"
      });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (nombre, username, email, password, rol)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, nombre, username, email, rol`,
      [nombre.trim(), username, email, hash, rolFinal]
    );

    res.json(result.rows[0]);

  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({ error: "Ese username ya está en uso" });
    }
    console.error("ERROR REGISTER:", error);
    res.status(500).json({ error: "Error al registrar usuario" });
  }
});

// LOGIN (por username, no por email)
router.post("/login", async (req, res) => {
  try {
    const username = req.body.username?.toLowerCase().trim();
    const { password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Credenciales inválidas" });
    }

    const result = await pool.query(
      "SELECT * FROM usuarios WHERE username = $1",
      [username]
    );

    const user = result.rows[0];

    // Mensaje genérico en ambos casos (usuario no existe / contraseña
    // incorrecta) para no revelar si un username está o no registrado
    if (!user) {
      return res.status(400).json({ error: "Credenciales inválidas" });
    }

    if (!user.activo) {
      return res.status(403).json({ error: "Cuenta desactivada" });
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      return res.status(400).json({ error: "Credenciales inválidas" });
    }

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

  } catch (error) {
    console.error("ERROR LOGIN:", error);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

// LISTAR USUARIOS
router.get(
  "/usuarios",
  verificarToken,
  verificarAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, nombre, username, email, rol, activo
        FROM usuarios
        ORDER BY id DESC
      `);

      res.json(result.rows);

    } catch (error) {
      console.error("ERROR LISTAR USUARIOS:", error);
      res.status(500).json({ error: "Error al obtener usuarios" });
    }
});

// ACTIVAR / DESACTIVAR
router.put(
  "/usuarios/:id/activo",
  verificarToken,
  verificarAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { activo } = req.body;

      if (isNaN(Number(id))) {
        return res.status(400).json({ error: "ID inválido" });
      }

      // impedir desactivarse a sí mismo
      if (Number(id) === req.user.id) {
        return res.status(400).json({
          error: "No puedes desactivar tu propia cuenta"
        });
      }

      await pool.query(
        "UPDATE usuarios SET activo = $1 WHERE id = $2",
        [!!activo, id]
      );

      res.json({ ok: true });

    } catch (error) {
      console.error("ERROR ACTIVAR/DESACTIVAR:", error);
      res.status(500).json({ error: "Error al cambiar el estado del usuario" });
    }
});

// CAMBIAR CONTRASEÑA
router.put(
  "/cambiar-password",
  verificarToken,
  async (req, res) => {
    try {
      const { actual, nueva } = req.body;

      if (!actual || !nueva) {
        return res.status(400).json({ error: "Faltan datos" });
      }

      if (!esPasswordSegura(nueva)) {
        return res.status(400).json({
          error:
            "La nueva contraseña debe tener mínimo 8 caracteres, mayúscula, minúscula y número"
        });
      }

      const result = await pool.query(
        "SELECT * FROM usuarios WHERE id = $1",
        [req.user.id]
      );

      const user = result.rows[0];

      if (!user) {
        return res.status(404).json({ error: "Usuario no encontrado" });
      }

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

      res.json({ ok: true });

    } catch (error) {
      console.error("ERROR CAMBIAR PASSWORD:", error);
      res.status(500).json({ error: "Error al cambiar la contraseña" });
    }
});

// CAMBIAR USERNAME (con el que se inicia sesión)
router.put("/cambiar-username", verificarToken, async (req, res) => {
  try {
    const username = req.body.username?.toLowerCase().trim();

    if (!username || !USERNAME_REGEX.test(username)) {
      return res.status(400).json({
        error: "Username inválido (3 a 20 caracteres: letras, números, punto o guión bajo)"
      });
    }

    const existe = await pool.query(
      "SELECT id FROM usuarios WHERE username = $1 AND id != $2",
      [username, req.user.id]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({ error: "Ese username ya está en uso" });
    }

    await pool.query(
      "UPDATE usuarios SET username = $1 WHERE id = $2",
      [username, req.user.id]
    );

    res.json({ ok: true, username });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({ error: "Ese username ya está en uso" });
    }
    console.error("ERROR CAMBIAR USERNAME:", error);
    res.status(500).json({ error: "Error al cambiar el username" });
  }
});

// CAMBIAR CORREO (ya no se usa para loguearse, pero se puede seguir
// actualizando por si sirve como dato de contacto)
router.put("/cambiar-email", verificarToken, async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();

    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Correo inválido" });
    }

    await pool.query(
      "UPDATE usuarios SET email = $1 WHERE id = $2",
      [email, req.user.id]
    );

    res.json({ ok: true });

  } catch (error) {
    console.error("ERROR CAMBIAR EMAIL:", error);
    res.status(500).json({ error: "Error al cambiar el correo" });
  }
});

export default router;