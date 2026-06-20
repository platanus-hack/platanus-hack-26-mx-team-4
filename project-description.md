# MercadoLimpio

**Comprá mejor en MercadoLibre: resultados sin sesgo de publicidad y opiniones resumidas con IA.**

## El problema

Comprar en MercadoLibre se volvió una pelea contra el ruido. Los primeros resultados están dominados por publicidad y posicionamiento pago, no necesariamente por la mejor relación calidad-precio. Y para saber si un producto vale la pena, hay que leerse decenas de opiniones dispersas. El resultado: decisiones peores y más lentas.

## La solución

**MercadoLimpio** es una extensión de Chrome (Manifest V3) que actúa como una capa de IA sobre la experiencia de compra, sin reemplazar a MercadoLibre. Tiene dos pilares:

### Pilar 1 — Reordenamiento limpio del listado
Reordena las tarjetas de la página de resultados usando **solo señales visibles** (precio, reputación, ventas, calificación), bajando el peso de la publicidad. Es un *toggle*: lo prendés y ves el listado ordenado por calidad real; lo apagás y vuelve al orden original. **No hace ninguna llamada de red** — solo reordena el DOM de la página.

### Pilar 2 — Resumen de opiniones con IA
En la página de producto, extrae las opiniones públicas y las resume con IA (Gemini 2.5 Flash) en tres bloques claros: **puntos a favor**, **puntos en contra** y un **veredicto**. Así decidís en segundos en vez de leer 40 reviews.

## Cómo funciona (y por qué es seguro)

- La extensión **nunca** habla directamente con el modelo de IA. Envía únicamente el **texto público de las opiniones** a un proxy propio (función serverless en Vercel), que es el único que tiene la API key.
- La **API key vive solo del lado del servidor**: nunca está en la extensión, ni en el código, ni en las peticiones.
- El proxy valida y acota cada pedido, restringe los orígenes permitidos a dominios de MercadoLibre y devuelve un resumen con estructura fija.
- Si la IA no está disponible, la tarjeta muestra un estado claro en vez de romperse.

## Stack

- **Extensión**: TypeScript + Vite + crxjs (Chrome MV3, permission-light)
- **Backend**: función serverless en Vercel + Gemini 2.5 Flash
- **Calidad**: 273 tests automatizados (extensión + proxy), endurecido con revisión adversarial de código

## Track

☎️ Legacy — modernizamos la experiencia de compra sobre un producto legacy (MercadoLibre) sin pedirle permiso ni reemplazarlo: una capa de IA que el usuario controla.
