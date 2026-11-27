"""Mi Mercado - servidor de edición.

Recibe los cambios que se hacen desde la web (añadir un producto, marcarlo
como comprado, eliminarlo o descartar una tienda equivocada) y los guarda en
web/data/productos.json del repositorio de GitHub. Al guardarse, el robot
revisa los precios y Render vuelve a publicar la web.

Solo usa la biblioteca estándar de Python. Variables de entorno:
  GITHUB_TOKEN   clave de GitHub con permiso de escritura en el repositorio
  CLAVE_EDICION  contraseña que hay que escribir en la web para editar
  ORIGEN_WEB     dirección de la web (para permitir sus peticiones)
  REPO           (opcional) usuario/repositorio, por defecto Maktub86/Mi-Mercado
"""

from __future__ import annotations

import base64
import hmac
import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.environ.get("REPO", "Maktub86/Mi-Mercado")
RAMA = os.environ.get("RAMA", "main")
RUTA_PRODUCTOS = "web/data/productos.json"
RUTA_CALCULAR = "web/data/calcular.json"
ORIGENES = {o.strip().rstrip("/") for o in os.environ.get("ORIGEN_WEB", "").split(",") if o.strip()}
BLOQUEO = threading.Lock()

TIENDAS = {
    "amazon.": "Amazon", "toyplanet.": "Toy Planet", "toysrus.": "Toys R Us",
    "elcorteingles.": "El Corte Inglés", "sfera.": "Sfera", "carrefour.": "Carrefour",
    "dideco.": "Dideco", "juguettos.": "Juguettos", "fnac.": "Fnac", "casadellibro.": "Casa del Libro",
    "abacus.": "Abacus", "miravia.": "Miravia", "decathlon.": "Decathlon", "zalando.": "Zalando",
    "kiabi.": "Kiabi", "hipercor.": "Hipercor", "alcampo.": "Alcampo", "pccomponentes.": "PcComponentes",
}


# ---------------------------------------------------------------- reglas de la lista

def slug(texto: str) -> str:
    texto = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", texto).strip("-")[:60] or "producto"


def nombre_tienda(url: str) -> str:
    dominio = urllib.parse.urlsplit(url).netloc.lower()
    for clave, nombre in TIENDAS.items():
        if clave in dominio:
            return nombre
    base = dominio.removeprefix("www.").split(".")[0]
    return base.capitalize() or "Tienda"


def normalizar_url(url: str) -> str:
    """Quita el rastro de seguimiento; en Amazon deja solo /dp/CÓDIGO."""
    partes = urllib.parse.urlsplit(url.strip())
    if partes.scheme not in ("http", "https") or not partes.netloc:
        raise ValueError("El enlace debe empezar por http:// o https://")
    if "amazon." in partes.netloc:
        asin = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", partes.path)
        if asin:
            return f"https://www.amazon.es/dp/{asin.group(1)}"
    return urllib.parse.urlunsplit((partes.scheme, partes.netloc, partes.path, "", ""))


def enlace_desde_url(url: str) -> dict:
    url = normalizar_url(url)
    if "globerada.com/precios/" in url:
        return {"tienda": "Globerada", "comparador": url}
    return {"tienda": nombre_tienda(url), "url": url}


def enlaces_para(nombre: str, busqueda: str, urls: list[str]) -> list[dict]:
    """Los enlaces que da quien añade el producto, más búsquedas automáticas
    en Amazon, Globerada, Idealo, Toy Planet y El Corte Inglés para encontrar muchas tiendas."""
    enlaces = []
    for url in urls:
        if url.strip():
            nuevo = enlace_desde_url(url)
            if nuevo not in enlaces:
                enlaces.append(nuevo)
    consulta = busqueda.strip() or nombre.strip()
    tiendas = {e["tienda"] for e in enlaces}
    if "Amazon" not in tiendas:
        enlaces.append({"tienda": "Amazon", "amazon_buscar": consulta})
    if "Globerada" not in tiendas:
        enlaces.append({"tienda": "Globerada", "comparador_buscar": consulta})
    enlaces.append({"tienda": "Idealo", "comparador_buscar": consulta})
    if "Toy Planet" not in tiendas:
        enlaces.append({"tienda": "Toy Planet", "dominio": "www.toyplanet.com", "buscar": consulta})
    if not any(t.startswith("El Corte Inglés") for t in tiendas):
        enlaces.append({"tienda": "El Corte Inglés", "eci_buscar": consulta})
    return enlaces


