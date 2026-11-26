"use strict";

const REPO = "Maktub86/Mi-Mercado";
const CLASES = { "Alba": "alba", "Lucía": "lucia", "Las dos": "dos", "Alejandro": "alejandro", "Rocío": "rocio" };
let categorias = [];

const euros = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const fechaCorta = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });
const fechaLarga = new Intl.DateTimeFormat("es-ES", {
  weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
});

const estado = { categoria: null, persona: "todas", texto: "", orden: "lista", soloElegidos: false, vista: "lista" };
const CLAVE_ELEGIDOS = "mi-mercado-elegidos";
let elegidos = new Set();
try { elegidos = new Set(JSON.parse(localStorage.getItem(CLAVE_ELEGIDOS) || "[]")); } catch (e) { /* sin almacenamiento */ }
function guardarElegidos(local) {
  try { localStorage.setItem(CLAVE_ELEGIDOS, JSON.stringify([...elegidos])); } catch (e) { /* sin almacenamiento */ }
  if (!local) programarSubida();
}
let productos = [];

// Pestaña Calcular: a quién va cada regalo, precio cambiado a mano y cosas que no están en la lista.
// Se guarda en este dispositivo y se comparte con los demás a través del servidor (web/data/calcular.json).
const CLAVE_CALCULAR = "mi-mercado-calcular";
const GRUPOS_BASE = ["Reyes Niñas", "Reyes Lucía", "Reyes Alba", "Cumpleaños Lucía", "Papá Noel"];
const CESTA = "Cesta";
let calc = { grupo: {}, precio: {}, extras: [], grupos: [], orden: [] };
try { calc = { ...calc, ...JSON.parse(localStorage.getItem(CLAVE_CALCULAR) || "{}") }; } catch (e) { /* sin almacenamiento */ }
calc.grupo = calc.grupo || {};
calc.orden = calc.orden || [];
calc.grupos = [...new Set([...GRUPOS_BASE, ...(calc.grupos || [])])];
function guardarCalc(local) {
  try { localStorage.setItem(CLAVE_CALCULAR, JSON.stringify(calc)); } catch (e) { /* sin almacenamiento */ }
  if (!local) programarSubida();
}

// ---- compartir las cestas entre móviles
let compartir = { listo: false, pendiente: false, temporizador: null, sinClave: false, ultimoError: "" };

function estadoCestas() {
  return { elegidos: [...elegidos], grupo: calc.grupo, precio: calc.precio, extras: calc.extras, grupos: calc.grupos, orden: calc.orden };
}

function hayCestas() {
  return elegidos.size > 0 || calc.extras.length > 0;
}

function programarSubida() {
  compartir.pendiente = true;
  if (!API || !compartir.listo || compartir.sinClave) return;
  clearTimeout(compartir.temporizador);
  compartir.temporizador = setTimeout(subirCestas, 2500);
}

async function subirCestas() {
  if (!compartir.pendiente) return;
  try {
    await llamar("POST", "/calcular", { calcular: estadoCestas() });
    compartir.pendiente = false;
    compartir.ultimoError = "";
  } catch (err) {
    if (!leerContrasena()) {
      compartir.sinClave = true;
      aviso("Las cestas se guardan solo en este móvil. Para compartirlas, pon la contraseña en ✎ Editar.", "error");
    } else if (compartir.ultimoError !== err.message) {
      compartir.ultimoError = err.message;
      aviso(`No se pudieron compartir las cestas: ${err.message}`, "error");
    }
  }
}

