# Mi Mercado

Página para seguir los precios de la lista de Reyes de Alba y Lucía (y, más adelante, de cualquier otra cosa).

## Cómo funciona

- **La web** (`web/`) es una página estática que se publica en Render. Lee dos archivos:
  - `web/data/productos.json`: la lista de productos, para quién son, si ya están comprados y los enlaces de cada tienda.
  - `web/data/precios.json`: el historial de precios. Lo escribe el robot, no hace falta tocarlo.
- **El robot** (`scripts/actualizar_precios.py`) se ejecuta solo con GitHub Actions a las 08:00 y a las 20:00 (hora de Sevilla). Visita cada enlace, lee el precio y lo guarda. Render vuelve a publicar la web en cuanto cambia el historial.
- También se lanza solo cada vez que se cambia `productos.json`, y se puede lanzar a mano desde la pestaña **Actions** del repositorio → *Actualizar precios de Mi Mercado* → *Run workflow*.

## Qué muestra cada juguete

- La foto del producto (sacada de la tienda).
- El mejor precio entre todas las tiendas y la diferencia con el precio de la lista.
- Una pestaña por tienda con su precio, si está bajando o subiendo, una gráfica del historial y la puntuación de las opiniones (estrellas y número de opiniones; en Amazon, también su resumen de lo que opinan los clientes).

Si una tienda no deja leer el precio, `diagnostico/ultima_revision.json` explica qué pasó en cada enlace.

## Editar desde la web

Botón **＋ Añadir** (nombre, para quién, enlaces opcionales) y botón **✎ Editar** (marcar comprado, eliminar, quitar una tienda que no es el producto, devolver a la lista y, en los ya comprados, **€ Precio y cantidad**). En *Precio y cantidad* se apunta mi precio por unidad, cuántas unidades hay y qué precio se suma: el mío o el del historial de tiendas. En la ✉️ Carta, debajo del precio sale x2, x3… si hay varias unidades, y el botón ⇄ cambia entre los dos precios. Los cambios los guarda el servidor `api/servidor.py` (servicio `mi-mercado-api` en Render) en `web/data/productos.json`, con una contraseña (`CLAVE_EDICION`) y una clave de GitHub (`GITHUB_TOKEN`) configuradas en Render. La dirección del servidor está en `web/data/config.json`.

## Añadir o cambiar un producto a mano

Edita `web/data/productos.json` desde GitHub (botón del lápiz). Cada producto tiene este aspecto:

```json
{
  "id": "nombre-sin-espacios",
  "nombre": "Nombre que se verá en la web",
  "para": "Alba",
  "estado": "pendiente",
  "nota": "Lo pide mucho",
  "precio_lista": 29.99,
  "busqueda": "texto para buscarlo en Amazon y comparar tiendas",
  "enlaces": [
    {"tienda": "Amazon", "url": "https://www.amazon.es/dp/XXXXXXXXXX"},
    {"tienda": "El Corte Inglés", "url": "https://www.elcorteingles.es/juguetes/..."}
  ]
}
```

- `para`: `Alba`, `Lucía` o `Las dos` (puede ser cualquier otro nombre).
- `estado`: `pendiente` o `comprado` (los comprados dejan de revisarse). Opcional: `"comprado_por": "Abuela Mari Luz"`.
- Opcionales: `"precio_propio": 24.99` (mi precio por unidad), `"cantidad": 2` y `"usar_precio": "tienda"` (sumar el precio del historial aunque haya precio propio; si no se pone, con precio propio se suma el propio).
- `enlaces`: la página de producto de cada tienda. Cuantas más tiendas, mejor comparación.
- Si no tienes la página de El Corte Inglés, pon `{"tienda": "El Corte Inglés", "eci_buscar": "palabras del producto"}`: el ordenador de casa lo busca en la tienda (con el navegador) y se queda con el primer producto que tenga todas esas palabras. Lo mismo con `amazon_buscar` para Amazon.

## Limitaciones

Amazon y El Corte Inglés a veces bloquean a los robots. Cuando pasa, la web lo indica en esa tienda y sigue mostrando el último precio conocido o el de la lista. Las tiendas más pequeñas (Juguettos, Toys R Us, Carrefour…) suelen leerse sin problema, así que conviene añadir enlaces de varias tiendas.

## Publicar en Render

1. En Render: **New → Blueprint** y elige este repositorio. Render lee `render.yaml` y crea el sitio estático `mi-mercado`.
2. Listo. Cada vez que el robot guarda precios nuevos, Render publica la web de nuevo.

## Pruebas

```bash
python -m unittest discover -s tests
```

## Revisar precios desde un ordenador con Windows

Desde los servidores de GitHub, Amazon pide captcha y El Corte Inglés o Toys R Us bloquean. La carpeta `windows/` instala una tarea programada que, cada día a las 22:00, descarga la lista y el robot desde GitHub, revisa las tiendas desde el ordenador de casa y sube `precios.json`. Instrucciones en `windows/LEEME.txt`. El robot de GitHub sigue revisando el resto de tiendas a las 08:00 y a las 20:00 (sin Amazon).
