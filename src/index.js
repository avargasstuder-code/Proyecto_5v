import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import productosRoutes from "./routes/productos.js";
import ventasRoutes from "./routes/ventas.js";
import clientesRoutes from "./routes/clientes.js";
import authRoutes from "./routes/auth.js";
import historialRoutes from "./routes/historial.js";
import ciudadesRoutes from "./routes/ciudades.js";
import categoriasRoutes from "./routes/categorias.js";

const app = express();

// Verificación temprana: si falta alguna variable de entorno crítica,
// mejor que el servidor no arranque en silencio con un bug difícil de rastrear
if (!process.env.DATABASE_URL) {
  console.error("FALTA DATABASE_URL en las variables de entorno");
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error("FALTA JWT_SECRET en las variables de entorno");
  process.exit(1);
}

// Cabeceras de seguridad básicas (evita clickjacking, sniffing de MIME, etc.)
app.use(helmet());


const origenesPermitidos = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Permite peticiones sin "origin" (apps móviles, curl, health checks)
    if (!origin) return callback(null, true);

    if (origenesPermitidos.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origen no permitido por CORS"));
  },
  credentials: true
}));

// RATE LIMITING GENERAL: máximo 300 peticiones cada 15 min por IP
const limiterGeneral = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones, intenta más tarde" }
});
app.use(limiterGeneral);

// RATE LIMITING ESTRICTO PARA LOGIN: evita fuerza bruta de contraseñas
const limiterLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos de inicio de sesión, espera unos minutos" }
});
app.use("/api/auth/login", limiterLogin);

// JSON
app.use(express.json({ limit: "1mb" }));

// RUTAS
app.use("/api/ventas", ventasRoutes);
app.use("/api/productos", productosRoutes);
app.use("/api/clientes", clientesRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/historial", historialRoutes);
app.use("/api/ciudades", ciudadesRoutes);
app.use("/api/categorias", categoriasRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// MANEJADOR DE ERRORES GLOBAL: cualquier error no capturado en una ruta
// termina acá en vez de tumbar el servidor o exponer detalles internos
app.use((err, req, res, next) => {
  console.error("ERROR NO MANEJADO:", err);

  if (err.message === "Origen no permitido por CORS") {
    return res.status(403).json({ error: "Origen no permitido" });
  }

  res.status(500).json({ error: "Error interno del servidor" });
});

// SERVIDOR
app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Servidor corriendo");
});