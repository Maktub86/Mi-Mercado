"use strict";

const REPO = "Maktub86/Mi-Mercado";
const PERSONAS = [
  { id: "todas", nombre: "Todas" },
  { id: "Alba", nombre: "Alba", clase: "alba" },
  { id: "Lucía", nombre: "Lucía", clase: "lucia" },
  { id: "Las dos", nombre: "Las dos", clase: "dos" },
];

const euros = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const fechaCorta = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });
const fechaLarga = new Intl.DateTimeFormat("es-ES", {
  weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
});

const estado = { persona: "todas", texto: "", orden: "lista" };
let productos = [];

const $ = (sel) => document.querySelector(sel);

function leerFecha(iso) {
  // "2026-11-18" -> fecha local a mediodía para evitar saltos de zona horaria
  return new Date(`${iso}T12:00:00`);
}

function claseDe(para) {
  return (PERSONAS.find((p) => p.id === para) || {}).clase || "dos";
}

function normalizar(texto) {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

async function cargar(ruta) {
  const resp = await fetch(`${ruta}?t=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`${ruta}: ${resp.status}`);
  return resp.json();
}

/** Junta la lista con el historial de precios y calcula lo que se muestra. */
function preparar(lista, precios) {
  const historial = precios.productos || {};
  return lista.productos.map((p, indice) => {
    const datos = historial[p.id] || {};
    const tiendas = (p.enlaces || []).map((enlace) => {
      const info = datos[enlace.url] || {};
      const serie = info.historial || [];
      const ultimo = serie[serie.length - 1] || null;
      return {
        ...enlace,
        serie,
        ultimo,
        error: info.ultimo_error || null,
        comprobado: info.ultima_comprobacion || null,
      };
    });

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
    const minimo = serie.length ? Math.min(...serie.map(([, v]) => v)) : null;

    const actual = mejor ? mejor.ultimo.precio : null;
    const referencia = actual ?? p.precio_lista;
    const variacion = actual != null && p.precio_lista != null ? actual - p.precio_lista : null;

    return { ...p, indice, tiendas, mejor, actual, referencia, variacion, serie, minimo };
  });
}

function pintarResumen(actualizado) {
  const pendientes = productos.filter((p) => p.estado !== "comprado");
  const conValor = pendientes.filter((p) => p.referencia != null);
  const total = conValor.reduce((s, p) => s + p.referencia, 0);
  const bajadas = pendientes.filter((p) => p.variacion != null && p.variacion < -0.009);
  const ahorro = bajadas.reduce((s, p) => s - p.variacion, 0);
  const comprados = productos.length - pendientes.length;

  $("#resumen").innerHTML = `
    <div class="dato"><strong>${pendientes.length}</strong><span>por comprar</span></div>
    <div class="dato"><strong>${euros.format(total)}</strong><span>coste estimado (${conValor.length} con precio)</span></div>
    <div class="dato"><strong>${bajadas.length}</strong><span>más baratos que en la lista${ahorro ? ` · −${euros.format(ahorro)}` : ""}</span></div>
    <div class="dato"><strong>${comprados}</strong><span>ya comprados</span></div>`;

  $("#actualizado").textContent = actualizado
    ? `Precios revisados el ${fechaLarga.format(new Date(actualizado))}`
    : "Todavía no se han revisado los precios: se muestran los de la lista.";
}

function pintarChips() {
  const pendientes = productos.filter((p) => p.estado !== "comprado");
  $("#chips-persona").innerHTML = PERSONAS.map((p) => {
    const n = p.id === "todas" ? pendientes.length : pendientes.filter((x) => x.para === p.id).length;
    return `<button class="chip" role="tab" data-persona="${p.id}" aria-selected="${estado.persona === p.id}">
      ${p.nombre}<span class="cuenta">${n}</span></button>`;
  }).join("");
}

function grafica(svg, serie) {
  if (serie.length < 2) return;
  const valores = serie.map(([, v]) => v);
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

function tarjeta(p) {
  const nodo = $("#plantilla-tarjeta").content.firstElementChild.cloneNode(true);
  const persona = nodo.querySelector(".persona");
  persona.textContent = p.para;
  persona.classList.add(claseDe(p.para));
  if (p.fuera_de_carta) nodo.querySelector(".etiqueta-fuera").hidden = false;

  nodo.querySelector(".nombre").textContent = p.nombre;
  const nota = nodo.querySelector(".nota");
  const textoNota = p.fuera_de_carta ? (p.nota || "").replace(/^Fuera de carta\.?\s*/, "") : p.nota || "";
  nota.textContent = textoNota;
  if (/lo pide|lo quiere/i.test(textoNota)) nota.classList.add("destacada");

  const precio = nodo.querySelector(".precio");
  const detalle = nodo.querySelector(".precio-detalle");
  if (p.actual != null) {
    precio.textContent = euros.format(p.actual);
    const partes = [`en ${p.mejor.tienda}, ${fechaCorta.format(leerFecha(p.mejor.ultimo.fecha))}`];
    if (p.precio_lista != null) partes.push(`lista: ${euros.format(p.precio_lista)}`);
    if (p.minimo != null && p.minimo < p.actual) partes.push(`mínimo: ${euros.format(p.minimo)}`);
    if (p.mejor.ultimo.disponible === false) partes.unshift("agotado");
    detalle.textContent = partes.join(" · ");
  } else if (p.precio_lista != null) {
    precio.textContent = euros.format(p.precio_lista);
    detalle.textContent = `precio de la lista${p.tienda_lista ? ` (${p.tienda_lista})` : ""}`;
  } else {
    precio.textContent = "Sin precio todavía";
    precio.classList.add("sin-dato");
    detalle.textContent = "busca y añade un enlace para seguirlo";
  }

  if (p.variacion != null) {
    const v = nodo.querySelector(".variacion");
    const centimos = Math.round(p.variacion * 100);
    if (centimos < 0) { v.textContent = `▼ ${euros.format(-p.variacion)}`; v.classList.add("baja"); }
    else if (centimos > 0) { v.textContent = `▲ ${euros.format(p.variacion)}`; v.classList.add("sube"); }
    else { v.textContent = "igual que en la lista"; v.classList.add("igual"); }
    v.hidden = false;
  }

  grafica(nodo.querySelector(".grafica"), p.serie);

  const ul = nodo.querySelector(".tiendas");
  p.tiendas.forEach((t) => {
    const li = document.createElement("li");
    const enlace = document.createElement("a");
    enlace.href = t.url;
    enlace.target = "_blank";
    enlace.rel = "noopener";
    enlace.textContent = `${t.tienda} ↗`;
    const valor = document.createElement("span");
    valor.className = "valor";
    if (t.ultimo) {
      valor.textContent = euros.format(t.ultimo.precio);
      if (t === p.mejor && p.tiendas.length > 1) valor.classList.add("mejor");
      if (t.error) valor.title = `Última lectura correcta: ${t.ultimo.fecha}. Hoy: ${t.error}`;
    } else if (t.error) {
      valor.textContent = t.error.startsWith("bloqueado") ? "la tienda no deja leerlo" : "no se pudo leer";
      valor.classList.add("fallo");
      valor.title = t.error;
    } else {
      valor.textContent = "pendiente de revisar";
      valor.classList.add("fallo");
    }
    li.append(enlace, valor);
    ul.append(li);
  });
  if (!p.tiendas.length) ul.remove();

  const consulta = encodeURIComponent(p.busqueda || p.nombre);
  nodo.querySelector(".buscar-amazon").href = `https://www.amazon.es/s?k=${consulta}`;
  nodo.querySelector(".comparar").href = `https://www.google.com/search?tbm=shop&hl=es&gl=es&q=${consulta}`;
  return nodo;
}

function pintarLista() {
  const texto = normalizar(estado.texto.trim());
  let lista = productos.filter((p) => p.estado !== "comprado")
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

  const comprados = productos.filter((p) => p.estado === "comprado")
    .filter((p) => estado.persona === "todas" || p.para === estado.persona);
  $("#titulo-comprados").textContent = `Ya comprados (${comprados.length})`;
  $("#bloque-comprados").hidden = comprados.length === 0;
  $("#lista-comprados").innerHTML = comprados.map((p) => `
    <li><span><span class="tachado">${p.nombre}</span> · ${p.para}</span>
    <span class="quien">${p.comprado_por ? `por ${p.comprado_por}` : "tachado en la lista"}</span></li>`).join("");
}

function enlazarEventos() {
  $("#chips-persona").addEventListener("click", (e) => {
    const boton = e.target.closest("[data-persona]");
    if (!boton) return;
    estado.persona = boton.dataset.persona;
    pintarChips();
    pintarLista();
  });
  $("#buscar").addEventListener("input", (e) => { estado.texto = e.target.value; pintarLista(); });
  $("#orden").addEventListener("change", (e) => { estado.orden = e.target.value; pintarLista(); });
  $("#editar").href = `https://github.com/${REPO}/edit/main/web/data/productos.json`;
}

async function iniciar() {
  enlazarEventos();
  try {
    const [lista, precios] = await Promise.all([
      cargar("data/productos.json"),
      cargar("data/precios.json").catch(() => ({ productos: {} })),
    ]);
    $("#antetitulo").textContent = `Lista de ${lista.lista || "regalos"} · Alba y Lucía`;
    productos = preparar(lista, precios);
    pintarResumen(precios.actualizado);
    pintarChips();
    pintarLista();
  } catch (err) {
    $("#actualizado").textContent = `No se pudo cargar la lista (${err.message}).`;
  }
}

iniciar();
