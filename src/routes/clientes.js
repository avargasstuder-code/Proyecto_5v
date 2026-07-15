import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";

const router = Router();

// OBTENER CLIENTES
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, d.nombre AS dia
      FROM clientes c
      JOIN dias_visita d ON d.id = c.dia_id
      ORDER BY d.id, c.nombre
    `);

    res.json(result.rows);

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Error al obtener clientes"
    });
  }
});

// CREAR CLIENTE
router.post("/", async (req, res) => {

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

    if (!nombre || !rut || !dia_id) {
      return res.status(400).json({
        error: "Faltan datos obligatorios"
      });
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
        telefono
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [
      nombre,
      apellido,
      rut,
      direccion,
      ciudad_id,
      dia_id,
      telefono
    ]);

    res.json(result.rows[0]);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Error al crear cliente"
    });
  }
});

// PRODUCTOS FRECUENTES
router.get("/frecuentes/:cliente_id", async (req, res) => {

  const { cliente_id } = req.params;

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
});

// STOCK CLIENTE
router.get("/stock/:cliente_id", async (req, res) => {

  const { cliente_id } = req.params;

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

    if (stock_actual < 0) {
      return res.status(400).json({
        error: "Stock inválido"
      });
    }

    try {

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
          stock_actual,
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
          stock_actual
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
        stock_actual
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
router.get("/ultimas-ventas/:cliente_id", async (req, res) => {

  const { cliente_id } = req.params;

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
});

// DÍAS
router.get("/dias", async (req, res) => {

  const result = await pool.query(`
    SELECT *
    FROM dias_visita
    ORDER BY id
  `);

  res.json(result.rows);
});

// ÚLTIMOS STOCKS
router.get(
  "/ultimos-stocks/:clienteId",
  async (req, res) => {

    const { clienteId } = req.params;

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
  }
);

export default router;