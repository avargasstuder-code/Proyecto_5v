import { Router } from "express";
import { pool } from "../db.js";
import { verificarToken } from "../middleware/auth.js";
import PDFDocument from "pdfkit";

const router = Router();

const MM_A_PT = 2.83465;
const mm = (valor) => valor * MM_A_PT;

// ===== Helpers de formato (mismos que usa el frontend) =====

function formatoCLP(valor) {
  const numero = Math.round(Number(valor) || 0);
  return numero.toLocaleString("es-CL", { maximumFractionDigits: 0 });
}

function formatoRUT(rut) {
  if (!rut) return "";
  const limpio = rut.replace(/\./g, "").replace(/-/g, "").trim();
  const cuerpo = limpio.slice(0, -1);
  const dv = limpio.slice(-1).toUpperCase();
  const cuerpoConPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${cuerpoConPuntos}-${dv}`;
}

function formatoFecha(fecha) {
  return new Date(fecha).toLocaleString("es-CL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ===== Datos de la venta (con control de propiedad para vendedor) =====

async function obtenerVentaAutorizada(id, user) {
  const ventaResult = await pool.query(
    `SELECT v.*,
            c.nombre || ' ' || c.apellido AS cliente,
            c.rut AS rut,
            ciu.nombre AS ciudad,
            u.nombre AS usuario
     FROM ventas v
     JOIN clientes c ON v.cliente_id = c.id
     LEFT JOIN ciudades ciu ON ciu.id = c.ciudad_id
     JOIN usuarios u ON v.usuario_id = u.id
     WHERE v.id = $1`,
    [id]
  );

  const venta = ventaResult.rows[0];
  if (!venta) return null;

  // Un vendedor solo puede ver el detalle de sus propias ventas
  if (user.rol === "vendedor" && venta.usuario_id !== user.id) return null;

  const detalle = await pool.query(
    `SELECT d.*, p.nombre
     FROM detalle_venta d
     JOIN productos p ON d.producto_id = p.id
     WHERE d.venta_id = $1`,
    [id]
  );

  return { venta, productos: detalle.rows };
}

// ===== Generación de PDF (formato térmico 58mm) =====

function generarPdfTermico(res, venta, productos) {
  const anchoPt = mm(58);
  const margenPt = mm(3);

  // Estimamos un alto generoso según la cantidad de productos, para
  // que nunca se corte contenido (a lo sumo queda algo de espacio de
  // más al final, lo cual no es un problema para una impresora térmica)
  const altoEstimado =
    mm(40) +               // cabecera (cliente, rut, fecha, etc.)
    productos.length * mm(12) + // cada producto ocupa ~12mm (una fila, a veces dos si el nombre es largo)
    mm(25);                // total + pie de página

  const doc = new PDFDocument({
    size: [anchoPt, altoEstimado],
    margins: { top: margenPt, bottom: margenPt, left: margenPt, right: margenPt }
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="guia-venta-${venta.id}-termica.pdf"`
  );
  doc.pipe(res);

  const anchoUtil = anchoPt - margenPt * 2;

  doc.font("Helvetica-Bold").fontSize(12).text("Guía de venta", { align: "center" });
  doc.moveDown(0.6);

  doc.font("Helvetica").fontSize(8);
  doc.text(`Cliente: ${venta.cliente}`, { width: anchoUtil });
  doc.text(`Rut: ${formatoRUT(venta.rut)}`, { width: anchoUtil });
  if (venta.ciudad) doc.text(`Ciudad: ${venta.ciudad}`, { width: anchoUtil });
  doc.text(`Vendedor: ${venta.usuario}`, { width: anchoUtil });
  doc.text(`Fecha: ${formatoFecha(venta.fecha)}`, { width: anchoUtil });

  doc.moveDown(0.4);
  doc.moveTo(margenPt, doc.y).lineTo(anchoPt - margenPt, doc.y).dash(2, { space: 2 }).stroke();
  doc.undash();
  doc.moveDown(0.4);

  // Columnas: Cant. | Producto | Subtotal (como una boleta de supermercado)
  const anchoCantidad = anchoUtil * 0.14;
  const anchoSubtotal = anchoUtil * 0.32;
  const anchoProducto = anchoUtil - anchoCantidad - anchoSubtotal;
  const xCantidad = margenPt;
  const xProducto = margenPt + anchoCantidad;
  const xSubtotal = margenPt + anchoCantidad + anchoProducto;

  doc.font("Helvetica-Bold").fontSize(7);
  const yEncabezado = doc.y;
  doc.text("Cant.", xCantidad, yEncabezado, { width: anchoCantidad });
  doc.text("Producto", xProducto, yEncabezado, { width: anchoProducto });
  doc.text("Subtotal", xSubtotal, yEncabezado, { width: anchoSubtotal, align: "right" });
  doc.x = margenPt;
  doc.moveDown(0.3);
  doc.moveTo(margenPt, doc.y).lineTo(anchoPt - margenPt, doc.y).stroke();
  doc.moveDown(0.3);

  productos.forEach(p => {
    const yInicio = doc.y;
    const subtotal = p.precio_unitario * p.cantidad;

    // El nombre del producto es lo que puede ocupar más de una línea,
    // así que lo escribimos primero para saber cuánto ocupó esta fila
    doc.font("Helvetica").fontSize(8).text(p.nombre, xProducto, yInicio, { width: anchoProducto });
    const yFinFila = doc.y;

    doc.text(String(p.cantidad), xCantidad, yInicio, { width: anchoCantidad });
    doc.text(`$${formatoCLP(subtotal)}`, xSubtotal, yInicio, { width: anchoSubtotal, align: "right" });

    // Nos quedamos debajo de la línea más alta de la fila (por si el
    // nombre del producto ocupó dos líneas)
    doc.x = margenPt;
    doc.y = Math.max(doc.y, yFinFila) + mm(1);
  });

  doc.moveDown(0.2);
  doc.moveTo(margenPt, doc.y).lineTo(anchoPt - margenPt, doc.y).dash(2, { space: 2 }).stroke();
  doc.undash();
  doc.moveDown(0.4);

  doc.font("Helvetica-Bold").fontSize(11).text(`Total: $${formatoCLP(venta.total)}`, {
    width: anchoUtil,
    align: "right"
  });
  doc.moveDown(0.6);
  doc.font("Helvetica").fontSize(8).text("Gracias por su compra", {
    width: anchoUtil,
    align: "center"
  });

  doc.end();
}

