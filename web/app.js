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
    const tiendas = (p.enlaces || []).map((enlace) => {
      const clave = enlace.url || `buscar:${enlace.dominio}:${enlace.buscar}`;
      const info = datos[clave] || {};
      const url = enlace.url || info.url || `https://${enlace.dominio}/search?q=${encodeURIComponent(enlace.buscar)}`;
      const serie = info.historial || [];
      const ultimo = serie[serie.length - 1] || null;
      return {
        ...enlace,
        url,
        serie,
        ultimo,
        tendencia: tendenciaDe(serie),
        error: info.ultimo_error || null,
        comprobado: info.ultima_comprobacion || null,
        imagen: info.imagen || null,
        valoracion: info.valoracion || null,
        resumen: info.resumen_opiniones || null,
        opinionesUrl: info.opiniones_url || url,
      };
    });

    const visibles = tiendas.filter((t) => t.url && !(t.buscar && !t.ultimo && t.error))
      .sort((a, b) => (a.ultimo ? a.ultimo.precio : Infinity) - (b.ultimo ? b.ultimo.precio : Infinity));
    tiendas.length = 0;
    tiendas.push(...visibles);
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

    const conFoto = tiendas.find((t) => t.imagen && /amazon/i.test(t.tienda)) || tiendas.find((t) => t.imagen);
    const imagen = p.imagen || (conFoto ? conFoto.imagen : null);

    return { ...p, indice, tiendas, mejor, actual, referencia, variacion, serie, minimo, imagen };
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

function pintarPanel(panel, p, t) {
  const partes = [];
  if (t.ultimo) {
    const tend = textoTendencia(t);
    const precios = t.serie.map((e) => e.precio);
    const min = Math.min(...precios);
    const max = Math.max(...precios);
    const lineas = [`leído el ${fechaCorta.format(leerFecha(t.ultimo.fecha))}`];
    if (tend && tend.detalle) lineas.push(tend.detalle);
    if (t.serie.length > 1 && max - min >= 0.01) lineas.push(`mín. ${euros.format(min)} · máx. ${euros.format(max)}`);
    if (t.ultimo.disponible === false) lineas.unshift("agotado");
    partes.push(`<div class="panel-fila">
        <span class="panel-precio">${euros.format(t.ultimo.precio)}</span>
        ${tend ? `<span class="tendencia ${tend.clase}">${tend.texto}</span>` : ""}
      </div>
      <p class="panel-detalle">${lineas.join(" · ")}</p>
      <svg class="grafica" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true" hidden></svg>`);
    if (t.error) partes.push(`<p class="panel-aviso">Hoy no se pudo leer (${escapar(motivo(t.error))}); se muestra la última lectura.</p>`);
  } else if (t.error) {
    partes.push(`<p class="panel-aviso">${escapar(motivo(t.error))}. Pulsa “Ir a la tienda” para ver el precio.</p>`);
  } else {
    partes.push(`<p class="panel-aviso">Pendiente de la próxima revisión.</p>`);
  }

  if (t.valoracion || t.resumen) {
    const v = t.valoracion;
    partes.push(`<div class="opiniones">
      ${v ? `<div class="estrellas-fila">${estrellas(v)} <strong>${v.media.toLocaleString("es-ES")}</strong>
        ${v.total ? `<span class="total">(${v.total.toLocaleString("es-ES")} opiniones)</span>` : ""}</div>` : ""}
      ${t.resumen ? `<p class="resumen-opiniones"><em>Resumen de ${escapar(t.tienda.replace(/\s*\(.*\)/, ""))}:</em> ${escapar(t.resumen)}</p>` : ""}
    </div>`);
  }

  partes.push(`<div class="panel-fila">
      <a class="enlace-suave" href="${escapar(t.opinionesUrl)}" target="_blank" rel="noopener">Leer opiniones ↗</a>
      <a class="boton principal" href="${escapar(t.url)}" target="_blank" rel="noopener">Ir a la tienda</a>
    </div>`);

  panel.innerHTML = partes.join("");
  const svg = panel.querySelector(".grafica");
  if (svg) grafica(svg, t.serie.map((e) => e.precio));
}

