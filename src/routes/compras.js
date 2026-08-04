import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import { verificarAdmin } from "../middleware/verificarAdmin.js";

const router = Router();

function esEnteroValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

// REGISTRAR UNA COMPRA (varios productos a la vez, suma al stock)
router.post("/", verificarToken, verificarAdmin, async (req, res) => {
  const { proveedor_id, productos } = req.body;

  // VALIDACIONES (antes de tomar una conexión del pool)
  if (!esEnteroValido(proveedor_id)) {
    return res.status(400).json({ error: "Proveedor requerido" });
  }

  if (!productos || !Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: "No hay productos en la compra" });
  }

  for (const item of productos) {
    if (!esEnteroValido(item.producto_id)) {
      return res.status(400).json({ error: "producto_id inválido" });
    }
    const cantidad = Number(item.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return res.status(400).json({ error: "cantidad debe ser un número positivo" });
    }
    const costo = Number(item.costo_unitario);
    if (!Number.isFinite(costo) || costo < 0) {
      return res.status(400).json({ error: "costo_unitario inválido" });
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Verificar que el proveedor exista
    const proveedorResult = await client.query(
      "SELECT id FROM proveedores WHERE id = $1",
      [proveedor_id]
    );
    if (proveedorResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }

    let total = 0;

    // Verificar que todos los productos existan antes de escribir nada
    for (const item of productos) {
      const productoResult = await client.query(
        "SELECT id FROM productos WHERE id = $1",
        [item.producto_id]
      );
      if (productoResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Producto con ID ${item.producto_id} no existe` });
      }
      total += Number(item.cantidad) * Number(item.costo_unitario);
    }

    // Crear la compra (cabecera)
    const compraResult = await client.query(
      `INSERT INTO compras (proveedor_id, usuario_id, total)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [proveedor_id, req.user.id, total]
    );
    const compraId = compraResult.rows[0].id;

    // Detalle + suma de stock
    for (const item of productos) {
      await client.query(
        `INSERT INTO detalle_compra (compra_id, producto_id, cantidad, costo_unitario)
         VALUES ($1, $2, $3, $4)`,
        [compraId, item.producto_id, item.cantidad, item.costo_unitario]
      );

      await client.query(
        "UPDATE productos SET stock = stock + $1 WHERE id = $2",
        [item.cantidad, item.producto_id]
      );
    }

    await client.query("COMMIT");

    res.json({ mensaje: "Compra registrada", compraId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo registrar la compra" });
  } finally {
    client.release();
  }
});

// HISTORIAL DE COMPRAS
router.get("/", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.total,
        c.fecha,
        p.nombre AS proveedor,
        p.rut AS proveedor_rut,
        u.nombre AS usuario
      FROM compras c
      JOIN proveedores p ON p.id = c.proveedor_id
      JOIN usuarios u ON u.id = c.usuario_id
      ORDER BY c.fecha DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener el historial de compras" });
  }
});

// DETALLE DE UNA COMPRA
router.get("/:id", verificarToken, verificarAdmin, async (req, res) => {
  const { id } = req.params;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    const compraResult = await pool.query(
      `SELECT
        c.id,
        c.total,
        c.fecha,
        p.nombre AS proveedor,
        p.rut AS proveedor_rut,
        u.nombre AS usuario
      FROM compras c
      JOIN proveedores p ON p.id = c.proveedor_id
      JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.id = $1`,
      [id]
    );

    if (compraResult.rows.length === 0) {
      return res.status(404).json({ error: "Compra no encontrada" });
    }

    const detalleResult = await pool.query(
      `SELECT d.*, pr.nombre
       FROM detalle_compra d
       JOIN productos pr ON pr.id = d.producto_id
       WHERE d.compra_id = $1`,
      [id]
    );

    res.json({
      compra: compraResult.rows[0],
      productos: detalleResult.rows
    });
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener el detalle de la compra" });
  }
});

export default router;