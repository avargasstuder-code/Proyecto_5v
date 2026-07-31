import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";

const router = Router();

// Helper: valida que un valor sea un entero positivo
function esEnteroValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

// Helper: verifica que el cliente exista y, si el usuario es vendedor,
// que le pertenezca. Devuelve el cliente o null.
async function obtenerClienteAutorizado(clienteId, user) {
  const result = await pool.query("SELECT * FROM clientes WHERE id = $1", [clienteId]);
  const cliente = result.rows[0];
  if (!cliente) return null;
  if (user.rol === "vendedor" && cliente.usuario_id !== user.id) return null;
  return cliente;
}

// OBTENER CLIENTES (vista por día - solo activos, filtrados por vendedor)
router.get("/", verificarToken, async (req, res) => {
  try {
    const user = req.user;

    let query = `
      SELECT c.*, d.nombre AS dia
      FROM clientes c
      JOIN dias_visita d ON d.id = c.dia_id
      WHERE c.activo = true
    `;
    const params = [];

    if (user.rol === "vendedor") {
      params.push(user.id);
      query += ` AND c.usuario_id = $${params.length}`;
    }

    query += " ORDER BY d.id, c.nombre";

    const result = await pool.query(query, params);

    res.json(result.rows);

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Error al obtener clientes"
    });
  }
});

// LISTADO COMPLETO (activos e inactivos, con ciudad y vendedor) - para editar/desactivar
router.get("/todos", verificarToken, async (req, res) => {
  try {
    const user = req.user;

    let query = `
      SELECT c.*, d.nombre AS dia, ciu.nombre AS ciudad, u.nombre AS vendedor
      FROM clientes c
      JOIN dias_visita d ON d.id = c.dia_id
      LEFT JOIN ciudades ciu ON ciu.id = c.ciudad_id
      LEFT JOIN usuarios u ON u.id = c.usuario_id
    `;
    const params = [];

    if (user.rol === "vendedor") {
      params.push(user.id);
      query += ` WHERE c.usuario_id = $${params.length}`;
    }

    query += " ORDER BY c.nombre";

    const result = await pool.query(query, params);

    res.json(result.rows);

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Error al obtener listado de clientes"
    });
  }
});

// CREAR CLIENTE (queda asignado al usuario logueado)
router.post("/", verificarToken, async (req, res) => {

  const {
    nombre,
    apellido,
    rut,
    direccion,
    ciudad_id,
    dia_id,
    telefono
  } = req.body;

  try {

    if (!nombre || !apellido || !rut || !dia_id) {
      return res.status(400).json({
        error: "Faltan datos obligatorios"
      });
    }

    if (!esEnteroValido(dia_id)) {
      return res.status(400).json({ error: "dia_id inválido" });
    }

    if (ciudad_id !== undefined && ciudad_id !== null && !esEnteroValido(ciudad_id)) {
      return res.status(400).json({ error: "ciudad_id inválido" });
    }

    const existe = await pool.query(
      "SELECT * FROM clientes WHERE rut = $1",
      [rut]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({
        error: "Cliente ya existe con ese RUT"
      });
    }

    const result = await pool.query(`
      INSERT INTO clientes
      (
        nombre,
        apellido,
        rut,
        direccion,
        ciudad_id,
        dia_id,
        telefono,
        usuario_id,
        activo
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
      RETURNING *
    `, [
      nombre,
      apellido,
      rut,
      direccion,
      ciudad_id,
      dia_id,
      telefono,
      req.user.id
    ]);

    res.json(result.rows[0]);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Error al crear cliente"
    });
  }
});

