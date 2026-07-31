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

const METODOS_PAGO_VALIDOS = ["efectivo", "transferencia", "deposito", "cheque", "credito"];
const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Helper: valida que un id venga como entero positivo
function esEnteroValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

// LISTAR VENTAS DE UN DÍA (para el panel de "Cierre del día")
// Un vendedor solo ve las suyas; otros roles (ej. admin) ven todas.
router.get("/del-dia", verificarToken, async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);

  if (!REGEX_FECHA.test(fecha)) {
    return res.status(400).json({ error: "Fecha inválida, formato esperado YYYY-MM-DD" });
  }

  try {
    const params = [fecha];
    let query = `
      SELECT v.id, v.total, v.metodo_pago, v.dias_cheque, v.estado_pago, v.fecha,
             c.nombre AS cliente_nombre, c.apellido AS cliente_apellido
      FROM ventas v
      JOIN clientes c ON c.id = v.cliente_id
      WHERE v.fecha::date = $1::date
    `;

    if (req.user.rol === "vendedor") {
      params.push(req.user.id);
      query += ` AND v.usuario_id = $${params.length}`;
    }

    query += " ORDER BY v.fecha ASC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudieron obtener las ventas del día" });
  }
});

// DEFINIR / ACTUALIZAR EL MÉTODO DE PAGO DE UNA VENTA
router.put("/:id/metodo-pago", verificarToken, async (req, res) => {
  const { id } = req.params;
  const { metodo_pago, dias } = req.body;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  if (!METODOS_PAGO_VALIDOS.includes(metodo_pago)) {
    return res.status(400).json({ error: "Método de pago inválido" });
  }

  const requierePlazo = metodo_pago === "cheque" || metodo_pago === "credito";
  let diasPlazo = null;

  if (requierePlazo) {
    diasPlazo = Number(dias);
    if (!Number.isInteger(diasPlazo) || diasPlazo <= 0) {
      return res.status(400).json({ error: "Debes indicar los días de plazo (mayor a 0)" });
    }
  }

  try {
    const ventaResult = await pool.query("SELECT * FROM ventas WHERE id = $1", [id]);
    const venta = ventaResult.rows[0];

    if (!venta) {
      return res.status(404).json({ error: "Venta no encontrada" });
    }

    // Un vendedor solo puede definir el método de pago de sus propias ventas
    if (req.user.rol === "vendedor" && venta.usuario_id !== req.user.id) {
      return res.status(404).json({ error: "Venta no encontrada" });
    }

    const estadoPago = requierePlazo ? "pendiente" : "pagado";
    const fechaPago = requierePlazo ? null : new Date();

    const result = await pool.query(
      `
      UPDATE ventas
      SET metodo_pago = $1, dias_cheque = $2, estado_pago = $3, fecha_pago = $4
      WHERE id = $5
      RETURNING *
      `,
      [metodo_pago, diasPlazo, estadoPago, fechaPago, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo guardar el método de pago" });
  }
});

// REGISTRAR UN ABONO (pago total o parcial) A UNA DEUDA (CHEQUE O CRÉDITO)
router.post("/:id/abono", verificarToken, async (req, res) => {
  const { id } = req.params;
  const { monto } = req.body;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    return res.status(400).json({ error: "El monto debe ser mayor a 0" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ventaResult = await client.query(
      "SELECT * FROM ventas WHERE id = $1 FOR UPDATE",
      [id]
    );
    const venta = ventaResult.rows[0];

    if (!venta) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Venta no encontrada" });
    }

    if (req.user.rol === "vendedor" && venta.usuario_id !== req.user.id) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Venta no encontrada" });
    }

    if (!["cheque", "credito"].includes(venta.metodo_pago)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Esta venta no tiene una deuda asociada" });
    }

    const saldoActual = Number(venta.total) - Number(venta.monto_pagado || 0);

    // Margen de 1 peso por posibles redondeos
    if (montoNum > saldoActual + 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `El monto no puede ser mayor al saldo pendiente ($${Math.round(saldoActual)})`
      });
    }

    await client.query(
      "INSERT INTO abonos_deuda (venta_id, monto, usuario_id) VALUES ($1, $2, $3)",
      [id, montoNum, req.user.id]
    );

    const nuevoMontoPagado = Number(venta.monto_pagado || 0) + montoNum;
    const quedaPendiente = Number(venta.total) - nuevoMontoPagado > 1;
    const nuevoEstado = quedaPendiente
      ? (nuevoMontoPagado > 0 ? "parcial" : "pendiente")
      : "pagado";
    const fechaPago = nuevoEstado === "pagado" ? new Date() : venta.fecha_pago;

    const result = await client.query(
      `
      UPDATE ventas
      SET monto_pagado = $1, estado_pago = $2, fecha_pago = $3
      WHERE id = $4
      RETURNING *
      `,
      [nuevoMontoPagado, nuevoEstado, fechaPago, id]
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo registrar el abono" });
  } finally {
    client.release();
  }
});