async function bajarCestas() {
  if (!API) return;
  try {
    const resp = await fetch(`${API}/calcular`, { cache: "no-store" });
    const datos = await resp.json();
    if (!resp.ok) throw new Error(datos.error || resp.status);
    const remoto = datos.calcular || {};
    if (compartir.pendiente && compartir.listo) return; // hay cambios nuestros sin subir: mandan ellos
    if (remoto.actualizado) {
      const ids = new Set(productos.map((p) => p.id));
      elegidos = new Set((remoto.elegidos || []).filter((id) => ids.has(id)));
      calc = { grupo: remoto.grupo || {}, precio: remoto.precio || {}, extras: remoto.extras || [],
        grupos: [...new Set([...GRUPOS_BASE, ...(remoto.grupos || [])])], orden: remoto.orden || [] };
      guardarElegidos(true); guardarCalc(true);
      compartir.pendiente = false;
      if (!arrastre.activo) mostrarVista();
    } else {
      compartir.pendiente = hayCestas(); // aún no hay nada compartido: sube lo de este móvil
    }
  } catch (e) {
    /* sin conexión con el servidor: se sigue con lo de este dispositivo */
  } finally {
    compartir.listo = true;
    if (compartir.pendiente) programarSubida();
  }
}

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
      const clave = enlace.url || (enlace.amazon_buscar ? `amazon:${enlace.amazon_buscar}`
        : enlace.eci_buscar ? `eci:${enlace.eci_buscar}` : `buscar:${enlace.dominio}:${enlace.buscar}`);
      const info = datos[clave] || {};
      const url = enlace.url || info.url || (enlace.amazon_buscar
        ? `https://www.amazon.es/s?k=${encodeURIComponent(enlace.amazon_buscar)}`
        : enlace.eci_buscar
          ? `https://www.elcorteingles.es/search-nwx/1/?s=${encodeURIComponent(enlace.eci_buscar)}&stype=text_box`
          : `https://${enlace.dominio}/search?q=${encodeURIComponent(enlace.buscar)}`);
      // "propio": enlace que ha puesto alguien a mano (no una búsqueda automática).
      todas.push(aTienda({ ...enlace, propio: Boolean(enlace.url) }, info, url, clave));
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
    // Se enseñan las tiendas con precio leído y, aunque aún no tengan precio, los enlaces puestos a mano.
    const descartadas = new Set(p.descartadas || []);
    const tiendas = [...porNombre.values()]
      .filter((t) => t.url && (t.ultimo || t.propio) && !descartadas.has(t.clave))
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
  const enCalc = elegidos.size + calc.extras.length;
  $("#categorias").innerHTML = categorias.map((c) =>
    `<button type="button" class="categoria" data-categoria="${c.id}" aria-pressed="${estado.vista === "lista" && c.id === estado.categoria}">${escapar(c.nombre)}</button>`).join("")
    + `<button type="button" class="categoria pestana-carta" data-vista="carta" aria-pressed="${estado.vista === "carta"}">✉️ Carta</button>`
    + `<button type="button" class="categoria pestana-calcular" data-vista="calcular" aria-pressed="${estado.vista === "calcular"}">🧮 Calcular${enCalc ? ` <span class="cuenta-calc">${enCalc}</span>` : ""}</button>`;
}

function pintarEleccion() {
  const lista = itemsCalc();
  const barra = $("#barra-eleccion");
  const visible = lista.length > 0 && estado.vista === "lista";
  barra.hidden = !visible;
  document.body.classList.toggle("con-barra", visible);
  if (!lista.length) { estado.soloElegidos = false; return; }
  const total = lista.reduce((s, x) => s + (x.precio || 0), 0);
  const sinPrecio = lista.filter((x) => x.precio == null).length;
  $("#eleccion-total").textContent = euros.format(total);
  $("#eleccion-detalle").textContent = `${lista.length} ${lista.length === 1 ? "regalo" : "regalos"} en Calcular`
    + (sinPrecio ? ` · ${sinPrecio} sin precio` : "");
  $("#ver-elegidos").textContent = "Ir a Calcular →";
}

function pintarChips() {
  const categoria = categorias.find((c) => c.id === estado.categoria) || { personas: [] };
  const pendientes = deCategoria().filter((p) => p.estado !== "comprado");
  const opciones = [{ id: "todas", nombre: "Todos" }, ...categoria.personas.map((n) => ({ id: n, nombre: n }))];
  $("#chips-persona").innerHTML = opciones.map((p) => {
    const suyos = p.id === "todas" ? pendientes : pendientes.filter((x) => x.para === p.id);
    const { total } = sumar(suyos);
    return `<button class="chip ${CLASES[p.id] || ""}" role="tab" data-persona="${escapar(p.id)}" aria-selected="${estado.persona === p.id}">
      ${escapar(p.nombre)}<span class="cuenta">${suyos.length}</span>${suyos.length ? `<span class="suma">${eurosRedondos.format(total)}</span>` : ""}</button>`;
  }).join("");
  pintarResumen(categoria);
}

const eurosRedondos = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** Suma de una lista de regalos: al mejor precio de hoy (o el de la lista si no hay) y al precio de la lista. */
function sumar(lista) {
  const total = lista.reduce((s, p) => s + (p.referencia || 0), 0);
  const conLista = lista.filter((p) => p.precio_lista != null && p.actual != null);
  const ahorro = conLista.reduce((s, p) => s + (p.precio_lista - p.actual), 0);
  const sinPrecio = lista.filter((p) => p.referencia == null).length;
  return { total, ahorro, sinPrecio, conLista: conLista.length };
}

