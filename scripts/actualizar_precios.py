"""Mi Mercado: visita cada enlace de productos.json, lee precio, foto y
opiniones, y lo guarda en el historial web/data/precios.json.

Solo usa la biblioteca estándar de Python, así que no hace falta instalar nada.
Uso:  python scripts/actualizar_precios.py
"""

from __future__ import annotations

import gzip
import html as html_lib
import json
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

RAIZ = Path(__file__).resolve().parent.parent
PRODUCTOS = RAIZ / "web" / "data" / "productos.json"
PRECIOS = RAIZ / "web" / "data" / "precios.json"
DIAGNOSTICO = RAIZ / "diagnostico" / "ultima_revision.json"
ZONA = ZoneInfo("Europe/Madrid")

CABECERAS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "no-cache",
    "Upgrade-Insecure-Requests": "1",
}


class Bloqueado(Exception):
    """La tienda ha respondido con un captcha o un aviso anti-robots."""


# ---------------------------------------------------------------- descarga

def descargar(url: str, timeout: int = 25, extra: dict | None = None) -> str:
    peticion = urllib.request.Request(url, headers={**CABECERAS, **(extra or {})})
    try:
        with urllib.request.urlopen(peticion, timeout=timeout) as resp:
            datos = resp.read()
            codificacion = resp.headers.get("Content-Encoding", "")
            juego = resp.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as err:
        if err.code in (403, 429, 503):
            raise Bloqueado(f"la tienda respondió {err.code}") from err
        raise
    if codificacion == "gzip":
        datos = gzip.decompress(datos)
    elif codificacion == "deflate":
        datos = zlib.decompress(datos)
    return datos.decode(juego, errors="replace")


# ---------------------------------------------------------------- utilidades

def a_numero(texto) -> float | None:
    """Convierte '1.234,56 €', '27,29€', '27.29' o 27.29 en 27.29."""
    if texto is None or isinstance(texto, bool):
        return None
    if isinstance(texto, (int, float)):
        return round(float(texto), 2) if texto > 0 else None
    limpio = re.sub(r"[^\d,.]", "", html_lib.unescape(str(texto)))
    if not limpio:
        return None
    if "," in limpio and "." in limpio:
        if limpio.rfind(",") > limpio.rfind("."):
            limpio = limpio.replace(".", "").replace(",", ".")
        else:
            limpio = limpio.replace(",", "")
    elif "," in limpio:
        limpio = limpio.replace(",", ".")
    elif limpio.count(".") > 1:
        partes = limpio.split(".")
        limpio = "".join(partes[:-1]) + "." + partes[-1]
    try:
        valor = round(float(limpio), 2)
    except ValueError:
        return None
    return valor if 0 < valor < 100000 else None


def a_entero(texto) -> int | None:
    if texto is None:
        return None
    digitos = re.sub(r"\D", "", str(texto))
    return int(digitos) if digitos else None


def texto_plano(fragmento: str) -> str:
    sin_etiquetas = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", fragmento, flags=re.S | re.I)
    sin_etiquetas = re.sub(r"<[^>]+>", " ", sin_etiquetas)
    return re.sub(r"\s+", " ", html_lib.unescape(sin_etiquetas)).strip()


def _recorrer(nodo):
    if isinstance(nodo, dict):
        yield nodo
        for valor in nodo.values():
            yield from _recorrer(valor)
    elif isinstance(nodo, list):
        for valor in nodo:
            yield from _recorrer(valor)


def _tipos(nodo: dict) -> list:
    tipo = nodo.get("@type")
    return tipo if isinstance(tipo, list) else [tipo]


def json_ld(pagina: str) -> list:
    bloques = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        pagina, flags=re.S | re.I,
    )
    datos = []
    for bloque in bloques:
        try:
            datos.append(json.loads(html_lib.unescape(bloque.strip())))
        except (json.JSONDecodeError, ValueError):
            continue
    return datos


