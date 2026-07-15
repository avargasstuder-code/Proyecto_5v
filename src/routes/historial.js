import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";

const router = Router();

// LISTA DE VENTAS
router.get("/", verificarToken, async (req, res) => {
  try {
    const user = req.user;

    let query = `
      SELECT 
        v.id,
        v.total,
        v.metodo_pago,
        v.dias_cheque,
        v.fecha,
        c.nombre || ' ' || c.apellido AS cliente,
        u.nombre AS usuario
      FROM ventas v
      JOIN clientes c ON v.cliente_id = c.id
      JOIN usuarios u ON v.usuario_id = u.id
    `;

    if (user.rol === "vendedor") {
      query += " WHERE v.usuario_id = $1 ORDER BY v.fecha DESC";
      const result = await pool.query(query, [user.id]);
      return res.json(result.rows);
    }

    query += " ORDER BY v.fecha DESC";

    const result = await pool.query(query);
    res.json(result.rows);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// DETALLE DE VENTA 
router.get("/:id", verificarToken, async (req, res) => {
  const { id } = req.params;

  try {
    const venta = await pool.query(
      `SELECT v.*, c.nombre || ' ' || c.apellido AS cliente, c.rut AS rut, u.nombre AS usuario
       FROM ventas v
       JOIN clientes c ON v.cliente_id = c.id
       JOIN usuarios u ON v.usuario_id = u.id
       WHERE v.id = $1`,
      [id]
    );

    if (venta.rows.length === 0) {
      return res.status(404).json({ error: "Venta no encontrada" });
    }

    const detalle = await pool.query(
      `SELECT d.*, p.nombre
       FROM detalle_venta d
       JOIN productos p ON d.producto_id = p.id
       WHERE d.venta_id = $1`,
      [id]
    );

    res.json({
      venta: venta.rows[0],
      productos: detalle.rows
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error del servidor" });
  }
});


// ESTO ES LO QUE TE FALTA
export default router;