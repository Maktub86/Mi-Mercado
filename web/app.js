"use strict";

const REPO = "Maktub86/Mi-Mercado";
const CLASES = { "Alba": "alba", "Lucía": "lucia", "Las dos": "dos", "Alejandro": "alejandro", "Rocío": "rocio" };
let categorias = [];

const euros = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const fechaCorta = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });
const fechaLarga = new Intl.DateTimeFormat("es-ES", {
  weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
});

const estado = { categoria: null, persona: "todas", texto: "", orden: "lista", soloElegidos: false };
const CLAVE_ELEGIDOS = "mi-mercado-elegidos";
let elegidos = new Set();
try { elegidos = new Set(JSON.parse(localStorage.getItem(CLAVE_ELEGIDOS) || "[]")); } catch (e) { /* sin almacenamiento */ }
function guardarElegidos() {
  try { localStorage.setItem(CLAVE_ELEGIDOS, JSON.stringify([...elegidos])); } catch (e) { /* sin almacenamiento */ }
}
let productos = [];

const $ = (sel) => document.querySelector(sel);

function leerFecha(iso) {
  // "2026-11-18" -> fecha local a mediodía para evitar saltos de zona horaria
  return new Date(`${iso}T12:00:00`);
}

function claseDe(para) {
  return CLASES[para] || "dos";
}

function normalizar(texto) {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

async function cargar(ruta) {
  const resp = await fetch(`${ruta}?t=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`${ruta}: ${resp.status}`);
  return resp.json();
}

/** Compara la última lectura con el último precio distinto de esa tienda. */
function tendenciaDe(serie) {
  if (serie.length < 2) return null;
  const ultimo = serie[serie.length - 1];
  for (let i = serie.length - 2; i >= 0; i -= 1) {
    const diferencia = ultimo.precio - serie[i].precio;
    if (Math.abs(diferencia) >= 0.01) {
      return { tipo: diferencia < 0 ? "baja" : "sube", diferencia, desde: serie[i] };
    }
  }
  return { tipo: "igual", desde: serie[0] };
}

/** Junta la lista con el historial de precios y calcula lo que se muestra. */
function preparar(lista, precios) {
  const historial = precios.productos || {};
  return lista.productos.map((p, indice) => {
    const datos = historial[p.id] || {};
    const aTienda = (enlace, info, url, clave) => {
      const serie = info.historial || [];
      return {
        ...enlace,
        clave,
        url,
        serie,
        ultimo: serie[serie.length - 1] || null,
        tendencia: tendenciaDe(serie),
        error: info.ultimo_error || null,
        comprobado: info.ultima_comprobacion || null,
        imagen: info.imagen || null,
        valoracion: info.valoracion || null,
        resumen: info.resumen_opiniones || null,
        opinionesUrl: info.opiniones_url || url,
        via: info.via || null,
      };
    };
    const todas = [];
    (p.enlaces || []).forEach((enlace) => {
      if (enlace.comparador || enlace.comparador_buscar) {
        // Un comparador aporta varias tiendas: se guardan como "clave#Tienda".
        const clave = enlace.comparador || `${enlace.tienda === "Idealo" ? "idealo" : "comparador"}:${enlace.comparador_buscar}`;
        Object.entries(datos)
          .filter(([k, info]) => k.startsWith(`${clave}#`) && info.ultimo_error !== "ya no aparece en el comparador")
          .forEach(([k, info]) => todas.push(aTienda({ tienda: info.tienda || k.split("#")[1] }, info, info.url || enlace.comparador, k)));
        return;
      }
      const clave = enlace.url || (enlace.amazon_buscar ? `amazon:${enlace.amazon_buscar}` : `buscar:${enlace.dominio}:${enlace.buscar}`);
      const info = datos[clave] || {};
      const url = enlace.url || info.url || (enlace.amazon_buscar
        ? `https://www.amazon.es/s?k=${encodeURIComponent(enlace.amazon_buscar)}`
        : `https://${enlace.dominio}/search?q=${encodeURIComponent(enlace.buscar)}`);
      todas.push(aTienda(enlace, info, url, clave));
    });

    // Si una tienda aparece por dos caminos (p. ej. Amazon directo y vía comparador), nos quedamos
    // con la lectura más reciente y más barata.
    const porNombre = new Map();
    todas.forEach((t) => {
      const nombre = normalizar(t.tienda);
      const previa = porNombre.get(nombre);
      const mejorQue = (x, y) => !y || (x.ultimo && (!y.ultimo || x.ultimo.fecha > y.ultimo.fecha
        || (x.ultimo.fecha === y.ultimo.fecha && x.ultimo.precio < y.ultimo.precio)));
      if (mejorQue(t, previa)) porNombre.set(nombre, previa && !t.imagen ? { ...t, imagen: previa.imagen, valoracion: t.valoracion || previa.valoracion, resumen: t.resumen || previa.resumen } : t);
    });
    const conImagen = todas.filter((t) => t.imagen);
    // Solo se enseñan las tiendas de las que se ha podido leer el precio.
    const descartadas = new Set(p.descartadas || []);
    const tiendas = [...porNombre.values()]
      .filter((t) => t.url && t.ultimo && !descartadas.has(t.clave))
      .sort((a, b) => (a.ultimo ? a.ultimo.precio : Infinity) - (b.ultimo ? b.ultimo.precio : Infinity));
    const conPrecio = tiendas.filter((t) => t.ultimo);
    const mejor = conPrecio.length
      ? conPrecio.reduce((a, b) => (b.ultimo.precio < a.ultimo.precio ? b : a))
      : null;

    // Serie diaria: el precio más bajo de cualquier tienda cada día.
    const porDia = new Map();
    if (p.precio_lista != null && lista.fecha_lista) porDia.set(lista.fecha_lista, p.precio_lista);
    tiendas.forEach((t) => t.serie.forEach(({ fecha, precio }) => {
      porDia.set(fecha, Math.min(precio, porDia.has(fecha) ? porDia.get(fecha) : Infinity));
    }));
    const serie = [...porDia.entries()].sort(([a], [b]) => a.localeCompare(b));
    const lecturas = tiendas.flatMap((t) => t.serie.map((e) => e.precio));
    const minimo = lecturas.length ? Math.min(...lecturas) : null;

    const actual = mejor ? mejor.ultimo.precio : null;
    const referencia = actual ?? p.precio_lista;
    const variacion = actual != null && p.precio_lista != null ? actual - p.precio_lista : null;

    const conFoto = conImagen.find((t) => /amazon/i.test(t.tienda)) || conImagen.find((t) => /toy planet/i.test(t.tienda)) || conImagen[0];
    const imagen = p.imagen || (conFoto ? conFoto.imagen : null);
    const fotos = [...new Set([p.imagen, conFoto && conFoto.imagen, ...conImagen.map((t) => t.imagen)].filter(Boolean))];

    return { ...p, indice, tiendas, mejor, actual, referencia, variacion, serie, minimo, imagen, fotos, _fechaLista: lista.fecha_lista };
  });
}