/** Resumen de la pestaña elegida: lo que falta por comprar, el reparto por persona y lo ya comprado. */
function pintarResumen(categoria) {
  const todos = deCategoria();
  const deQuien = (p) => estado.persona === "todas" || p.para === estado.persona;
  const pendientes = todos.filter((p) => p.estado !== "comprado" && deQuien(p));
  const comprados = todos.filter((p) => p.estado === "comprado" && deQuien(p));
  const caja = $("#resumen");
  if (!pendientes.length && !comprados.length) { caja.hidden = true; return; }
  caja.hidden = false;

  const s = sumar(pendientes);
  const c = sumar(comprados);
  const quien = estado.persona === "todas" ? "todos" : estado.persona;
  const detalles = [`${pendientes.length} ${pendientes.length === 1 ? "regalo" : "regalos"}`];
  if (s.sinPrecio) detalles.push(`${s.sinPrecio} sin precio todavía`);
  if (s.conLista && Math.abs(s.ahorro) >= 0.5) {
    detalles.push(s.ahorro > 0 ? `<span class="baja">${euros.format(s.ahorro)} menos que en la lista</span>`
      : `<span class="sube">${euros.format(-s.ahorro)} más que en la lista</span>`);
  }

  let reparto = "";
  if (estado.persona === "todas") {
    const personas = [...new Set([...categoria.personas, ...pendientes.map((p) => p.para)])];
    const filas = personas.map((n) => {
      const suyos = pendientes.filter((p) => p.para === n);
      return suyos.length ? `<li class="${CLASES[n] || "dos"}"><span>${escapar(n)}</span><strong>${euros.format(sumar(suyos).total)}</strong></li>` : "";
    }).join("");
    if (filas) reparto = `<ul class="reparto">${filas}</ul>`;
  }

  caja.innerHTML = `
    <div class="resumen-principal">
      <p class="resumen-titulo">Falta por comprar (${escapar(quien)})</p>
      <p class="resumen-total">${euros.format(s.total)}</p>
      <p class="resumen-detalle">${detalles.join(" · ")}</p>
    </div>
    ${reparto}
    ${comprados.length ? `<p class="resumen-comprado">Ya comprado: <strong>${euros.format(c.total)}</strong> en ${comprados.length} ${comprados.length === 1 ? "regalo" : "regalos"}${c.sinPrecio ? ` (${c.sinPrecio} sin precio)` : ""}</p>` : ""}
    <p class="resumen-nota">Suma del mejor precio de hoy de cada regalo; si aún no hay precio de tienda, el de la lista.</p>`;
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
  const conPrecio = p.tiendas.filter((t) => t.ultimo);
  const mejor = conPrecio[0];
  const peor = conPrecio[conPrecio.length - 1];
  const ahorro = mejor ? peor.ultimo.precio - mejor.ultimo.precio : 0;
  const cabecera = !conPrecio.length
    ? "Todavía no se ha leído el precio. El robot lo intentará en la próxima revisión."
    : p.tiendas.length > 1
      ? `Top ${top.length} de ${p.tiendas.length} ${p.tiendas.length === 1 ? "tienda" : "tiendas"}${ahorro >= 0.01 ? ` · ahorras hasta <strong>${euros.format(ahorro)}</strong>` : ""}`
      : "1 tienda con precio";
  const filas = top.map((t, i) => {
    if (!t.ultimo) {
      return `<li class="fila-tienda">
      <span class="puesto">–</span>
      <span class="fila-texto"><span class="fila-nombre">${escapar(t.tienda)}</span>
        <span class="fila-info">${escapar(t.error || "precio pendiente de leer")}</span></span>
      <span class="fila-precio">—</span>
      <a class="fila-ir" href="${escapar(t.url)}" target="_blank" rel="noopener" aria-label="Ir a ${escapar(t.tienda)}">Ir ↗</a>
      <button type="button" class="fila-quitar solo-edicion" data-descartar="${escapar(t.clave)}" data-tienda="${escapar(t.tienda)}"
        title="No es este producto: quitar esta tienda" aria-label="Quitar ${escapar(t.tienda)}">✕</button>
    </li>`;
    }
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
    elegir.title = si ? "Quitar de Calcular" : "Mandar a Calcular";
    nodo.classList.toggle("elegida", si);
  };
  elegir.addEventListener("click", () => {
    if (elegidos.has(p.id)) elegidos.delete(p.id); else elegidos.add(p.id);
    guardarElegidos();
    marcar();
    pintarEleccion();
    pintarCategorias();
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

// ---------------------------------------------------------------- calcular

function leerPrecio(texto) {
  const limpio = String(texto).replace(/[€\s]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (limpio === "") return null;
  const n = Number(limpio);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
}

/** Color de cada cesta según para quién es. */
function claseGrupo(g) {
  if (g === CESTA) return "cesta";
  if (/niñas|las dos/i.test(g)) return "dos";
  if (/lucía|lucia/i.test(g)) return "lucia";
  if (/alba/i.test(g)) return "alba";
  if (/alejandro/i.test(g)) return "alejandro";
  if (/roc[ií]o|noel/i.test(g)) return "rocio";
  return "otro";
}

function nombreVisible(g) {
  return g === CESTA ? "🧺 Cesta (sin colocar)" : g;
}

function itemsCalcSinOrden() {
  const deLista = productos.filter((p) => elegidos.has(p.id)).map((p) => ({
    id: p.id,
    nombre: p.nombre,
    grupo: calc.grupo[p.id] || CESTA,
    precio: calc.precio[p.id] ?? p.referencia ?? null,
    original: p.referencia ?? null,
    cambiado: calc.precio[p.id] != null,
    donde: p.mejor ? p.mejor.tienda : p.precio_lista != null ? "precio de la lista" : "",
    url: p.mejor ? p.mejor.url : null,
    tienda: p.mejor ? p.mejor.tienda : "",
    fotos: p.fotos || [],
    extra: false,
  }));
  const extras = calc.extras.map((x) => ({ ...x, grupo: x.grupo || CESTA, original: null, cambiado: false, donde: "añadido a mano", url: null, tienda: "", fotos: [], extra: true }));
  return [...deLista, ...extras];
}

function itemsCalc() {
  return itemsCalcSinOrden();
}

function mostrarVista() {
  const enLista = estado.vista === "lista";
  document.querySelector(".filtros").hidden = !enLista;
  $("#pendientes").hidden = !enLista;
  $("#vista-calcular").hidden = estado.vista !== "calcular";
  $("#vista-carta").hidden = estado.vista !== "carta";
  if (!enLista) {
    $("#resumen").hidden = true;
    $("#vacio").hidden = true;
    $("#bloque-comprados").hidden = true;
    if (estado.vista === "carta") pintarCarta(); else pintarCalcular();
  } else {
    pintarChips();
    pintarLista();
  }
  pintarCategorias();
  pintarEleccion();
}

function pintarCalcular() {
  const caja = $("#vista-calcular");
  const items = itemsCalc();
  const orden = [CESTA, ...calc.grupos];
  const opciones = (actual) => orden.map((g) =>
    `<option value="${escapar(g)}"${g === actual ? " selected" : ""}>${escapar(nombreVisible(g))}</option>`).join("")
    + `<option value="__nuevo">＋ Nueva cesta…</option>`;
  const total = items.reduce((s, x) => s + (x.precio || 0), 0);
  const sinPrecio = items.filter((x) => x.precio == null).length;

  const grupos = orden.map((g) => ({ nombre: g, items: items.filter((x) => x.grupo === g) }))
    .filter((g) => g.items.length);
  grupos.forEach((g) => g.items.sort((a, b) => (b.precio ?? -1) - (a.precio ?? -1)));

  const reparto = grupos.map((g) => {
    const suma = g.items.reduce((s, x) => s + (x.precio || 0), 0);
    return `<li class="${claseGrupo(g.nombre)}"><span>${escapar(g.nombre === CESTA ? "Sin colocar" : g.nombre)}</span><strong>${euros.format(suma)}</strong></li>`;
  }).join("");

  const fila = (x) => `
    <li class="calc-fila" data-item="${escapar(x.id)}">
      <div class="calc-nombre">
        <strong>${escapar(x.nombre)}</strong>
        <small>${x.url ? `<a href="${escapar(x.url)}" target="_blank" rel="noopener">${escapar(x.donde)} ↗</a>` : escapar(x.donde)}${x.cambiado && x.original != null ? ` · antes ${euros.format(x.original)}` : ""}${enlaceCoupert(x) ? ` · <a class="enlace-coupert" href="${escapar(enlaceCoupert(x))}" target="_blank" rel="noopener">🏷️ Cupones Coupert</a>` : ""}</small>
      </div>
      <label class="calc-campo"><span>Colocar en</span>
        <select data-calc-grupo>${opciones(x.grupo)}</select></label>
      <label class="calc-campo calc-precio"><span>Precio</span>
        <input data-calc-precio inputmode="decimal" value="${x.precio != null ? x.precio.toFixed(2).replace(".", ",") : ""}" placeholder="—" aria-label="Precio de ${escapar(x.nombre)}"></label>
      <button type="button" class="calc-quitar" data-calc-quitar title="Quitar de Calcular" aria-label="Quitar ${escapar(x.nombre)}">✕</button>
    </li>`;

  const listas = grupos.map((g) => {
    const suma = g.items.reduce((s, x) => s + (x.precio || 0), 0);
    return `<section class="calc-grupo ${claseGrupo(g.nombre)}">
      <header class="calc-grupo-cabeza"><h2>${escapar(nombreVisible(g.nombre))}</h2>
        <span>${g.items.length} ${g.items.length === 1 ? "regalo" : "regalos"} · <strong>${euros.format(suma)}</strong></span></header>
      <ul class="calc-lista">${g.items.map(fila).join("")}</ul>
    </section>`;
  }).join("");

  caja.innerHTML = `
    <div class="resumen calc-resumen">
      <div class="resumen-principal">
        <p class="resumen-titulo">Total</p>
        <p class="resumen-total">${euros.format(total)}</p>
        <p class="resumen-detalle">${items.length} ${items.length === 1 ? "regalo" : "regalos"}${sinPrecio ? ` · ${sinPrecio} sin precio` : ""}</p>
      </div>
      ${reparto ? `<ul class="reparto">${reparto}</ul>` : ""}
      ${items.length ? `<div class="calc-acciones">
        <button type="button" class="boton-accion suave" id="calc-copiar">Copiar resumen</button>
        <button type="button" class="boton-accion suave" id="calc-vaciar">Vaciar</button></div>` : ""}
    </div>
    ${items.length ? listas : `<p class="calc-vacio">Toca el <b>🧮</b> de cualquier regalo de la lista para mandarlo a la cesta. Desde aquí lo colocas en Reyes Niñas, Reyes Lucía, Reyes Alba, Cumpleaños Lucía, Papá Noel o una cesta nueva, y ves cuánto sale cada una.</p>`}
    <form class="calc-anadir" id="calc-anadir">
      <h2>Añadir algo que no está en la lista</h2>
      <div class="calc-anadir-campos">
        <input id="calc-nuevo-nombre" required maxlength="120" placeholder="Qué es" aria-label="Qué es">
        <input id="calc-nuevo-precio" inputmode="decimal" placeholder="Precio" aria-label="Precio">
        <select id="calc-nuevo-grupo" aria-label="Colocar en">${opciones(CESTA)}</select>
        <button type="submit" class="boton-accion">Añadir</button>
      </div>
      <p class="ayuda">Las cestas se comparten entre todos los móviles que tengan puesta la contraseña. No cambian la lista de regalos.</p>
    </form>
    ${bloqueCoupert(items)}`;
}

function textoResumenCalc() {
  const items = itemsCalc();
  const lineas = [];
  [CESTA, ...calc.grupos].forEach((g) => {
    const suyos = items.filter((x) => x.grupo === g).sort((a, b) => (b.precio ?? -1) - (a.precio ?? -1));
    if (!suyos.length) return;
    const suma = suyos.reduce((s, x) => s + (x.precio || 0), 0);
    lineas.push(`${g === CESTA ? "Sin colocar" : g}: ${euros.format(suma)}`);
    suyos.forEach((x) => lineas.push(`  - ${x.nombre}: ${x.precio != null ? euros.format(x.precio) : "sin precio"}`));
  });
  lineas.push(`TOTAL: ${euros.format(items.reduce((s, x) => s + (x.precio || 0), 0))}`);
  return lineas.join("\n");
}

function enlazarCalcular() {
  const caja = $("#vista-calcular");
  caja.addEventListener("change", (e) => {
    const fila = e.target.closest("[data-item]");
    if (!fila) return;
    const id = fila.dataset.item;
    const extra = calc.extras.find((x) => x.id === id);
    if (e.target.matches("[data-calc-grupo]")) {
      let destino = e.target.value;
      if (destino === "__nuevo") {
        destino = (window.prompt("Nombre de la cesta nueva (por ejemplo: Cumpleaños Alba)") || "").trim().slice(0, 40);
        if (!destino) { pintarCalcular(); return; }
        if (!calc.grupos.includes(destino) && destino !== CESTA) calc.grupos.push(destino);
      }
      colocar(id, destino);
    } else if (e.target.matches("[data-calc-precio]")) {
      const valor = leerPrecio(e.target.value);
      if (valor === undefined) { aviso("Ese precio no se entiende. Escribe por ejemplo 24,99.", "error"); return; }
      if (extra) extra.precio = valor;
      else {
        const p = productos.find((x) => x.id === id);
        if (valor == null || (p && valor === p.referencia)) delete calc.precio[id]; else calc.precio[id] = valor;
      }
    } else return;
    guardarCalc();
    pintarCalcular();
  });
  caja.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-calc-precio]")) { e.preventDefault(); e.target.blur(); }
  });
  caja.addEventListener("click", (e) => {
    const quitar = e.target.closest("[data-calc-quitar]");
    if (quitar) {
      const id = quitar.closest("[data-item]").dataset.item;
      calc.extras = calc.extras.filter((x) => x.id !== id);
      elegidos.delete(id); guardarElegidos();
      delete calc.grupo[id]; delete calc.precio[id];
      guardarCalc();
      pintarCalcular(); pintarCategorias();
    } else if (e.target.id === "calc-vaciar") {
      if (!window.confirm("¿Quitar todo de Calcular?")) return;
      elegidos.clear(); guardarElegidos();
      calc = { grupo: {}, precio: {}, extras: [], grupos: calc.grupos, orden: [] }; guardarCalc();
      pintarCalcular(); pintarCategorias();
    } else if (e.target.id === "calc-copiar") {
      const texto = textoResumenCalc();
      (navigator.clipboard ? navigator.clipboard.writeText(texto) : Promise.reject())
        .then(() => aviso("Resumen copiado. Puedes pegarlo en WhatsApp.", "ok"))
        .catch(() => window.prompt("Copia el resumen:", texto));
    }
  });
  caja.addEventListener("submit", (e) => {
    if (e.target.id !== "calc-anadir") return;
    e.preventDefault();
    const nombre = $("#calc-nuevo-nombre").value.trim();
    const precio = leerPrecio($("#calc-nuevo-precio").value);
    if (!nombre) return;
    if (precio === undefined) { aviso("Ese precio no se entiende. Escribe por ejemplo 24,99.", "error"); return; }
    let grupo = $("#calc-nuevo-grupo").value;
    if (grupo === "__nuevo") {
      grupo = (window.prompt("Nombre de la cesta nueva") || "").trim().slice(0, 40) || CESTA;
      if (grupo !== CESTA && !calc.grupos.includes(grupo)) calc.grupos.push(grupo);
    }
    calc.extras.push({ id: `extra-${Date.now()}`, nombre, grupo, precio });
    guardarCalc();
    pintarCalcular(); pintarCategorias();
    $("#calc-nuevo-nombre").focus();
  });
}

// ---------------------------------------------------------------- coupert

// Coupert (cupones y reembolso) tiene una página por tienda: https://www.coupert.com/store/<dominio>.
// Los enlaces que vienen de un comparador (Globerada, Idealo) llevan a ese comparador, así que
// en esos casos el dominio se saca del nombre de la tienda.
const DOMINIOS_TIENDA = [
  [/amazon/i, "amazon.es"], [/corte ingl/i, "elcorteingles.es"], [/toy planet/i, "toyplanet.com"],
  [/juguettos/i, "juguettos.com"], [/abacus/i, "abacus.coop"], [/fnac/i, "fnac.es"], [/miravia/i, "miravia.es"],
  [/temu/i, "temu.com"], [/aliexpress/i, "aliexpress.com"], [/pccomponentes/i, "pccomponentes.com"],
  [/toys ?"?r"? ?us/i, "toysrus.es"], [/carrefour/i, "carrefour.es"], [/pixmania/i, "pixmania.com"],
  [/raijuguetes/i, "raijuguetes.com"], [/electropolis/i, "electropolis.es"], [/onbuy/i, "onbuy.com"],
  [/sfera/i, "sfera.com"], [/casa del libro/i, "casadellibro.com"], [/dideco/i, "dideco.es"],
  [/ebay/i, "ebay.es"], [/shein/i, "shein.com"], [/lego/i, "lego.com"], [/decathlon/i, "decathlon.es"],
];
const COMPARADORES = /(^|\.)(globerada\.com|idealo\.es|idealo\.com)$/i;

function dominioTienda(x) {
  let host = "";
  try { host = new URL(x.url).hostname.replace(/^www\./, ""); } catch (e) { /* sin enlace */ }
  if (host && !COMPARADORES.test(host)) return host;
  const conocido = DOMINIOS_TIENDA.find(([re]) => re.test(x.tienda || x.donde || ""));
  return conocido ? conocido[1] : null;
}

function enlaceCoupert(x) {
  const dominio = x.url ? dominioTienda(x) : null;
  return dominio ? `https://www.coupert.com/store/${dominio}` : null;
}

/** Tiendas donde está lo elegido, con su enlace a los cupones de Coupert. */
function bloqueCoupert(items) {
  const tiendas = new Map();
  items.forEach((x) => {
    const dominio = x.url ? dominioTienda(x) : null;
    if (!dominio) return;
    const t = tiendas.get(dominio) || { dominio, nombre: (x.tienda || x.donde || dominio).replace(/\s*\(.*\)$/, ""), regalos: 0, suma: 0 };
    t.regalos += 1;
    t.suma += x.precio || 0;
    tiendas.set(dominio, t);
  });
  if (!tiendas.size) return "";
  const filas = [...tiendas.values()].sort((a, b) => b.suma - a.suma).map((t) => `
    <li><a href="https://www.coupert.com/store/${escapar(t.dominio)}" target="_blank" rel="noopener">
      <strong>${escapar(t.nombre)}</strong> <span>${escapar(t.dominio)}</span></a>
      <small>${t.regalos} ${t.regalos === 1 ? "regalo" : "regalos"} · ${euros.format(t.suma)}</small></li>`).join("");
  return `<section class="coupert" aria-label="Cupones Coupert">
    <h2>🏷️ Cupones y reembolso con Coupert</h2>
    <p>Antes de pagar, mira si hay cupón en la tienda donde está más barato cada regalo de lo que tenéis elegido. Si tenéis la extensión o la app de Coupert, al pagar prueba los cupones sola.</p>
    <ul class="coupert-lista">${filas}</ul>
    <p class="ayuda">Coupert está pensado sobre todo para tiendas de EE. UU.: algunas tiendas españolas pueden no tener cupones o abrir la página de la tienda de otro país.</p>
  </section>`;
}

// ---------------------------------------------------------------- carta

/** Pone un regalo (de la lista o añadido a mano) en una cesta. */
function colocar(id, destino) {
  const extra = calc.extras.find((x) => x.id === id);
  if (extra) extra.grupo = destino;
  else if (destino === CESTA) delete calc.grupo[id];
  else calc.grupo[id] = destino;
}

function ordenCarta(items) {
  const pos = new Map(calc.orden.map((id, i) => [id, i]));
  return items.slice().sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
}

function pintarCarta() {
  const caja = $("#vista-carta");
  const items = ordenCarta(itemsCalc());
  const total = items.reduce((s, x) => s + (x.precio || 0), 0);
  const sinPrecio = items.filter((x) => x.precio == null).length;
  const sinColocar = items.some((x) => x.grupo === CESTA);
  const grupos = [...(sinColocar ? [CESTA] : []), ...calc.grupos];

  const ficha = (x) => {
    const [foto, ...resto] = x.fotos;
    return `<li class="carta-item" data-item="${escapar(x.id)}" title="${escapar(x.nombre)}">
      <div class="carta-foto">${foto
        ? `<img src="${escapar(foto)}" data-resto="${escapar(resto.map(encodeURI).join(" "))}" alt="${escapar(x.nombre)}" draggable="false" loading="lazy" referrerpolicy="no-referrer">`
        : '<span aria-hidden="true">🎁</span>'}</div>
      <p class="carta-nombre">${escapar(x.nombre)}</p>
      <p class="carta-precio${x.precio == null ? " sin-dato" : ""}">${x.precio != null ? euros.format(x.precio) : "sin precio"}</p>
    </li>`.replace(/>\s+</g, "><");
  };

  const secciones = grupos.map((g) => {
    const suyos = items.filter((x) => x.grupo === g);
    const suma = suyos.reduce((s, x) => s + (x.precio || 0), 0);
    return `<section class="carta-grupo ${claseGrupo(g)}" data-grupo="${escapar(g)}">
      <header class="carta-grupo-cabeza"><h2>${escapar(nombreVisible(g))}</h2>
        <span>${suyos.length} ${suyos.length === 1 ? "regalo" : "regalos"}</span></header>
      <ul class="carta-items" data-grupo="${escapar(g)}">${suyos.map(ficha).join("")}</ul>
      <p class="carta-subtotal">Total: <strong>${euros.format(suma)}</strong></p>
    </section>`;
  }).join("");

  caja.innerHTML = items.length ? `
    <p class="carta-ayuda">Arrastra cada regalo (en el móvil, mantenlo pulsado un momento) para pasarlo a otra carta o cambiarlo de sitio. Se guarda igual que en 🧮 Calcular.</p>
    ${secciones}
    <div class="carta-total">
      <div><p class="resumen-titulo">Total de todo</p>
        <p class="resumen-detalle">${items.length} ${items.length === 1 ? "regalo" : "regalos"}${sinPrecio ? ` · ${sinPrecio} sin precio` : ""}</p></div>
      <strong>${euros.format(total)}</strong>
    </div>
    <button type="button" class="boton-accion suave" id="carta-nueva">＋ Nueva carta</button>
    ${bloqueCoupert(items)}`
    : `<p class="calc-vacio">Todavía no hay nada elegido. Toca el <b>🧮</b> de los regalos de la lista y aparecerán aquí, repartidos en Reyes Niñas, Reyes Lucía, Reyes Alba, Cumpleaños Lucía, Papá Noel…</p>`;
}

const arrastre = { activo: null, pendiente: null, rueda: null };

function enlazarCarta() {
  const caja = $("#vista-carta");

  // Si una foto no carga, se prueba la siguiente; si no queda ninguna, el paquete de regalo.
  caja.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const resto = (img.dataset.resto || "").split(" ").filter(Boolean);
    if (resto.length) { img.src = decodeURI(resto.shift()); img.dataset.resto = resto.join(" "); }
    else img.replaceWith(Object.assign(document.createElement("span"), { textContent: "🎁" }));
  }, true);

  const empezar = (item, x, y) => {
    const r = item.getBoundingClientRect();
    const fantasma = item.cloneNode(true);
    fantasma.classList.add("carta-fantasma");
    fantasma.style.width = `${r.width}px`;
    document.body.append(fantasma);
    arrastre.activo = { item, fantasma, dx: x - r.left, dy: y - r.top, x, y };
    item.classList.add("arrastrando");
    document.body.classList.add("arrastrando-carta");
    if (navigator.vibrate) navigator.vibrate(12);
    // Si el dedo está cerca del borde de la pantalla, la página se desplaza sola.
    arrastre.rueda = setInterval(() => {
      const a = arrastre.activo;
      if (!a) return;
      const margen = 70;
      const paso = a.y < margen ? -14 : a.y > window.innerHeight - margen ? 14 : 0;
      if (paso) { window.scrollBy(0, paso); mover(a.x, a.y); }
    }, 16);
    mover(x, y);
  };

  const mover = (x, y) => {
    const a = arrastre.activo;
    a.x = x; a.y = y;
    a.fantasma.style.transform = `translate(${x - a.dx}px, ${y - a.dy}px) rotate(-2deg)`;
    const debajo = document.elementFromPoint(x, y);
    const grupo = debajo && debajo.closest(".carta-grupo");
    caja.querySelectorAll(".carta-grupo.sobre").forEach((g) => g !== grupo && g.classList.remove("sobre"));
    if (!grupo) return;
    grupo.classList.add("sobre");
    const lista = grupo.querySelector(".carta-items");
    const antes = [...lista.querySelectorAll(".carta-item:not(.arrastrando)")].find((h) => {
      const r = h.getBoundingClientRect();
      return y < r.top || (y <= r.bottom && x < r.left + r.width / 2);
    });
    if (antes) { if (antes.previousElementSibling !== a.item) lista.insertBefore(a.item, antes); }
    else if (lista.lastElementChild !== a.item) lista.append(a.item);
  };

  const terminar = () => {
    const a = arrastre.activo;
    clearTimeout(arrastre.pendiente && arrastre.pendiente.temporizador);
    arrastre.pendiente = null;
    if (!a) return;
    clearInterval(arrastre.rueda);
    a.fantasma.remove();
    a.item.classList.remove("arrastrando");
    document.body.classList.remove("arrastrando-carta");
    arrastre.activo = null;
    const orden = [];
    caja.querySelectorAll(".carta-items").forEach((ul) => {
      ul.querySelectorAll(".carta-item").forEach((li) => {
        orden.push(li.dataset.item);
        colocar(li.dataset.item, ul.dataset.grupo);
      });
    });
    calc.orden = orden;
    guardarCalc();
    pintarCarta();
  };

  // Ratón: se arrastra en cuanto se mueve un poco.
  caja.addEventListener("mousedown", (e) => {
    const item = e.button === 0 && e.target.closest(".carta-item");
    if (!item) return;
    e.preventDefault();
    arrastre.pendiente = { item, x: e.clientX, y: e.clientY };
  });
  document.addEventListener("mousemove", (e) => {
    if (arrastre.activo) { mover(e.clientX, e.clientY); return; }
    const p = arrastre.pendiente;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) { arrastre.pendiente = null; empezar(p.item, e.clientX, e.clientY); }
  });
  document.addEventListener("mouseup", terminar);

  // Táctil: hay que mantener pulsado un momento, para que deslizar el dedo siga moviendo la página.
  caja.addEventListener("touchstart", (e) => {
    const item = e.touches.length === 1 && e.target.closest(".carta-item");
    if (!item) return;
    const { clientX: x, clientY: y } = e.touches[0];
    arrastre.pendiente = { item, x, y, temporizador: setTimeout(() => {
      const p = arrastre.pendiente;
      if (p) { arrastre.pendiente = null; empezar(p.item, p.x, p.y); }
    }, 300) };
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (arrastre.activo) { e.preventDefault(); mover(t.clientX, t.clientY); return; }
    const p = arrastre.pendiente;
    if (p) {
      if (Math.hypot(t.clientX - p.x, t.clientY - p.y) > 10) { clearTimeout(p.temporizador); arrastre.pendiente = null; }
      else { p.x = t.clientX; p.y = t.clientY; }
    }
  }, { passive: false });
  document.addEventListener("touchend", terminar);
  document.addEventListener("touchcancel", terminar);
  caja.addEventListener("contextmenu", (e) => { if (e.target.closest(".carta-item")) e.preventDefault(); });
  caja.addEventListener("dragstart", (e) => e.preventDefault());

  caja.addEventListener("click", (e) => {
    if (e.target.id !== "carta-nueva") return;
    const nombre = (window.prompt("Nombre de la carta nueva (por ejemplo: Cumpleaños Alba)") || "").trim().slice(0, 40);
    if (!nombre || nombre === CESTA) return;
    if (!calc.grupos.includes(nombre)) calc.grupos.push(nombre);
    guardarCalc();
    pintarCarta();
  });
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
  if (estado.vista !== "lista") { mostrarVista(); return; }
  pintarChips();
  pintarEleccion();
  pintarLista();
  pintarCategorias();
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
    const pestana = e.target.closest("[data-vista]");
    if (pestana) {
      estado.vista = pestana.dataset.vista;
      mostrarVista();
      return;
    }
    const boton = e.target.closest("[data-categoria]");
    if (!boton) return;
    estado.categoria = boton.dataset.categoria;
    estado.persona = "todas";
    estado.vista = "lista";
    mostrarVista();
  });
  $("#ver-elegidos").addEventListener("click", () => {
    estado.vista = "calcular";
    mostrarVista();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#quitar-eleccion").addEventListener("click", () => {
    if (!window.confirm("¿Quitar todo de Calcular?")) return;
    elegidos.clear(); guardarElegidos();
    calc = { grupo: {}, precio: {}, extras: [], grupos: calc.grupos, orden: [] }; guardarCalc();
    estado.soloElegidos = false;
    pintarEleccion(); pintarLista(); pintarCategorias();
  });
  enlazarCalcular();
  enlazarCarta();
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
    compartir.pendiente = false;
    bajarCestas();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !compartir.pendiente) bajarCestas();
    });
  } catch (err) {
    $("#actualizado").textContent = `No se pudo cargar la lista (${err.message}).`;
  }
}

iniciar();
