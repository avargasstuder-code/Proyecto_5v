import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";

const router = Router();

router.post("/", verificarToken, async (req, res) => {
  const { cliente_id, productos, metodo_pago, dias_cheque } = req.body;
  const usuario_id = req.user.id;

  const client = await pool.connect();

  // VALIDACIONES
  if (!cliente_id) {
    return res.status(400).json({ error: "Cliente requerido" });
  }

  if (!productos || productos.length === 0) {
    return res.status(400).json({ error: "No hay productos en la venta" });
  }

  if (!metodo_pago) {
    return res.status(400).json({ error: "Método de pago requerido" });
  }

  if (metodo_pago === "cheque" && (!dias_cheque || dias_cheque <= 0)) {
    return res.status(400).json({ error: "Días de cheque inválidos" });
  }

  try {
    await client.query("BEGIN");

    let total = 0;
    let detalles = [];

    // 1. CALCULAR TOTAL Y VALIDAR STOCK
    for (let item of productos) {
      const result = await client.query(
        "SELECT * FROM productos WHERE id = $1",
        [item.producto_id]
      );
      await client.query(`
        INSERT INTO cliente_productos_frecuentes (cliente_id, producto_id, cantidad_frecuente)
        VALUES ($1, $2, $3)
        ON CONFLICT (cliente_id, producto_id)
        DO UPDATE SET cantidad_frecuente = EXCLUDED.cantidad_frecuente
      `, [cliente_id, item.producto_id, item.cantidad]);

      const producto = result.rows[0];

      if (!producto) {
        throw new Error(`Producto con ID ${item.producto_id} no existe`);
      }

      if (!producto.tipo_venta) {
        throw new Error(`Producto ${producto.nombre} sin tipo de venta`);
      }

      let precio = 0;
      let descuentoStock = 0;

      // UNITARIO
      if (producto.tipo_venta === "unitario") {
        precio = producto.precio_unitario;
        descuentoStock = item.cantidad;
      } 
      // CIGARRO
      else {
        if (item.tipo === "carton") {
          precio = producto.precio_carton;
          descuentoStock = item.cantidad * 1;
        } else if (item.tipo === "medio") {
          precio = producto.precio_medio;
          descuentoStock = item.cantidad * 0.5;
        } else {
          throw new Error("Tipo de unidad inválido");
        }
      }

      // VALIDAR STOCK (CORRECTO)
      if (producto.stock < descuentoStock) {
        return res.status(400).json({
          error: `Stock insuficiente para ${producto.nombre}`
        });
      }

      total += precio * item.cantidad;

      detalles.push({
        producto_id: item.producto_id,
        tipo: item.tipo,
        cantidad: item.cantidad,
        precio,
        descuentoStock
      });
    }

    // 2. CREAR VENTA
    const venta = await client.query(
      `INSERT INTO ventas 
      (cliente_id, usuario_id, total, metodo_pago, dias_cheque)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        cliente_id,
        usuario_id,
        total,
        metodo_pago,
        metodo_pago === "cheque" ? dias_cheque : null
      ]
    );

    const ventaId = venta.rows[0].id;

    // 3. DETALLE + STOCK
    for (let item of detalles) {
      await client.query(
        `INSERT INTO detalle_venta 
        (venta_id, producto_id, tipo_unidad, cantidad, precio_unitario)
        VALUES ($1,$2,$3,$4,$5)`,
        [
          ventaId,
          item.producto_id,
          item.tipo,
          item.cantidad,
          item.precio
        ]
      );

      await client.query(
        "UPDATE productos SET stock = stock - $1 WHERE id = $2",
        [item.descuentoStock, item.producto_id]
      );
      await client.query(`
        INSERT INTO cliente_stock (cliente_id, producto_id, stock)
        VALUES ($1, $2, $3)
        ON CONFLICT (cliente_id, producto_id)
        DO UPDATE SET stock = cliente_stock.stock + EXCLUDED.stock
      `, [cliente_id, item.producto_id, item.descuentoStock]);
    }

    await client.query("COMMIT");

    res.json({ mensaje: "Venta realizada", ventaId });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: error.message });

  } finally {
    client.release();
  }
});

router.get("/frecuentes/:cliente_id", async (req, res) => {
  const { cliente_id } = req.params;

  const result = await pool.query(`
    SELECT p.*, f.cantidad_frecuente
    FROM cliente_productos_frecuentes f
    JOIN productos p ON p.id = f.producto_id
    WHERE f.cliente_id = $1
  `, [cliente_id]);

  res.json(result.rows);
});

export default router;