function pintarActualizado(actualizado) {
  $("#actualizado").textContent = actualizado
    ? `Precios revisados el ${fechaLarga.format(new Date(actualizado))}.`
    : "Todavía no se han revisado los precios.";
}

function deCategoria() {
  return productos.filter((p) => (p.categoria || "reyes") === estado.categoria);
}

function pintarCategorias() {
  $("#categorias").innerHTML = categorias.map((c) =>
    `<button type="button" class="categoria" data-categoria="${c.id}" aria-pressed="${c.id === estado.categoria}">${escapar(c.nombre)}</button>`).join("");
}

function pintarEleccion() {
  const lista = productos.filter((p) => elegidos.has(p.id));
  const barra = $("#barra-eleccion");
  barra.hidden = lista.length === 0;
  document.body.classList.toggle("con-barra", lista.length > 0);
  if (!lista.length) { estado.soloElegidos = false; return; }
  const total = lista.reduce((s, p) => s + (p.referencia || 0), 0);
  const sinPrecio = lista.filter((p) => p.referencia == null).length;
  const porPersona = {};
  lista.forEach((p) => { porPersona[p.para] = (porPersona[p.para] || 0) + (p.referencia || 0); });
  $("#eleccion-total").textContent = euros.format(total);
  $("#eleccion-detalle").textContent = `${lista.length} ${lista.length === 1 ? "regalo elegido" : "regalos elegidos"}`
    + (Object.keys(porPersona).length > 1 ? " · " + Object.entries(porPersona).map(([n, v]) => `${n} ${euros.format(v)}`).join(" · ") : "")
    + (sinPrecio ? ` · ${sinPrecio} sin precio` : "");
  $("#ver-elegidos").textContent = estado.soloElegidos ? "Ver todos" : "Ver solo elegidos";
}

