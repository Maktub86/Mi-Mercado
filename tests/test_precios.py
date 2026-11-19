import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import actualizar_precios as ap  # noqa: E402


class NumeroTest(unittest.TestCase):
    def test_formatos(self):
        self.assertEqual(ap.a_numero("27,29 €"), 27.29)
        self.assertEqual(ap.a_numero("1.234,56 €"), 1234.56)
        self.assertEqual(ap.a_numero("1,234.56"), 1234.56)
        self.assertEqual(ap.a_numero("44.99"), 44.99)
        self.assertEqual(ap.a_numero(19.5), 19.5)
        self.assertEqual(ap.a_numero("39&nbsp;€"), 39.0)
        self.assertIsNone(ap.a_numero(""))
        self.assertIsNone(ap.a_numero("gratis"))
        self.assertIsNone(ap.a_numero(0))


class ExtraccionTest(unittest.TestCase):
    def test_json_ld(self):
        pagina = """<html><script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Product","name":"Muñeca",
         "offers":{"@type":"Offer","price":"28.95","priceCurrency":"EUR",
         "availability":"https://schema.org/InStock"}}</script></html>"""
        self.assertEqual(ap.leer_precio("https://www.elcorteingles.es/x", pagina), 28.95)
        self.assertTrue(ap.disponible("https://www.elcorteingles.es/x", pagina))

    def test_json_ld_lista_y_agotado(self):
        pagina = """<script type="application/ld+json">[{"@type":"BreadcrumbList"},
        {"@type":"Product","offers":[{"@type":"AggregateOffer","lowPrice":19.49}],
         "availability":"https://schema.org/OutOfStock"}]</script>"""
        self.assertEqual(ap.leer_precio("https://www.carrefour.es/x", pagina), 19.49)
        self.assertFalse(ap.disponible("https://www.carrefour.es/x", pagina))

    def test_meta(self):
        pagina = '<meta property="product:price:amount" content="34,99">'
        self.assertEqual(ap.leer_precio("https://tienda.es/p", pagina), 34.99)
        pagina = '<span itemprop="price" content="12.50">12,50 €</span>'
        self.assertEqual(ap.leer_precio("https://tienda.es/p", pagina), 12.5)

    def test_amazon_bloque_principal(self):
        pagina = """<div id="otro"><span class="a-offscreen">5,00 €</span></div>
        <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">27,29 €</span>
        <span class="a-price-whole">27<span class="a-price-decimal">,</span></span>
        <span class="a-price-fraction">29</span></span></div>
        <div id="availability"><span>En stock</span></div>
        <img alt="Imagen no disponible del Color">"""
        url = "https://www.amazon.es/dp/B0B4KQMTVM"
        self.assertEqual(ap.leer_precio(url, pagina), 27.29)
        self.assertTrue(ap.disponible(url, pagina))

    def test_amazon_partes(self):
        pagina = """<div id="corePriceDisplay_desktop_feature_div">
        <span class="a-price-whole">1.044<span class="a-price-decimal">,</span></span>
        <span class="a-price-fraction">90</span></div>"""
        self.assertEqual(ap.leer_precio("https://www.amazon.es/dp/X", pagina), 1044.9)

    def test_amazon_agotado(self):
        pagina = '<div id="availability"><span class="a-color-price">No disponible.</span></div>'
        self.assertFalse(ap.disponible("https://www.amazon.es/dp/X", pagina))

    def test_amazon_captcha(self):
        pagina = '<form action="/errors/validateCaptcha">'
        with self.assertRaises(ap.Bloqueado):
            ap.leer_precio("https://www.amazon.es/dp/X", pagina)


class HistorialTest(unittest.TestCase):
    def test_un_registro_por_dia(self):
        hist = {}
        enlace = {"tienda": "Amazon", "url": "https://www.amazon.es/dp/X"}
        ap.registrar(hist, "p", enlace, "2026-11-18", 30.0, True, None)
        ap.registrar(hist, "p", enlace, "2026-11-18", 29.0, True, None)
        ap.registrar(hist, "p", enlace, "2026-11-19", None, None, "bloqueado")
        ap.registrar(hist, "p", enlace, "2026-11-20", 25.0, True, None)
        datos = hist["p"][enlace["url"]]
        self.assertEqual([e["precio"] for e in datos["historial"]], [29.0, 25.0])
        self.assertNotIn("ultimo_error", datos)
        self.assertEqual(datos["ultima_comprobacion"], "2026-11-20")


