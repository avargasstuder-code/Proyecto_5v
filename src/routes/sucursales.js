import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import { verificarRol } from "../middleware/verificarRol.js";

const router = Router();

function esEnteroValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

// Vacío/no definido se permite, ya que el teléfono no es obligatorio.
function esTelefonoValido(telefono) {
  if (!telefono) return true;
  const limpio = String(telefono).replace(/[\s-]/g, "");
  return /^9\d{8}$/.test(limpio);
}

// Helper: verifica que la sucursal exista y, si el usuario tiene un
// rol restringido por dueño, que le pertenezca. Devuelve la sucursal o null.
async function obtenerSucursalAutorizada(sucursalId, user) {
  const result = await pool.query("SELECT * FROM sucursales WHERE id = $1", [sucursalId]);
  const sucursal = result.rows[0];
  if (!sucursal) return null;
  if (user.rol === "vendedor" && sucursal.usuario_id !== user.id) return null;
  return sucursal;
}

// OBTENER SUCURSALES (vista por día - solo activas, filtradas por vendedor)
router.get("/", verificarToken, verificarRol("vendedor"), async (req, res) => {
  try {
    const user = req.user;

    let query = `
      SELECT
        s.*,
        c.nombre,
        c.apellido,
        c.rut,
        d.nombre AS dia,
        COALESCE(deuda.total_pendiente, 0) AS deuda_pendiente,
        (visita.id IS NOT NULL) AS visitado_hoy
      FROM sucursales s
      JOIN clientes c ON c.id = s.cliente_id
      JOIN dias_visita d ON d.id = s.dia_id
      LEFT JOIN (
        SELECT sucursal_id, SUM(total - monto_pagado) AS total_pendiente
        FROM ventas
        WHERE estado_pago IN ('pendiente', 'parcial')
        GROUP BY sucursal_id
      ) deuda ON deuda.sucursal_id = s.id
      LEFT JOIN visitas_ruta visita
        ON visita.sucursal_id = s.id
        AND visita.fecha = (NOW() AT TIME ZONE 'America/Santiago')::date
      WHERE s.activo = true
    `;
    const params = [];

    if (user.rol === "vendedor") {
      params.push(user.id);
      query += ` AND s.usuario_id = $${params.length}`;
    }

    // Las visitadas hoy quedan al final; dentro de cada grupo, según
    // el orden de visita que se haya definido para ese día
    query += " ORDER BY d.id, (visita.id IS NOT NULL) ASC, s.orden_visita ASC NULLS LAST, s.id ASC";

    const result = await pool.query(query, params);

    const sucursales = result.rows.map(s => ({
      ...s,
      deuda_pendiente: Number(s.deuda_pendiente)
    }));

    res.json(sucursales);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener sucursales" });
  }
});

// LISTADO COMPLETO (activas e inactivas, con ciudad y vendedor) - para editar/desactivar
router.get("/todos", verificarToken, verificarRol("vendedor"), async (req, res) => {
  try {
    const user = req.user;

    let query = `
      SELECT
        s.*,
        c.nombre,
        c.apellido,
        c.rut,
        d.nombre AS dia,
        ciu.nombre AS ciudad,
        u.nombre AS vendedor
      FROM sucursales s
      JOIN clientes c ON c.id = s.cliente_id
      JOIN dias_visita d ON d.id = s.dia_id
      LEFT JOIN ciudades ciu ON ciu.id = s.ciudad_id
      LEFT JOIN usuarios u ON u.id = s.usuario_id
    `;
    const params = [];

    if (user.rol === "vendedor") {
      params.push(user.id);
      query += ` WHERE s.usuario_id = $${params.length}`;
    }

    query += " ORDER BY c.nombre, s.id";

    const result = await pool.query(query, params);

    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener listado de sucursales" });
  }
});

// MARCAR / DESMARCAR "YA PASÉ" (se resetea solo cada día, según fecha)
router.post("/:id/toggle-visitado", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { id } = req.params;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    const sucursalAutorizada = await obtenerSucursalAutorizada(id, req.user);
    if (!sucursalAutorizada) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    const existente = await pool.query(
      `SELECT id FROM visitas_ruta
       WHERE sucursal_id = $1
         AND fecha = (NOW() AT TIME ZONE 'America/Santiago')::date`,
      [id]
    );

    if (existente.rows.length > 0) {
      await pool.query("DELETE FROM visitas_ruta WHERE id = $1", [existente.rows[0].id]);
      return res.json({ visitado: false });
    }

    await pool.query(
      `INSERT INTO visitas_ruta (sucursal_id, fecha, usuario_id)
       VALUES ($1, (NOW() AT TIME ZONE 'America/Santiago')::date, $2)`,
      [id, req.user.id]
    );

    res.json({ visitado: true });
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo actualizar la visita" });
  }
});