function pintarChips() {
  const categoria = categorias.find((c) => c.id === estado.categoria) || { personas: [] };
  const pendientes = deCategoria().filter((p) => p.estado !== "comprado");
  const opciones = [{ id: "todas", nombre: "Todos" }, ...categoria.personas.map((n) => ({ id: n, nombre: n }))];
  $("#chips-persona").innerHTML = opciones.map((p) => {
    const n = p.id === "todas" ? pendientes.length : pendientes.filter((x) => x.para === p.id).length;
    return `<button class="chip ${CLASES[p.id] || ""}" role="tab" data-persona="${escapar(p.id)}" aria-selected="${estado.persona === p.id}">
      ${escapar(p.nombre)}<span class="cuenta">${n}</span></button>`;
  }).join("");
}

function grafica(svg, valores) {
  if (valores.length < 2) return;
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  if (max - min < 0.01) return; // precio plano: la gráfica no aporta nada
  const rango = max - min;
  const ancho = 200;
  const alto = 44;
  const pad = 4;
  const puntos = valores.map((v, i) => [
    pad + (i / (valores.length - 1)) * (ancho - pad * 2),
    pad + (1 - (v - min) / rango) * (alto - pad * 2),
  ]);
  const ultimo = valores[valores.length - 1];
  const color = ultimo < valores[0] ? "var(--baja)" : ultimo > valores[0] ? "var(--sube)" : "var(--tinta-suave)";
  const linea = puntos.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [ux, uy] = puntos[puntos.length - 1];
  svg.innerHTML = `
    <polyline points="${linea}" fill="none" stroke="${color}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${ux}" cy="${uy}" r="3" fill="${color}"/>`;
  svg.hidden = false;
}

function estrellas(valoracion) {
  const maximo = valoracion.maximo || 5;
  const porcentaje = Math.max(0, Math.min(100, (valoracion.media / maximo) * 100));
  return `<span class="estrellas" role="img" aria-label="${valoracion.media} de ${maximo} estrellas">
    <span style="width:${porcentaje}%"></span></span>`;
}

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function textoTendencia(t) {
  if (!t.tendencia) return t.ultimo ? { clase: "igual", texto: "primera lectura" } : null;
  const { tipo, diferencia, desde } = t.tendencia;
  const cuando = fechaCorta.format(leerFecha(desde.fecha));
  if (tipo === "baja") return { clase: "baja", texto: `▼ bajando ${euros.format(-diferencia)}`, detalle: `antes ${euros.format(desde.precio)} (${cuando})` };
  if (tipo === "sube") return { clase: "sube", texto: `▲ subiendo ${euros.format(diferencia)}`, detalle: `antes ${euros.format(desde.precio)} (${cuando})` };
  return { clase: "igual", texto: "= estable", detalle: `sin cambios desde el ${cuando}` };
}

function motivo(error) {
  return error;
}

const PESTANAS = [
  { id: "comparar", titulo: "Comparar precios" },
  { id: "historial", titulo: "Historial" },
];

