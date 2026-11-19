"""Mi Mercado - revisión de precios desde el ordenador de casa.

1. Descarga de GitHub la lista de productos, el historial y el robot.
2. Ejecuta el robot desde este ordenador (Amazon y El Corte Inglés sí dejan entrar).
3. Sube el historial actualizado a GitHub, y Render publica la web.

Solo usa la biblioteca estándar de Python. Necesita el archivo token.txt
con una clave de GitHub que pueda escribir en el repositorio Mi-Mercado.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

REPO = "Maktub86/Mi-Mercado"
RAMA = "main"
API = f"https://api.github.com/repos/{REPO}/contents"
CARPETA = Path(__file__).resolve().parent
TOKEN = (CARPETA / "token.txt").read_text(encoding="utf-8").strip() if (CARPETA / "token.txt").exists() else ""

ARCHIVOS = {
    "web/data/productos.json": "lectura",
    "web/data/precios.json": "escritura",
    "scripts/actualizar_precios.py": "lectura",
}


def peticion(metodo: str, ruta: str, cuerpo: dict | None = None, crudo: bool = False):
    url = f"{API}/{ruta}" + (f"?ref={RAMA}" if metodo == "GET" else "")
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(url, data=datos, method=metodo, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github.raw" if crudo else "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mi-mercado-casa",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        contenido = resp.read()
    return contenido if crudo else json.loads(contenido or b"{}")


def descargar(ruta: str) -> tuple[bytes, str | None]:
    try:
        sha = peticion("GET", ruta).get("sha")
        return peticion("GET", ruta, crudo=True), sha
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return b"", None
        raise


def subir(ruta: str, contenido: bytes, sha: str | None, mensaje: str) -> None:
    cuerpo = {"message": mensaje, "content": base64.b64encode(contenido).decode(), "branch": RAMA}
    if sha:
        cuerpo["sha"] = sha
    peticion("PUT", ruta, cuerpo)


def fusionar(remoto: dict, local: dict) -> dict:
    """Si mientras tanto el robot de GitHub guardó precios, juntamos los dos historiales."""
    resultado = json.loads(json.dumps(remoto))
    resultado["actualizado"] = max(filter(None, [remoto.get("actualizado"), local.get("actualizado")]), default=None)
    for pid, enlaces in local.get("productos", {}).items():
        destino = resultado.setdefault("productos", {}).setdefault(pid, {})
        for clave, datos in enlaces.items():
            if clave not in destino:
                destino[clave] = datos
                continue
            otro = destino[clave]
            fechas = {e["fecha"]: e for e in otro.get("historial", [])}
            for entrada in datos.get("historial", []):
                fechas[entrada["fecha"]] = entrada
            nuevo = {**otro, **{k: v for k, v in datos.items() if k != "historial"}}
            nuevo["historial"] = [fechas[f] for f in sorted(fechas)]
            if datos.get("historial") and not datos.get("ultimo_error"):
                nuevo.pop("ultimo_error", None)
            destino[clave] = nuevo
    return resultado


def main() -> int:
    for flujo in (sys.stdout, sys.stderr):
        try:
            flujo.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    print(f"Mi Mercado - revisión desde casa ({datetime.now():%d/%m/%Y %H:%M})")
    if not TOKEN:
        print("Falta token.txt. Vuelve a ejecutar instalar.bat.")
        return 1
    with tempfile.TemporaryDirectory(prefix="mi-mercado-") as tmp:
        raiz = Path(tmp)
        shas = {}
        for ruta in ARCHIVOS:
            contenido, sha = descargar(ruta)
            shas[ruta] = sha
            destino = raiz / ruta
            destino.parent.mkdir(parents=True, exist_ok=True)
            destino.write_bytes(contenido)
        print("Lista y robot descargados de GitHub. Revisando tiendas...")

        entorno = {**os.environ, "MI_MERCADO_RAIZ": str(raiz), "MI_MERCADO_INFORME": "revision_casa.json",
                   "PYTHONIOENCODING": "utf-8"}
        proceso = subprocess.run([sys.executable, "-I", str(raiz / "scripts" / "actualizar_precios.py")],
                                 env=entorno, check=False)
        if proceso.returncode != 0:
            print("El robot terminó con un error; no se sube nada.")
            return proceso.returncode

        local = json.loads((raiz / "web/data/precios.json").read_text(encoding="utf-8"))
        for intento in range(3):
            remoto_bytes, sha = descargar("web/data/precios.json")
            remoto = json.loads(remoto_bytes or b'{"productos": {}}')
            final = fusionar(remoto, local) if sha != shas["web/data/precios.json"] else local
            try:
                subir("web/data/precios.json",
                      (json.dumps(final, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
                      sha, "Actualizar precios (desde casa)")
                break
            except urllib.error.HTTPError as err:
                if err.code in (409, 422) and intento < 2:
                    time.sleep(3)
                    continue
                raise
        informe = raiz / "diagnostico" / "revision_casa.json"
        if informe.exists():
            _, sha_informe = descargar("diagnostico/revision_casa.json")
            try:
                subir("diagnostico/revision_casa.json", informe.read_bytes(), sha_informe,
                      "Informe de la revisión desde casa")
            except urllib.error.HTTPError:
                pass
    print("Precios subidos. La web se actualizará en un par de minutos.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as err:
        if err.code in (401, 403):
            print("GitHub no acepta la clave de token.txt (caducada o sin permiso). Vuelve a ejecutar instalar.bat.")
        else:
            print(f"Error de GitHub: {err}")
        sys.exit(1)
    except urllib.error.URLError as err:
        print(f"Sin conexión a internet ({err.reason}). Se intentará en la próxima revisión.")
        sys.exit(1)
