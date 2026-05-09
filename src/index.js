import dotenv from "dotenv";
dotenv.config();

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

// CORS
app.use(cors({
  origin: "*"
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

// SERVIDOR
app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Servidor corriendo");
});