function hojaComparar(p) {
  const top = p.tiendas.slice(0, 10);
  if (!top.length) {
    return '<p class="hoja-vacia">Todavía no hay precios de tiendas para este juguete. El robot lo sigue buscando en cada revisión.</p>';
  }
  const mejor = top[0];
  const peor = p.tiendas[p.tiendas.length - 1];
  const ahorro = peor.ultimo.precio - mejor.ultimo.precio;
  const cabecera = p.tiendas.length > 1
    ? `Top ${top.length} de ${p.tiendas.length} ${p.tiendas.length === 1 ? "tienda" : "tiendas"}${ahorro >= 0.01 ? ` · ahorras hasta <strong>${euros.format(ahorro)}</strong>` : ""}`
    : "1 tienda con precio";
  const filas = top.map((t, i) => {
    const dif = t.ultimo.precio - mejor.ultimo.precio;
    const tend = textoTendencia(t);
    const info = [];
    if (t.ultimo.disponible === false) info.push("<b>agotado</b>");
    if (tend && tend.clase !== "igual") info.push(`<span class="flecha-${tend.clase}">${tend.texto}</span>`);
    if (t.precio_manual != null) info.push("apuntado a mano");
    if (t.valoracion) info.push(`★ ${t.valoracion.media.toLocaleString("es-ES")}`);
    info.push(fechaCorta.format(leerFecha(t.ultimo.fecha)));
    return `<li class="fila-tienda${i === 0 ? " ganadora" : ""}">
      <span class="puesto">${i + 1}</span>
      <span class="fila-texto"><span class="fila-nombre">${escapar(t.tienda)}</span>
        <span class="fila-info">${info.join(" · ")}</span></span>
      <span class="fila-precio">${euros.format(t.ultimo.precio)}${i > 0 && dif >= 0.01 ? `<small>+${euros.format(dif)}</small>` : ""}</span>
      <a class="fila-ir" href="${escapar(t.url)}" target="_blank" rel="noopener" aria-label="Ir a ${escapar(t.tienda)}">Ir ↗</a>
      <button type="button" class="fila-quitar solo-edicion" data-descartar="${escapar(t.clave)}" data-tienda="${escapar(t.tienda)}"
        title="No es este producto: quitar esta tienda" aria-label="Quitar ${escapar(t.tienda)}">✕</button>
    </li>`;
  }).join("");
  return `<p class="hoja-cabecera">${cabecera}</p><ol class="comparador-lista">${filas}</ol>`;
}

function hojaOpiniones(p) {
  const conNota = p.tiendas.filter((t) => t.valoracion || t.resumen);
  if (!conNota.length) {
    const consulta = encodeURIComponent(`${p.busqueda || p.nombre} opiniones`);
    return `<p class="hoja-vacia">Aún no hay opiniones recogidas de las tiendas.</p>
      <a class="enlace-suave" href="https://www.google.com/search?q=${consulta}" target="_blank" rel="noopener">Buscar opiniones en internet ↗</a>`;
  }
  return conNota.map((t) => {
    const v = t.valoracion;
    return `<div class="opinion">
      <div class="opinion-cabeza"><strong>${escapar(t.tienda)}</strong>
        ${v ? `<span class="estrellas-fila">${estrellas(v)} <b>${v.media.toLocaleString("es-ES")}</b>
          ${v.total ? `<span class="total">${v.total.toLocaleString("es-ES")} opiniones</span>` : ""}</span>` : ""}</div>
      ${t.resumen ? `<p class="resumen-opiniones">${escapar(t.resumen)}</p>` : ""}
      <a class="enlace-suave" href="${escapar(t.opinionesUrl)}" target="_blank" rel="noopener">Leer las opiniones ↗</a>
    </div>`;
  }).join("");
}

function hojaHistorial(p) {
  if (!p.serie.length) return '<p class="hoja-vacia">Todavía no hay historial.</p>';
  const filas = [...p.serie].reverse().slice(0, 8).map(([fecha, precio], i, arr) => {
    const anterior = arr[i + 1];
    const dif = anterior ? precio - anterior[1] : 0;
    const flecha = Math.abs(dif) < 0.01 ? "" : dif < 0 ? `<span class="flecha-baja">▼ ${euros.format(-dif)}</span>` : `<span class="flecha-sube">▲ ${euros.format(dif)}</span>`;
    const esLista = fecha === p._fechaLista && precio === p.precio_lista && i === arr.length - 1;
    return `<tr><td>${fechaCorta.format(leerFecha(fecha))}${esLista ? " <small>(lista)</small>" : ""}</td>
      <td class="num">${euros.format(precio)}</td><td class="num">${flecha}</td></tr>`;
  }).join("");
  return `<svg class="grafica grande" viewBox="0 0 200 60" preserveAspectRatio="none" aria-hidden="true" hidden></svg>
    <p class="hoja-cabecera">Mejor precio de cada día</p>
    <table class="tabla-historial"><tbody>${filas}</tbody></table>`;
}

