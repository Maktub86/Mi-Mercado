"""Mi Mercado: lee el precio actual de cada enlace de productos.json
y lo guarda en el historial web/data/precios.json.

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
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

RAIZ = Path(__file__).resolve().parent.parent
PRODUCTOS = RAIZ / "web" / "data" / "productos.json"
PRECIOS = RAIZ / "web" / "data" / "precios.json"
ZONA = ZoneInfo("Europe/Madrid")

CABECERAS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "no-cache",
}


class Bloqueado(Exception):
    """La tienda ha respondido con un captcha o un aviso anti-robots."""


# ---------------------------------------------------------------- descarga

def descargar(url: str, timeout: int = 25) -> str:
    peticion = urllib.request.Request(url, headers=CABECERAS)
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


# ---------------------------------------------------------------- precios

def a_numero(texto) -> float | None:
    """Convierte '1.234,56 €', '27,29€', '27.29' o 27.29 en 27.29."""
    if texto is None:
        return None
    if isinstance(texto, (int, float)):
        return float(texto) if texto > 0 else None
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


def _recorrer(nodo):
    if isinstance(nodo, dict):
        yield nodo
        for valor in nodo.values():
            yield from _recorrer(valor)
    elif isinstance(nodo, list):
        for valor in nodo:
            yield from _recorrer(valor)


def precio_json_ld(pagina: str) -> float | None:
    bloques = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        pagina, flags=re.S | re.I,
    )
    for bloque in bloques:
        try:
            datos = json.loads(html_lib.unescape(bloque.strip()))
        except (json.JSONDecodeError, ValueError):
            continue
        for nodo in _recorrer(datos):
            tipo = nodo.get("@type")
            tipos = tipo if isinstance(tipo, list) else [tipo]
            if not any(t in ("Offer", "AggregateOffer") for t in tipos):
                continue
            for clave in ("price", "lowPrice"):
                valor = a_numero(nodo.get(clave))
                if valor:
                    return valor
            espec = nodo.get("priceSpecification")
            if isinstance(espec, dict):
                valor = a_numero(espec.get("price"))
                if valor:
                    return valor
    return None


def precio_meta(pagina: str) -> float | None:
    patrones = [
        r'<meta[^>]+(?:property|name)=["\'](?:product:price:amount|og:price:amount)["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'](?:product:price:amount|og:price:amount)',
        r'itemprop=["\']price["\'][^>]+content=["\']([^"\']+)',
        r'content=["\']([^"\']+)["\'][^>]+itemprop=["\']price["\']',
    ]
    for patron in patrones:
        encontrado = re.search(patron, pagina, flags=re.I)
        if encontrado:
            valor = a_numero(encontrado.group(1))
            if valor:
                return valor
    return None


def precio_amazon(pagina: str) -> float | None:
    if re.search(r"/errors/validateCaptcha|api-services-support@amazon\.com|Introduzca los caracteres", pagina):
        raise Bloqueado("Amazon pidió un captcha")
    # Bloque principal del precio (el que se ve junto al botón de comprar).
    for id_bloque in ("corePrice_feature_div", "corePriceDisplay_desktop_feature_div",
                      "apex_desktop", "price", "tp_price_block_total_price_ww"):
        pos = pagina.find(f'id="{id_bloque}"')
        if pos == -1:
            continue
        trozo = pagina[pos:pos + 6000]
        encontrado = re.search(r'class="a-offscreen">\s*([^<]+?)\s*<', trozo)
        if encontrado:
            valor = a_numero(encontrado.group(1))
            if valor:
                return valor
        entero = re.search(r'class="a-price-whole">\s*([\d.]+)', trozo)
        decimales = re.search(r'class="a-price-fraction">\s*(\d+)', trozo)
        if entero:
            valor = a_numero(entero.group(1).replace(".", "") + "," + (decimales.group(1) if decimales else "00"))
            if valor:
                return valor
    encontrado = re.search(r'"priceAmount"\s*:\s*([\d.]+)', pagina)
    if encontrado:
        return a_numero(encontrado.group(1))
    return None


def disponible(url: str, pagina: str) -> bool:
    """True si la página no dice claramente que está agotado."""
    if "amazon." in url:
        pos = pagina.find('id="availability"')
        if pos != -1:
            trozo = re.sub(r"<[^>]+>", " ", pagina[pos:pos + 1500]).lower()
            if "no disponible" in trozo or "currently unavailable" in trozo:
                return False
    return not re.search(r'"availability"\s*:\s*"https?://schema\.org/(OutOfStock|SoldOut)"',
                         pagina, flags=re.I)


def leer_precio(url: str, pagina: str) -> float | None:
    if "amazon." in url:
        valor = precio_amazon(pagina)
        if valor:
            return valor
    return precio_json_ld(pagina) or precio_meta(pagina)


# ---------------------------------------------------------------- historial

def cargar_json(ruta: Path, por_defecto):
    if ruta.exists():
        return json.loads(ruta.read_text(encoding="utf-8"))
    return por_defecto


def registrar(historial: dict, producto_id: str, enlace: dict, hoy: str,
              precio: float | None, en_stock: bool | None, error: str | None) -> None:
    prod = historial.setdefault(producto_id, {})
    datos = prod.setdefault(enlace["url"], {"tienda": enlace["tienda"], "historial": []})
    datos["tienda"] = enlace["tienda"]
    datos["ultima_comprobacion"] = hoy
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

    ids_validos = {p["id"] for p in productos}
    for viejo in [i for i in historial if i not in ids_validos]:
        del historial[viejo]

    leidos = fallos = 0
    for producto in productos:
        if producto.get("estado") == "comprado":
            continue
        for enlace in producto.get("enlaces", []):
            url = enlace["url"]
            precio = en_stock = error = None
            try:
                pagina = descargar(url)
                precio = leer_precio(url, pagina)
                en_stock = disponible(url, pagina)
            except Bloqueado as err:
                error = f"bloqueado: {err}"
            except Exception as err:  # noqa: BLE001 - seguimos con el resto
                error = f"{type(err).__name__}: {err}"
            registrar(historial, producto["id"], enlace, hoy, precio, en_stock, error)
            if precio is None:
                fallos += 1
                print(f"  ✗ {producto['nombre']} [{enlace['tienda']}]: {error or 'sin precio'}")
            else:
                leidos += 1
                print(f"  ✓ {producto['nombre']} [{enlace['tienda']}]: {precio:.2f} €")
            time.sleep(random.uniform(2.0, 5.0))

    estado["actualizado"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    PRECIOS.write_text(json.dumps(estado, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Precios leídos: {leidos}. Sin leer: {fallos}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
