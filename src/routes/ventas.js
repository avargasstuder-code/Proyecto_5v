import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";

const router = Router();

router.post("/", verificarToken, async (req, res) => {
  const { cliente_id, productos } = req.body;
  const usuario_id = req.user.id;

  // VALIDACIONES (antes de tomar una conexión del pool)
  if (!cliente_id || !Number.isInteger(Number(cliente_id))) {
    return res.status(400).json({ error: "Cliente requerido y debe ser válido" });
  }

  if (!productos || !Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: "No hay productos en la venta" });
  }

  // Validar cada item ANTES de tocar la base de datos
  for (const item of productos) {
    if (!item.producto_id || !Number.isInteger(Number(item.producto_id))) {
      return res.status(400).json({ error: "producto_id inválido" });
    }
    if (
      typeof item.cantidad !== "number" ||
      !Number.isFinite(item.cantidad) ||
      item.cantidad <= 0
    ) {
      return res.status(400).json({ error: "cantidad debe ser un número positivo" });
    }
    if (item.tipo !== undefined && !["carton", "medio"].includes(item.tipo)) {
      return res.status(400).json({ error: "Tipo de unidad inválido" });
    }
  }

  // Recién ahora tomamos una conexión, ya validado el input
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let total = 0;
    let detalles = [];
    let stockError = null;

    // 1. CALCULAR TOTAL Y VALIDAR STOCK
    for (let item of productos) {
      const result = await client.query(
        "SELECT * FROM productos WHERE id = $1",
        [item.producto_id]
      );

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

      // VALIDAR STOCK — usamos throw en vez de return para no dejar
      // la transacción abierta ni la conexión sin liberar
      if (producto.stock < descuentoStock) {
        stockError = `Stock insuficiente para ${producto.nombre}`;
        break;
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

    if (stockError) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: stockError });
    }

    // 1.5 REGISTRAR PRODUCTOS FRECUENTES (solo si todo el pedido es válido)
    for (const item of detalles) {
      await client.query(
        `
        INSERT INTO cliente_productos_frecuentes (cliente_id, producto_id, cantidad_frecuente)
        VALUES ($1, $2, $3)
        ON CONFLICT (cliente_id, producto_id)
        DO UPDATE SET cantidad_frecuente = EXCLUDED.cantidad_frecuente
        `,
        [cliente_id, item.producto_id, item.cantidad]
      );
    }

    // 2. CREAR VENTA (sin método de pago, se define después)
    const venta = await client.query(
      `INSERT INTO ventas 
      (cliente_id, usuario_id, total, metodo_pago, dias_cheque)
      VALUES ($1,$2,$3,NULL,NULL) RETURNING *`,
      [cliente_id, usuario_id, total]
    );

    const ventaId = venta.rows[0].id;

    // 3. DETALLE + STOCK
    for (let item of detalles) {
      await client.query(
        `INSERT INTO detalle_venta 
        (venta_id, producto_id, tipo_unidad, cantidad, precio_unitario)
        VALUES ($1,$2,$3,$4,$5)`,
        [ventaId, item.producto_id, item.tipo, item.cantidad, item.precio]
      );

      await client.query(
        "UPDATE productos SET stock = stock - $1 WHERE id = $2",
        [item.descuentoStock, item.producto_id]
      );

      await client.query(
        `
        INSERT INTO cliente_stock (cliente_id, producto_id, stock)
        VALUES ($1, $2, $3)
        ON CONFLICT (cliente_id, producto_id)
        DO UPDATE SET stock = cliente_stock.stock + EXCLUDED.stock
        `,
        [cliente_id, item.producto_id, item.descuentoStock]
      );
    }

    await client.query("COMMIT");

    res.json({ mensaje: "Venta realizada", ventaId });
  } catch (error) {
    await client.query("ROLLBACK");
    // No exponer error.message crudo al cliente: puede filtrar detalles
    // internos de la base de datos. Se loguea en el servidor y se
    // responde con un mensaje genérico.
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo procesar la venta" });
  } finally {
    client.release();
  }
});

// Requiere autenticación: antes cualquiera podía consultar los
// productos frecuentes de cualquier cliente sin loguearse.
router.get("/frecuentes/:cliente_id", verificarToken, async (req, res) => {
  const { cliente_id } = req.params;

  if (!Number.isInteger(Number(cliente_id))) {
    return res.status(400).json({ error: "cliente_id inválido" });
  }

  try {
    const result = await pool.query(
      `
      SELECT p.*, f.cantidad_frecuente
      FROM cliente_productos_frecuentes f
      JOIN productos p ON p.id = f.producto_id
      WHERE f.cliente_id = $1
      `,
      [cliente_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo obtener los productos frecuentes" });
  }
});

export default router;