// ACTUALIZAR CLIENTE
router.put("/:id", verificarToken, async (req, res) => {
  const { id } = req.params;

  const {
    nombre,
    apellido,
    rut,
    direccion,
    ciudad_id,
    dia_id,
    telefono
  } = req.body;

  try {

    if (!esEnteroValido(id)) {
      return res.status(400).json({ error: "id inválido" });
    }

    if (!nombre || !apellido || !rut || !dia_id) {
      return res.status(400).json({
        error: "Faltan datos obligatorios"
      });
    }

    if (!esEnteroValido(dia_id)) {
      return res.status(400).json({ error: "dia_id inválido" });
    }

    if (ciudad_id !== undefined && ciudad_id !== null && !esEnteroValido(ciudad_id)) {
      return res.status(400).json({ error: "ciudad_id inválido" });
    }

    // Control de propiedad: un vendedor solo puede editar sus propios clientes
    const clienteAutorizado = await obtenerClienteAutorizado(id, req.user);
    if (!clienteAutorizado) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const existe = await pool.query(
      "SELECT * FROM clientes WHERE rut = $1 AND id != $2",
      [rut, id]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({
        error: "Ya existe otro cliente con ese RUT"
      });
    }

    const result = await pool.query(`
      UPDATE clientes
      SET nombre = $1,
          apellido = $2,
          rut = $3,
          direccion = $4,
          ciudad_id = $5,
          dia_id = $6,
          telefono = $7
      WHERE id = $8
      RETURNING *
    `, [
      nombre,
      apellido,
      rut,
      direccion,
      ciudad_id,
      dia_id,
      telefono,
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar cliente" });
  }
});

// ACTIVAR / DESACTIVAR CLIENTE
router.put("/:id/activo", verificarToken, async (req, res) => {
  const { id } = req.params;
  const { activo } = req.body;

  try {

    if (!esEnteroValido(id)) {
      return res.status(400).json({ error: "id inválido" });
    }

    if (typeof activo !== "boolean") {
      return res.status(400).json({ error: "activo debe ser true o false" });
    }

    // Control de propiedad: un vendedor solo puede (des)activar sus propios clientes
    const clienteAutorizado = await obtenerClienteAutorizado(id, req.user);
    if (!clienteAutorizado) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    await pool.query(
      "UPDATE clientes SET activo = $1 WHERE id = $2",
      [activo, id]
    );

    res.json({ ok: true });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al cambiar estado del cliente" });
  }
});

// PRODUCTOS FRECUENTES
router.get("/frecuentes/:cliente_id", verificarToken, async (req, res) => {

  const { cliente_id } = req.params;

  if (!esEnteroValido(cliente_id)) {
    return res.status(400).json({ error: "cliente_id inválido" });
  }

  try {
    const clienteAutorizado = await obtenerClienteAutorizado(cliente_id, req.user);
    if (!clienteAutorizado) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const result = await pool.query(`
      SELECT
        p.id,
        p.nombre,
        f.cantidad_frecuente
      FROM cliente_productos_frecuentes f
      JOIN productos p
        ON p.id = f.producto_id
      WHERE f.cliente_id = $1
    `, [cliente_id]);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener productos frecuentes" });
  }
});

// STOCK CLIENTE
router.get("/stock/:cliente_id", verificarToken, async (req, res) => {

  const { cliente_id } = req.params;

  if (!esEnteroValido(cliente_id)) {
    return res.status(400).json({ error: "cliente_id inválido" });
  }

  try {
    const clienteAutorizado = await obtenerClienteAutorizado(cliente_id, req.user);
    if (!clienteAutorizado) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const result = await pool.query(`
      SELECT
        p.id,
        p.nombre,
        cs.stock
      FROM cliente_stock cs
      JOIN productos p
        ON p.id = cs.producto_id
      WHERE cs.cliente_id = $1
    `, [cliente_id]);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener stock del cliente" });
  }
});

// GUARDAR STOCK ACTUAL
router.post(
  "/stock-actual",
  verificarToken,
  async (req, res) => {

    const {
      cliente_id,
      producto_id,
      stock_actual
    } = req.body;

    if (!esEnteroValido(cliente_id) || !esEnteroValido(producto_id)) {
      return res.status(400).json({ error: "cliente_id o producto_id inválido" });
    }

    const stockNum = Number(stock_actual);
    if (!Number.isFinite(stockNum) || stockNum < 0) {
      return res.status(400).json({
        error: "Stock inválido"
      });
    }

    try {

      // Control de propiedad: un vendedor solo puede reportar stock
      // de sus propios clientes
      const clienteAutorizado = await obtenerClienteAutorizado(cliente_id, req.user);
      if (!clienteAutorizado) {
        return res.status(404).json({ error: "Cliente no encontrado" });
      }

      // verificar si existe
      const existe = await pool.query(`
        SELECT *
        FROM cliente_stock
        WHERE cliente_id = $1
        AND producto_id = $2
      `, [
        cliente_id,
        producto_id
      ]);

      if (existe.rows.length > 0) {

        // actualizar
        await pool.query(`
          UPDATE cliente_stock
          SET stock = $1
          WHERE cliente_id = $2
          AND producto_id = $3
        `, [
          stockNum,
          cliente_id,
          producto_id
        ]);

      } else {

        // crear
        await pool.query(`
          INSERT INTO cliente_stock
          (
            cliente_id,
            producto_id,
            stock
          )
          VALUES ($1,$2,$3)
        `, [
          cliente_id,
          producto_id,
          stockNum
        ]);
      }

      // guardar historial
      await pool.query(`
        INSERT INTO historial_stock_cliente
        (
          cliente_id,
          producto_id,
          stock_actual
        )
        VALUES ($1,$2,$3)
      `, [
        cliente_id,
        producto_id,
        stockNum
      ]);

      res.json({
        ok: true
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Error al guardar stock"
      });
    }
});

// ÚLTIMAS VENTAS
router.get("/ultimas-ventas/:cliente_id", verificarToken, async (req, res) => {

  const { cliente_id } = req.params;

  if (!esEnteroValido(cliente_id)) {
    return res.status(400).json({ error: "cliente_id inválido" });
  }

  try {
    const clienteAutorizado = await obtenerClienteAutorizado(cliente_id, req.user);
    if (!clienteAutorizado) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const result = await pool.query(`
      SELECT
        id,
        total,
        fecha
      FROM ventas
      WHERE cliente_id = $1
      ORDER BY fecha DESC
      LIMIT 3
    `, [cliente_id]);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener últimas ventas" });
  }
});

// DÍAS
router.get("/dias", verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM dias_visita
      ORDER BY id
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener días" });
  }
});