function hojaNota(p) {
  const partes = [];
  if (p.nota) partes.push(`<p class="nota-texto${/lo pide|lo quiere/i.test(p.nota) ? " destacada" : ""}">${escapar(p.nota.replace(/^Fuera de carta\.?\s*/, "") || "Fuera de carta")}</p>`);
  if (p.precio_lista != null) partes.push(`<p class="hoja-detalle">Precio en la lista: <strong>${euros.format(p.precio_lista)}</strong>${p.tienda_lista ? ` (${escapar(p.tienda_lista)})` : ""}</p>`);
  partes.push(`<p class="hoja-detalle">Para: <strong>${escapar(p.para)}</strong></p>`);
  const consulta = encodeURIComponent(p.busqueda || p.nombre);
  partes.push(`<a class="enlace-suave" href="https://www.amazon.es/s?k=${consulta}" target="_blank" rel="noopener">Buscarlo en Amazon ↗</a>`);
  return partes.join("");
}

function pintarHoja(hoja, p, id) {
  const html = { comparar: hojaComparar, opiniones: hojaOpiniones, historial: hojaHistorial, nota: hojaNota }[id](p);
  hoja.innerHTML = html;
  const svg = hoja.querySelector(".grafica");
  if (svg) grafica(svg, p.serie.map(([, v]) => v));
}

function tarjeta(p) {
  const nodo = $("#plantilla-tarjeta").content.firstElementChild.cloneNode(true);
  const persona = nodo.querySelector(".persona");
  persona.textContent = p.para;
  persona.classList.add(claseDe(p.para));
  if (p.fuera_de_carta) nodo.querySelector(".etiqueta-fuera").hidden = false;

  const elegir = nodo.querySelector(".elegir");
  const marcar = () => {
    const si = elegidos.has(p.id);
    elegir.setAttribute("aria-pressed", String(si));
    elegir.title = si ? "Quitar de elegidos" : "Elegir este regalo";
    nodo.classList.toggle("elegida", si);
  };
  elegir.addEventListener("click", () => {
    if (elegidos.has(p.id)) elegidos.delete(p.id); else elegidos.add(p.id);
    guardarElegidos();
    marcar();
    pintarEleccion();
    if (estado.soloElegidos) pintarLista();
  });
  marcar();

  const img = nodo.querySelector(".foto img");
  const fotos = p.fotos.slice();
  const siguienteFoto = () => {
    const url = fotos.shift();
    if (!url) { img.hidden = true; return; }
    img.src = url;
    img.alt = p.nombre;
    img.hidden = false;
  };
  img.addEventListener("error", siguienteFoto);
  siguienteFoto();

  nodo.querySelector(".nombre").textContent = p.nombre;

  const precio = nodo.querySelector(".precio");
  const detalle = nodo.querySelector(".precio-detalle");
  const titulo = nodo.querySelector(".precio-titulo");
  if (p.actual != null) {
    precio.textContent = euros.format(p.actual);
    detalle.textContent = `en ${p.mejor.tienda}`;
  } else if (p.precio_lista != null) {
    titulo.textContent = "Precio de la lista";
    precio.textContent = euros.format(p.precio_lista);
    detalle.textContent = p.tienda_lista ? `visto en ${p.tienda_lista}` : "";
  } else {
    titulo.textContent = "Precio";
    precio.textContent = "Buscando tiendas…";
    precio.classList.add("sin-dato");
  }
  if (p.variacion != null) {
    const v = nodo.querySelector(".variacion");
    const centimos = Math.round(p.variacion * 100);
    if (centimos < 0) { v.textContent = `▼ ${euros.format(-p.variacion)} vs lista`; v.classList.add("baja"); }
    else if (centimos > 0) { v.textContent = `▲ ${euros.format(p.variacion)} vs lista`; v.classList.add("sube"); }
    else { v.textContent = "igual que la lista"; v.classList.add("igual"); }
    v.hidden = false;
  }

  const pestanas = nodo.querySelector(".pestanas");
  const hoja = nodo.querySelector(".hoja");
  PESTANAS.forEach((pest, i) => {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "pestana";
    boton.setAttribute("role", "tab");
    boton.setAttribute("aria-selected", String(i === 0));
    const cuenta = pest.id === "comparar" && p.tiendas.length ? ` <span class="cuenta">${Math.min(p.tiendas.length, 10)}</span>` : "";
    boton.innerHTML = `${pest.titulo}${cuenta}`;
    boton.addEventListener("click", () => {
      pestanas.querySelectorAll(".pestana").forEach((b) => b.setAttribute("aria-selected", "false"));
      boton.setAttribute("aria-selected", "true");
      pintarHoja(hoja, p, pest.id);
    });
    pestanas.append(boton);
  });
  pintarHoja(hoja, p, "comparar");

  const acciones = document.createElement("div");
  acciones.className = "acciones-edicion solo-edicion";
  acciones.innerHTML = `<button type="button" class="boton-mini" data-comprado="${p.id}">✓ Ya está comprado</button>
    <button type="button" class="boton-mini peligro" data-eliminar="${p.id}">Eliminar</button>`;
  nodo.querySelector(".cuerpo").append(acciones);
  hoja.addEventListener("click", (e) => {
    const boton = e.target.closest("[data-descartar]");
    if (boton) descartarTienda(p, boton.dataset.descartar, boton.dataset.tienda);
  });
  return nodo;
}