class FichaTest(unittest.TestCase):
    def test_ficha_amazon(self):
        pagina = """<span id="productTitle" class="a-size-large">  Mondo Motors Barbie City Car  </span>
        <img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/abc._AC_SL1500_.jpg" src="x">
        <div id="averageCustomerReviews"><span id="acrPopover" title="4,5 de 5 estrellas"></span>
        <span id="acrCustomerReviewText" class="a-size-base">1.234 valoraciones</span></div>
        <div id="product-summary"><h3>Opiniones</h3><p><span>Los clientes opinan que el coche es bonito y fácil de manejar para niñas pequeñas.</span></p>
        <span>Generado por IA a partir de las reseñas</span></div>"""
        ficha = ap.ficha_amazon("https://www.amazon.es/dp/B0BJLD278H", pagina)
        self.assertEqual(ficha["titulo"], "Mondo Motors Barbie City Car")
        self.assertTrue(ficha["imagen"].endswith("_SL1500_.jpg"))
        self.assertEqual(ficha["valoracion"], {"media": 4.5, "total": 1234, "maximo": 5})
        self.assertTrue(ficha["resumen_opiniones"].startswith("Los clientes opinan"))
        self.assertNotIn("Generado", ficha["resumen_opiniones"])
        self.assertEqual(ficha["opiniones_url"], "https://www.amazon.es/product-reviews/B0BJLD278H")

    def test_amazon_precio_oculto(self):
        pagina = '<input type="hidden" name="items[0.base][customerVisiblePrice][amount]" value="23.88">'
        self.assertEqual(ap.leer_precio("https://www.amazon.es/dp/X", pagina), 23.88)

    def test_ficha_generica(self):
        pagina = """<meta property="og:image" content="https://tienda.es/foto.jpg">
        <script type="application/ld+json">{"@type":"Product","name":"Trineo",
        "image":["https://tienda.es/trineo.jpg"],
        "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"12"},
        "offers":{"@type":"Offer","price":39.49}}</script>"""
        ficha = ap.ficha_generica(pagina)
        self.assertEqual(ficha["imagen"], "https://tienda.es/trineo.jpg")
        self.assertEqual(ficha["valoracion"]["media"], 4.8)
        self.assertEqual(ficha["valoracion"]["total"], 12)

    def test_shopify(self):
        original = ap.descargar
        pedidas = []
        def falso(url, timeout=25, extra=None):
            pedidas.append(url)
            return '{"title":"Claire","available":false,"featured_image":"//cdn.shopify.com/a.jpg","variants":[{"price":3499},{"price":2899}]}'
        ap.descargar = falso
        try:
            r = ap.leer_shopify("https://www.toyplanet.com/en/products/monster-high-claire?x=1")
        finally:
            ap.descargar = original
        self.assertEqual(pedidas, ["https://www.toyplanet.com/products/monster-high-claire.js"])
        self.assertEqual(r["precio"], 28.99)
        self.assertFalse(r["disponible"])
        self.assertEqual(r["ficha"]["imagen"], "https://cdn.shopify.com/a.jpg")

    def test_registrar_guarda_ficha(self):
        hist = {}
        enlace = {"tienda": "Amazon", "url": "u"}
        ap.registrar(hist, "p", enlace, "2026-11-19", None, None, "bloqueado", {"imagen": "i.jpg"})
        self.assertEqual(hist["p"]["u"]["imagen"], "i.jpg")
        self.assertEqual(hist["p"]["u"]["historial"], [])


class BusquedaTest(unittest.TestCase):
    def test_buscar_shopify_exige_todas_las_palabras(self):
        original = ap.descargar
        ap.descargar = lambda url, timeout=25, extra=None: json.dumps({"resources": {"results": {"products": [
            {"title": "Crazy Chic Taller de Velas", "url": "/products/velas?_pos=1"},
            {"title": "Crazy Chic Nail Art Studio Clementoni", "url": "/products/nail-art?_pos=2"}]}}})
        try:
            self.assertEqual(ap.buscar_shopify("www.toyplanet.com", "Crazy Chic Nail Art Studio"),
                             "https://www.toyplanet.com/products/nail-art")
            self.assertIsNone(ap.buscar_shopify("www.toyplanet.com", "Nail Art Barbie"))
            self.assertEqual(ap.buscar_shopify("www.toyplanet.com", "Crazy Chic vélas"),
                             "https://www.toyplanet.com/products/velas")
        finally:
            ap.descargar = original

    def test_clave_enlace(self):
        self.assertEqual(ap.clave_enlace({"url": "https://a"}), "https://a")
        self.assertEqual(ap.clave_enlace({"dominio": "t.com", "buscar": "x y"}), "buscar:t.com:x y")

    def test_amazon_reintenta_tras_captcha(self):
        original_d, original_s = ap.descargar, ap.time.sleep
        respuestas = ['<form action="/errors/validateCaptcha">', '<div id="corePrice_feature_div"><span class="a-offscreen">10,00 €</span></div>']
        ap.descargar = lambda url, timeout=25, extra=None: respuestas.pop(0)
        ap.time.sleep = lambda s: None
        try:
            pagina = ap.descargar_amazon("https://www.amazon.es/dp/B0BJLD278H", intentos=2)
        finally:
            ap.descargar, ap.time.sleep = original_d, original_s
        self.assertIn("10,00", pagina)


