import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

// OBTENER TODAS LAS CATEGORÍAS
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM categoria");
    res.json(result.rows);
  } catch (error) {
    console.error("ERROR GET CATEGORIAS:", error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

export default router;