def meta(pagina: str, *nombres: str) -> str | None:
    for nombre in nombres:
        for patron in (
            rf'<meta[^>]+(?:property|name|itemprop)=["\']{re.escape(nombre)}["\'][^>]*content=["\']([^"\']+)',
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name|itemprop)=["\']{re.escape(nombre)}["\']',
        ):
            encontrado = re.search(patron, pagina, flags=re.I)
            if encontrado:
                return html_lib.unescape(encontrado.group(1)).strip()
    return None


# ---------------------------------------------------------------- lectura genérica

def precio_json_ld(pagina: str) -> float | None:
    for datos in json_ld(pagina):
        for nodo in _recorrer(datos):
            if not any(t in ("Offer", "AggregateOffer") for t in _tipos(nodo)):
                continue
            for clave in ("price", "lowPrice"):
                valor = a_numero(nodo.get(clave))
                if valor:
                    return valor
            espec = nodo.get("priceSpecification")
            if isinstance(espec, list):
                espec = espec[0] if espec else None
            if isinstance(espec, dict):
                valor = a_numero(espec.get("price"))
                if valor:
                    return valor
    return None


def precio_meta(pagina: str) -> float | None:
    valor = meta(pagina, "product:price:amount", "og:price:amount", "price")
    if valor:
        return a_numero(valor)
    encontrado = re.search(r'itemprop=["\']price["\'][^>]*content=["\']([^"\']+)', pagina, flags=re.I)
    return a_numero(encontrado.group(1)) if encontrado else None


def ficha_generica(pagina: str) -> dict:
    """Foto, título y valoración a partir de JSON-LD y etiquetas meta."""
    ficha: dict = {}
    for datos in json_ld(pagina):
        for nodo in _recorrer(datos):
            tipos = _tipos(nodo)
            if "Product" in tipos:
                ficha.setdefault("titulo", nodo.get("name"))
                imagen = nodo.get("image")
                if isinstance(imagen, list):
                    imagen = imagen[0] if imagen else None
                if isinstance(imagen, dict):
                    imagen = imagen.get("url") or imagen.get("contentUrl")
                if isinstance(imagen, str):
                    ficha.setdefault("imagen", imagen)
            if "AggregateRating" in tipos or (isinstance(nodo.get("aggregateRating"), dict)):
                nota = nodo if "AggregateRating" in tipos else nodo["aggregateRating"]
                media = a_numero(nota.get("ratingValue"))
                total = a_entero(nota.get("reviewCount") or nota.get("ratingCount"))
                if media and "valoracion" not in ficha:
                    ficha["valoracion"] = {"media": media, "total": total,
                                           "maximo": a_numero(nota.get("bestRating")) or 5}
    ficha.setdefault("imagen", meta(pagina, "og:image", "twitter:image"))
    ficha.setdefault("titulo", meta(pagina, "og:title"))
    return {k: v for k, v in ficha.items() if v}


def disponible_generico(pagina: str) -> bool:
    return not re.search(r'"availability"\s*:\s*"https?://schema\.org/(OutOfStock|SoldOut)"',
                         pagina, flags=re.I)


# ---------------------------------------------------------------- Amazon

def asin_de(url: str) -> str | None:
    encontrado = re.search(r"/(?:dp|gp/product|product-reviews)/([A-Z0-9]{10})", url)
    return encontrado.group(1) if encontrado else None


def es_captcha_amazon(pagina: str) -> bool:
    return bool(re.search(r"/errors/validateCaptcha|api-services-support@amazon\.com|"
                          r"Introduce los caracteres|Introduzca los caracteres", pagina))


