import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";

const router = Router();

// GET todas las ciudades
router.get("/", verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM ciudades ORDER BY nombre"
    );

    res.json(result.rows);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener ciudades" });
  }
});

export default router;