// GUARDAR EL ORDEN DE VISITA (arrastrar/mover dentro del día)
router.put("/orden-visita", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids debe ser un arreglo con al menos un elemento" });
  }

  for (const id of ids) {
    if (!esEnteroValido(id)) {
      return res.status(400).json({ error: "Hay un id inválido en la lista" });
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (let i = 0; i < ids.length; i++) {
      const sucursalResult = await client.query(
        "SELECT usuario_id FROM sucursales WHERE id = $1",
        [ids[i]]
      );
      const sucursal = sucursalResult.rows[0];

      if (!sucursal) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: `Sucursal ${ids[i]} no encontrada` });
      }

      if (req.user.rol === "vendedor" && sucursal.usuario_id !== req.user.id) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Sucursal no encontrada" });
      }

      await client.query(
        "UPDATE sucursales SET orden_visita = $1 WHERE id = $2",
        [i, ids[i]]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo guardar el orden" });
  } finally {
    client.release();
  }
});

// CREAR SUCURSAL (y el cliente si es un RUT nuevo; si el RUT ya
// existe, esta sucursal queda asociada al cliente que ya tenías)
router.post("/", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const {
    nombre,
    apellido,
    rut,
    direccion,
    ciudad_id,
    dia_id,
    telefono
  } = req.body;

  if (!nombre || !apellido || !rut || !direccion || !dia_id || !ciudad_id) {
    return res.status(400).json({
      error: "Nombre, apellido, RUT, dirección, ciudad y día son obligatorios"
    });
  }

  if (!esEnteroValido(dia_id)) {
    return res.status(400).json({ error: "dia_id inválido" });
  }

  if (!esEnteroValido(ciudad_id)) {
    return res.status(400).json({ error: "ciudad_id inválido" });
  }

  if (!esTelefonoValido(telefono)) {
    return res.status(400).json({ error: "Teléfono inválido. Formato esperado: 912345678" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ¿Ya existe un cliente con ese RUT? Si sí, esta sucursal se le
    // agrega a ese cliente (no se crea uno nuevo ni se duplica).
    const existente = await client.query("SELECT * FROM clientes WHERE rut = $1", [rut]);
    let clienteId;
    let clienteExistente = false;

    if (existente.rows.length > 0) {
      clienteId = existente.rows[0].id;
      clienteExistente = true;
    } else {
      const nuevoCliente = await client.query(
        `INSERT INTO clientes (nombre, apellido, rut, activo) VALUES ($1,$2,$3,true) RETURNING id`,
        [nombre, apellido, rut]
      );
      clienteId = nuevoCliente.rows[0].id;
    }

    const sucursalResult = await client.query(
      `
      INSERT INTO sucursales
      (cliente_id, direccion, telefono, ciudad_id, dia_id, usuario_id, activo)
      VALUES ($1,$2,$3,$4,$5,$6,true)
      RETURNING *
      `,
      [clienteId, direccion, telefono || null, ciudad_id, dia_id, req.user.id]
    );

    await client.query("COMMIT");

    res.json({
      ...sucursalResult.rows[0],
      clienteExistente,
      nombre,
      apellido,
      rut
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(400).json({ error: "Ya existe un cliente con ese RUT" });
    }
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al crear la sucursal" });
  } finally {
    client.release();
  }
});

// ACTUALIZAR SUCURSAL (y de paso, la identidad del cliente si cambió
// nombre/apellido/rut — afecta a todas sus otras sucursales, porque
// es la misma persona/empresa)
router.put("/:id", verificarToken, verificarRol("vendedor"), async (req, res) => {
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

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  if (!nombre || !apellido || !rut || !direccion || !dia_id || !ciudad_id) {
    return res.status(400).json({
      error: "Nombre, apellido, RUT, dirección, ciudad y día son obligatorios"
    });
  }

  if (!esEnteroValido(dia_id)) {
    return res.status(400).json({ error: "dia_id inválido" });
  }

  if (!esEnteroValido(ciudad_id)) {
    return res.status(400).json({ error: "ciudad_id inválido" });
  }

  if (!esTelefonoValido(telefono)) {
    return res.status(400).json({ error: "Teléfono inválido. Formato esperado: 912345678" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Control de propiedad: un vendedor solo puede editar sus propias sucursales
    const sucursalActual = await client.query("SELECT * FROM sucursales WHERE id = $1", [id]);
    const sucursal = sucursalActual.rows[0];

    if (!sucursal || (req.user.rol === "vendedor" && sucursal.usuario_id !== req.user.id)) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    const existeOtroRut = await client.query(
      "SELECT id FROM clientes WHERE rut = $1 AND id != $2",
      [rut, sucursal.cliente_id]
    );

    if (existeOtroRut.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ya existe otro cliente con ese RUT" });
    }

    await client.query(
      `UPDATE clientes SET nombre = $1, apellido = $2, rut = $3 WHERE id = $4`,
      [nombre, apellido, rut, sucursal.cliente_id]
    );

    const result = await client.query(
      `
      UPDATE sucursales
      SET direccion = $1, telefono = $2, ciudad_id = $3, dia_id = $4
      WHERE id = $5
      RETURNING *
      `,
      [direccion, telefono || null, ciudad_id, dia_id, id]
    );

    await client.query("COMMIT");

    res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(400).json({ error: "Ya existe otro cliente con ese RUT" });
    }
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al actualizar la sucursal" });
  } finally {
    client.release();
  }
});

// ACTIVAR / DESACTIVAR SUCURSAL
router.put("/:id/activo", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { id } = req.params;
  const { activo } = req.body;

  try {
    if (!esEnteroValido(id)) {
      return res.status(400).json({ error: "id inválido" });
    }

    if (typeof activo !== "boolean") {
      return res.status(400).json({ error: "activo debe ser true o false" });
    }

    const sucursalAutorizada = await obtenerSucursalAutorizada(id, req.user);
    if (!sucursalAutorizada) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    await pool.query(
      "UPDATE sucursales SET activo = $1 WHERE id = $2",
      [activo, id]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al cambiar estado de la sucursal" });
  }
});

// PRODUCTOS FRECUENTES
router.get("/frecuentes/:sucursal_id", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { sucursal_id } = req.params;

  if (!esEnteroValido(sucursal_id)) {
    return res.status(400).json({ error: "sucursal_id inválido" });
  }

  try {
    const sucursalAutorizada = await obtenerSucursalAutorizada(sucursal_id, req.user);
    if (!sucursalAutorizada) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    const result = await pool.query(`
      SELECT
        p.id,
        p.nombre,
        f.cantidad_frecuente
      FROM cliente_productos_frecuentes f
      JOIN productos p
        ON p.id = f.producto_id
      WHERE f.sucursal_id = $1
    `, [sucursal_id]);

    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener productos frecuentes" });
  }
});

// STOCK DE LA SUCURSAL
router.get("/stock/:sucursal_id", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { sucursal_id } = req.params;

  if (!esEnteroValido(sucursal_id)) {
    return res.status(400).json({ error: "sucursal_id inválido" });
  }

  try {
    const sucursalAutorizada = await obtenerSucursalAutorizada(sucursal_id, req.user);
    if (!sucursalAutorizada) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    const result = await pool.query(`
      SELECT
        p.id,
        p.nombre,
        cs.stock
      FROM cliente_stock cs
      JOIN productos p
        ON p.id = cs.producto_id
      WHERE cs.sucursal_id = $1
    `, [sucursal_id]);

    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener stock de la sucursal" });
  }
});

// GUARDAR STOCK ACTUAL
router.post(
  "/stock-actual",
  verificarToken,
  verificarRol("vendedor"),
  async (req, res) => {
    const {
      sucursal_id,
      producto_id,
      stock_actual
    } = req.body;

    if (!esEnteroValido(sucursal_id) || !esEnteroValido(producto_id)) {
      return res.status(400).json({ error: "sucursal_id o producto_id inválido" });
    }

    const stockNum = Number(stock_actual);
    if (!Number.isFinite(stockNum) || stockNum < 0) {
      return res.status(400).json({ error: "Stock inválido" });
    }

    try {
      const sucursalAutorizada = await obtenerSucursalAutorizada(sucursal_id, req.user);
      if (!sucursalAutorizada) {
        return res.status(404).json({ error: "Sucursal no encontrada" });
      }

      const existe = await pool.query(`
        SELECT *
        FROM cliente_stock
        WHERE sucursal_id = $1
        AND producto_id = $2
      `, [sucursal_id, producto_id]);

      if (existe.rows.length > 0) {
        await pool.query(`
          UPDATE cliente_stock
          SET stock = $1
          WHERE sucursal_id = $2
          AND producto_id = $3
        `, [stockNum, sucursal_id, producto_id]);
      } else {
        await pool.query(`
          INSERT INTO cliente_stock (sucursal_id, producto_id, stock)
          VALUES ($1,$2,$3)
        `, [sucursal_id, producto_id, stockNum]);
      }

      await pool.query(`
        INSERT INTO historial_stock_cliente (sucursal_id, producto_id, stock_actual)
        VALUES ($1,$2,$3)
      `, [sucursal_id, producto_id, stockNum]);

      res.json({ ok: true });
    } catch (error) {
      console.error("ERROR REAL:", error);
      res.status(500).json({ error: "Error al guardar stock" });
    }
  }
);

// ÚLTIMAS VENTAS
router.get("/ultimas-ventas/:sucursal_id", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { sucursal_id } = req.params;

  if (!esEnteroValido(sucursal_id)) {
    return res.status(400).json({ error: "sucursal_id inválido" });
  }

  try {
    const sucursalAutorizada = await obtenerSucursalAutorizada(sucursal_id, req.user);
    if (!sucursalAutorizada) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    const result = await pool.query(`
      SELECT id, total, fecha
      FROM ventas
      WHERE sucursal_id = $1
      ORDER BY fecha DESC
      LIMIT 3
    `, [sucursal_id]);

    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener últimas ventas" });
  }
});