function pintarLista() {
  const texto = normalizar(estado.texto.trim());
  let lista = deCategoria().filter((p) => p.estado !== "comprado")
    .filter((p) => !estado.soloElegidos || elegidos.has(p.id))
    .filter((p) => estado.persona === "todas" || p.para === estado.persona)
    .filter((p) => !texto || normalizar(`${p.nombre} ${p.nota || ""}`).includes(texto));

  const sinValorAlFinal = (f) => (a, b) => {
    if (a.referencia == null) return 1;
    if (b.referencia == null) return -1;
    return f(a, b);
  };
  if (estado.orden === "barato") lista.sort(sinValorAlFinal((a, b) => a.referencia - b.referencia));
  if (estado.orden === "caro") lista.sort(sinValorAlFinal((a, b) => b.referencia - a.referencia));
  if (estado.orden === "bajada") lista.sort((a, b) => (a.variacion ?? 0) - (b.variacion ?? 0) || a.indice - b.indice);

  const contenedor = $("#pendientes");
  contenedor.replaceChildren(...lista.map(tarjeta));
  $("#vacio").hidden = lista.length > 0;
  $("#vacio").textContent = estado.soloElegidos ? "No hay regalos elegidos aquí."
    : estado.texto ? "No hay nada que coincida con la búsqueda."
    : estado.persona !== "todas" ? `Todavía no hay regalos para ${estado.persona}.` : "Todavía no hay regalos en esta categoría.";

  const comprados = deCategoria().filter((p) => p.estado === "comprado")
    .filter((p) => estado.persona === "todas" || p.para === estado.persona);
  $("#titulo-comprados").textContent = `Ya comprados (${comprados.length})`;
  $("#bloque-comprados").hidden = comprados.length === 0;
  $("#lista-comprados").innerHTML = comprados.map((p) => `
    <li><span><span class="tachado">${escapar(p.nombre)}</span> · ${escapar(p.para)}</span>
    <span class="quien">${p.comprado_por ? `por ${escapar(p.comprado_por)}` : "comprado"}
      <button type="button" class="enlace-boton solo-edicion" data-pendiente="${p.id}">Volver a la lista</button></span></li>`).join("");
}

// ---------------------------------------------------------------- edición

let API = "";
let datosLista = null;
let datosPrecios = null;
const CLAVE_CONTRASENA = "mi-mercado-clave";

function leerContrasena() {
  try { return localStorage.getItem(CLAVE_CONTRASENA) || ""; } catch (e) { return ""; }
}
function guardarContrasena(valor) {
  try { if (valor) localStorage.setItem(CLAVE_CONTRASENA, valor); else localStorage.removeItem(CLAVE_CONTRASENA); } catch (e) { /* sin almacenamiento */ }
}

function aviso(texto, tipo = "") {
  const caja = $("#aviso");
  caja.textContent = texto;
  caja.className = `aviso visible ${tipo}`;
  clearTimeout(aviso.temporizador);
  if (tipo !== "esperando") aviso.temporizador = setTimeout(() => { caja.className = "aviso"; }, 5000);
}