// ===== Generación de PDF (formato oficio, con paginado real) =====

function generarPdfOficio(res, venta, productos) {
  const anchoPt = mm(216);
  const altoPt = mm(330);
  const margenPt = mm(15);
  const opcionesPagina = {
    size: [anchoPt, altoPt],
    margins: { top: margenPt, bottom: margenPt, left: margenPt, right: margenPt }
  };

  const doc = new PDFDocument(opcionesPagina);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="guia-venta-${venta.id}-oficio.pdf"`
  );
  doc.pipe(res);

  const anchoUtil = anchoPt - margenPt * 2;
  const limiteInferior = altoPt - margenPt;

  // Si lo que sigue no entra en lo que queda de página, arranca una nueva
  function saltarPaginaSiHaceFalta(alturaNecesaria) {
    if (doc.y + alturaNecesaria > limiteInferior) {
      doc.addPage(opcionesPagina);
    }
  }

  doc.font("Helvetica-Bold").fontSize(20).text("Guía de venta", { align: "center" });
  doc.moveDown(1);

  doc.font("Helvetica").fontSize(12);
  doc.text(`Cliente: ${venta.cliente}`, { width: anchoUtil });
  doc.text(`Rut: ${formatoRUT(venta.rut)}`, { width: anchoUtil });
  if (venta.ciudad) doc.text(`Ciudad: ${venta.ciudad}`, { width: anchoUtil });
  doc.text(`Vendedor: ${venta.usuario}`, { width: anchoUtil });
  doc.text(`Fecha: ${formatoFecha(venta.fecha)}`, { width: anchoUtil });

  doc.moveDown(0.6);
  doc.moveTo(margenPt, doc.y).lineTo(anchoPt - margenPt, doc.y).stroke();
  doc.moveDown(0.6);

  productos.forEach(p => {
    saltarPaginaSiHaceFalta(mm(26));

    doc.font("Helvetica-Bold").fontSize(13).text(p.nombre, { width: anchoUtil });
    doc.font("Helvetica").fontSize(11).text(
      `Tipo: ${p.tipo_unidad}    Cantidad: ${p.cantidad}    Subtotal: $${formatoCLP(p.precio_unitario * p.cantidad)}`,
      { width: anchoUtil }
    );
    doc.moveDown(0.7);
  });

  saltarPaginaSiHaceFalta(mm(20));
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(16).text(`Total: $${formatoCLP(venta.total)}`, {
    width: anchoUtil,
    align: "right"
  });

  doc.end();
}

// LISTA DE VENTAS
router.get("/", verificarToken, async (req, res) => {
  try {
    const user = req.user;

    let query = `
      SELECT 
        v.id,
        v.total,
        v.metodo_pago,
        v.dias_cheque,
        v.fecha,
        c.nombre || ' ' || c.apellido AS cliente,
        c.rut AS rut,
        u.nombre AS usuario
      FROM ventas v
      JOIN clientes c ON v.cliente_id = c.id
      JOIN usuarios u ON v.usuario_id = u.id
    `;

    if (user.rol === "vendedor") {
      query += " WHERE v.usuario_id = $1 ORDER BY v.fecha DESC";
      const result = await pool.query(query, [user.id]);
      return res.json(result.rows);
    }

    query += " ORDER BY v.fecha DESC";

    const result = await pool.query(query);
    res.json(result.rows);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// DETALLE DE VENTA
router.get("/:id", verificarToken, async (req, res) => {
  const { id } = req.params;

  if (!Number.isInteger(Number(id))) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    const datos = await obtenerVentaAutorizada(id, req.user);

    if (!datos) {
      return res.status(404).json({ error: "Venta no encontrada" });
    }

    res.json(datos);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// DESCARGAR GUÍA DE VENTA EN PDF (generado en el servidor, formato
// consistente sin importar el navegador/celular de quien lo descarga)
router.get("/:id/pdf", verificarToken, async (req, res) => {
  const { id } = req.params;
  const formato = req.query.formato === "oficio" ? "oficio" : "termica";

  if (!Number.isInteger(Number(id))) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    const datos = await obtenerVentaAutorizada(id, req.user);

    if (!datos) {
      return res.status(404).json({ error: "Venta no encontrada" });
    }

    if (formato === "oficio") {
      generarPdfOficio(res, datos.venta, datos.productos);
    } else {
      generarPdfTermico(res, datos.venta, datos.productos);
    }

  } catch (error) {
    console.error("ERROR REAL:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "No se pudo generar el PDF" });
    }
  }
});

export default router;