def precio_amazon(pagina: str) -> float | None:
    if es_captcha_amazon(pagina):
        raise Bloqueado("Amazon pidió un captcha")
    # 1. Bloques del precio principal (junto al botón de comprar).
    for id_bloque in ("corePrice_feature_div", "corePriceDisplay_desktop_feature_div",
                      "apex_desktop", "apex_offerDisplay_desktop", "price",
                      "tp_price_block_total_price_ww", "priceblock_ourprice", "priceblock_dealprice"):
        pos = pagina.find(f'id="{id_bloque}"')
        if pos == -1:
            continue
        trozo = pagina[pos:pos + 6000]
        encontrado = re.search(r'class="a-offscreen">\s*([^<]+?)\s*<', trozo)
        if encontrado and a_numero(encontrado.group(1)):
            return a_numero(encontrado.group(1))
        entero = re.search(r'class="a-price-whole">\s*([\d.]+)', trozo)
        decimales = re.search(r'class="a-price-fraction">\s*(\d+)', trozo)
        if entero:
            valor = a_numero(entero.group(1).replace(".", "") + "," + (decimales.group(1) if decimales else "00"))
            if valor:
                return valor
    # 2. Datos internos que Amazon deja en la página.
    for patron in (
        r'name="items\[0\.base\]\[customerVisiblePrice\]\[amount\]"\s+value="([\d.]+)"',
        r'"priceAmount"\s*:\s*([\d.]+)',
        r'"displayPrice"\s*:\s*"([^"]+)"',
        r'data-asin-price="([\d.]+)"',
        r'id="twister-plus-price-data-price"[^>]*value="([\d.]+)"',
    ):
        encontrado = re.search(patron, pagina)
        if encontrado and a_numero(encontrado.group(1)):
            return a_numero(encontrado.group(1))
    return None


def precio_amazon_ofertas(asin: str) -> float | None:
    """Pide a Amazon la lista de vendedores (la ventana 'Ver todas las opciones de compra')."""
    url = f"https://www.amazon.es/gp/product/ajax/aodAjaxMain/ref=dp_aod_ALL_mbc?asin={asin}&pc=dp&experienceId=aodAjaxMain"
    pagina = descargar(url, extra={"Accept": "text/html,*/*", "X-Requested-With": "XMLHttpRequest",
                                   "Referer": f"https://www.amazon.es/dp/{asin}"})
    if es_captcha_amazon(pagina):
        raise Bloqueado("Amazon pidió un captcha")
    precios = [a_numero(p) for p in re.findall(r'class="a-offscreen">\s*([^<]+?)\s*<', pagina)]
    precios = [p for p in precios if p]
    return min(precios) if precios else None


def ficha_amazon(url: str, pagina: str) -> dict:
    ficha: dict = {}
    titulo = re.search(r'id="productTitle"[^>]*>(.*?)</span>', pagina, flags=re.S)
    if titulo:
        ficha["titulo"] = texto_plano(titulo.group(1))
    imagen = (re.search(r'id="landingImage"[^>]*data-old-hires="(https://[^"]+)"', pagina)
              or re.search(r'data-old-hires="(https://[^"]+)"[^>]*id="landingImage"', pagina)
              or re.search(r'"hiRes"\s*:\s*"(https://[^"]+)"', pagina)
              or re.search(r'"large"\s*:\s*"(https://[^"]+)"', pagina)
              or re.search(r'id="landingImage"[^>]*src="(https://[^"]+)"', pagina))
    if imagen:
        ficha["imagen"] = imagen.group(1)
    pos = pagina.find('id="averageCustomerReviews"')
    bloque = pagina[pos:pos + 3000] if pos != -1 else ""
    media = (re.search(r'id="acrPopover"[^>]*title="([\d,.]+) de 5', pagina)
             or re.search(r'([\d,.]+) de 5 estrellas', bloque))
    total = re.search(r'id="acrCustomerReviewText"[^>]*>\s*\(?([\d.,]+)', pagina)
    if media and a_numero(media.group(1)):
        ficha["valoracion"] = {"media": a_numero(media.group(1)),
                               "total": a_entero(total.group(1)) if total else None, "maximo": 5}
    pos = pagina.find('id="product-summary"')
    if pos != -1:
        resumen = texto_plano(pagina[pos:pos + 4000])
        inicio = resumen.find("Los clientes")
        if inicio != -1:
            resumen = resumen[inicio:]
            corte = resumen.find("Generado por IA")
            resumen = resumen[:corte if corte != -1 else 420].strip()
            if len(resumen) > 30:
                ficha["resumen_opiniones"] = resumen[:420].rsplit(" ", 1)[0] + ("…" if len(resumen) > 420 else "")
    asin = asin_de(url)
    if asin:
        ficha["opiniones_url"] = f"https://www.amazon.es/product-reviews/{asin}"
    return ficha