// PANEL DE DEUDORES: todos los clientes con saldo pendiente (cheque/crédito),
// agrupados, con el detalle de cada deuda individual
router.get("/deudores", verificarToken, async (req, res) => {
  try {
    const params = [];
    let query = `
      SELECT
        v.id AS venta_id,
        v.cliente_id,
        c.nombre AS cliente_nombre,
        c.apellido AS cliente_apellido,
        c.telefono,
        v.total,
        v.monto_pagado,
        (v.total - v.monto_pagado) AS saldo,
        v.metodo_pago,
        v.dias_cheque,
        v.estado_pago,
        v.fecha,
        to_char(v.fecha::date + (v.dias_cheque || ' days')::interval, 'YYYY-MM-DD') AS vencimiento
      FROM ventas v
      JOIN clientes c ON c.id = v.cliente_id
      WHERE v.estado_pago IN ('pendiente', 'parcial')
    `;

    if (req.user.rol === "vendedor") {
      params.push(req.user.id);
      query += ` AND v.usuario_id = $${params.length}`;
    }

    query += " ORDER BY vencimiento ASC";

    const result = await pool.query(query, params);
    const hoy = new Date().toISOString().slice(0, 10);

    // Agrupamos las deudas por cliente
    const porCliente = {};
    for (const row of result.rows) {
      if (!porCliente[row.cliente_id]) {
        porCliente[row.cliente_id] = {
          cliente_id: row.cliente_id,
          cliente_nombre: row.cliente_nombre,
          cliente_apellido: row.cliente_apellido,
          telefono: row.telefono,
          deudaTotal: 0,
          deudas: []
        };
      }

      const saldo = Number(row.saldo);
      porCliente[row.cliente_id].deudaTotal += saldo;
      porCliente[row.cliente_id].deudas.push({
        venta_id: row.venta_id,
        total: Number(row.total),
        monto_pagado: Number(row.monto_pagado),
        saldo,
        metodo_pago: row.metodo_pago,
        dias_cheque: row.dias_cheque,
        estado_pago: row.estado_pago,
        fecha: row.fecha,
        vencimiento: row.vencimiento,
        vencido: row.vencimiento < hoy
      });
    }

    res.json(Object.values(porCliente));
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo obtener el listado de deudores" });
  }
});

// RESUMEN DEL DÍA POR MÉTODO DE PAGO (para cuadrar caja)
router.get("/resumen", verificarToken, async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);

  if (!REGEX_FECHA.test(fecha)) {
    return res.status(400).json({ error: "Fecha inválida, formato esperado YYYY-MM-DD" });
  }

  try {
    const params = [fecha];
    let query = `
      SELECT
        COALESCE(v.metodo_pago, 'sin_definir') AS metodo_pago,
        COUNT(*)::int AS cantidad,
        COALESCE(SUM(v.total), 0)::numeric AS total
      FROM ventas v
      WHERE v.fecha::date = $1::date
    `;

    if (req.user.rol === "vendedor") {
      params.push(req.user.id);
      query += ` AND v.usuario_id = $${params.length}`;
    }

    query += " GROUP BY COALESCE(v.metodo_pago, 'sin_definir') ORDER BY metodo_pago";

    const result = await pool.query(query, params);
    const totalGeneral = result.rows.reduce((acc, r) => acc + Number(r.total), 0);

    res.json({ fecha, detalle: result.rows, totalGeneral });
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo obtener el resumen del día" });
  }
});

export default router;