def personas_de(datos: dict, categoria: str) -> list[str]:
    for c in datos.get("categorias", []):
        if c["id"] == categoria:
            return c.get("personas", [])
    raise ValueError("Esa categoría no existe")


def buscar(datos: dict, producto_id: str) -> dict:
    for producto in datos["productos"]:
        if producto["id"] == producto_id:
            return producto
    raise LookupError("Ese producto no existe")


def anadir(datos: dict, peticion: dict) -> tuple[dict, str]:
    nombre = str(peticion.get("nombre", "")).strip()
    if not 2 <= len(nombre) <= 120:
        raise ValueError("Escribe un nombre (entre 2 y 120 letras)")
    categoria = str(peticion.get("categoria") or (datos.get("categorias") or [{"id": "reyes"}])[0]["id"])
    para = str(peticion.get("para", "")).strip()
    if para not in personas_de(datos, categoria):
        raise ValueError("Elige para quién es")
    urls = peticion.get("enlaces") or ([peticion["enlace"]] if peticion.get("enlace") else [])
    if not isinstance(urls, list) or len(urls) > 10:
        raise ValueError("Enlaces no válidos")
    precio = peticion.get("precio_lista")
    precio = round(float(str(precio).replace(",", ".")), 2) if precio not in (None, "") else None
    base = slug(nombre)
    ids = {p["id"] for p in datos["productos"]}
    nuevo_id, n = base, 2
    while nuevo_id in ids:
        nuevo_id, n = f"{base}-{n}", n + 1
    producto = {
        "id": nuevo_id, "nombre": nombre, "para": para, "estado": "pendiente", "categoria": categoria,
        "nota": str(peticion.get("nota", "")).strip()[:200], "precio_lista": precio,
        "busqueda": str(peticion.get("busqueda", "")).strip()[:120] or nombre,
        "enlaces": enlaces_para(nombre, str(peticion.get("busqueda", "")), [str(u) for u in urls]),
    }
    if peticion.get("imagen"):
        producto["imagen"] = normalizar_url(str(peticion["imagen"]))
    datos["productos"].append(producto)
    return producto, f"Añadir {nombre} ({para})"


def cambiar_estado(datos: dict, producto_id: str, peticion: dict) -> tuple[dict, str]:
    producto = buscar(datos, producto_id)
    estado = peticion.get("estado")
    if estado not in ("pendiente", "comprado"):
        raise ValueError("Estado no válido")
    producto["estado"] = estado
    if estado == "comprado" and peticion.get("comprado_por"):
        producto["comprado_por"] = str(peticion["comprado_por"]).strip()[:60]
    if estado == "pendiente":
        producto.pop("comprado_por", None)
    return producto, f"Marcar {producto['nombre']} como {estado}"


def eliminar(datos: dict, producto_id: str) -> tuple[dict, str]:
    producto = buscar(datos, producto_id)
    datos["productos"].remove(producto)
    return producto, f"Eliminar {producto['nombre']}"


def descartar(datos: dict, producto_id: str, peticion: dict) -> tuple[dict, str]:
    """Oculta una tienda que no es el producto (p. ej. otro modelo con el mismo nombre)."""
    producto = buscar(datos, producto_id)
    clave = str(peticion.get("tienda", "")).strip()
    if not clave:
        raise ValueError("Falta la tienda")
    descartadas = producto.setdefault("descartadas", [])
    if peticion.get("recuperar"):
        if clave in descartadas:
            descartadas.remove(clave)
    elif clave not in descartadas:
        descartadas.append(clave)
    if not descartadas:
        producto.pop("descartadas")
    return producto, f"{'Recuperar' if peticion.get('recuperar') else 'Descartar'} {clave} en {producto['nombre']}"