// DÍAS
router.get("/dias", verificarToken, verificarRol("vendedor"), async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM dias_visita ORDER BY id`);
    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener días" });
  }
});

// ÚLTIMOS STOCKS
router.get(
  "/ultimos-stocks/:sucursalId",
  verificarToken,
  verificarRol("vendedor"),
  async (req, res) => {
    const { sucursalId } = req.params;

    if (!esEnteroValido(sucursalId)) {
      return res.status(400).json({ error: "sucursalId inválido" });
    }

    try {
      const sucursalAutorizada = await obtenerSucursalAutorizada(sucursalId, req.user);
      if (!sucursalAutorizada) {
        return res.status(404).json({ error: "Sucursal no encontrada" });
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
        WHERE h.sucursal_id = $1
        ORDER BY h.fecha DESC
        LIMIT 50
      `, [sucursalId]);

      res.json(result.rows);
    } catch (error) {
      console.error("ERROR REAL:", error);
      res.status(500).json({ error: "Error al obtener últimos stocks" });
    }
  }
);

// DEUDA PENDIENTE DE UNA SUCURSAL (cheque a fecha o crédito aún no
// cobrados). Se usa antes de venderle, para avisarle al vendedor.
router.get("/:id/deuda", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { id } = req.params;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    const sucursalAutorizada = await obtenerSucursalAutorizada(id, req.user);
    if (!sucursalAutorizada) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
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
        to_char(
          ((COALESCE(fecha_metodo_pago, fecha) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date + (dias_cheque || ' days')::interval,
          'YYYY-MM-DD'
        ) AS vencimiento,
        (
          ((COALESCE(fecha_metodo_pago, fecha) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date
            + (dias_cheque || ' days')::interval
        ) < (NOW() AT TIME ZONE 'America/Santiago')::date AS vencido
      FROM ventas
      WHERE sucursal_id = $1
        AND estado_pago IN ('pendiente', 'parcial')
        AND metodo_pago IN ('cheque_fecha', 'credito')
      ORDER BY fecha ASC
      `,
      [id]
    );

    const deudas = result.rows.map(r => ({
      ...r,
      total: Number(r.total),
      monto_pagado: Number(r.monto_pagado),
      saldo: Number(r.saldo)
    }));

    res.json({
      tieneDeuda: deudas.length > 0,
      deudas
    });
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo consultar la deuda de la sucursal" });
  }
});

export default router;