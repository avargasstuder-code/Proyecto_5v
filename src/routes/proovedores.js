import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import { verificarAdmin } from "../middleware/verificarAdmin.js";

const router = Router();

function esEnteroValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

// LISTAR PROVEEDORES ACTIVOS (para elegir al registrar una compra)
router.get("/", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM proveedores WHERE activo = true ORDER BY nombre"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener proveedores" });
  }
});

// LISTADO COMPLETO (activos e inactivos, para administrar)
router.get("/todos", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM proveedores ORDER BY nombre"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener el listado de proveedores" });
  }
});

// CREAR PROVEEDOR
router.post("/", verificarToken, verificarAdmin, async (req, res) => {
  const { nombre, rut, telefono, direccion } = req.body;

  if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
    return res.status(400).json({ error: "El nombre es obligatorio" });
  }

  try {
    if (rut) {
      const existe = await pool.query(
        "SELECT id FROM proveedores WHERE rut = $1",
        [rut]
      );
      if (existe.rows.length > 0) {
        return res.status(400).json({ error: "Ya existe un proveedor con ese RUT" });
      }
    }

    const result = await pool.query(
      `INSERT INTO proveedores (nombre, rut, telefono, direccion, activo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [nombre.trim(), rut || null, telefono || null, direccion || null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({ error: "Ya existe un proveedor con ese RUT" });
    }
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al crear proveedor" });
  }
});

// ACTUALIZAR PROVEEDOR
router.put("/:id", verificarToken, verificarAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, rut, telefono, direccion } = req.body;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
    return res.status(400).json({ error: "El nombre es obligatorio" });
  }

  try {
    if (rut) {
      const existe = await pool.query(
        "SELECT id FROM proveedores WHERE rut = $1 AND id != $2",
        [rut, id]
      );
      if (existe.rows.length > 0) {
        return res.status(400).json({ error: "Ya existe otro proveedor con ese RUT" });
      }
    }

    const result = await pool.query(
      `UPDATE proveedores
       SET nombre = $1, rut = $2, telefono = $3, direccion = $4
       WHERE id = $5
       RETURNING *`,
      [nombre.trim(), rut || null, telefono || null, direccion || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({ error: "Ya existe otro proveedor con ese RUT" });
    }
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al actualizar proveedor" });
  }
});

// ACTIVAR / DESACTIVAR PROVEEDOR
router.put("/:id/activo", verificarToken, verificarAdmin, async (req, res) => {
  const { id } = req.params;
  const { activo } = req.body;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  if (typeof activo !== "boolean") {
    return res.status(400).json({ error: "activo debe ser true o false" });
  }

  try {
    const result = await pool.query(
      "UPDATE proveedores SET activo = $1 WHERE id = $2 RETURNING *",
      [activo, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al cambiar estado del proveedor" });
  }
});

export default router;