def editar(datos: dict, producto_id: str, peticion: dict) -> tuple[dict, str]:
    producto = buscar(datos, producto_id)
    if "nombre" in peticion:
        nombre = str(peticion["nombre"]).strip()
        if not 2 <= len(nombre) <= 120:
            raise ValueError("Nombre no válido")
        producto["nombre"] = nombre
    if peticion.get("categoria"):
        categoria = str(peticion["categoria"])
        personas = personas_de(datos, categoria)  # da error si no existe
        if peticion.get("para", producto["para"]) not in personas:
            raise ValueError("Elige para quién es en esa categoría")
        producto["categoria"] = categoria
    if "para" in peticion:
        if peticion["para"] not in personas_de(datos, producto.get("categoria", "reyes")):
            raise ValueError("Persona no válida")
        producto["para"] = peticion["para"]
    if peticion.get("enlace"):
        nuevo = enlace_desde_url(str(peticion["enlace"]))
        if nuevo not in producto["enlaces"]:
            producto["enlaces"].insert(0, nuevo)
    # Precio que he pagado o apuntado yo (por unidad), cuántas unidades y qué precio se usa al sumar.
    if "precio_propio" in peticion:
        valor = peticion["precio_propio"]
        precio = _precio(str(valor).replace(",", ".")) if valor not in (None, "") else None
        if precio is None:
            producto.pop("precio_propio", None)
            producto.pop("usar_precio", None)
        else:
            producto["precio_propio"] = precio
    if "cantidad" in peticion:
        try:
            cantidad = 1 if peticion["cantidad"] in (None, "") else int(peticion["cantidad"])
        except (TypeError, ValueError):
            raise ValueError("Cantidad no válida") from None
        if not 1 <= cantidad <= 99:
            raise ValueError("La cantidad tiene que estar entre 1 y 99")
        if cantidad == 1:
            producto.pop("cantidad", None)
        else:
            producto["cantidad"] = cantidad
    if "usar_precio" in peticion:
        usar = peticion["usar_precio"]
        if usar not in ("propio", "tienda"):
            raise ValueError("Elige mi precio o el del historial")
        if usar == "propio" and producto.get("precio_propio") is None:
            raise ValueError("Primero escribe tu precio")
        if usar == "propio":
            producto.pop("usar_precio", None)  # con precio propio, por defecto se usa el propio
        else:
            producto["usar_precio"] = "tienda"
    return producto, f"Editar {producto['nombre']}"


# ---------------------------------------------------------------- GitHub