def disponible_amazon(pagina: str) -> bool:
    pos = pagina.find('id="availability"')
    if pos != -1:
        trozo = texto_plano(pagina[pos:pos + 1500]).lower()
        if "no disponible" in trozo or "currently unavailable" in trozo:
            return False
    return True


# ---------------------------------------------------------------- Shopify (Toy Planet y similares)

def leer_shopify(url: str) -> dict | None:
    """Las tiendas Shopify publican cada producto en JSON añadiendo '.js' a la dirección."""
    partes = urllib.parse.urlsplit(url)
    if "/products/" not in partes.path:
        return None
    ruta = re.sub(r"^/[a-z]{2}(-[a-z]{2})?/products/", "/products/", partes.path).rstrip("/")
    try:
        datos = json.loads(descargar(f"{partes.scheme}://{partes.netloc}{ruta}.js",
                                     extra={"Accept": "application/json"}))
    except (json.JSONDecodeError, urllib.error.HTTPError):
        return None
    variantes = datos.get("variants") or []
    precios = [v.get("price") for v in variantes if v.get("price")] or [datos.get("price")]
    precio = min(p for p in precios if p) / 100 if any(precios) else None
    imagen = datos.get("featured_image")
    if isinstance(imagen, str) and imagen.startswith("//"):
        imagen = "https:" + imagen
    return {
        "precio": round(precio, 2) if precio else None,
        "disponible": bool(datos.get("available")),
        "ficha": {k: v for k, v in {"titulo": datos.get("title"), "imagen": imagen}.items() if v},
        "metodo": "shopify",
    }


# ---------------------------------------------------------------- lectura de un enlace

def analizar(url: str) -> dict:
    """Devuelve {'precio', 'disponible', 'ficha', 'metodo'}; lanza Bloqueado si la tienda lo impide."""
    if "/products/" in url and "amazon." not in url:
        resultado = leer_shopify(url)
        if resultado and resultado["precio"]:
            return resultado

    pagina = descargar(url)
    if "amazon." in url:
        ficha = ficha_amazon(url, pagina)
        precio = precio_amazon(pagina)
        metodo = "amazon-pagina"
        if not precio and asin_de(url):
            time.sleep(random.uniform(1.5, 3.0))
            try:
                precio = precio_amazon_ofertas(asin_de(url))
                metodo = "amazon-ofertas"
            except (Bloqueado, urllib.error.URLError):
                precio = None
        en_stock = disponible_amazon(pagina)
        if not precio:
            precio = precio_json_ld(pagina) or precio_meta(pagina)
        return {"precio": precio, "disponible": en_stock, "ficha": ficha, "metodo": metodo,
                "_pagina": pagina}

    ficha = ficha_generica(pagina)
    return {"precio": precio_json_ld(pagina) or precio_meta(pagina),
            "disponible": disponible_generico(pagina), "ficha": ficha, "metodo": "generico",
            "_pagina": pagina}


def leer_precio(url: str, pagina: str) -> float | None:
    """Solo para las pruebas: precio a partir de una página ya descargada."""
    if "amazon." in url:
        valor = precio_amazon(pagina)
        if valor:
            return valor
    return precio_json_ld(pagina) or precio_meta(pagina)


def disponible(url: str, pagina: str) -> bool:
    return disponible_amazon(pagina) if "amazon." in url else disponible_generico(pagina)


