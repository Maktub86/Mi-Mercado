import base64
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import servidor as sv  # noqa: E402

LISTA = {
    "categorias": [{"id": "reyes", "nombre": "Reyes 2027", "personas": ["Alba", "Lucía", "Las dos", "Alejandro", "Rocío"]}],
    "productos": [{"id": "tren", "nombre": "Tren", "para": "Alba", "estado": "pendiente", "categoria": "reyes", "enlaces": []}],
}


class ReglasTest(unittest.TestCase):
    def datos(self):
        return json.loads(json.dumps(LISTA))

    def test_normalizar_amazon(self):
        self.assertEqual(sv.normalizar_url("https://www.amazon.es/Barbie-Coche/dp/B0BJLD278H/ref=sr_1_3?keywords=x"),
                         "https://www.amazon.es/dp/B0BJLD278H")
        with self.assertRaises(ValueError):
            sv.normalizar_url("javascript:alert(1)")

    def test_anadir_con_enlace(self):
        datos = self.datos()
        producto, _ = sv.anadir(datos, {"nombre": "Tren de madera", "para": "Alejandro",
                                        "enlace": "https://www.juguettos.com/tren-madera?utm=1"})
        self.assertEqual(producto["id"], "tren-de-madera")
        self.assertEqual(producto["enlaces"][0], {"tienda": "Juguettos", "url": "https://www.juguettos.com/tren-madera"})
        tiendas = [e["tienda"] for e in producto["enlaces"]]
        self.assertEqual(tiendas, ["Juguettos", "Amazon", "Globerada", "Idealo", "Toy Planet", "El Corte Inglés"])
        self.assertEqual(datos["productos"][-1], producto)

    def test_anadir_id_repetido_y_validaciones(self):
        datos = self.datos()
        producto, _ = sv.anadir(datos, {"nombre": "Tren", "para": "Rocío"})
        self.assertEqual(producto["id"], "tren-2")
        with self.assertRaises(ValueError):
            sv.anadir(datos, {"nombre": "Pelota", "para": "Pepe"})
        with self.assertRaises(ValueError):
            sv.anadir(datos, {"nombre": "", "para": "Alba"})

    def test_amazon_y_globerada_no_se_duplican(self):
        enlaces = sv.enlaces_para("Coche", "", ["https://www.amazon.es/dp/B0BJLD278H",
                                                "https://www.globerada.com/precios/coche.html"])
        tiendas = [e["tienda"] for e in enlaces]
        self.assertEqual(tiendas.count("Amazon"), 1)
        self.assertEqual(tiendas.count("Globerada"), 1)

    def test_estado_descartar_eliminar(self):
        datos = self.datos()
        sv.cambiar_estado(datos, "tren", {"estado": "comprado", "comprado_por": "Abuela"})
        self.assertEqual(datos["productos"][0]["comprado_por"], "Abuela")
        sv.cambiar_estado(datos, "tren", {"estado": "pendiente"})
        self.assertNotIn("comprado_por", datos["productos"][0])
        sv.descartar(datos, "tren", {"tienda": "comparador:x#Abacus"})
        self.assertEqual(datos["productos"][0]["descartadas"], ["comparador:x#Abacus"])
        sv.descartar(datos, "tren", {"tienda": "comparador:x#Abacus", "recuperar": True})
        self.assertNotIn("descartadas", datos["productos"][0])
        sv.eliminar(datos, "tren")
        self.assertEqual(datos["productos"], [])
        with self.assertRaises(LookupError):
            sv.eliminar(datos, "tren")