async function llamar(metodo, ruta, cuerpo) {
  if (!API) throw new Error("La edición todavía no está activada en esta web.");
  let contrasena = leerContrasena();
  if (!contrasena) contrasena = await pedirContrasena();
  if (!contrasena) throw new Error("Hace falta la contraseña para guardar cambios.");
  const despertando = setTimeout(() => aviso("Despertando el servidor… (la primera vez tarda hasta un minuto)", "esperando"), 2500);
  const control = new AbortController();
  const limite = setTimeout(() => control.abort(), 90000);
  try {
    const resp = await fetch(API + ruta, {
      method: metodo,
      headers: { "Content-Type": "application/json", "X-Clave": contrasena },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: control.signal,
    });
    const datos = await resp.json().catch(() => ({}));
    if (resp.status === 401) {
      guardarContrasena("");
      throw new Error("Contraseña incorrecta. Vuelve a intentarlo.");
    }
    if (!resp.ok) throw new Error(datos.error || `El servidor respondió ${resp.status}`);
    return datos;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("El servidor no responde. Prueba otra vez en un minuto.");
    if (err instanceof TypeError) throw new Error("No se pudo conectar con el servidor.");
    throw err;
  } finally {
    clearTimeout(despertando);
    clearTimeout(limite);
  }
}

function pedirContrasena() {
  return new Promise((resolver) => {
    const dialogo = $("#dialogo-clave");
    const campo = $("#campo-clave");
    campo.value = "";
    $("#error-clave").textContent = "";
    dialogo.showModal();
    campo.focus();
    const terminar = (valor) => {
      dialogo.close();
      $("#form-clave").onsubmit = null;
      $("#cancelar-clave").onclick = null;
      resolver(valor);
    };
    $("#form-clave").onsubmit = async (e) => {
      e.preventDefault();
      const valor = campo.value.trim();
      if (!valor) return;
      guardarContrasena(valor);
      terminar(valor);
    };
    $("#cancelar-clave").onclick = () => terminar("");
  });
}

/** Aplica un producto devuelto por el servidor a la lista local y repinta. */
function aplicarCambio(producto, borrar = false) {
  const lista = datosLista.productos;
  const i = lista.findIndex((p) => p.id === producto.id);
  if (borrar) { if (i !== -1) lista.splice(i, 1); }
  else if (i === -1) lista.push(producto);
  else lista[i] = producto;
  productos = preparar(datosLista, datosPrecios);
  pintarChips();
  pintarEleccion();
  pintarLista();
}

async function accion(texto, fn) {
  aviso(texto, "esperando");
  try {
    const mensaje = await fn();
    aviso(mensaje, "ok");
  } catch (err) {
    aviso(err.message, "error");
  }
}

function descartarTienda(p, clave, tienda) {
  if (!document.body.classList.contains("editando")) return;
  accion(`Quitando ${tienda}…`, async () => {
    const { producto } = await llamar("POST", `/productos/${p.id}/descartar`, { tienda: clave });
    aplicarCambio(producto);
    return `${tienda} ya no aparecerá en “${p.nombre}”.`;
  });
}

function abrirAnadir() {
  const categoria = categorias.find((c) => c.id === estado.categoria) || categorias[0];
  const selector = $("#nuevo-para");
  selector.innerHTML = categoria.personas.map((n) => `<option value="${escapar(n)}">${escapar(n)}</option>`).join("");
  if (estado.persona !== "todas") selector.value = estado.persona;
  $("#form-anadir").reset();
  if (estado.persona !== "todas") selector.value = estado.persona;
  $("#error-anadir").textContent = "";
  $("#titulo-anadir").textContent = `Añadir a ${categoria.nombre}`;
  $("#dialogo-anadir").showModal();
  $("#nuevo-nombre").focus();
}

async function guardarNuevo(e) {
  e.preventDefault();
  const boton = $("#guardar-anadir");
  const cuerpo = {
    nombre: $("#nuevo-nombre").value.trim(),
    para: $("#nuevo-para").value,
    categoria: estado.categoria,
    enlaces: [$("#nuevo-enlace").value.trim(), $("#nuevo-enlace-2").value.trim()].filter(Boolean),
    precio_lista: $("#nuevo-precio").value.trim() || null,
    busqueda: $("#nuevo-busqueda").value.trim(),
  };
  boton.disabled = true;
  $("#error-anadir").textContent = "";
  try {
    aviso("Guardando…", "esperando");
    const { producto } = await llamar("POST", "/productos", cuerpo);
    $("#dialogo-anadir").close();
    aplicarCambio(producto);
    aviso(`“${producto.nombre}” añadido. El robot empieza a buscar precios; aparecerán en unos minutos.`, "ok");
  } catch (err) {
    $("#error-anadir").textContent = err.message;
    $("#aviso").className = "aviso";
  } finally {
    boton.disabled = false;
  }
}

