import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import { verificarRol } from "../middleware/verificarRol.js";

const router = Router();

function esEnteroValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

// BUSCAR CLIENTE POR RUT EXACTO (para saber si ya existe antes de
// crear una sucursal nueva con ese RUT)
router.get("/buscar-rut/:rut", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { rut } = req.params;

  try {
    const result = await pool.query("SELECT * FROM clientes WHERE rut = $1", [rut]);
    res.json(result.rows[0] || null);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al buscar cliente" });
  }
});

// LISTAR CLIENTES (identidad básica, sin filtrar por vendedor: el
// cliente es compartido entre todas sus sucursales, sin importar qué
// vendedor atienda cada una)
router.get("/", verificarToken, verificarRol("vendedor"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM clientes WHERE activo = true ORDER BY nombre"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener clientes" });
  }
});

// DETALLE DE UN CLIENTE CON TODAS SUS SUCURSALES
router.get("/:id", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { id } = req.params;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    const clienteResult = await pool.query("SELECT * FROM clientes WHERE id = $1", [id]);
    const cliente = clienteResult.rows[0];

    if (!cliente) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const sucursalesResult = await pool.query(
      `
      SELECT s.*, ciu.nombre AS ciudad, d.nombre AS dia, u.nombre AS vendedor
      FROM sucursales s
      JOIN ciudades ciu ON ciu.id = s.ciudad_id
      JOIN dias_visita d ON d.id = s.dia_id
      JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.cliente_id = $1
      ORDER BY s.id
      `,
      [id]
    );

    res.json({ cliente, sucursales: sucursalesResult.rows });
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al obtener el cliente" });
  }
});

// ACTUALIZAR IDENTIDAD DEL CLIENTE (nombre/apellido/rut) — afecta a
// TODAS sus sucursales, porque es la misma persona/empresa
router.put("/:id", verificarToken, verificarRol("vendedor"), async (req, res) => {
  const { id } = req.params;
  const { nombre, apellido, rut } = req.body;

  if (!esEnteroValido(id)) {
    return res.status(400).json({ error: "id inválido" });
  }

  if (!nombre || !apellido || !rut) {
    return res.status(400).json({ error: "Nombre, apellido y RUT son obligatorios" });
  }

  try {
    const existe = await pool.query(
      "SELECT id FROM clientes WHERE rut = $1 AND id != $2",
      [rut, id]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({ error: "Ya existe otro cliente con ese RUT" });
    }

    const result = await pool.query(
      `UPDATE clientes SET nombre = $1, apellido = $2, rut = $3 WHERE id = $4 RETURNING *`,
      [nombre, apellido, rut, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({ error: "Ya existe otro cliente con ese RUT" });
    }
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "Error al actualizar cliente" });
  }
});

export default router;