class ComparadorTest(unittest.TestCase):
    PAGINA = """<table><thead><tr><th>Tienda</th></tr></thead><tbody id="table_prices_body">
    <tr data-condition="new"><td class='pt_pr_name'><h3><a title="Carrito de limpieza" href='/out/aaa?sig=1'>Carrito</a></h3></td>
      <td class='pt_pr_price'><div><a data-merchant='Abacus' href='/out/aaa?sig=1'>23,99€</a></div>
      <div class="shipping"><div class="best-total-price">Precio total más barato: <div>26,98€ e.i.</div></div></div></td>
      <td class='pt_pr_mlogo'><a href='/out/aaa?sig=1'><img title='Ver oferta en Abacus' alt='Comprar en Abacus' src='/logos/Abacus.png' /></a></td>
      <td class='pt_pr_visit'><a href='/out/aaa?sig=1'>Ver oferta</a></td></tr>
    <tr><td class='pt_pr_name'><h3><a title="Theo Klein Vileda" href='/out/bbb'>x</a></h3></td>
      <td class='pt_pr_price'><a data-merchant='Amazon' href='/out/bbb'>29,66€</a><div class="row shipping">29,66€ e.i.</div></td>
      <td class='pt_pr_mlogo'><img alt='Comprar en Amazon'><div class="label">Marketplace</div><div class="pt_fp_from">Vendido por Amazon</div></td></tr>
    <tr><td class='pt_pr_name'><h3><a title="Carro Vileda" href='/out/ccc'>x</a></h3></td>
      <td class='pt_pr_price'><a data-merchant='Fnac' href='/out/ccc'>39,43€</a></td>
      <td class='pt_pr_mlogo'><div class="label">Marketplace</div><div class="pt_fp_from">Vendido por Electro MGD</div></td></tr>
    <tr><td class='pt_pr_name'><h3><a title="Carrito Klein" href='/out/ddd'>x</a></h3></td>
      <td class='pt_pr_price'><a data-merchant='Raijuguetes' href='/out/ddd'>25,96€</a><div class="row shipping">31,95€ e.i.</div></td>
      <td class='pt_pr_mtext'><a href='/out/ddd'>Raijuguetes</a></td></tr>
    </tbody></table>"""

    def test_lee_ofertas(self):
        ofertas = ap.ofertas_comparador("https://www.globerada.com/precios/x.html", self.PAGINA)
        self.assertEqual([(o["tienda"], o["precio"]) for o in ofertas],
                         [("Abacus", 23.99), ("Raijuguetes", 25.96), ("Amazon", 29.66),
                          ("Fnac (Electro MGD)", 39.43)])
        self.assertEqual(ofertas[0]["url"], "https://www.globerada.com/out/aaa?sig=1")

    def test_muestra_real_si_existe(self):
        ruta = Path(__file__).resolve().parent.parent / "diagnostico" / "muestras" / "comparador-carro-limpieza.html"
        if not ruta.exists():
            self.skipTest("sin muestra")
        ofertas = ap.ofertas_comparador("https://www.globerada.com/precios/x.html", ruta.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(ofertas), 3)
        self.assertTrue(all(not o["tienda"].startswith("Marketplace") for o in ofertas))

    def test_revisar_comparador_guarda_cada_tienda(self):
        original = ap.descargar
        ap.descargar = lambda url, timeout=25, extra=None: self.PAGINA
        hist = {}
        try:
            fila = ap.revisar_comparador(hist, {"id": "p"}, {"tienda": "Globerada",
                                         "comparador": "https://www.globerada.com/precios/x.html"}, "2026-11-19")
        finally:
            ap.descargar = original
        self.assertEqual(len(fila["ofertas"]), 4)
        clave = "https://www.globerada.com/precios/x.html#Abacus"
        self.assertEqual(hist["p"][clave]["historial"][-1]["precio"], 23.99)
        self.assertEqual(hist["p"][clave]["via"], "Globerada")


if __name__ == "__main__":
    unittest.main()