def github(metodo: str, cuerpo: dict | None = None, crudo: bool = False, ruta: str = RUTA_PRODUCTOS):
    url = f"https://api.github.com/repos/{REPO}/contents/{ruta}"
    if metodo == "GET":
        url += f"?ref={RAMA}"
    req = urllib.request.Request(url, method=metodo, data=json.dumps(cuerpo).encode() if cuerpo else None, headers={
        "Authorization": f"Bearer {os.environ.get('GITHUB_TOKEN', '').strip()}",
        "Accept": "application/vnd.github.raw" if crudo else "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mi-mercado-api",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        datos = resp.read()
    return datos if crudo else json.loads(datos or b"{}")


def leer_lista() -> tuple[dict, str]:
    sha = github("GET")["sha"]
    return json.loads(github("GET", crudo=True)), sha


def guardar_lista(cambio) -> dict:
    """Lee la lista, aplica el cambio y la guarda; si alguien la cambió a la vez, reintenta."""
    with BLOQUEO:
        for intento in range(4):
            datos, sha = leer_lista()
            resultado, mensaje = cambio(datos)
            contenido = (json.dumps(datos, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            try:
                github("PUT", {"message": f"{mensaje} (desde la web)", "branch": RAMA, "sha": sha,
                               "content": base64.b64encode(contenido).decode()})
                return resultado
            except urllib.error.HTTPError as err:
                if err.code in (409, 422) and intento < 3:
                    time.sleep(1.5)
                    continue
                raise
    raise RuntimeError("No se pudo guardar")


# ---------------------------------------------------------------- cestas de Calcular (compartidas)

def _texto(valor, largo: int = 120) -> str:
    return str(valor or "").strip()[:largo]


def _precio(valor):
    if valor is None or valor == "":
        return None
    numero = float(valor)
    if not (0 <= numero < 100_000):
        raise ValueError("Precio no válido")
    return round(numero, 2)


def limpiar_calcular(estado: dict) -> dict:
    """Comprueba y ordena lo que manda la web para las cestas."""
    if not isinstance(estado, dict):
        raise ValueError("Cestas no válidas")
    elegidos = [_texto(x, 80) for x in (estado.get("elegidos") or [])[:400] if _texto(x, 80)]
    grupos = []
    for g in (estado.get("grupos") or [])[:40]:
        g = _texto(g, 40)
        if g and g not in grupos:
            grupos.append(g)
    grupo = {_texto(k, 80): _texto(v, 40) for k, v in list((estado.get("grupo") or {}).items())[:400] if _texto(v, 40)}
    precio = {}
    for k, v in list((estado.get("precio") or {}).items())[:400]:
        p = _precio(v)
        if p is not None:
            precio[_texto(k, 80)] = p
    extras = []
    for x in (estado.get("extras") or [])[:200]:
        if isinstance(x, dict) and _texto(x.get("nombre")):
            extras.append({"id": _texto(x.get("id"), 40) or f"extra-{len(extras)}", "nombre": _texto(x.get("nombre")),
                           "grupo": _texto(x.get("grupo"), 40) or "Cesta", "precio": _precio(x.get("precio"))})
    carta = {}
    for k, v in list((estado.get("carta") or {}).items())[:400]:
        try:
            x, y = (min(100.0, max(0.0, round(float(n), 1))) for n in v)
        except (TypeError, ValueError):
            continue
        if _texto(k, 80):
            carta[_texto(k, 80)] = [x, y]
    sin_dinero = []
    for x in (estado.get("sin_dinero") or [])[:400]:
        x = _texto(x, 80)
        if x and x not in sin_dinero:
            sin_dinero.append(x)
    return {"elegidos": elegidos, "grupo": grupo, "precio": precio, "extras": extras, "grupos": grupos,
            "carta": carta, "sin_dinero": sin_dinero, "actualizado": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def leer_calcular() -> tuple[dict, str | None]:
    try:
        sha = github("GET", ruta=RUTA_CALCULAR)["sha"]
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return {}, None
        raise
    return json.loads(github("GET", crudo=True, ruta=RUTA_CALCULAR)), sha


def guardar_calcular(estado: dict) -> dict:
    limpio = limpiar_calcular(estado)
    contenido = (json.dumps(limpio, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with BLOQUEO:
        for intento in range(4):
            _, sha = leer_calcular()
            cuerpo = {"message": "Cestas de Calcular (desde la web)", "branch": RAMA,
                      "content": base64.b64encode(contenido).decode()}
            if sha:
                cuerpo["sha"] = sha
            try:
                github("PUT", cuerpo, ruta=RUTA_CALCULAR)
                return limpio
            except urllib.error.HTTPError as err:
                if err.code in (409, 422) and intento < 3:
                    time.sleep(1.5)
                    continue
                raise
    raise RuntimeError("No se pudo guardar")


# ---------------------------------------------------------------- servidor HTTP

class Manejador(BaseHTTPRequestHandler):
    server_version = "MiMercado/1.0"

    def _origen_permitido(self) -> str | None:
        origen = (self.headers.get("Origin") or "").rstrip("/")
        if origen and (origen in ORIGENES or origen.startswith(("http://localhost", "http://127.0.0.1"))):
            return origen
        return None

    def _responder(self, codigo: int, cuerpo: dict) -> None:
        datos = json.dumps(cuerpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("Cache-Control", "no-store")
        origen = self._origen_permitido()
        if origen:
            self.send_header("Access-Control-Allow-Origin", origen)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(datos)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        origen = self._origen_permitido()
        if origen:
            self.send_header("Access-Control-Allow-Origin", origen)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Clave")
            self.send_header("Access-Control-Max-Age", "86400")
            self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("", "/salud"):
            self._responder(200, {"ok": True, "configurado": bool(os.environ.get("GITHUB_TOKEN")
                                                                   and os.environ.get("CLAVE_EDICION"))})
        elif urllib.parse.urlsplit(self.path).path.rstrip("/") == "/calcular":
            try:
                estado, _ = leer_calcular()
                self._responder(200, {"ok": True, "calcular": estado})
            except Exception as err:  # noqa: BLE001
                self._responder(502, {"error": f"No se pudieron leer las cestas ({type(err).__name__})"})
        else:
            self._responder(404, {"error": "No encontrado"})

    def _autorizado(self) -> bool:
        esperada = os.environ.get("CLAVE_EDICION", "")
        dada = self.headers.get("X-Clave", "")
        if esperada and hmac.compare_digest(esperada.encode(), dada.encode()):
            return True
        time.sleep(1)  # frena los intentos de adivinar la contraseña
        return False

    def _cuerpo(self) -> dict:
        largo = int(self.headers.get("Content-Length") or 0)
        if largo > 200_000:
            raise ValueError("Petición demasiado grande")
        datos = json.loads(self.rfile.read(largo) or b"{}") if largo else {}
        if not isinstance(datos, dict):
            raise ValueError("Petición no válida")
        return datos

    def _ejecutar(self, metodo: str) -> None:
        if not self._autorizado():
            self._responder(401, {"error": "Contraseña incorrecta"})
            return
        ruta = urllib.parse.urlsplit(self.path).path.rstrip("/")
        try:
            cuerpo = self._cuerpo() if metodo == "POST" else {}
            if metodo == "POST" and ruta == "/comprobar":
                self._responder(200, {"ok": True})
                return
            if metodo == "POST" and ruta == "/calcular":
                self._responder(200, {"ok": True, "calcular": guardar_calcular(cuerpo.get("calcular") or {})})
                return
            if metodo == "POST" and ruta == "/productos":
                producto = guardar_lista(lambda d: anadir(d, cuerpo))
            else:
                m = re.fullmatch(r"/productos/([a-z0-9-]+)(?:/(estado|descartar|editar))?", ruta)
                if not m:
                    self._responder(404, {"error": "No encontrado"})
                    return
                pid, accion = m.group(1), m.group(2)
                if metodo == "DELETE" and not accion:
                    producto = guardar_lista(lambda d: eliminar(d, pid))
                elif metodo == "POST" and accion == "estado":
                    producto = guardar_lista(lambda d: cambiar_estado(d, pid, cuerpo))
                elif metodo == "POST" and accion == "descartar":
                    producto = guardar_lista(lambda d: descartar(d, pid, cuerpo))
                elif metodo == "POST" and accion == "editar":
                    producto = guardar_lista(lambda d: editar(d, pid, cuerpo))
                else:
                    self._responder(405, {"error": "Acción no permitida"})
                    return
            self._responder(200, {"ok": True, "producto": producto})
        except (ValueError, json.JSONDecodeError) as err:
            self._responder(400, {"error": str(err)})
        except LookupError as err:
            self._responder(404, {"error": str(err)})
        except urllib.error.HTTPError as err:
            mensaje = {401: "GitHub no reconoce la clave: GITHUB_TOKEN está mal copiada o ha caducado",
                       403: "La clave de GitHub no tiene permiso para escribir: dale 'Contents: Read and write' en Mi-Mercado",
                       404: "La clave de GitHub no tiene acceso al repositorio Mi-Mercado"}.get(err.code, f"GitHub respondió {err.code}")
            self._responder(502, {"error": mensaje})
        except Exception as err:  # noqa: BLE001
            self._responder(500, {"error": f"Error inesperado: {type(err).__name__}"})

    def do_POST(self):  # noqa: N802
        self._ejecutar("POST")

    def do_DELETE(self):  # noqa: N802
        self._ejecutar("DELETE")

    def log_message(self, formato, *args):  # registro breve en la consola de Render
        print(f"{self.address_string()} {formato % args}", flush=True)


def main() -> None:
    puerto = int(os.environ.get("PORT", "8000"))
    print(f"Mi Mercado API escuchando en el puerto {puerto} para {REPO}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", puerto), Manejador).serve_forever()


if __name__ == "__main__":
    main()
