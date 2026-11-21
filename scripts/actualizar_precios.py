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
import os
import shutil
import subprocess
import tempfile
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

RAIZ = Path(os.environ.get("MI_MERCADO_RAIZ") or Path(__file__).resolve().parent.parent)
PRODUCTOS = RAIZ / "web" / "data" / "productos.json"
PRECIOS = RAIZ / "web" / "data" / "precios.json"
DIAGNOSTICO = RAIZ / "diagnostico" / (os.environ.get("MI_MERCADO_INFORME") or "ultima_revision.json")
MUESTRAS = RAIZ / "diagnostico" / "muestras"


def guardar_muestra(nombre: str, pagina: str, limite: int = 150_000) -> None:
    """Guarda un trozo de la página para poder ajustar el lector con datos reales."""
    try:
        MUESTRAS.mkdir(parents=True, exist_ok=True)
        (MUESTRAS / f"{re.sub(r'[^a-z0-9]+', '-', nombre.lower())[:60]}.html").write_text(
            pagina[:limite], encoding="utf-8")
    except OSError:
        pass
try:
    ZONA = ZoneInfo("Europe/Madrid")
except ZoneInfoNotFoundError:  # Windows sin el paquete tzdata: usamos la hora del propio ordenador
    ZONA = None


def ahora_local() -> datetime:
    return datetime.now(ZONA) if ZONA else datetime.now().astimezone()

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

def descargar(url: str, timeout: int = 25, extra: dict | None = None, reintentos: int = 2) -> str:
    peticion = urllib.request.Request(url, headers={**CABECERAS, **(extra or {})})
    try:
        with urllib.request.urlopen(peticion, timeout=timeout) as resp:
            datos = resp.read()
            codificacion = resp.headers.get("Content-Encoding", "")
            juego = resp.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as err:
        if err.code == 429 and reintentos > 0:
            # "Demasiadas peticiones": esperamos lo que pida la tienda (o 30 s) y repetimos.
            espera = err.headers.get("Retry-After", "")
            time.sleep(min(int(espera), 90) if espera.isdigit() else 30)
            return descargar(url, timeout, extra, reintentos - 1)
        if err.code in (403, 429, 503):
            raise Bloqueado(f"la tienda respondió {err.code}") from err
        raise
    if codificacion == "gzip":
        datos = gzip.decompress(datos)
    elif codificacion == "deflate":
        datos = zlib.decompress(datos)
    return datos.decode(juego, errors="replace")


def buscar_navegador() -> str | None:
    """Edge o Chrome instalados en el ordenador (Windows trae Edge siempre)."""
    propio = os.environ.get("MI_MERCADO_NAVEGADOR")
    if propio and Path(propio).exists():
        return propio
    candidatos = []
    for base in (os.environ.get("PROGRAMFILES(X86)"), os.environ.get("PROGRAMFILES"), os.environ.get("LOCALAPPDATA")):
        if base:
            candidatos += [Path(base) / "Microsoft/Edge/Application/msedge.exe",
                           Path(base) / "Google/Chrome/Application/chrome.exe"]
    for ruta in candidatos:
        if ruta.exists():
            return str(ruta)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        return None  # desde GitHub no sirve: la tienda bloquea igual a sus servidores
    for nombre in ("msedge", "google-chrome", "chromium", "chrome"):
        encontrado = shutil.which(nombre)
        if encontrado:
            return encontrado
    return None


