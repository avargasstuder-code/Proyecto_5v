import dotenv from "dotenv";
dotenv.config();
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import productosRoutes from "./routes/productos.js";
import ventasRoutes from "./routes/ventas.js";
import clientesRoutes from "./routes/clientes.js";
import authRoutes from "./routes/auth.js";
import historialRoutes from "./routes/historial.js";
import ciudadesRoutes from "./routes/ciudades.js";
import categoriasRoutes from "./routes/categorias.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use((req, res, next) => {
  res.header("ngrok-skip-browser-warning", "true");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});


app.use(cors({
  origin: true,
  credentials: true
}));
// JSON
app.use(express.json());

// RUTAS
app.use("/api/ventas", ventasRoutes);
app.use("/api/productos", productosRoutes);
app.use("/api/clientes", clientesRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/historial", historialRoutes);
app.use("/api/ciudades", ciudadesRoutes);
app.use("/api/categorias", categoriasRoutes);
app.use(express.static(path.join(__dirname, "../../frontend/dist")));

app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/dist/index.html"));
});
// SERVIDOR
app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Servidor corriendo");
});