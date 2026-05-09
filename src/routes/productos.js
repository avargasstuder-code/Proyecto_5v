import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

// OBTENER PRODUCTOS
router.get("/", async (req, res) => {
  try {
    const { codigo } = req.query;

    if (codigo) {
      const result = await pool.query(
        "SELECT * FROM productos WHERE codigo_barra = $1",
        [codigo]
      );
      return res.json(result.rows);
    }

    const result = await pool.query(
      "SELECT p.*, c.nombre AS categoria FROM productos p LEFT JOIN categoria c ON c.id = p.categoria_id WHERE p.activo = true"
    );

    res.json(result.rows);

  } catch (error) {
    console.error("ERROR GET PRODUCTOS:", error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// CREAR PRODUCTO
router.post("/", async (req, res) => {
  try {
    const {
      nombre,
      codigo_barra,
      stock,
      categoria_id,
      precio_carton,
      precio_medio,
      precio_unitario,
      tipo_venta
    } = req.body;

    // VALIDACIÓN BÁSICA
    if (!nombre || !tipo_venta) {
      return res.status(400).json({
        error: "Nombre y tipo de venta son obligatorios"
      });
    }

    // VALIDAR DUPLICADO (ANTES)
    if (codigo_barra) {
      const existe = await pool.query(
        "SELECT id FROM productos WHERE codigo_barra = $1",
        [codigo_barra]
      );

      if (existe.rows.length > 0) {
        return res.status(400).json({
          error: "El código de barras ya está en uso"
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO productos 
      (nombre, codigo_barra, stock,categoria_id, precio_carton, precio_medio, precio_unitario, tipo_venta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        nombre,
        codigo_barra || null,
        stock || 0,
        categoria_id || null,
        tipo_venta === "cigarro" ? precio_carton : null,
        tipo_venta === "cigarro" ? precio_medio : null,
        tipo_venta === "unitario" ? precio_unitario : null,
        tipo_venta
      ]
    );

    res.json(result.rows[0]);

  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "El código de barras ya está en uso"
      });
    }

    console.error("ERROR CREAR PRODUCTO:", error);
    res.status(500).json({ error: "Error al crear producto" });
  }
});

// DESACTIVAR PRODUCTO
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query(
      "UPDATE productos SET activo = false WHERE id = $1",
      [id]
    );

    res.json({ mensaje: "Producto desactivado" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// ACTUALIZAR PRODUCTO
router.put("/:id", async (req, res) => {
  const { id } = req.params;

  const {
    nombre,
    codigo_barra,
    stock,
    categoria_id,
    precio_carton,
    precio_medio,
    precio_unitario,
    tipo_venta
  } = req.body;

  try {
    // VALIDAR DUPLICADO (EXCLUYENDO EL MISMO ID)
    if (codigo_barra) {
      const existe = await pool.query(
        "SELECT id FROM productos WHERE codigo_barra = $1 AND id != $2",
        [codigo_barra, id]
      );

      if (existe.rows.length > 0) {
        return res.status(400).json({
          error: "El código de barras ya está en uso"
        });
      }
    }

    await pool.query(
      `UPDATE productos SET
        nombre = $1,
        codigo_barra = $2,
        stock = $3,
        categoria_id = $4,
        tipo_venta = $5,
        precio_unitario = $6,
        precio_carton = $7,
        precio_medio = $8
      WHERE id = $9`,
      [
        nombre,
        codigo_barra || null,
        stock,
        categoria_id,
        tipo_venta,
        tipo_venta === "unitario" ? precio_unitario : null,
        tipo_venta === "cigarro" ? precio_carton : null,
        tipo_venta === "cigarro" ? precio_medio : null,
        id
      ]
    );

    res.json({ mensaje: "Producto actualizado" });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "El código de barras ya está en uso"
      });
    }

    console.error(error);
    res.status(500).json({ error: "Error al actualizar producto" });
  }
});

export default router;