import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import { verificarRol } from "../middleware/verificarRol.js";

const router = Router();

router.post("/", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { sucursal_id, productos, metodo_pago } = req.body;
  const usuario_id = req.user.id;

  // VALIDACIONES (antes de tomar una conexión del pool)
  if (!sucursal_id || !Number.isInteger(Number(sucursal_id))) {
    return res.status(400).json({ error: "Sucursal requerida y debe ser válida" });
  }

  if (!productos || !Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: "No hay productos en la venta" });
  }

  // Al momento de la venta solo se puede dejar en efectivo (pagado al
  // toque) o pendiente (se define el método real después, en el panel
  // de Método de pago)
  if (!["efectivo", "pendiente"].includes(metodo_pago)) {
    return res.status(400).json({ error: "Método de pago debe ser 'efectivo' o 'pendiente'" });
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
    if (item.tipo !== undefined && !["carton", "medio", "unidad"].includes(item.tipo)) {
      return res.status(400).json({ error: "Tipo de unidad inválido" });
    }
    // Precio manual opcional: permite venderle a un cliente puntual a un
    // precio distinto al del catálogo, sin tocar el precio del producto
    if (item.precio !== undefined) {
      const precioManual = Number(item.precio);
      if (!Number.isFinite(precioManual) || precioManual < 0) {
        return res.status(400).json({ error: "El precio manual debe ser un número mayor o igual a 0" });
      }
    }
  }

  // Recién ahora tomamos una conexión, ya validado el input
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Verificar que la sucursal exista y, si es vendedor, que sea suya
    const sucursalResult = await client.query("SELECT * FROM sucursales WHERE id = $1", [sucursal_id]);
    const sucursal = sucursalResult.rows[0];

    if (!sucursal) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    if (req.user.rol === "vendedor" && sucursal.usuario_id !== req.user.id) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

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
      const tipoVentaNormalizado = (producto.tipo_venta || "").trim().toLowerCase();

      if (tipoVentaNormalizado === "unitario") {
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

      // Si viene un precio manual (venta con descuento para este
      // cliente puntual), se usa ese en vez del precio de catálogo.
      // El producto en sí no se modifica.
      if (item.precio !== undefined) {
        precio = Number(item.precio);
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
        INSERT INTO cliente_productos_frecuentes (sucursal_id, producto_id, cantidad_frecuente)
        VALUES ($1, $2, $3)
        ON CONFLICT (sucursal_id, producto_id)
        DO UPDATE SET cantidad_frecuente = EXCLUDED.cantidad_frecuente
        `,
        [sucursal_id, item.producto_id, item.cantidad]
      );
    }

    // 2. CREAR VENTA
    // Efectivo queda resuelto de una (pagado); pendiente se define
    // después en el panel de "Método de pago"
    const estadoPagoInicial = metodo_pago === "efectivo" ? "pagado" : null;
    const fechaPagoInicial = metodo_pago === "efectivo" ? new Date() : null;

    const venta = await client.query(
      `INSERT INTO ventas 
      (sucursal_id, usuario_id, total, metodo_pago, dias_cheque, estado_pago, fecha_pago)
      VALUES ($1,$2,$3,$4,NULL,$5,$6) RETURNING *`,
      [sucursal_id, usuario_id, total, metodo_pago, estadoPagoInicial, fechaPagoInicial]
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
        INSERT INTO cliente_stock (sucursal_id, producto_id, stock)
        VALUES ($1, $2, $3)
        ON CONFLICT (sucursal_id, producto_id)
        DO UPDATE SET stock = cliente_stock.stock + EXCLUDED.stock
        `,
        [sucursal_id, item.producto_id, item.descuentoStock]
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
router.get("/frecuentes/:sucursal_id", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { sucursal_id } = req.params;

  if (!Number.isInteger(Number(sucursal_id))) {
    return res.status(400).json({ error: "sucursal_id inválido" });
  }

  try {
    const result = await pool.query(
      `
      SELECT p.*, f.cantidad_frecuente
      FROM cliente_productos_frecuentes f
      JOIN productos p ON p.id = f.producto_id
      WHERE f.sucursal_id = $1
      `,
      [sucursal_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo obtener los productos frecuentes" });
  }
});

// Métodos que se pueden elegir en el panel de "Método de pago" (para
// ventas que quedaron 'pendiente' al momento de vender)
const METODOS_PAGO_VALIDOS = ["efectivo", "credito", "transferencia", "deposito", "cheque_dia", "cheque_fecha"];
const REQUIERE_DIAS = ["credito", "cheque_fecha"];
const REQUIERE_BANCO = ["transferencia"];
const BANCOS_VALIDOS = ["santander", "estado"];
const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Helper: valida que un id venga como entero positivo
function esEnteroValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

// LISTAR VENTAS PENDIENTES DE UN DÍA (para el panel de "Método de pago")
// Solo las que quedaron 'pendiente' al vender — las que ya se dejaron
// en efectivo no aparecen acá, porque ya están resueltas.
// Un vendedor solo ve las suyas; otros roles (ej. admin) ven todas.
router.get("/del-dia", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);

  if (!REGEX_FECHA.test(fecha)) {
    return res.status(400).json({ error: "Fecha inválida, formato esperado YYYY-MM-DD" });
  }

  try {
    const params = [fecha];
    let query = `
      SELECT v.id, v.total, v.metodo_pago, v.dias_cheque, v.banco, v.estado_pago, v.fecha,
             c.nombre AS cliente_nombre, c.apellido AS cliente_apellido,
             s.direccion AS sucursal_direccion
      FROM ventas v
      JOIN sucursales s ON s.id = v.sucursal_id
      JOIN clientes c ON c.id = s.cliente_id
      WHERE ((v.fecha AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date = $1::date
        AND v.metodo_pago = 'pendiente'
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
    res.status(500).json({ error: "No se pudieron obtener las ventas pendientes del día" });
  }
});

// DEFINIR / ACTUALIZAR EL MÉTODO DE PAGO DE UNA VENTA
router.put("/:id/metodo-pago", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { id } = req.params;
  const { metodo_pago, dias, banco } = req.body;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  if (!METODOS_PAGO_VALIDOS.includes(metodo_pago)) {
    return res.status(400).json({ error: "Método de pago inválido" });
  }

  const requierePlazo = REQUIERE_DIAS.includes(metodo_pago);
  let diasPlazo = null;

  if (requierePlazo) {
    diasPlazo = Number(dias);
    if (!Number.isInteger(diasPlazo) || diasPlazo <= 0) {
      return res.status(400).json({ error: "Debes indicar los días de plazo (mayor a 0)" });
    }
  }

  const requiereBanco = REQUIERE_BANCO.includes(metodo_pago);
  let bancoFinal = null;

  if (requiereBanco) {
    if (!BANCOS_VALIDOS.includes(banco)) {
      return res.status(400).json({ error: "Debes indicar el banco (Santander o Estado)" });
    }
    bancoFinal = banco;
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
    const fechaMetodoPago = new Date(); // desde acá empieza a correr el plazo del crédito/cheque a fecha

    const result = await pool.query(
      `
      UPDATE ventas
      SET metodo_pago = $1, dias_cheque = $2, banco = $3, estado_pago = $4, fecha_pago = $5, fecha_metodo_pago = $6, monto_pagado = 0
      WHERE id = $7
      RETURNING *
      `,
      [metodo_pago, diasPlazo, bancoFinal, estadoPago, fechaPago, fechaMetodoPago, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo guardar el método de pago" });
  }
});

// Métodos con los que se puede cobrar una deuda pendiente (no incluye
// crédito/cheque_fecha, porque esos son la causa de la deuda, no la
// forma de saldarla)
const METODOS_ABONO_VALIDOS = ["efectivo", "transferencia", "deposito", "cheque_dia"];

// REGISTRAR UN ABONO (pago total o parcial) A UNA DEUDA (CHEQUE A FECHA O CRÉDITO)
router.post("/:id/abono", verificarToken, verificarRol("admin", "vendedor"), async (req, res) => {
  const { id } = req.params;
  const { monto, metodo_pago, banco } = req.body;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    return res.status(400).json({ error: "El monto debe ser mayor a 0" });
  }

  if (!METODOS_ABONO_VALIDOS.includes(metodo_pago)) {
    return res.status(400).json({ error: "Método de pago inválido" });
  }

  let bancoFinal = null;
  if (metodo_pago === "transferencia") {
    if (!BANCOS_VALIDOS.includes(banco)) {
      return res.status(400).json({ error: "Debes indicar el banco (Santander o Estado)" });
    }
    bancoFinal = banco;
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

    if (!["cheque_fecha", "credito"].includes(venta.metodo_pago)) {
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
      "INSERT INTO abonos_deuda (venta_id, monto, usuario_id, metodo_pago, banco) VALUES ($1, $2, $3, $4, $5)",
      [id, montoNum, req.user.id, metodo_pago, bancoFinal]
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

// PANEL DE DEUDORES: todas las sucursales con saldo pendiente
// (cheque a fecha/crédito), agrupadas por sucursal, con el detalle de
// cada deuda individual
router.get("/deudores", verificarToken, verificarRol("admin", "vendedor"), async (req, res) => {
  try {
    const params = [];
    let query = `
      SELECT
        v.id AS venta_id,
        v.sucursal_id,
        c.nombre AS cliente_nombre,
        c.apellido AS cliente_apellido,
        s.direccion AS sucursal_direccion,
        s.telefono,
        v.total,
        v.monto_pagado,
        (v.total - v.monto_pagado) AS saldo,
        v.metodo_pago,
        v.dias_cheque,
        v.estado_pago,
        v.fecha,
        to_char(
          ((COALESCE(v.fecha_metodo_pago, v.fecha) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date + (v.dias_cheque || ' days')::interval,
          'YYYY-MM-DD'
        ) AS vencimiento,
        (
          ((COALESCE(v.fecha_metodo_pago, v.fecha) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date
            + (v.dias_cheque || ' days')::interval
        ) < (NOW() AT TIME ZONE 'America/Santiago')::date AS vencido
      FROM ventas v
      JOIN sucursales s ON s.id = v.sucursal_id
      JOIN clientes c ON c.id = s.cliente_id
      WHERE v.estado_pago IN ('pendiente', 'parcial')
    `;

    if (req.user.rol === "vendedor") {
      params.push(req.user.id);
      query += ` AND v.usuario_id = $${params.length}`;
    }

    query += " ORDER BY vencimiento ASC";

    const result = await pool.query(query, params);

    // Agrupamos las deudas por sucursal (cada dirección es su propio
    // deudor, aunque comparta RUT con otra sucursal del mismo cliente)
    const porSucursal = {};
    for (const row of result.rows) {
      if (!porSucursal[row.sucursal_id]) {
        porSucursal[row.sucursal_id] = {
          sucursal_id: row.sucursal_id,
          cliente_nombre: row.cliente_nombre,
          cliente_apellido: row.cliente_apellido,
          sucursal_direccion: row.sucursal_direccion,
          telefono: row.telefono,
          deudaTotal: 0,
          deudas: []
        };
      }

      const saldo = Number(row.saldo);
      porSucursal[row.sucursal_id].deudaTotal += saldo;
      porSucursal[row.sucursal_id].deudas.push({
        venta_id: row.venta_id,
        total: Number(row.total),
        monto_pagado: Number(row.monto_pagado),
        saldo,
        metodo_pago: row.metodo_pago,
        dias_cheque: row.dias_cheque,
        estado_pago: row.estado_pago,
        fecha: row.fecha,
        vencimiento: row.vencimiento,
        vencido: row.vencido
      });
    }

    res.json(Object.values(porSucursal));
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo obtener el listado de deudores" });
  }
});

// RESUMEN DEL DÍA POR MÉTODO DE PAGO (para cuadrar caja)
router.get("/resumen", verificarToken, verificarRol("vendedor"), async (req, res) => {
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
      WHERE ((v.fecha AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date = $1::date
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