function enlazarEdicion() {
  $("#boton-anadir").addEventListener("click", abrirAnadir);
  $("#form-anadir").addEventListener("submit", guardarNuevo);
  $("#cancelar-anadir").addEventListener("click", () => $("#dialogo-anadir").close());
  $("#boton-editar").addEventListener("click", () => {
    const activo = document.body.classList.toggle("editando");
    $("#boton-editar").setAttribute("aria-pressed", String(activo));
    $("#boton-editar").textContent = activo ? "Terminar de editar" : "✎ Editar";
    if (activo) aviso("Modo edición: marca comprados, elimina regalos o quita tiendas que no son el producto (✕).");
  });
  document.addEventListener("click", (e) => {
    const comprado = e.target.closest("[data-comprado]");
    const eliminar = e.target.closest("[data-eliminar]");
    const pendiente = e.target.closest("[data-pendiente]");
    if (comprado) {
      const p = productos.find((x) => x.id === comprado.dataset.comprado);
      accion("Guardando…", async () => {
        const { producto } = await llamar("POST", `/productos/${p.id}/estado`, { estado: "comprado" });
        elegidos.delete(p.id); guardarElegidos();
        aplicarCambio(producto);
        return `“${p.nombre}” pasa a Ya comprados.`;
      });
    } else if (eliminar) {
      const p = productos.find((x) => x.id === eliminar.dataset.eliminar);
      if (!window.confirm(`¿Eliminar “${p.nombre}” de la lista?`)) return;
      accion("Eliminando…", async () => {
        await llamar("DELETE", `/productos/${p.id}`);
        elegidos.delete(p.id); guardarElegidos();
        aplicarCambio(p, true);
        return `“${p.nombre}” eliminado.`;
      });
    } else if (pendiente) {
      const p = productos.find((x) => x.id === pendiente.dataset.pendiente);
      accion("Guardando…", async () => {
        const { producto } = await llamar("POST", `/productos/${p.id}/estado`, { estado: "pendiente" });
        aplicarCambio(producto);
        return `“${p.nombre}” vuelve a la lista.`;
      });
    }
  });
  if (API) fetch(`${API}/salud`).catch(() => {}); // lo despierta mientras miras la lista
}

function enlazarEventos() {
  $("#chips-persona").addEventListener("click", (e) => {
    const boton = e.target.closest("[data-persona]");
    if (!boton) return;
    estado.persona = boton.dataset.persona;
    pintarChips();
    pintarLista();
  });
  $("#categorias").addEventListener("click", (e) => {
    const boton = e.target.closest("[data-categoria]");
    if (!boton) return;
    estado.categoria = boton.dataset.categoria;
    estado.persona = "todas";
    pintarCategorias(); pintarChips(); pintarLista();
  });
  $("#ver-elegidos").addEventListener("click", () => {
    estado.soloElegidos = !estado.soloElegidos;
    pintarEleccion(); pintarLista();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#quitar-eleccion").addEventListener("click", () => {
    elegidos.clear(); guardarElegidos();
    estado.soloElegidos = false;
    pintarEleccion(); pintarLista();
  });
  $("#buscar").addEventListener("input", (e) => { estado.texto = e.target.value; pintarLista(); });
  $("#orden").addEventListener("change", (e) => { estado.orden = e.target.value; pintarLista(); });
}

async function iniciar() {
  enlazarEventos();
  try {
    const [lista, precios, config] = await Promise.all([
      cargar("data/productos.json"),
      cargar("data/precios.json").catch(() => ({ productos: {} })),
      cargar("data/config.json").catch(() => ({})),
    ]);
    datosLista = lista;
    datosPrecios = precios;
    API = (config.api || "").replace(/\/$/, "");
    enlazarEdicion();
    categorias = lista.categorias || [{ id: "reyes", nombre: lista.lista || "Reyes", personas: ["Alba", "Lucía", "Las dos"] }];
    estado.categoria = categorias[0].id;
    productos = preparar(lista, precios);
    const ids = new Set(productos.map((p) => p.id));
    elegidos = new Set([...elegidos].filter((id) => ids.has(id)));
    pintarActualizado(precios.actualizado);
    pintarCategorias();
    pintarChips();
    pintarEleccion();
    pintarLista();
  } catch (err) {
    $("#actualizado").textContent = `No se pudo cargar la lista (${err.message}).`;
  }
}

iniciar();