function motivo(error) {
  if (error.startsWith("bloqueado")) return "la tienda no deja leer el precio automáticamente";
  if (/404/.test(error)) return "el enlace ya no existe";
  if (/catálogo/.test(error)) return "esta tienda no lo tiene ahora mismo";
  return "no se encontró el precio en la página";
}

function tarjeta(p) {
  const nodo = $("#plantilla-tarjeta").content.firstElementChild.cloneNode(true);
  const persona = nodo.querySelector(".persona");
  persona.textContent = p.para;
  persona.classList.add(claseDe(p.para));
  if (p.fuera_de_carta) nodo.querySelector(".etiqueta-fuera").hidden = false;

  const img = nodo.querySelector(".foto img");
  if (p.imagen) {
    img.src = p.imagen;
    img.alt = p.nombre;
    img.hidden = false;
    img.addEventListener("error", () => { img.hidden = true; });
  }

  nodo.querySelector(".nombre").textContent = p.nombre;
  const nota = nodo.querySelector(".nota");
  const textoNota = p.fuera_de_carta ? (p.nota || "").replace(/^Fuera de carta\.?\s*/, "") : p.nota || "";
  nota.textContent = textoNota;
  if (/lo pide|lo quiere/i.test(textoNota)) nota.classList.add("destacada");

  const precio = nodo.querySelector(".precio");
  const detalle = nodo.querySelector(".precio-detalle");
  const titulo = nodo.querySelector(".precio-titulo");
  if (p.actual != null) {
    precio.textContent = euros.format(p.actual);
    const partes = [`en ${p.mejor.tienda}`];
    if (p.precio_lista != null) partes.push(`lista: ${euros.format(p.precio_lista)}`);
    if (p.minimo != null && p.minimo < p.actual) partes.push(`mínimo visto: ${euros.format(p.minimo)}`);
    detalle.textContent = partes.join(" · ");
  } else if (p.precio_lista != null) {
    titulo.textContent = "Precio de la lista";
    precio.textContent = euros.format(p.precio_lista);
    detalle.textContent = p.tienda_lista ? `visto en ${p.tienda_lista}` : "";
  } else {
    titulo.textContent = "Precio";
    precio.textContent = "Sin precio todavía";
    precio.classList.add("sin-dato");
    detalle.textContent = "busca y añade un enlace para seguirlo";
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
  const panel = nodo.querySelector(".panel");
  if (p.tiendas.length) {
    const inicial = p.mejor || p.tiendas[0];
    p.tiendas.forEach((t, i) => {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "pestana";
      boton.setAttribute("role", "tab");
      boton.setAttribute("aria-selected", String(t === inicial));
      const valor = t.ultimo ? euros.format(t.ultimo.precio) : "—";
      const tipo = t.tendencia && t.tendencia.tipo;
      const marca = tipo === "baja" ? ' <span class="flecha-baja">▼</span>' : tipo === "sube" ? ' <span class="flecha-sube">▲</span>' : "";
      const esMejor = t === p.mejor && p.tiendas.filter((x) => x.ultimo).length > 1;
      boton.innerHTML = `${escapar(t.tienda)}<small class="${esMejor ? "mejor" : ""}">${valor}${marca}</small>`;
      boton.addEventListener("click", () => {
        pestanas.querySelectorAll(".pestana").forEach((b) => b.setAttribute("aria-selected", "false"));
        boton.setAttribute("aria-selected", "true");
        pintarPanel(panel, p, t);
      });
      boton.dataset.indice = i;
      pestanas.append(boton);
    });
    pintarPanel(panel, p, inicial);
  } else {
    pestanas.remove();
    panel.innerHTML = '<p class="panel-aviso">Todavía no hay tiendas para este juguete. Usa los botones de abajo para buscarlo.</p>';
  }

  const consulta = encodeURIComponent(p.busqueda || p.nombre);
  nodo.querySelector(".buscar-amazon").href = `https://www.amazon.es/s?k=${consulta}`;
  nodo.querySelector(".comparar").addEventListener("click", () => abrirComparador(p));
  return nodo;
}

function abrirComparador(p) {
  const dialogo = $("#comparador");
  $("#comparador-titulo").textContent = p.nombre;
  const conPrecio = p.tiendas.filter((t) => t.ultimo).sort((a, b) => a.ultimo.precio - b.ultimo.precio);
  const sinPrecio = p.tiendas.filter((t) => !t.ultimo);
  const mejor = conPrecio[0];

  const resumen = $("#comparador-resumen");
  if (conPrecio.length > 1) {
    const ahorro = conPrecio[conPrecio.length - 1].ultimo.precio - mejor.ultimo.precio;
    resumen.innerHTML = `${conPrecio.length} tiendas con precio. Lo más barato está en <strong>${escapar(mejor.tienda)}</strong>`
      + (ahorro >= 0.01 ? `, ${euros.format(ahorro)} menos que la más cara.` : ".");
  } else if (conPrecio.length === 1) {
    resumen.textContent = `De momento solo hay precio de ${mejor.tienda}.`;
  } else {
    resumen.textContent = "Todavía no se ha podido leer el precio en ninguna tienda.";
  }
  if (p.precio_lista != null && mejor) {
    const dif = mejor.ultimo.precio - p.precio_lista;
    const frase = Math.abs(dif) < 0.01 ? "igual que en tu lista"
      : dif < 0 ? `${euros.format(-dif)} menos que en tu lista (${euros.format(p.precio_lista)})`
      : `${euros.format(dif)} más que en tu lista (${euros.format(p.precio_lista)})`;
    resumen.innerHTML += ` El mejor precio está ${frase}.`;
  }

  $("#comparador-lista").innerHTML = conPrecio.map((t, i) => {
    const tend = textoTendencia(t);
    const dif = t.ultimo.precio - mejor.ultimo.precio;
    const info = [`leído el ${fechaCorta.format(leerFecha(t.ultimo.fecha))}`];
    if (t.ultimo.disponible === false) info.unshift("<b>agotado</b>");
    if (t.valoracion) info.push(`★ ${t.valoracion.media.toLocaleString("es-ES")}${t.valoracion.total ? ` (${t.valoracion.total.toLocaleString("es-ES")})` : ""}`);
    return `<li class="fila-tienda${i === 0 ? " ganadora" : ""}">
      <span class="puesto">${i + 1}</span>
      <span class="fila-nombre">${escapar(t.tienda)}</span>
      <div class="fila-derecha">
        <span class="fila-precio">${euros.format(t.ultimo.precio)}</span>
        ${i > 0 && dif >= 0.01 ? `<span class="fila-dif">+${euros.format(dif)}</span>` : ""}
        <a class="boton principal" href="${escapar(t.url)}" target="_blank" rel="noopener">Ir</a>
      </div>
      <span class="fila-info">${tend && tend.texto !== "primera lectura" ? `<span class="tendencia ${tend.clase}">${tend.texto}</span>` : ""}${info.join(" · ")}</span>
    </li>`;
  }).join("");

  $("#comparador-sin-precio").innerHTML = sinPrecio.length ? `
    <p class="sin-precio-titulo">Sin precio automático</p>
    <ul class="sin-precio">${sinPrecio.map((t) => `<li>${escapar(t.tienda)}
      <span>${t.error ? escapar(motivo(t.error)) : "pendiente de revisar"}</span>
      <a href="${escapar(t.url)}" target="_blank" rel="noopener">Ver ↗</a></li>`).join("")}</ul>` : "";

  $("#comparador-pie").innerHTML = "Precios recogidos por el robot de Mi Mercado. Pueden haber cambiado desde la última revisión.";
  dialogo.showModal();
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
  const dialogo = $("#comparador");
  dialogo.querySelector(".cerrar").addEventListener("click", () => dialogo.close());
  dialogo.addEventListener("click", (e) => { if (e.target === dialogo) dialogo.close(); });
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