class ServidorTest(unittest.TestCase):
    """Servidor de verdad en un puerto local, con GitHub simulado."""

    @classmethod
    def setUpClass(cls):
        os.environ["CLAVE_EDICION"] = "reyes2027"
        os.environ["GITHUB_TOKEN"] = "falso"
        cls.repo = {"contenido": json.dumps(LISTA), "sha": "1", "puts": 0}

        cls.otros = {}

        def falso(metodo, cuerpo=None, crudo=False, ruta=sv.RUTA_PRODUCTOS):
            if ruta != sv.RUTA_PRODUCTOS:
                if metodo == "GET":
                    if ruta not in cls.otros:
                        raise urllib.error.HTTPError("x", 404, "no", {}, None)
                    return cls.otros[ruta].encode() if crudo else {"sha": "c"}
                cls.otros[ruta] = base64.b64decode(cuerpo["content"]).decode()
                return {}
            if metodo == "GET":
                return cls.repo["contenido"].encode() if crudo else {"sha": cls.repo["sha"]}
            assert cuerpo["sha"] == cls.repo["sha"]
            cls.repo["contenido"] = base64.b64decode(cuerpo["content"]).decode()
            cls.repo["sha"] = str(int(cls.repo["sha"]) + 1)
            cls.repo["puts"] += 1
            return {}

        sv.github = falso
        sv.time.sleep = lambda s: None
        cls.servidor = ThreadingHTTPServer(("127.0.0.1", 0), sv.Manejador)
        cls.base = f"http://127.0.0.1:{cls.servidor.server_address[1]}"
        threading.Thread(target=cls.servidor.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.servidor.shutdown()

    def pedir(self, metodo, ruta, cuerpo=None, clave="reyes2027"):
        req = urllib.request.Request(self.base + ruta, method=metodo,
                                     data=json.dumps(cuerpo).encode() if cuerpo is not None else None,
                                     headers={"Content-Type": "application/json", "X-Clave": clave,
                                              "Origin": "http://localhost:8765"})
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read()), resp.headers
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read()), err.headers

    def test_cestas_compartidas(self):
        codigo, datos, _ = self.pedir("GET", "/calcular")
        self.assertEqual((codigo, datos["calcular"]), (200, {}))
        estado = {"elegidos": ["vtech", ""], "grupo": {"vtech": "Reyes Lucía"}, "precio": {"vtech": "39.5"},
                  "extras": [{"id": "extra-1", "nombre": "Pijama", "grupo": "Papá Noel", "precio": 12}],
                  "grupos": ["Reyes Niñas", "Reyes Niñas", "Cumpleaños Alba"]}
        codigo, _, _ = self.pedir("POST", "/calcular", {"calcular": estado}, clave="mala")
        self.assertEqual(codigo, 401)
        codigo, datos, _ = self.pedir("POST", "/calcular", {"calcular": estado})
        self.assertEqual(codigo, 200)
        codigo, datos, _ = self.pedir("GET", "/calcular")
        guardado = datos["calcular"]
        self.assertEqual(guardado["elegidos"], ["vtech"])
        self.assertEqual(guardado["precio"], {"vtech": 39.5})
        self.assertEqual(guardado["grupos"], ["Reyes Niñas", "Cumpleaños Alba"])
        self.assertEqual(guardado["extras"][0]["grupo"], "Papá Noel")
        codigo, _, _ = self.pedir("POST", "/calcular", {"calcular": {"precio": {"x": -3}}})
        self.assertEqual(codigo, 400)

    def test_flujo_completo(self):
        codigo, cuerpo, cabeceras = self.pedir("GET", "/salud")
        self.assertEqual(codigo, 200)
        self.assertTrue(cuerpo["configurado"])
        self.assertEqual(cabeceras["Access-Control-Allow-Origin"], "http://localhost:8765")

        codigo, cuerpo, _ = self.pedir("POST", "/productos", {"nombre": "Pelota", "para": "Alba"}, clave="mala")
        self.assertEqual(codigo, 401)

        codigo, cuerpo, _ = self.pedir("POST", "/productos", {"nombre": "Pelota azul", "para": "Rocío",
                                                              "enlace": "https://www.amazon.es/x/dp/B000000001/ref=1"})
        self.assertEqual(codigo, 200, cuerpo)
        self.assertEqual(cuerpo["producto"]["enlaces"][0]["url"], "https://www.amazon.es/dp/B000000001")

        codigo, cuerpo, _ = self.pedir("POST", "/productos/pelota-azul/estado", {"estado": "comprado"})
        self.assertEqual(cuerpo["producto"]["estado"], "comprado")
        codigo, cuerpo, _ = self.pedir("POST", "/productos/pelota-azul/descartar", {"tienda": "amazon:Pelota azul"})
        self.assertEqual(cuerpo["producto"]["descartadas"], ["amazon:Pelota azul"])
        codigo, cuerpo, _ = self.pedir("POST", "/productos", {"nombre": "Pelota", "para": "Nadie"})
        self.assertEqual(codigo, 400)
        codigo, cuerpo, _ = self.pedir("DELETE", "/productos/no-existe")
        self.assertEqual(codigo, 404)
        codigo, cuerpo, _ = self.pedir("DELETE", "/productos/pelota-azul")
        self.assertEqual(codigo, 200)

        guardado = json.loads(self.repo["contenido"])
        self.assertEqual([p["id"] for p in guardado["productos"]], ["tren"])
        self.assertEqual(self.repo["puts"], 4)


if __name__ == "__main__":
    unittest.main()

