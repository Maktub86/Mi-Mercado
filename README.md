# Mi Mercado

Página para seguir los precios de la lista de Reyes de Alba y Lucía (y, más adelante, de cualquier otra cosa).

## Cómo funciona

- **La web** (`web/`) es una página estática que se publica en Render. Lee dos archivos:
  - `web/data/productos.json`: la lista de productos, para quién son, si ya están comprados y los enlaces de cada tienda.
  - `web/data/precios.json`: el historial de precios. Lo escribe el robot, no hace falta tocarlo.
- **El robot** (`scripts/actualizar_precios.py`) se ejecuta solo con GitHub Actions a las 08:00 y a las 20:00 (hora de Sevilla). Visita cada enlace, lee el precio y lo guarda. Render vuelve a publicar la web en cuanto cambia el historial.
- También se puede lanzar a mano desde la pestaña **Actions** del repositorio → *Actualizar precios de Mi Mercado* → *Run workflow*.

## Añadir o cambiar un producto

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
- `enlaces`: la página de producto de cada tienda. Cuantas más tiendas, mejor comparación.

## Limitaciones

Amazon y El Corte Inglés a veces bloquean a los robots. Cuando pasa, la web lo indica en esa tienda y sigue mostrando el último precio conocido o el de la lista. Las tiendas más pequeñas (Juguettos, Toys R Us, Carrefour…) suelen leerse sin problema, así que conviene añadir enlaces de varias tiendas.

## Publicar en Render

1. En Render: **New → Blueprint** y elige este repositorio. Render lee `render.yaml` y crea el sitio estático `mi-mercado`.
2. Listo. Cada vez que el robot guarda precios nuevos, Render publica la web de nuevo.

## Pruebas

```bash
python -m unittest discover -s tests
```