def diagnosticar(pagina: str | None) -> dict:
    """Pistas para entender por qué no se encontró el precio."""
    if not pagina:
        return {}
    titulo = re.search(r"<title[^>]*>(.*?)</title>", pagina, flags=re.S | re.I)
    pista = {"bytes": len(pagina), "titulo": texto_plano(titulo.group(1))[:120] if titulo else None,
             "captcha": es_captcha_amazon(pagina), "json_ld": len(json_ld(pagina))}
    pos = pagina.find("a-price")
    if pos != -1:
        pista["cerca_de_a_price"] = texto_plano(pagina[max(0, pos - 300):pos + 500])[:300]
    for marca in ("corePrice", "apex_", "availability", "buybox", "outOfStock", "See All Buying Options",
                  "Ver todas las opciones de compra"):
        if marca in pagina:
            pista.setdefault("marcas", []).append(marca)
    return pista


# ---------------------------------------------------------------- historial

def cargar_json(ruta: Path, por_defecto):
    if ruta.exists():
        return json.loads(ruta.read_text(encoding="utf-8"))
    return por_defecto


def registrar(historial: dict, producto_id: str, enlace: dict, hoy: str,
              precio: float | None, en_stock: bool | None, error: str | None,
              ficha: dict | None = None) -> None:
    prod = historial.setdefault(producto_id, {})
    datos = prod.setdefault(enlace["url"], {"tienda": enlace["tienda"], "historial": []})
    datos["tienda"] = enlace["tienda"]
    datos["ultima_comprobacion"] = hoy
    for clave, valor in (ficha or {}).items():
        if valor:
            datos[clave] = valor
    if precio is None:
        datos["ultimo_error"] = error or "no se encontró el precio en la página"
        return
    datos.pop("ultimo_error", None)
    entrada = {"fecha": hoy, "precio": precio, "disponible": en_stock}
    serie = datos["historial"]
    if serie and serie[-1]["fecha"] == hoy:
        serie[-1] = entrada
    else:
        serie.append(entrada)


def main() -> int:
    productos = cargar_json(PRODUCTOS, {"productos": []})["productos"]
    estado = cargar_json(PRECIOS, {"actualizado": None, "productos": {}})
    historial = estado.setdefault("productos", {})
    hoy = datetime.now(ZONA).date().isoformat()
    informe = []

    ids_validos = {p["id"] for p in productos}
    for viejo in [i for i in historial if i not in ids_validos]:
        del historial[viejo]
    for producto in productos:
        urls = {e["url"] for e in producto.get("enlaces", [])}
        for url in [u for u in historial.get(producto["id"], {}) if u not in urls]:
            del historial[producto["id"]][url]

    leidos = fallos = 0
    for producto in productos:
        if producto.get("estado") == "comprado":
            continue
        for enlace in producto.get("enlaces", []):
            url = enlace["url"]
            resultado: dict = {}
            error = None
            try:
                resultado = analizar(url)
            except Bloqueado as err:
                error = f"bloqueado: {err}"
            except Exception as err:  # noqa: BLE001 - seguimos con el resto
                error = f"{type(err).__name__}: {err}"
            precio = resultado.get("precio")
            registrar(historial, producto["id"], enlace, hoy, precio,
                      resultado.get("disponible"), error, resultado.get("ficha"))
            fila = {"producto": producto["id"], "tienda": enlace["tienda"], "url": url,
                    "precio": precio, "metodo": resultado.get("metodo"), "error": error}
            if precio is None:
                fallos += 1
                fila["pistas"] = diagnosticar(resultado.get("_pagina"))
                print(f"  ✗ {producto['nombre']} [{enlace['tienda']}]: {error or 'sin precio'}")
            else:
                leidos += 1
                print(f"  ✓ {producto['nombre']} [{enlace['tienda']}]: {precio:.2f} € ({resultado.get('metodo')})")
            informe.append(fila)
            time.sleep(random.uniform(2.0, 5.0))

    estado["actualizado"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    PRECIOS.write_text(json.dumps(estado, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    DIAGNOSTICO.parent.mkdir(exist_ok=True)
    DIAGNOSTICO.write_text(json.dumps({"fecha": estado["actualizado"], "leidos": leidos,
                                       "fallos": fallos, "enlaces": informe},
                                      ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Precios leídos: {leidos}. Sin leer: {fallos}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