// ÚLTIMOS STOCKS
router.get(
  "/ultimos-stocks/:clienteId",
  verificarToken,
  async (req, res) => {

    const { clienteId } = req.params;

    if (!esEnteroValido(clienteId)) {
      return res.status(400).json({ error: "clienteId inválido" });
    }

    try {
      const clienteAutorizado = await obtenerClienteAutorizado(clienteId, req.user);
      if (!clienteAutorizado) {
        return res.status(404).json({ error: "Cliente no encontrado" });
      }

      const result = await pool.query(`
        SELECT
          h.producto_id,
          h.stock_actual,
          h.fecha,
          p.nombre
        FROM historial_stock_cliente h
        JOIN productos p
          ON p.id = h.producto_id
        WHERE h.cliente_id = $1
        ORDER BY h.fecha DESC
        LIMIT 50
      `, [clienteId]);

      res.json(result.rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Error al obtener últimos stocks" });
    }
  }
);

// DEUDA PENDIENTE DE UN CLIENTE (cheques o créditos aún no cobrados)
// Se usa antes de venderle, para avisarle al vendedor que tiene algo pendiente.
router.get("/:id/deuda", verificarToken, async (req, res) => {
  const { id } = req.params;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    const clienteAutorizado = await obtenerClienteAutorizado(id, req.user);
    if (!clienteAutorizado) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        total,
        monto_pagado,
        (total - monto_pagado) AS saldo,
        metodo_pago,
        dias_cheque,
        estado_pago,
        fecha,
        to_char(fecha::date + (dias_cheque || ' days')::interval, 'YYYY-MM-DD') AS vencimiento
      FROM ventas
      WHERE cliente_id = $1
        AND estado_pago IN ('pendiente', 'parcial')
        AND metodo_pago IN ('cheque', 'credito')
      ORDER BY fecha ASC
      `,
      [id]
    );

    const hoy = new Date().toISOString().slice(0, 10);

    const deudas = result.rows.map(r => ({
      ...r,
      total: Number(r.total),
      monto_pagado: Number(r.monto_pagado),
      saldo: Number(r.saldo),
      vencido: r.vencimiento < hoy
    }));

    res.json({
      tieneDeuda: deudas.length > 0,
      deudas
    });
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo consultar la deuda del cliente" });
  }
});

export default router;