def descargar_navegador(url: str, espera_ms: int = 9000) -> str:
    """Abre la página con el navegador real, sin ventana, y devuelve el HTML ya cargado.
    Sirve para tiendas (El Corte Inglés, Sfera) que rechazan a los programas normales."""
    navegador = buscar_navegador()
    if not navegador:
        raise Bloqueado("no hay navegador instalado para abrir la tienda")
    # La página se escribe en un archivo y no en una tubería: en Windows los procesos hijos de
    # Edge pueden dejar la tubería abierta y el robot se quedaría esperando para siempre.
    perfil = tempfile.mkdtemp(prefix="mi-mercado-")
    salida = Path(perfil) / "pagina.html"
    try:
        orden = [navegador, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                 "--disable-blink-features=AutomationControlled", "--lang=es-ES", "--window-size=1366,900",
                 "--disable-extensions", "--disable-background-networking", "--disable-crash-reporter",
                 f"--user-agent={CABECERAS['User-Agent']}", f"--user-data-dir={perfil}",
                 f"--virtual-time-budget={espera_ms}", "--dump-dom", url]
        with open(salida, "wb") as destino:
            proceso = subprocess.Popen(orden, stdout=destino, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try:
                proceso.wait(timeout=60)
            except subprocess.TimeoutExpired as err:
                cerrar_navegador(proceso)
                raise Bloqueado("el navegador tardó demasiado") from err
        cerrar_navegador(proceso)
        pagina = salida.read_bytes().decode("utf-8", errors="replace")
    finally:
        shutil.rmtree(perfil, ignore_errors=True)
    if len(pagina) < 2000 or re.search(r"Access Denied|Acceso denegado|captcha", pagina[:5000], re.I):
        guardar_muestra(f"navegador-{urllib.parse.urlsplit(url).netloc}", pagina)
        raise Bloqueado("la tienda también bloqueó al navegador")
    return pagina


def cerrar_navegador(proceso) -> None:
    """Cierra el navegador y todos sus procesos hijos, por si alguno se quedó abierto."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proceso.pid), "/T", "/F"], capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    elif proceso.poll() is None:
        proceso.kill()
    try:
        proceso.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


TIENDAS_CON_NAVEGADOR = re.compile(r"elcorteingles\.es|sfera\.com")


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


NAVEGADORES = [
    CABECERAS["User-Agent"],
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
]


def descargar_amazon(url: str, intentos: int = 1) -> str:
    """Amazon pide captcha a muchas visitas de robots; probamos varias veces,
    con pausas y distintos navegadores, antes de rendirnos."""
    asin = asin_de(url)
    destino = f"https://www.amazon.es/dp/{asin}?th=1&psc=1" if asin else url
    ultimo = None
    for intento in range(intentos):
        try:
            pagina = descargar(destino, extra={"User-Agent": NAVEGADORES[intento % len(NAVEGADORES)]})
        except Bloqueado as err:
            ultimo = err
        else:
            if not es_captcha_amazon(pagina):
                return pagina
            ultimo = Bloqueado("Amazon pidió un captcha")
        if intento < intentos - 1:
            time.sleep(random.uniform(12, 25))
    raise ultimo or Bloqueado("Amazon no respondió")


def buscar_amazon(consulta: str) -> str | None:
    """Busca en Amazon y devuelve la ficha del primer resultado cuyo título
    contiene todas las palabras de la consulta."""
    pagina = descargar_amazon(f"https://www.amazon.es/s?k={urllib.parse.quote_plus(consulta)}")
    buscadas = _palabras(consulta)
    for asin, bloque in re.findall(r'data-asin="([A-Z0-9]{10})"(.*?)(?=data-asin="[A-Z0-9]{10}"|$)', pagina, flags=re.S):
        titulo = re.search(r"<h2[^>]*>(.*?)</h2>", bloque, flags=re.S)
        if titulo and buscadas <= _palabras(texto_plano(titulo.group(1))):
            return f"https://www.amazon.es/dp/{asin}"
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


PALABRAS_VACIAS = {"de", "la", "el", "los", "las", "con", "y", "en", "para", "un", "una", "del", "al", "a"}


def _palabras(texto: str) -> set:
    texto = texto.lower()
    for a, b in (("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"), ("ñ", "n")):
        texto = texto.replace(a, b)
    return {p for p in re.findall(r"[a-z0-9]+", texto) if p not in PALABRAS_VACIAS and len(p) > 1}


def buscar_shopify(dominio: str, consulta: str) -> str | None:
    """Busca en una tienda Shopify y devuelve la dirección del producto que contiene
    todas las palabras de la consulta (o None si no hay ninguno claro)."""
    url = (f"https://{dominio}/search/suggest.json?q={urllib.parse.quote(consulta)}"
           "&resources[type]=product&resources[limit]=10")
    datos = json.loads(descargar(url, extra={"Accept": "application/json"}))
    productos = (datos.get("resources", {}).get("results", {}) or {}).get("products", []) or []
    buscadas = _palabras(consulta)
    for producto in productos:
        if buscadas <= _palabras(producto.get("title", "")):
            ruta = producto.get("url", "").split("?")[0]
            if ruta:
                return f"https://{dominio}{ruta}"
    return None


# ---------------------------------------------------------------- El Corte Inglés (búsqueda)

BUSCADORES_ECI = (
    "https://www.elcorteingles.es/search-nwx/1/?s={q}&stype=text_box",
    "https://www.elcorteingles.es/search/?s={q}",
)
FICHA_ECI = re.compile(
    r"""href=['"]((?:https://www\.elcorteingles\.es)?/[a-z0-9-]+(?:/[a-z0-9-]+)*/(A\d{6,10})-([a-z0-9-]+)/?)(?:\?[^'"]*)?['"]""")


def descargar_eci(url: str) -> str:
    """El Corte Inglés casi siempre rechaza a los programas normales: probamos y, si bloquea,
    usamos el navegador del ordenador."""
    try:
        return descargar(url)
    except Bloqueado:
        return descargar_navegador(url)


def fichas_eci(pagina: str) -> list[tuple[str, str]]:
    """(dirección, texto) de cada producto que aparece en una página de El Corte Inglés.
    El texto junta las palabras de la dirección (que llevan el nombre del producto)
    y el texto del enlace."""
    vistas: dict[str, list] = {}
    for encontrado in FICHA_ECI.finditer(pagina):
        ruta, referencia, nombre = encontrado.groups()
        url = ruta if ruta.startswith("http") else "https://www.elcorteingles.es" + ruta
        url = url if url.endswith("/") else url + "/"
        # Solo el texto del propio enlace: lo que viene después puede ser ya otro producto.
        fin = pagina.find("</a>", encontrado.end())
        cerca = texto_plano(pagina[encontrado.end():fin if 0 < fin - encontrado.end() < 3000 else encontrado.end()])
        ficha = vistas.setdefault(referencia, [url, ""])
        ficha[1] += f" {nombre.replace('-', ' ')} {cerca}"
    return [(url, texto) for url, texto in vistas.values()]


def buscar_eci(consulta: str) -> str | None:
    """Busca en El Corte Inglés y devuelve la ficha del primer producto que contiene
    todas las palabras de la consulta (o None si no hay ninguno claro)."""
    buscadas = _palabras(consulta)
    ultima = ""
    for patron in BUSCADORES_ECI:
        try:
            pagina = descargar_eci(patron.format(q=urllib.parse.quote_plus(consulta)))
        except Bloqueado:
            raise
        except Exception as err:  # noqa: BLE001 - probamos la otra forma de buscar
            ultima = f"{patron}\n{err}"
            continue
        fichas = fichas_eci(pagina)
        for url, texto in fichas:
            if buscadas <= _palabras(texto):
                return url
        if fichas:
            return None  # la búsqueda funcionó pero no hay ese producto
        ultima = pagina
    guardar_muestra(f"eci-busqueda-{consulta}", ultima)
    return None


# ---------------------------------------------------------------- comparadores (Globerada)

PRECIO_EUROS = re.compile(r"(\d{1,4}(?:\.\d{3})*,\d{2})\s*€")


def ofertas_comparador(url: str, pagina: str) -> list[dict]:
    """Lee la tabla de ofertas de una página de Globerada.
    Cada fila <tr> lleva el precio en un enlace con data-merchant='Tienda'."""
    partes = urllib.parse.urlsplit(url)
    base = f"{partes.scheme}://{partes.netloc}"
    ofertas: dict[str, dict] = {}
    cuerpo = pagina
    inicio = pagina.find("table_prices_body")
    if inicio != -1:
        cuerpo = pagina[inicio:]
    for fila in re.findall(r"<tr\b.*?</tr>", cuerpo, flags=re.S | re.I):
        tienda = re.search(r"""data-merchant=['"]([^'"]+)['"]""", fila)
        if not tienda:
            alt = re.search(r"""alt=['"]Comprar en ([^'"]+)['"]""", fila)
            texto_tienda = re.search(r"""class=['"]pt_pr_mtext['"][^>]*>(.*?)</td>""", fila, flags=re.S)
            tienda = alt or texto_tienda
        if not tienda:
            continue
        nombre_tienda = texto_plano(html_lib.unescape(tienda.group(1))).strip()
        if not nombre_tienda:
            continue
        precio_html = re.search(r"""data-merchant=['"][^'"]+['"][^>]*>\s*([^<]+)<""", fila)
        texto = texto_plano(fila)
        precio = a_numero(precio_html.group(1)) if precio_html else None
        if not precio:
            encontrado = PRECIO_EUROS.search(texto)
            precio = a_numero(encontrado.group(1)) if encontrado else None
        if not precio:
            continue
        vendedor = re.search(r"Vendido por\s+(.+?)(?:\s+Ver oferta\b|$)", texto)
        if vendedor:
            quien = vendedor.group(1).strip()
            if quien and normalizar_tienda(quien) != normalizar_tienda(nombre_tienda) \
                    and not normalizar_tienda(quien).startswith(normalizar_tienda(nombre_tienda)):
                nombre_tienda = f"{nombre_tienda} ({quien})"
        enlace = re.search(r"""href=['"]([^'"]*/out/[^'"]+)['"]""", fila)
        destino = html_lib.unescape(enlace.group(1)) if enlace else url
        if destino.startswith("/"):
            destino = base + destino
        producto = re.search(r"""class=['"]pt_pr_name['"].*?title=['"]([^'"]+)['"]""", fila, flags=re.S)
        actual = ofertas.get(nombre_tienda)
        if not actual or precio < actual["precio"]:
            ofertas[nombre_tienda] = {"tienda": nombre_tienda, "precio": precio, "url": destino,
                                      "producto": html_lib.unescape(producto.group(1))[:120] if producto else ""}
    return sorted(ofertas.values(), key=lambda o: o["precio"])


def normalizar_tienda(nombre: str) -> str:
    return re.sub(r"[^a-z0-9]", "", nombre.lower().replace(".es", ""))


BUSCADORES_GLOBERADA = (
    "https://www.globerada.com/search.php?q={q}",
)


def buscar_globerada(consulta: str) -> str | None:
    """Busca la ficha de un producto en Globerada y devuelve su página de precios
    si el título contiene todas las palabras buscadas."""
    buscadas = _palabras(consulta)
    for patron in BUSCADORES_GLOBERADA:
        try:
            pagina = descargar(patron.format(q=urllib.parse.quote_plus(consulta)))
        except Exception as err:  # noqa: BLE001 - probamos el siguiente formato
            guardar_muestra("busqueda-error", f"{patron}\n{err}")
            continue
        for etiqueta, ruta, texto in re.findall(
                r"""(<a\b[^>]*href=['"]((?:https://www\.globerada\.com)?/precios/[^'"#?]+\.html)['"][^>]*>)(.*?)</a>""",
                pagina, flags=re.S):
            titulo_attr = re.search(r"""title=['"]([^'"]+)['"]""", etiqueta)
            titulo = " ".join(filter(None, [titulo_attr.group(1) if titulo_attr else "", texto_plano(texto),
                                            ruta.rsplit("/", 1)[-1][:-5].replace("-", " ")]))
            if buscadas <= _palabras(titulo):
                return ruta if ruta.startswith("http") else "https://www.globerada.com" + ruta
        guardar_muestra(f"busqueda-{consulta}", pagina)
    return None


# ---------------------------------------------------------------- Idealo

def buscar_idealo(consulta: str) -> str | None:
    """Busca en Idealo y devuelve la ficha del primer producto cuyo título contiene todas las palabras."""
    url = f"https://www.idealo.es/precios/MainSearchProductCategory.html?q={urllib.parse.quote_plus(consulta)}"
    pagina = descargar(url)
    buscadas = _palabras(consulta)
    for etiqueta, ruta, texto in re.findall(
            r"""(<a\b[^>]*href=['"]((?:https://www\.idealo\.es)?/precios/\d+/[^'"#?]+\.html)['"][^>]*>)(.*?)</a>""",
            pagina, flags=re.S):
        titulo_attr = re.search(r"""(?:title|aria-label)=['"]([^'"]+)['"]""", etiqueta)
        titulo = " ".join(filter(None, [titulo_attr.group(1) if titulo_attr else "", texto_plano(texto),
                                        ruta.rsplit("/", 1)[-1][:-5].replace("-", " ")]))
        if buscadas <= _palabras(titulo):
            return ruta if ruta.startswith("http") else "https://www.idealo.es" + ruta
    guardar_muestra(f"idealo-busqueda-{consulta}", pagina)
    return None


def ofertas_idealo(url: str, pagina: str) -> list[dict]:
    """Ofertas de una ficha de Idealo: cada oferta lleva el nombre de la tienda y su precio."""
    ofertas: dict[str, dict] = {}
    bloques = re.split(r"""(?=<(?:li|div)[^>]+class=['"][^'"]*productOffers-listItem\b)""", pagina)[1:]
    for bloque in bloques:
        bloque = bloque[:8000]
        tienda = (re.search(r"""data-shop-name=['"]([^'"]+)['"]""", bloque)
                  or re.search(r"""alt=['"]([^'"]{2,50})['"][^>]*class=['"][^'"]*shop""", bloque)
                  or re.search(r"""class=['"][^'"]*shop[^'"]*['"][^>]*alt=['"]([^'"]{2,50})['"]""", bloque))
        precio = re.search(r"""productOffers-listItemOfferPrice[^>]*>\s*([^<]+)<""", bloque) or PRECIO_EUROS.search(texto_plano(bloque))
        if not tienda or not precio:
            continue
        nombre = re.sub(r"(?i)\s*-\s*opiniones.*$", "", html_lib.unescape(tienda.group(1))).strip()
        valor = a_numero(precio.group(1))
        enlace = re.search(r"""href=['"]([^'"]*/relocator/[^'"]+)['"]""", bloque) or re.search(r"""href=['"](https?://[^'"]+)['"]""", bloque)
        destino = html_lib.unescape(enlace.group(1)) if enlace else url
        if destino.startswith("/"):
            destino = "https://www.idealo.es" + destino
        if valor and (nombre not in ofertas or valor < ofertas[nombre]["precio"]):
            ofertas[nombre] = {"tienda": nombre, "precio": valor, "url": destino, "producto": ""}
    if not ofertas:
        # Al menos el precio más bajo que Idealo declara en sus datos estructurados.
        minimo = precio_json_ld(pagina)
        if minimo:
            ofertas["Idealo (mejor precio)"] = {"tienda": "Idealo (mejor precio)", "precio": minimo, "url": url, "producto": ""}
    return sorted(ofertas.values(), key=lambda o: o["precio"])


def clave_enlace(enlace: dict) -> str:
    """Identificador estable de un enlace en el historial."""
    if enlace.get("url"):
        return enlace["url"]
    if enlace.get("comparador"):
        return enlace["comparador"]
    if enlace.get("comparador_buscar"):
        prefijo = "idealo" if enlace.get("tienda") == "Idealo" else "comparador"
        return f"{prefijo}:{enlace['comparador_buscar']}"
    if enlace.get("amazon_buscar"):
        return f"amazon:{enlace['amazon_buscar']}"
    if enlace.get("eci_buscar"):
        return f"eci:{enlace['eci_buscar']}"
    return f"buscar:{enlace['dominio']}:{enlace['buscar']}"


# ---------------------------------------------------------------- lectura de un enlace

def analizar(url: str) -> dict:
    """Devuelve {'precio', 'disponible', 'ficha', 'metodo'}; lanza Bloqueado si la tienda lo impide."""
    if "/products/" in url and "amazon." not in url:
        resultado = leer_shopify(url)
        if resultado and resultado["precio"]:
            return resultado

    if "amazon." in url:
        pagina = descargar_amazon(url)
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

    metodo = "generico"
    try:
        pagina = descargar(url)
    except Bloqueado:
        if not TIENDAS_CON_NAVEGADOR.search(url):
            raise
        pagina = descargar_navegador(url)
        metodo = "navegador"
    ficha = ficha_generica(pagina)
    precio = precio_json_ld(pagina) or precio_meta(pagina)
    if not precio and re.search(r"elcorteingles\.es|sfera\.com", url):
        # Las tiendas del grupo El Corte Inglés guardan el precio en sus datos de página.
        for patron in (r'"(?:final|sale_price|price_final|finalPrice)"\s*:\s*"?(\d+[.,]\d{2})',
                       r'data-price=["\'](\d+[.,]\d{2})', r'"price"\s*:\s*\{[^}]*?"(?:final|f_price)"\s*:\s*"?(\d+[.,]\d{2})'):
            encontrado = re.search(patron, pagina)
            if encontrado:
                precio = a_numero(encontrado.group(1))
                break
    if not precio:
        guardar_muestra(f"sin-precio-{urllib.parse.urlsplit(url).netloc}", pagina)
    return {"precio": precio,
            "disponible": disponible_generico(pagina), "ficha": ficha, "metodo": metodo,
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


def referencia_producto(producto: dict, historial: dict, excluir: str) -> float | None:
    """Precio de referencia: el de la lista o, si no hay, la mediana de las otras tiendas."""
    if producto.get("precio_lista"):
        return float(producto["precio_lista"])
    ultimos = sorted(datos["historial"][-1]["precio"] for clave, datos in historial.get(producto["id"], {}).items()
                     if clave != excluir and datos.get("historial") and not datos.get("ultimo_error"))
    return ultimos[len(ultimos) // 2] if len(ultimos) >= 2 else None


def precio_dudoso(precio: float, referencia: float | None) -> bool:
    """Un precio encontrado por búsqueda que es menos de la mitad o más del doble
    de la referencia suele ser otro producto (un accesorio, un pack...)."""
    return bool(referencia) and (precio < referencia * 0.45 or precio > referencia * 2.2)


def revisar_comparador(historial: dict, producto: dict, enlace: dict, hoy: str) -> dict:
    """Guarda cada oferta del comparador como una tienda más ('url#Tienda')."""
    url = enlace["comparador"]
    base_clave = clave_enlace({k: v for k, v in enlace.items() if k != "comparador"}) \
        if enlace.get("comparador_buscar") else url
    prod = historial.setdefault(producto["id"], {})
    fila = {"producto": producto["id"], "tienda": enlace["tienda"], "url": url, "metodo": "comparador"}
    try:
        pagina = descargar(url)
        ofertas = ofertas_idealo(url, pagina) if "idealo." in url else ofertas_comparador(url, pagina)
        if not ofertas or ("idealo." in url and len(ofertas) == 1):
            guardar_muestra(f"comparador-{enlace['tienda']}-{producto['id']}", pagina, 400_000)
        ficha = ficha_generica(pagina)
    except Bloqueado as err:
        ofertas, ficha, fila["error"] = [], {}, f"bloqueado: {err}"
    except Exception as err:  # noqa: BLE001
        ofertas, ficha, fila["error"] = [], {}, f"{type(err).__name__}: {err}"
    else:
        if not ofertas:
            fila["error"] = "no se encontraron ofertas en la página"
            fila["pistas"] = diagnosticar(pagina)
    vistas = set()
    if enlace.get("etiqueta"):
        ofertas = [{**o, "tienda": f"{enlace['etiqueta']} · {o['tienda']}"} for o in ofertas]
    for oferta in ofertas:
        clave = f"{base_clave}#{oferta['tienda']}"
        vistas.add(clave)
        registrar(historial, producto["id"], {"tienda": oferta["tienda"], "url": clave}, hoy,
                  oferta["precio"], True, None,
                  {"url": oferta["url"], "via": enlace["tienda"], "producto_tienda": oferta["producto"],
                   "imagen": ficha.get("imagen") if ficha.get("imagen") else None})
    if not fila.get("error"):
        for clave, datos in prod.items():
            if clave.startswith(f"{base_clave}#") and clave not in vistas:
                datos["ultimo_error"] = "ya no aparece en el comparador"
                datos["ultima_comprobacion"] = hoy
    fila["pagina"] = url
    fila["ofertas"] = [{"tienda": o["tienda"], "precio": o["precio"]} for o in ofertas]
    return fila


def main() -> int:
    for flujo in (sys.stdout, sys.stderr):
        try:
            flujo.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except (AttributeError, ValueError):
            pass
    productos = cargar_json(PRODUCTOS, {"productos": []})["productos"]
    estado = cargar_json(PRECIOS, {"actualizado": None, "productos": {}})
    historial = estado.setdefault("productos", {})
    hoy = ahora_local().date().isoformat()
    informe = []

    ids_validos = {p["id"] for p in productos}
    for viejo in [i for i in historial if i not in ids_validos]:
        del historial[viejo]
    for producto in productos:
        urls = {clave_enlace(e) for e in producto.get("enlaces", [])}
        for url in [u for u in historial.get(producto["id"], {})
                    if u not in urls and u.split("#")[0] not in urls]:
            del historial[producto["id"]][url]

    leidos = fallos = 0
    for producto in productos:
        if producto.get("estado") == "comprado":
            continue
        for enlace in producto.get("enlaces", []):
            if enlace.get("precio_manual") is not None:
                # Tiendas que no dejan leer la página (El Corte Inglés...): precio apuntado a mano.
                registrar(historial, producto["id"], {**enlace, "url": clave_enlace(enlace)},
                          enlace.get("fecha_manual") or hoy, float(enlace["precio_manual"]), True, None)
                continue
            if enlace.get("tienda") == "Idealo" and os.environ.get("GITHUB_ACTIONS") == "true":
                continue  # Idealo bloquea a los servidores de GitHub (403); lo lee el ordenador de casa
            if enlace.get("comparador_buscar") and not enlace.get("comparador"):
                buscador = buscar_idealo if enlace["tienda"] == "Idealo" else buscar_globerada
                try:
                    encontrado = buscador(enlace["comparador_buscar"])
                except Bloqueado as err:
                    encontrado = None
                    guardar_muestra(f"bloqueo-{enlace['tienda']}", str(err))
                except Exception:  # noqa: BLE001
                    encontrado = None
                if not encontrado:
                    informe.append({"producto": producto["id"], "tienda": enlace["tienda"],
                                    "url": clave_enlace(enlace), "error": "no encontrado en el comparador"})
                    print(f"  ✗ {producto['nombre']} [{enlace['tienda']}]: no encontrado")
                    continue
                enlace = {**enlace, "comparador": encontrado}
            if enlace.get("comparador"):
                fila = revisar_comparador(historial, producto, enlace, hoy)
                informe.append(fila)
                leidos += len(fila.get("ofertas", []))
                fallos += 0 if fila.get("ofertas") else 1
                print(f"  {'✓' if fila.get('ofertas') else '✗'} {producto['nombre']} [{enlace['tienda']}]: "
                      f"{len(fila.get('ofertas', []))} ofertas {fila.get('error') or ''}")
                time.sleep(random.uniform(2.0, 5.0))
                continue
            clave = clave_enlace(enlace)
            url = enlace.get("url")
            es_amazon = enlace.get("amazon_buscar") or "amazon." in (url or "")
            if es_amazon and os.environ.get("GITHUB_ACTIONS") == "true":
                # Desde los servidores de GitHub Amazon siempre pide captcha; lo lee el ordenador de casa.
                continue
            es_eci = enlace.get("eci_buscar") or TIENDAS_CON_NAVEGADOR.search(url or "")
            if es_eci and os.environ.get("GITHUB_ACTIONS") == "true":
                # El Corte Inglés y Sfera solo se dejan leer con el navegador del ordenador de casa.
                # Si lo intentáramos aquí, el fallo taparía el precio que dejó el ordenador.
                continue
            resultado: dict = {}
            error = None
            try:
                if not url:
                    anterior = historial.get(producto["id"], {}).get(clave, {}).get("url")
                    if anterior:
                        url = anterior
                    elif enlace.get("amazon_buscar"):
                        url = buscar_amazon(enlace["amazon_buscar"])
                    elif enlace.get("eci_buscar"):
                        url = buscar_eci(enlace["eci_buscar"])
                    else:
                        url = buscar_shopify(enlace["dominio"], enlace["buscar"])
                    if not url:
                        raise LookupError("no está en el catálogo de la tienda")
                resultado = analizar(url)
                if not enlace.get("url"):
                    resultado.setdefault("ficha", {})["url"] = url
            except Bloqueado as err:
                error = f"bloqueado: {err}"
            except Exception as err:  # noqa: BLE001 - seguimos con el resto
                error = f"{type(err).__name__}: {err}"
            precio = resultado.get("precio")
            if precio and (enlace.get("amazon_buscar") or enlace.get("buscar") or enlace.get("eci_buscar")) and \
                    precio_dudoso(precio, referencia_producto(producto, historial, clave)):
                error = f"precio dudoso ({precio:.2f} €): posible producto equivocado"
                precio = None
                resultado["ficha"] = {}
                historial.get(producto["id"], {}).get(clave, {}).pop("url", None)
            registrar(historial, producto["id"], {**enlace, "url": clave}, hoy, precio,
                      resultado.get("disponible"), error, resultado.get("ficha"))
            fila = {"producto": producto["id"], "tienda": enlace["tienda"], "url": url or clave,
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
