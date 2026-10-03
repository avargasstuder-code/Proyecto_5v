import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import { verificarAdmin } from "../middleware/verificarAdmin.js";

const router = Router();

// Fecha en hora de Chile (las columnas fecha se guardan en UTC)
const FECHA_CL = (col) => `((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')`;

// REPORTE DE VENTAS Y COMPRAS (solo admin)
// ?anio=2026 -> totales mes a mes de ese año + totales por año (todos)
// Las ventas no entregadas (anuladas) no se cuentan.
router.get("/resumen", verificarToken, verificarAdmin, async (req, res) => {
  const anioActual = new Date().getFullYear();
  const anio = Number(req.query.anio || anioActual);

  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
    return res.status(400).json({ error: "Año inválido" });
  }

  try {
    const [ventasMes, comprasMes, ventasAnio, comprasAnio] = await Promise.all([
      pool.query(
        `
        SELECT EXTRACT(MONTH FROM ${FECHA_CL("fecha")})::int AS mes,
               COALESCE(SUM(total), 0)::numeric AS total,
               COUNT(*)::int AS cantidad
        FROM ventas
        WHERE estado_entrega <> 'no_entregado'
          AND EXTRACT(YEAR FROM ${FECHA_CL("fecha")}) = $1
        GROUP BY 1
        `,
        [anio]
      ),
      pool.query(
        `
        SELECT EXTRACT(MONTH FROM ${FECHA_CL("fecha")})::int AS mes,
               COALESCE(SUM(total), 0)::numeric AS total,
               COUNT(*)::int AS cantidad
        FROM compras
        WHERE EXTRACT(YEAR FROM ${FECHA_CL("fecha")}) = $1
        GROUP BY 1
        `,
        [anio]
      ),
      pool.query(`
        SELECT EXTRACT(YEAR FROM ${FECHA_CL("fecha")})::int AS anio,
               COALESCE(SUM(total), 0)::numeric AS total,
               COUNT(*)::int AS cantidad
        FROM ventas
        WHERE estado_entrega <> 'no_entregado'
        GROUP BY 1
      `),
      pool.query(`
        SELECT EXTRACT(YEAR FROM ${FECHA_CL("fecha")})::int AS anio,
               COALESCE(SUM(total), 0)::numeric AS total,
               COUNT(*)::int AS cantidad
        FROM compras
        GROUP BY 1
      `)
    ]);

    // Siempre 12 meses, aunque alguno no tenga movimientos
    const mensual = Array.from({ length: 12 }, (_, i) => {
      const v = ventasMes.rows.find(r => r.mes === i + 1);
      const c = comprasMes.rows.find(r => r.mes === i + 1);
      return {
        mes: i + 1,
        ventas: Number(v?.total || 0),
        cantidadVentas: v?.cantidad || 0,
        compras: Number(c?.total || 0),
        cantidadCompras: c?.cantidad || 0
      };
    });

    const anios = new Set([
      anioActual,
      ...ventasAnio.rows.map(r => r.anio),
      ...comprasAnio.rows.map(r => r.anio)
    ]);

    const anual = [...anios].sort((a, b) => a - b).map(a => {
      const v = ventasAnio.rows.find(r => r.anio === a);
      const c = comprasAnio.rows.find(r => r.anio === a);
      return {
        anio: a,
        ventas: Number(v?.total || 0),
        cantidadVentas: v?.cantidad || 0,
        compras: Number(c?.total || 0),
        cantidadCompras: c?.cantidad || 0
      };
    });

    res.json({ anio, mensual, anual });
  } catch (error) {
    console.error("ERROR REAL:", error);
    res.status(500).json({ error: "No se pudo generar el reporte" });
  }
});

export default router;
